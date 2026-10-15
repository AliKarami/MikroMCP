// ---------------------------------------------------------------------------
// MikroMCP - SwOS / SwOS Lite ".b" API client (both firmware editions)
//
// Transport (see swos-protocol.ts for the full picture):
//   * Plain HTTP, HTTP Digest auth on every request (login + password)
//   * GET  /<tab>.b  -> "broken JSON" blob
//   * POST /<tab>.b  -> the *entire* re-encoded blob (never a diff)
//
// Writes are intentionally coarse: read the whole blob, mutate it locally,
// POST it back. This mirrors exactly what the web UI does and is the only
// safe write pattern the firmware supports.
// ---------------------------------------------------------------------------

import { createHash, randomBytes } from "node:crypto";
import { request as httpRequest } from "node:http";
import type { IncomingHttpHeaders, OutgoingHttpHeaders } from "node:http";
import {
  decodeEndpoint,
  dumpBlob,
  encodePasswordChange,
  PASSWORD_CHANGE_BYTES,
  parseWireBlob,
  presentableBlob,
  SWOS_SCHEMA,
  type DecodedBlob,
} from "./swos-protocol.js";
import { HttpError } from "./rest-client.js";
import { MikroMCPError, ErrorCategory } from "../domain/errors/error-types.js";
import type { Credentials } from "./connection-pool.js";

interface DigestChallenge {
  realm: string;
  nonce: string;
  opaque?: string;
  qop?: string;
  algorithm?: string;
}

/** Timeout for a single HTTP request, in milliseconds. */
const REQUEST_TIMEOUT_MS = 15_000;

function md5(input: string): string {
  return createHash("md5").update(input).digest("hex");
}

/** Parse a `WWW-Authenticate: Digest ...` challenge header. */
function parseDigestChallenge(header: string): DigestChallenge | undefined {
  if (!header.toLowerCase().startsWith("digest")) return undefined;
  const fields: Record<string, string> = {};
  const quoted = /([a-zA-Z0-9_-]+)\s*=\s*("([^"]*)"|([^\s,]+))/g;
  let m: RegExpExecArray | null;
  while ((m = quoted.exec(header)) !== null) {
    fields[m[1]] = m[3] ?? m[4];
  }
  if (!fields.realm || !fields.nonce) return undefined;
  return {
    realm: fields.realm,
    nonce: fields.nonce,
    opaque: fields.opaque,
    qop: fields.qop,
    algorithm: fields.algorithm,
  };
}

/** Build the `Authorization: Digest ...` header value (RFC 2617, qop="auth"). */
function buildDigestHeader(
  method: string,
  path: string,
  challenge: DigestChallenge,
  credentials: Credentials,
  nonceCount: number,
): string {
  const ha1 = md5(`${credentials.username}:${challenge.realm}:${credentials.password}`);
  const ha2 = md5(`${method}:${path}`);
  const nc = nonceCount.toString(16).padStart(8, "0");
  const cnonce = randomBytes(8).toString("hex");
  const qop = challenge.qop
    ?.split(",")
    .map((s) => s.trim())
    .find((s) => s === "auth");

  const response = qop
    ? md5(`${ha1}:${challenge.nonce}:${nc}:${cnonce}:${qop}:${ha2}`)
    : md5(`${ha1}:${challenge.nonce}:${ha2}`);

  const parts = [
    `username="${credentials.username}"`,
    `realm="${challenge.realm}"`,
    `nonce="${challenge.nonce}"`,
    `uri="${path}"`,
    `response="${response}"`,
  ];
  if (challenge.algorithm) parts.push(`algorithm=${challenge.algorithm}`);
  if (challenge.opaque) parts.push(`opaque="${challenge.opaque}"`);
  if (qop) parts.push(`qop=${qop}`, `nc=${nc}`, `cnonce="${cnonce}"`);
  return `Digest ${parts.join(", ")}`;
}

