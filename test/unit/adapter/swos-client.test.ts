import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createServer, type Server } from "node:http";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { SwosClient } from "../../../src/adapter/swos-client.js";
import { HttpError } from "../../../src/adapter/rest-client.js";
import { encodePasswordChange, parseBlob } from "../../../src/adapter/swos-protocol.js";
import { MikroMCPError, ErrorCategory } from "../../../src/domain/errors/error-types.js";

const REALM = "SwOS";
const USER = "admin";
const PASS = "admin";
const FIXTURES = join(import.meta.dirname, "../../fixtures/swos");
const linkBlob = readFileSync(join(FIXTURES, "link.b"), "utf8");
const sysBlob = readFileSync(join(FIXTURES, "sys.b"), "utf8");

/** Digest verification matching what the switch firmware does (RFC 2617, qop=auth). */
function validDigest(authHeader: string, method: string, password: string): boolean {
  if (!authHeader.startsWith("Digest ")) return false;
  const fields: Record<string, string> = {};
  for (const kv of authHeader.slice("Digest ".length).split(",")) {
    const [k, v] = kv.split("=", 2);
    fields[k.trim()] = (v ?? "").trim().replace(/^"|"$/g, "");
  }
  const user = fields.username ?? "";
  const ha1 = createHash("md5").update(`${user}:${REALM}:${password}`).digest("hex");
  const ha2 = createHash("md5").update(`${method}:${fields.uri}`).digest("hex");
  const expected = fields.qop
    ? createHash("md5")
        .update(`${ha1}:${fields.nonce}:${fields.nc}:${fields.cnonce}:${fields.qop}:${ha2}`)
        .digest("hex")
    : createHash("md5").update(`${ha1}:${fields.nonce}:${ha2}`).digest("hex");
  return expected === fields.response;
}

interface MockState {
  store: Map<string, string>;
  binary: Map<string, Buffer>;
  uploads: { path: string; contentType: string; body: Buffer }[];
  requests: { path: string; method: string; authOk: boolean }[];
  password: string;
  nextPassword?: string;
  refusePassword?: boolean;
  /** Apply the change but never answer, as SwOS Lite does with POSTed blobs. */
  hangPassword?: boolean;
}

