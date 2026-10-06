import { accessSync, constants, statSync } from "node:fs";

/**
 * Why a configured SSH private key cannot be used, or `null` when it is
 * readable. Returns the errno code (`ENOENT`, `EACCES`) so config errors can
 * name the cause without leaking anything about the key itself.
 */
export function privateKeyReadError(path: string): string | null {
  try {
    accessSync(path, constants.R_OK);
    return null;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    return code ?? (err instanceof Error ? err.message : String(err));
  }
}

/**
 * True when the key is readable by group or others. OpenSSH refuses such keys
 * outright; ssh2 does not, so the registry warns instead. POSIX mode bits are
 * meaningless on Windows, so it never warns there.
 */
export function privateKeyIsShared(path: string): boolean {
  if (process.platform === "win32") return false;
  return (statSync(path).mode & 0o077) !== 0;
}

const SHA256_HEX_RE = /^[0-9a-f]{64}$/;
// `ssh-keygen -l` prints the SHA-256 digest as unpadded base64 (43 characters).
const OPENSSH_SHA256_RE = /^SHA256:([A-Za-z0-9+/]{43})=?$/;

/**
 * An `sshFingerprint` as lowercase hex, or `null` when it is not a SHA-256
 * host-key fingerprint. Accepts hex in either case, with or without colons, and
 * the `SHA256:<base64>` form that `ssh-keygen -l` prints.
 */
export function sshFingerprintHex(value: string): string | null {
  const openssh = OPENSSH_SHA256_RE.exec(value);
  if (openssh) return Buffer.from(openssh[1], "base64").toString("hex");
  const hex = value.replace(/:/g, "").toLowerCase();
  return SHA256_HEX_RE.test(hex) ? hex : null;
}
