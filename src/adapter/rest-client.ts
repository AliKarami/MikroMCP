// ---------------------------------------------------------------------------
// MikroMCP - Core RouterOS REST API client
// ---------------------------------------------------------------------------

import { request, Agent } from "undici";
import type { RouterConfig, QueryOptions, RouterOSRecord } from "../types.js";
import { buildAgentOptions } from "./tls-manager.js";
import { parseRecord, parseRecords } from "./response-parser.js";
import { buildListQuery, applyPagination } from "./query-builder.js";

// ---------------------------------------------------------------------------
// HttpError - thrown on non-2xx responses
// ---------------------------------------------------------------------------

export class HttpError extends Error {
  readonly statusCode: number;
  readonly responseBody: string;

  constructor(statusCode: number, responseBody: string) {
    super(`HTTP ${statusCode}: ${responseBody}`);
    this.name = "HttpError";
    this.statusCode = statusCode;
    this.responseBody = responseBody;
  }
}

// ---------------------------------------------------------------------------
// REST client
// ---------------------------------------------------------------------------

/** Request timeout in milliseconds. */
const REQUEST_TIMEOUT_MS = 30_000;

export class RouterOSRestClient {
  private readonly baseUrl: string;
  private readonly authHeader: string;
  private readonly agent: Agent;

  constructor(
    config: RouterConfig,
    credentials: { username: string; password: string },
  ) {
    const scheme = config.tls.enabled ? "https" : "http";
    this.baseUrl = `${scheme}://${config.host}:${config.port}/rest`;

    this.authHeader =
      "Basic " + Buffer.from(`${credentials.username}:${credentials.password}`).toString("base64");

    this.agent = new Agent(buildAgentOptions(config.tls));
  }

  // ---------- public CRUD methods ----------

  /**
   * List resources at the given path.
   *
   * Applies filtering via GET query params or POST body depending on the
   * query complexity, then runs client-side pagination.
   */
  async get<T = Record<string, unknown>>(
    path: string,
    options?: QueryOptions,
  ): Promise<T[]> {
    const query = buildListQuery(options);
    let raw: Array<Record<string, string>>;

    if (query.method === "POST") {
      raw = (await this.doRequest("POST", `${this.baseUrl}/${path}`, query.body)) as Array<
        Record<string, string>
      >;
    } else {
      const qs = query.queryParams ? "?" + new URLSearchParams(query.queryParams).toString() : "";
      raw = (await this.doRequest("GET", `${this.baseUrl}/${path}${qs}`)) as Array<
        Record<string, string>
      >;
    }

    const parsed = parseRecords<T>(raw);

    // Client-side pagination
    if (options?.limit !== undefined || options?.offset !== undefined) {
      const page = applyPagination(parsed, options?.limit, options?.offset);
      return page.items;
    }

    return parsed;
  }

  /** Fetch a single resource by its RouterOS `.id`. */
  async getOne<T = Record<string, unknown>>(path: string, id: string): Promise<T> {
    const raw = (await this.doRequest(
      "GET",
      `${this.baseUrl}/${path}/${id}`,
    )) as Record<string, string>;

    return parseRecord<T>(raw);
  }

  /** Create a new resource (PUT). Returns the created record including `.id`. */
  async create(path: string, data: Record<string, string>): Promise<RouterOSRecord> {
    const raw = (await this.doRequest(
      "PUT",
      `${this.baseUrl}/${path}`,
      data,
    )) as RouterOSRecord;

    return raw;
  }

  /** Update an existing resource by `.id` (PATCH). */
  async update(path: string, id: string, data: Record<string, string>): Promise<void> {
    await this.doRequest("PATCH", `${this.baseUrl}/${path}/${id}`, data);
  }

  /** Remove a resource by `.id` (DELETE). */
  async remove(path: string, id: string): Promise<void> {
    await this.doRequest("DELETE", `${this.baseUrl}/${path}/${id}`);
  }

  /** Execute a command (POST), e.g. `/ip/firewall/filter/print`. */
  async execute<T = unknown>(path: string, data?: Record<string, unknown>): Promise<T> {
    const result = await this.doRequest("POST", `${this.baseUrl}/${path}`, data);
    return result as T;
  }

  // ---------- lifecycle ----------

  /** Close the underlying HTTP agent and free resources. */
  close(): void {
    this.agent.close();
  }

  // ---------- internal ----------

  /**
   * Core HTTP request method.
   *
   * - Sends JSON body when provided.
   * - Attaches Basic Auth and content-type headers.
   * - Throws `HttpError` on non-2xx status codes.
   * - Returns parsed JSON (or `undefined` for empty bodies).
   */
  private async doRequest(method: string, url: string, body?: unknown): Promise<unknown> {
    const headers: Record<string, string> = {
      Accept: "application/json",
      Authorization: this.authHeader,
    };

    let requestBody: string | undefined;

    if (body !== undefined) {
      headers["Content-Type"] = "application/json";
      requestBody = JSON.stringify(body);
    }

    const response = await request(url, {
      method: method as "GET" | "POST" | "PUT" | "PATCH" | "DELETE",
      headers,
      body: requestBody,
      dispatcher: this.agent,
      bodyTimeout: REQUEST_TIMEOUT_MS,
      headersTimeout: REQUEST_TIMEOUT_MS,
    });

    const text = await response.body.text();

    if (response.statusCode < 200 || response.statusCode >= 300) {
      throw new HttpError(response.statusCode, text);
    }

    // RouterOS DELETE returns an empty body on success.
    if (!text || text.length === 0) {
      return undefined;
    }

    return JSON.parse(text);
  }
}
