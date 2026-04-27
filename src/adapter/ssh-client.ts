import { Client } from "ssh2";
import type { RouterConfig } from "../types.js";

export class SshClient {
  constructor(
    private readonly config: RouterConfig,
    private readonly credentials: { username: string; password: string },
  ) {}

  async execute(command: string, timeoutMs?: number): Promise<string> {
    return new Promise((resolve, reject) => {
      const conn = new Client();
      let output = "";
      let timer: ReturnType<typeof setTimeout> | undefined;

      const finish = () => {
        if (timer !== undefined) clearTimeout(timer);
        conn.end();
        resolve(output);
      };

      conn.on("ready", () => {
        conn.exec(command, (err, stream) => {
          if (err) {
            if (timer !== undefined) clearTimeout(timer);
            conn.end();
            reject(err);
            return;
          }

          stream.on("data", (data: Buffer) => {
            output += data.toString();
          });

          stream.stderr.on("data", (data: Buffer) => {
            output += data.toString();
          });

          stream.on("close", finish);

          if (timeoutMs !== undefined) {
            // Force-close after timeout — used for interactive commands like torch
            timer = setTimeout(() => {
              stream.close();
            }, timeoutMs);
          }
        });
      });

      conn.on("error", (err) => {
        if (timer !== undefined) clearTimeout(timer);
        reject(err);
      });

      conn.connect({
        host: this.config.host,
        port: this.config.sshPort ?? 22,
        username: this.credentials.username,
        password: this.credentials.password,
        readyTimeout: 10_000,
      });
    });
  }
}
