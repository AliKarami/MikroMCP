import { createHash } from "node:crypto";
import { Client } from "ssh2";
import type { RouterConfig } from "../types.js";

/**
 * Uploads a file over SFTP (encrypted, over the SSH channel) — the preferred
 * alternative to plaintext FTP. Honors the router's `sshPort` and
 * `sshFingerprint` exactly like {@link SshClient}.
 */
export class SftpClient {
  constructor(
    private readonly config: RouterConfig,
    private readonly credentials: { username: string; password: string },
  ) {}

  async upload(remoteName: string, content: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const conn = new Client();
      let settled = false;

      const cleanup = (err?: Error) => {
        if (settled) return;
        settled = true;
        conn.end();
        if (err) reject(err);
        else resolve();
      };

      conn.on("ready", () => {
        conn.sftp((err, sftp) => {
          if (err) {
            cleanup(err);
            return;
          }
          sftp.writeFile(remoteName, Buffer.from(content, "utf-8"), (writeErr) => {
            cleanup(writeErr ?? undefined);
          });
        });
      });

      conn.on("error", (err) => cleanup(err));

      const connectOptions: Record<string, unknown> = {
        host: this.config.host,
        port: this.config.sshPort ?? 22,
        username: this.credentials.username,
        password: this.credentials.password,
        readyTimeout: 10_000,
      };

      if (this.config.sshFingerprint) {
        const expected = this.config.sshFingerprint.toLowerCase();
        connectOptions.hostVerifier = (key: Buffer): boolean => {
          const actual = createHash("sha256").update(key).digest("hex");
          return actual === expected;
        };
      }

      conn.connect(connectOptions as Parameters<Client["connect"]>[0]);
    });
  }
}