function assertKnownEndpoint(endpoint: string): void {
  if (endpoint in SWOS_SCHEMA) return;
  throw new MikroMCPError({
    category: ErrorCategory.VALIDATION,
    code: "SWOS_UNKNOWN_ENDPOINT",
    message: `No SwOS schema for "${endpoint}".`,
    details: { endpoint, known: Object.keys(SWOS_SCHEMA) },
    recoverability: {
      retryable: false,
      suggestedAction: "Call list_swos_endpoints to see the supported endpoints.",
    },
  });
}

interface RawResponse {
  statusCode: number;
  headers: IncomingHttpHeaders;
  body: string;
  /** The body as received, for binary endpoints (backup.swb). */
  raw: Buffer;
}

export class SwosClient {
  private readonly host: string;
  private readonly port: number;
  private credentials: Credentials;
  private readonly requestTimeoutMs: number;
  private challenge?: DigestChallenge;
  private nonceCount = 0;

  constructor(
    host: string,
    port: number,
    credentials: Credentials,
    requestTimeoutMs = REQUEST_TIMEOUT_MS,
  ) {
    this.host = host;
    this.port = port;
    this.credentials = credentials;
    this.requestTimeoutMs = requestTimeoutMs;
  }

  // ---------- raw transport ----------

  /**
   * Uses `node:http` with `insecureHTTPParser` rather than undici, because the
   * SwOS firmware terminates the status line of a POST response with a bare LF
   * instead of CRLF ("HTTP/1.0 200 OK\n"). A strict parser rejects that, which
   * would report a write that actually succeeded as a failure. The leniency is
   * scoped to this client — the RouterOS REST client keeps the strict parser.
   */
  private rawRequest(
    method: "GET" | "POST",
    path: string,
    headers: OutgoingHttpHeaders,
    body?: string | Buffer,
    timeoutMs = this.requestTimeoutMs,
  ): Promise<RawResponse> {
    return new Promise((resolve, reject) => {
      const req = httpRequest(
        {
          host: this.host,
          port: this.port,
          path,
          method,
          headers,
          insecureHTTPParser: true,
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on("data", (chunk: Buffer) => chunks.push(chunk));
          res.on("end", () => {
            const raw = Buffer.concat(chunks);
            resolve({
              statusCode: res.statusCode ?? 0,
              headers: res.headers,
              body: raw.toString("utf8"),
              raw,
            });
          });
          res.on("error", reject);
        },
      );
      req.on("error", reject);
      req.setTimeout(timeoutMs, () => {
        // A timeout is ambiguous by design here: the CSS610 firmware applies
        // POSTed .b blobs without sending a response (verified: no answer even
        // after 70s), so a write that "timed out" may actually have landed.
        // Classify as ROUTER_TIMEOUT so the caller's ambiguous-write handling
        // ("verify state before retrying") applies instead of INTERNAL, and
        // never suggest a longer timeout for writes — the firmware won't
        // answer regardless.
        const isWrite = method === "POST";
        req.destroy(
          new MikroMCPError({
            category: ErrorCategory.ROUTER_TIMEOUT,
            code: "SWOS_REQUEST_TIMEOUT",
            message: `SwOS ${method} request to ${path} timed out after ${timeoutMs}ms${
              isWrite ? " — the write may still have been applied" : ""
            }`,
            recoverability: isWrite
              ? {
                  retryable: false,
                  suggestedAction:
                    "SwOS firmware does not acknowledge writes, so a longer timeout will not help.",
                }
              : {
                  retryable: true,
                  retryAfterMs: 3000,
                  suggestedAction: "The switch did not respond in time — retry the read.",
                },
          }),
        );
      });
      if (body !== undefined) req.write(body);
      req.end();
    });
  }

