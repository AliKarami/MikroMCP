import { describe, it, expect } from "vitest";
import {
  createRateLimiter,
  readBody,
  BodyTooLargeError,
} from "../../../src/mcp/transports/http.js";
import { Readable } from "node:stream";
import type { IncomingMessage } from "node:http";

function makeRequestStream(body: string): IncomingMessage {
  return Readable.from([Buffer.from(body)]) as unknown as IncomingMessage;
}

describe("createRateLimiter", () => {
  it("allows requests within the per-minute limit", () => {
    const check = createRateLimiter(5);
    for (let i = 0; i < 5; i++) {
      expect(check("10.0.0.1")).toBe(true);
    }
  });

  it("blocks the request that exceeds the limit", () => {
    const check = createRateLimiter(3);
    check("10.0.0.1");
    check("10.0.0.1");
    check("10.0.0.1");
    expect(check("10.0.0.1")).toBe(false);
  });

  it("tracks different IPs independently", () => {
    const check = createRateLimiter(2);
    check("10.0.0.1");
    check("10.0.0.1");
    expect(check("10.0.0.1")).toBe(false);
    expect(check("10.0.0.2")).toBe(true);
  });

  it("allows all requests when rpm is 0 (disabled)", () => {
    const check = createRateLimiter(0);
    for (let i = 0; i < 1000; i++) {
      expect(check("10.0.0.1")).toBe(true);
    }
  });
});

describe("readBody", () => {
  it("resolves with parsed JSON body", async () => {
    const req = makeRequestStream('{"key":"value"}');
    const result = await readBody(req, 1024 * 1024);
    expect(result).toEqual({ key: "value" });
  });

  it("resolves with undefined when body is empty", async () => {
    const req = makeRequestStream("");
    const result = await readBody(req, 1024 * 1024);
    expect(result).toBeUndefined();
  });

  it("rejects with BodyTooLargeError when body exceeds limit", async () => {
    const req = makeRequestStream("x".repeat(101));
    await expect(readBody(req, 100)).rejects.toBeInstanceOf(BodyTooLargeError);
  });

  it("rejects with SyntaxError when body is invalid JSON", async () => {
    const req = makeRequestStream("not-json");
    await expect(readBody(req, 1024 * 1024)).rejects.toThrow(SyntaxError);
  });
});
