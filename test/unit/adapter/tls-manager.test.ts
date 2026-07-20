import { describe, it, expect } from "vitest";
import type { buildConnector } from "undici";
import { buildAgentOptions, makePinnedConnector } from "../../../src/adapter/tls-manager.js";

describe("buildAgentOptions", () => {
  it("returns empty options when TLS is disabled", () => {
    const opts = buildAgentOptions({ enabled: false, rejectUnauthorized: true });
    expect(opts).toEqual({});
  });

  it("sets rejectUnauthorized from TLS config when no fingerprint is pinned", () => {
    const opts = buildAgentOptions({ enabled: true, rejectUnauthorized: false });
    expect((opts.connect as Record<string, unknown>).rejectUnauthorized).toBe(false);
  });

  it("uses a connector function (not a plain options object) when a fingerprint is pinned", () => {
    const opts = buildAgentOptions({
      enabled: true,
      rejectUnauthorized: false,
      fingerprint: "aabbccddeeff",
    });
    expect(typeof opts.connect).toBe("function");
  });
});

function fakeSocket(fp: string) {
  return {
    destroyed: false,
    destroy() {
      this.destroyed = true;
    },
    getPeerCertificate: () => ({ fingerprint256: fp }),
  };
}

describe("makePinnedConnector", () => {
  it("rejects and destroys the socket on fingerprint mismatch", async () => {
    const sock = fakeSocket("AA:BB:CC");
    const inner = ((_o: unknown, cb: (e: Error | null, s: unknown) => void) =>
      cb(null, sock)) as unknown as buildConnector.connector;
    const pinned = makePinnedConnector(inner, "dd:ee:ff");

    await new Promise<void>((resolve) => {
      pinned({} as never, (err, s) => {
        expect(err?.message).toMatch(/fingerprint mismatch/i);
        expect(s).toBeNull();
        expect(sock.destroyed).toBe(true);
        resolve();
      });
    });
  });

  it("passes the socket through on fingerprint match (colon-insensitive)", async () => {
    const sock = fakeSocket("AA:BB:CC");
    const inner = ((_o: unknown, cb: (e: Error | null, s: unknown) => void) =>
      cb(null, sock)) as unknown as buildConnector.connector;
    const pinned = makePinnedConnector(inner, "aabbcc");

    await new Promise<void>((resolve) => {
      pinned({} as never, (err, s) => {
        expect(err).toBeNull();
        expect(s).toBe(sock);
        expect(sock.destroyed).toBe(false);
        resolve();
      });
    });
  });

  it("propagates a connection error from the inner connector", async () => {
    const inner = ((_o: unknown, cb: (e: Error | null, s: unknown) => void) =>
      cb(new Error("boom"), null)) as unknown as buildConnector.connector;
    const pinned = makePinnedConnector(inner, "aabbcc");

    await new Promise<void>((resolve) => {
      pinned({} as never, (err, s) => {
        expect(err?.message).toBe("boom");
        expect(s).toBeNull();
        resolve();
      });
    });
  });
});