  private async send(
    method: "GET" | "POST",
    path: string,
    body?: string | Buffer,
    contentType = "text/plain",
    timeoutMs = this.requestTimeoutMs,
  ): Promise<RawResponse> {
    for (let attempt = 0; attempt < 3; attempt++) {
      const headers: OutgoingHttpHeaders = {
        Accept: "text/plain",
        "Accept-Encoding": "identity",
      };
      if (body !== undefined) {
        headers["Content-Type"] = contentType;
        headers["Content-Length"] = Buffer.byteLength(body);
      }
      if (this.challenge) {
        this.nonceCount += 1;
        headers["Authorization"] = buildDigestHeader(
          method,
          path,
          this.challenge,
          this.credentials,
          this.nonceCount,
        );
      }

      const response = await this.rawRequest(method, path, headers, body, timeoutMs);

      const rawChallengeHeader = response.headers["www-authenticate"];
      const rawChallenge = Array.isArray(rawChallengeHeader)
        ? rawChallengeHeader[0]
        : rawChallengeHeader;
      if (response.statusCode === 401 && rawChallenge) {
        const parsed = parseDigestChallenge(rawChallenge);
        if (parsed) {
          this.challenge = parsed;
          this.nonceCount = 0;
          continue;
        }
      }

      if (response.statusCode < 200 || response.statusCode >= 300) {
        throw new HttpError(response.statusCode, response.body);
      }
      return response;
    }
    throw new HttpError(401, "digest authentication failed");
  }

  private async doRequest(method: "GET" | "POST", path: string, body?: string): Promise<string> {
    return (await this.send(method, path, body)).body;
  }

  /** GET a .b endpoint, return the raw broken-JSON text. */
  async getRaw(endpoint: string): Promise<string> {
    return this.doRequest("GET", `/${endpoint}`);
  }

  /** POST a re-encoded .b blob back to the switch. */
  async postRaw(endpoint: string, body: string): Promise<string> {
    return this.doRequest("POST", `/${endpoint}`, body);
  }

  // ---------- decoded helpers ----------

  /** GET + decode into the schema. Unknown keys are preserved under `_raw`. */
  async get(endpoint: string, portCount?: number): Promise<unknown> {
    assertKnownEndpoint(endpoint);
    return decodeEndpoint(endpoint, await this.getRaw(endpoint), portCount);
  }

  /**
   * GET and parse into a plain wire dict for local mutation. Hex tokens keep
   * their verbatim `"0x…"` form so untouched fields re-serialize byte-for-byte.
   */
  async readBlob(endpoint: string): Promise<DecodedBlob> {
    assertKnownEndpoint(endpoint);
    return parseWireBlob(await this.getRaw(endpoint)) as DecodedBlob;
  }

  /**
   * GET for mutation, proving the codec is lossless for *this* device first.
   * The fixtures only prove it for the hardware they came from; a firmware that
   * serializes differently must fail here rather than during a whole-blob write.
   */
  async readBlobForWrite(endpoint: string): Promise<DecodedBlob> {
    assertKnownEndpoint(endpoint);
    const raw = await this.getRaw(endpoint);
    const wire = parseWireBlob(raw) as DecodedBlob;
    const reencoded = dumpBlob(wire);
    if (reencoded !== raw.trim()) {
      throw new MikroMCPError({
        category: ErrorCategory.VALIDATION,
        code: "SWOS_ROUNDTRIP_MISMATCH",
        message: `MikroMCP cannot re-encode ${endpoint} on this device byte-for-byte; refusing to write.`,
        details: {
          endpoint,
          received: presentableBlob(endpoint, raw.trim()),
          reencoded: presentableBlob(endpoint, reencoded),
        },
        recoverability: {
          retryable: false,
          suggestedAction:
            "This firmware serializes a value in a form the codec does not preserve. Reads are unaffected; please open an issue with the blob.",
        },
      });
    }
    return wire;
  }

  /** POST a wire dict (re-encoded via the codec) back to the switch. */
  async writeBlob(endpoint: string, wire: unknown): Promise<string> {
    assertKnownEndpoint(endpoint);
    return this.postRaw(endpoint, dumpBlob(wire));
  }

  /** GET a binary resource (the `backup.swb` configuration backup). */
  async getBinary(path: string): Promise<Buffer> {
    return (await this.send("GET", `/${path}`)).raw;
  }

