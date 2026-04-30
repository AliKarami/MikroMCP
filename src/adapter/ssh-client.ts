import { createHash } from "node:crypto";
import { Client } from "ssh2";
import type { RouterConfig } from "../types.js";

export interface SshClientOptions {
  commandTimeoutMs?: number;
  maxOutputBytes?: number;
}

export class SshClient {
  private readonly commandTimeoutMs: number;
  private readonly maxOutputBytes: number;

  constructor(
    private readonly config: RouterConfig,
    private readonly credentials: { username: string; password: string },
    options?: SshClientOptions,
  ) {
    this.commandTimeoutMs = options?.commandTimeoutMs ?? 30_000;
    this.maxOutputBytes = options?.maxOutputBytes ?? 512 * 1024;
  }

  async execute(command: string, overrideTimeoutMs?: number): Promise<string> {
    const timeoutMs = overrideTimeoutMs ?? this.commandTimeoutMs;
    const maxOutputBytes = this.maxOutputBytes;

    return new Promise((resolve, reject) => {
      const conn = new Client();
      let output = "";
      let outputSize = 0;
      let truncated = false;
      let settled = false;
      let timer: ReturnType<typeof setTimeout> | undefined;

      const cleanup = (err?: Error) => {
        if (settled) return;
        settled = true;
        if (timer !== undefined) clearTimeout(timer);
        conn.end();
        if (err) {
          reject(err);
        } else {
          resolve(truncated ? output + "\n[OUTPUT TRUNCATED]" : output);
        }
      };

      conn.on("ready", () => {
        conn.exec(command, (err, stream) => {
          if (err) {
            cleanup(err);
            return;
          }

          timer = setTimeout(() => {
            stream.close();
          }, timeoutMs);

          const appendOutput = (data: Buffer) => {
            if (truncated) return;
            const remaining = maxOutputBytes - outputSize;
            if (data.length >= remaining) {
              output += data.slice(0, remaining).toString();
              outputSize = maxOutputBytes;
              truncated = true;
              stream.close();
              return;
            }
            output += data.toString();
            outputSize += data.length;
          };

          stream.on("data", appendOutput);
          stream.stderr.on("data", appendOutput);
          stream.on("close", () => cleanup());
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
