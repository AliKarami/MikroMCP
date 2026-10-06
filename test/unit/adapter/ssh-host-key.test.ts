import { describe, it, expect } from "vitest";
import { createHash } from "node:crypto";
import { pinHostKey } from "../../../src/adapter/ssh-host-key.js";

const hostKey = Buffer.from("router-host-key");
const digest = createHash("sha256").update(hostKey).digest();
const pinned = digest.toString("hex");
// What ssh2 emits after hostVerifier returned false (lib/protocol/kex.js).
const hostDenied = (): Error =>
  Object.assign(new Error("Host denied (verification failed)"), { level: "handshake" });

describe("pinHostKey", () => {
  it("accepts the key whose SHA-256 is the pinned fingerprint, in either case", () => {
    expect(pinHostKey(pinned).hostVerifier(hostKey)).toBe(true);
    expect(pinHostKey(pinned.toUpperCase()).hostVerifier(hostKey)).toBe(true);
  });

  it("refuses any other key", () => {
    expect(pinHostKey("ab".repeat(32)).hostVerifier(hostKey)).toBe(false);
  });

  it("replaces ssh2's error for a refused key with one naming both fingerprints", () => {
    const pin = pinHostKey("ab".repeat(32));
    pin.hostVerifier(hostKey);
    const ssh2Error = hostDenied();

    const err = pin.connectionError(ssh2Error);

    expect(err).toMatchObject({
      code: "SSH_HOST_KEY_MISMATCH",
      expected: "ab".repeat(32),
      actual: pinned,
      cause: ssh2Error,
    });
    // The OpenSSH form, as `ssh-keygen -l` and `ssh-keyscan | ssh-keygen -lf -` print it.
    const openssh = `SHA256:${digest.toString("base64").replace(/=+$/, "")}`;
    expect(err.message).toBe(
      `SSH host key does not match sshFingerprint. Expected: ${"ab".repeat(32)}, got: ${pinned} (${openssh})`,
    );
  });

  it("passes other errors through unchanged once the key was accepted", () => {
    const pin = pinHostKey(pinned);
    pin.hostVerifier(hostKey);
    const authError = Object.assign(new Error("All configured authentication methods failed"), {
      level: "client-authentication",
    });

    expect(pin.connectionError(authError)).toBe(authError);
  });

  it("passes errors through unchanged before any key was presented", () => {
    const refused = Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" });
    expect(pinHostKey(pinned).connectionError(refused)).toBe(refused);
  });
});