  /**
   * POST a file as multipart/form-data, the way the web UI uploads a backup
   * (`backup.swb`, field "file") or firmware (`upgrade`, field "blob").
   */
  async postMultipart(
    path: string,
    field: string,
    filename: string,
    data: Buffer,
    timeoutMs = this.requestTimeoutMs,
  ): Promise<string> {
    const boundary = `----MikroMCP${randomBytes(12).toString("hex")}`;
    const body = Buffer.concat([
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="${field}"; filename="${filename}"\r\n` +
          "Content-Type: application/octet-stream\r\n\r\n",
      ),
      data,
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]);
    const response = await this.send(
      "POST",
      `/${path}`,
      body,
      `multipart/form-data; boundary=${boundary}`,
      timeoutMs,
    );
    return response.body;
  }

  /**
   * Change the admin password the way the web UI does: POST the encoded
   * change to `/!pwd.b` (field `pwd` on SwOS, `i01` on SwOS Lite). On success
   * the client authenticates with the new password from then on.
   */
  async changePassword(newPassword: string, field: "pwd" | "i01"): Promise<void> {
    // The change travels as old password, NUL, new password in one 32-byte
    // buffer; a long current password would silently cut the new one short.
    const changeBytes =
      Buffer.byteLength(this.credentials.password, "latin1") +
      1 +
      Buffer.byteLength(newPassword, "latin1");
    if (changeBytes > PASSWORD_CHANGE_BYTES) {
      throw new MikroMCPError({
        category: ErrorCategory.VALIDATION,
        code: "SWOS_PASSWORD_TOO_LONG",
        message: `The current and the new password together take ${changeBytes} bytes; the switch's password change holds ${PASSWORD_CHANGE_BYTES} (current password, a separator, new password).`,
        recoverability: {
          retryable: false,
          suggestedAction:
            "Shorten the new password, or change the password in two steps through a shorter one.",
        },
      });
    }
    const encoded = encodePasswordChange(this.credentials.password, newPassword);
    const previous = this.credentials;
    try {
      await this.postRaw("!pwd.b", `{${field}:'${encoded}'}`);
    } catch (err) {
      // SwOS Lite applies a POSTed blob without answering it. When the request
      // times out, the change may well have landed: try the new password before
      // giving up, and keep the old one if it does not work.
      if (err instanceof MikroMCPError && err.category === ErrorCategory.ROUTER_TIMEOUT) {
        this.credentials = { ...previous, password: newPassword };
        this.challenge = undefined;
        this.nonceCount = 0;
        try {
          await this.getRaw("sys.b");
          return;
        } catch {
          // Neither password is known to work now: say so, instead of the plain timeout.
          this.credentials = previous;
          this.challenge = undefined;
          this.nonceCount = 0;
          throw new MikroMCPError({
            category: ErrorCategory.ROUTER_TIMEOUT,
            code: "SWOS_PASSWORD_UNCONFIRMED",
            message:
              "The switch did not answer the password change, and a login with the new password failed too. The change may still have landed: the switch may now take either password. This client went back to the configured one.",
            recoverability: {
              retryable: false,
              suggestedAction:
                "Call get_swos_status. If it fails to authenticate, the new password is in force: update the router's password variable to it and restart the server.",
            },
          });
        }
      }
      if (err instanceof HttpError && err.statusCode === 405) {
        throw new MikroMCPError({
          category: ErrorCategory.ROUTER_AUTH_FAILED,
          code: "SWOS_PASSWORD_WRONG",
          message:
            "The switch refused the password change: the configured current password is wrong.",
          recoverability: {
            retryable: false,
            suggestedAction: "Check the router's password environment variable against the switch.",
          },
        });
      }
      throw err;
    }
    this.credentials = { ...this.credentials, password: newPassword };
    this.challenge = undefined;
    this.nonceCount = 0;
  }

  /** No-op; SwOS uses plain HTTP with per-request connections. */
  close(): void {
    // nothing to release
  }
}
