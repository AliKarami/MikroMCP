import { createHash } from "node:crypto";

export interface HostKeyPin {
  /** ssh2 `hostVerifier`: accepts only the pinned key. */
  hostVerifier: (key: Buffer) => boolean;
  /**
   * The error to reject with. Once the verifier has refused a key, ssh2 only
   * reports "Host denied (verification failed)", with no code and no key, so
   * this replaces it with one that names both fingerprints.
   */
  connectionError: (err: Error) => Error;
}

/** Pin the router's SSH host key to `fingerprint`, the lowercase hex the registry stores. */
export function pinHostKey(fingerprint: string): HostKeyPin {
  const expected = fingerprint.toLowerCase();
  let refused: Buffer | undefined;
  return {
    hostVerifier: (key) => {
      const digest = createHash("sha256").update(key).digest();
      if (digest.toString("hex") === expected) return true;
      refused = digest;
      return false;
    },
    connectionError: (err) => {
      if (refused === undefined) return err;
      const actual = refused.toString("hex");
      const openssh = `SHA256:${refused.toString("base64").replace(/=+$/, "")}`;
      return Object.assign(
        new Error(
          `SSH host key does not match sshFingerprint. Expected: ${expected}, got: ${actual} (${openssh})`,
          { cause: err },
        ),
        { code: "SSH_HOST_KEY_MISMATCH", expected, actual },
      );
    },
  };
}
