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