function startMock(): { server: Server; state: MockState; url: () => string } {
  const state: MockState = {
    store: new Map(),
    binary: new Map(),
    uploads: [],
    requests: [],
    password: PASS,
  };
  const server = createServer((req, res) => {
    const path = (req.url ?? "/").replace(/^\//, "").split("?")[0];
    const auth = req.headers.authorization ?? "";
    const authOk = validDigest(auth, req.method ?? "GET", state.password);
    state.requests.push({ path, method: req.method ?? "GET", authOk });

    if (!authOk) {
      res.writeHead(401, {
        "WWW-Authenticate": `Digest realm="${REALM}", qop="auth", nonce="deadbeef", algorithm=MD5`,
      });
      res.end();
      return;
    }

    if (req.method === "POST" && path === "!pwd.b") {
      let raw = "";
      req.on("data", (chunk) => (raw += chunk));
      req.on("end", () => {
        state.store.set(path, raw);
        if (state.hangPassword) {
          if (state.nextPassword !== undefined) state.password = state.nextPassword;
          return; // no reply
        }
        if (state.refusePassword) {
          res.writeHead(405);
        } else {
          if (state.nextPassword !== undefined) state.password = state.nextPassword;
          res.writeHead(200);
        }
        res.end();
      });
      return;
    }

    if (req.method === "GET" && state.binary.has(path)) {
      res.writeHead(200, { "Content-Type": "application/octet-stream" });
      res.end(state.binary.get(path));
      return;
    }

    if (req.method === "POST" && (req.headers["content-type"] ?? "").startsWith("multipart/")) {
      const chunks: Buffer[] = [];
      req.on("data", (chunk: Buffer) => chunks.push(chunk));
      req.on("end", () => {
        state.uploads.push({
          path,
          contentType: req.headers["content-type"] ?? "",
          body: Buffer.concat(chunks),
        });
        res.writeHead(200);
        res.end();
      });
      return;
    }

    if (req.method === "GET") {
      const body = state.store.get(path);
      if (body === undefined) {
        res.writeHead(404);
        res.end();
        return;
      }
      res.writeHead(200, { "Content-Type": "text/plain" });
      res.end(body);
      return;
    }

    if (req.method === "POST") {
      let raw = "";
      req.on("data", (chunk) => (raw += chunk));
      req.on("end", () => {
        try {
          parseBlob(raw);
        } catch {
          res.writeHead(400);
          res.end("invalid blob");
          return;
        }
        state.store.set(path, raw);
        res.writeHead(200);
        res.end();
      });
      return;
    }

    res.writeHead(405);
    res.end();
  });

  return {
    server,
    state,
    url: () => `http://127.0.0.1:${(server.address() as { port: number }).port}`,
  };
}

describe("SwosClient", () => {
  let mock: ReturnType<typeof startMock>;
  let client: SwosClient;

  beforeAll(async () => {
    mock = startMock();
    await new Promise<void>((resolve) => mock.server.listen(0, "127.0.0.1", resolve));
    const { port } = mock.server.address() as { port: number };
    client = new SwosClient("127.0.0.1", port, { username: USER, password: PASS });
  });

  afterAll(() => {
    mock.server.close();
    client.close();
  });

  it("authenticates with digest and decodes a GET response", async () => {
    mock.state.store.set("link.b", linkBlob);
    const decoded = (await client.get("link.b")) as { name: string[] };
    expect(decoded.name[0]).toBe("p1_uplink-a");
    expect(mock.state.requests.at(-1)).toMatchObject({
      path: "link.b",
      method: "GET",
      authOk: true,
    });
  });

  it("reuses the digest nonce across requests (single 401 per session)", async () => {
    mock.state.store.set("sys.b", sysBlob);
    await client.get("sys.b");
    await client.readBlob("sys.b");
    const sysRequests = mock.state.requests.filter((r) => r.path === "sys.b");
    expect(sysRequests.length).toBe(2);
    expect(sysRequests.every((r) => r.authOk)).toBe(true);
  });

  it("POSTs a mutated blob and the server stores it", async () => {
    mock.state.store.set("link.b", linkBlob);
    const blob = await client.readBlob("link.b");
    const nameKey = "i0a";
    const before = (blob[nameKey] as string[])[0];
    (blob[nameKey] as string[])[0] = Buffer.from("renamed").toString("hex");
    await client.writeBlob("link.b", blob);
    const stored = mock.state.store.get("link.b");
    expect(stored).toBeDefined();
    expect(stored).not.toContain(before);
    expect(stored).toContain(Buffer.from("renamed").toString("hex"));
  });

  it("downloads a binary resource byte-for-byte", async () => {
    const backup = Buffer.from([0x00, 0xff, 0x80, 0x0a, 0xc3, 0x28, 0x00]);
    mock.state.binary.set("backup.swb", backup);
    expect(await client.getBinary("backup.swb")).toEqual(backup);
  });

  it("uploads a file as multipart/form-data under the given field name", async () => {
    const firmware = Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0x00, 0xff]);
    await client.postMultipart("upgrade", "blob", "swos-css318g-2.19.bin", firmware);
    const upload = mock.state.uploads.at(-1)!;
    expect(upload.path).toBe("upgrade");
    const boundary = upload.contentType.split("boundary=")[1];
    expect(boundary).toMatch(/^----MikroMCP[0-9a-f]{24}$/);
    const text = upload.body.toString("latin1");
    expect(text).toContain(
      'Content-Disposition: form-data; name="blob"; filename="swos-css318g-2.19.bin"',
    );
    const start = upload.body.indexOf(Buffer.from("\r\n\r\n")) + 4;
    expect(upload.body.subarray(start, start + firmware.length)).toEqual(firmware);
    expect(text.endsWith(`--${boundary}--\r\n`)).toBe(true);
  });

  it("withholds the SNMP blob from a round-trip mismatch error", async () => {
    mock.state.store.set("snmp.b", "{en:12,com:'7365637265742d636f6d6d756e697479',ci:'',loc:''}");
    const err = await client.readBlobForWrite("snmp.b").catch((e: unknown) => e);
    expect(err).toMatchObject({ code: "SWOS_ROUNDTRIP_MISMATCH" });
    expect(JSON.stringify(err)).not.toContain("7365637265742d636f6d6d756e697479");
  });

  it("changes the admin password and authenticates with the new one afterwards", async () => {
    const { port } = mock.server.address() as { port: number };
    const own = new SwosClient("127.0.0.1", port, { username: USER, password: PASS });
    mock.state.store.set("sys.b", sysBlob);
    mock.state.nextPassword = "n3w-pass";
    try {
      await own.changePassword("n3w-pass", "pwd");
      expect(mock.state.store.get("!pwd.b")).toBe(
        `{pwd:'${encodePasswordChange(PASS, "n3w-pass")}'}`,
      );
      await expect(own.getRaw("sys.b")).resolves.toBe(sysBlob);
    } finally {
      mock.state.password = PASS;
      mock.state.nextPassword = undefined;
    }
  });

  it("confirms an unanswered password change by logging in with the new password", async () => {
    const { port } = mock.server.address() as { port: number };
    const own = new SwosClient("127.0.0.1", port, { username: USER, password: PASS }, 300);
    mock.state.store.set("sys.b", sysBlob);
    mock.state.hangPassword = true;
    mock.state.nextPassword = "n3w-pass";
    try {
      await expect(own.changePassword("n3w-pass", "i01")).resolves.toBeUndefined();
      await expect(own.getRaw("sys.b")).resolves.toBe(sysBlob);
    } finally {
      mock.state.hangPassword = false;
      mock.state.password = PASS;
      mock.state.nextPassword = undefined;
    }
  });

  it("keeps the old password when an unanswered change did not land", async () => {
    const { port } = mock.server.address() as { port: number };
    const own = new SwosClient("127.0.0.1", port, { username: USER, password: PASS }, 300);
    mock.state.store.set("sys.b", sysBlob);
    mock.state.hangPassword = true; // and no nextPassword: the switch kept the old one
    try {
      await expect(own.changePassword("n3w-pass", "i01")).rejects.toMatchObject({
        code: "SWOS_PASSWORD_UNCONFIRMED",
      });
      await expect(own.getRaw("sys.b")).resolves.toBe(sysBlob);
    } finally {
      mock.state.hangPassword = false;
    }
  });

  it("reports a refused password change as a wrong current password", async () => {
    mock.state.refusePassword = true;
    try {
      await expect(client.changePassword("whatever", "pwd")).rejects.toMatchObject({
        code: "SWOS_PASSWORD_WRONG",
      });
    } finally {
      mock.state.refusePassword = false;
    }
  });

  it("throws HttpError with 401 for wrong credentials", async () => {
    const bad = new SwosClient("127.0.0.1", (mock.server.address() as { port: number }).port, {
      username: "admin",
      password: "wrong",
    });
    mock.state.store.set("snmp.b", "{}");
    await expect(bad.get("snmp.b")).rejects.toMatchObject({ statusCode: 401 });
    bad.close();
  });

  it("throws HttpError for unknown endpoints", async () => {
    await expect(client.getRaw("nope.b")).rejects.toMatchObject({ statusCode: 404 });
  });

  it("rejects writes to endpoints without a schema", async () => {
    await expect(client.writeBlob("nope.b", {})).rejects.toMatchObject({
      code: "SWOS_UNKNOWN_ENDPOINT",
    });
  });

  it("re-POSTs an untouched blob byte-for-byte", async () => {
    // Whole-blob writes must not reshape untouched fields (0x00000000 -> 0x00).
    mock.state.store.set("rstp.b", readFileSync(join(FIXTURES, "rstp.b"), "utf8"));
    const blob = await client.readBlob("rstp.b");
    await client.writeBlob("rstp.b", blob);
    expect(mock.state.store.get("rstp.b")).toBe(
      readFileSync(join(FIXTURES, "rstp.b"), "utf8").trim(),
    );
  });

  it("readBlobForWrite refuses a blob the codec cannot round-trip byte-for-byte", async () => {
    // A firmware that serializes a value as a bare decimal (12) instead of a
    // hex token (0x0c) is numerically identical but not byte-preserving. The
    // fixtures only prove the codec for the hardware they came from; a write
    // to such a device must fail here, before the whole blob is POSTed back.
    mock.state.store.set("snmp.b", "{i01:12}");
    const err = await client.readBlobForWrite("snmp.b").catch((e) => e);
    expect(err).toBeInstanceOf(MikroMCPError);
    expect(err.category).toBe(ErrorCategory.VALIDATION);
    expect(err.code).toBe("SWOS_ROUNDTRIP_MISMATCH");
    expect(err.recoverability.retryable).toBe(false);
    expect(err.recoverability.suggestedAction).toContain("Reads are unaffected");
    expect(
      mock.state.requests.filter((r) => r.path === "snmp.b" && r.method === "POST"),
    ).toHaveLength(0);
  });

  it("accepts a POST response whose status line ends in a bare LF", async () => {
    // Real CSS610 firmware answers a successful POST with "HTTP/1.0 200 OK\n"
    // — no CR. A strict HTTP parser rejects it, which would report a write that
    // actually applied as a failure. Served here at the socket level because a
    // normal HTTP server cannot emit a malformed status line.
    const sloppy = createServer();
    sloppy.on("connection", (socket) => {
      socket.once("data", () => {
        socket.end("HTTP/1.0 200 OK\nContent-Type: text/html\n\n");
      });
    });
    await new Promise<void>((resolve) => sloppy.listen(0, "127.0.0.1", resolve));
    const { port } = sloppy.address() as { port: number };

    const client2 = new SwosClient("127.0.0.1", port, { username: USER, password: PASS });
    await expect(client2.postRaw("snmp.b", "{i01:0x01}")).resolves.toBe("");

    client2.close();
    sloppy.close();
  });

  it("gives up after repeated digest challenges instead of looping", async () => {
    const alwaysChallenging = createServer((_req, res) => {
      res.writeHead(401, {
        "WWW-Authenticate": `Digest realm="${REALM}", qop="auth", nonce="deadbeef", algorithm=MD5`,
      });
      res.end();
    });
    await new Promise<void>((resolve) => alwaysChallenging.listen(0, "127.0.0.1", resolve));
    const { port } = alwaysChallenging.address() as { port: number };
    const stubborn = new SwosClient("127.0.0.1", port, { username: USER, password: PASS });

    await expect(stubborn.getRaw("link.b")).rejects.toMatchObject({ statusCode: 401 });

    stubborn.close();
    alwaysChallenging.close();
  });

  it("classifies an unanswered POST as an ambiguous ROUTER_TIMEOUT (write may have applied)", async () => {
    // Real CSS610 firmware accepts a .b POST and never sends a response — the
    // write lands, the client just never hears back. It must surface as a
    // ROUTER_TIMEOUT MikroMCPError (so the caller's "verify state before
    // retrying" handling fires), not as a generic internal error.
    const silent = createServer();
    silent.on("connection", (socket) => {
      socket.once("data", () => {
        // swallow the request and never answer
      });
    });
    await new Promise<void>((resolve) => silent.listen(0, "127.0.0.1", resolve));
    const { port } = silent.address() as { port: number };
    const client2 = new SwosClient("127.0.0.1", port, { username: USER, password: PASS }, 200);

    const err = await client2.postRaw("link.b", "{i01:0x03ff}").catch((e) => e);
    expect(err).toBeInstanceOf(MikroMCPError);
    expect(err.category).toBe(ErrorCategory.ROUTER_TIMEOUT);
    expect(err.code).toBe("SWOS_REQUEST_TIMEOUT");
    expect(err.message).toContain("may still have been applied");
    expect(err.recoverability.retryable).toBe(false);
    expect(err.recoverability.suggestedAction).toContain("does not acknowledge writes");

    client2.close();
    silent.close();
  });

  it("classifies an unanswered GET as a retryable ROUTER_TIMEOUT", async () => {
    const silent = createServer();
    silent.on("connection", (socket) => {
      socket.once("data", () => {
        // never answer
      });
    });
    await new Promise<void>((resolve) => silent.listen(0, "127.0.0.1", resolve));
    const { port } = silent.address() as { port: number };
    const client2 = new SwosClient("127.0.0.1", port, { username: USER, password: PASS }, 200);

    const err = await client2.getRaw("link.b").catch((e) => e);
    expect(err).toBeInstanceOf(MikroMCPError);
    expect(err.category).toBe(ErrorCategory.ROUTER_TIMEOUT);
    expect(err.recoverability.retryable).toBe(true);

    client2.close();
    silent.close();
  });
});

describe("HttpError", () => {
  it("exposes status code and message", () => {
    const err = new HttpError(401, "unauthorized");
    expect(err.statusCode).toBe(401);
    expect(err.responseBody).toBe("unauthorized");
    expect(err).toBeInstanceOf(Error);
  });
});
