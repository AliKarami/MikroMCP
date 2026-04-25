import { Client } from "ssh2";
import type { RouterConfig } from "../types.js";

export class SshClient {
  constructor(
    private readonly config: RouterConfig,
    private readonly credentials: { username: string; password: string },
  ) {}

  async execute(command: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const conn = new Client();
      let output = "";

      conn.on("ready", () => {
        conn.exec(command, (err, stream) => {
          if (err) {
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

          stream.on("close", () => {
            conn.end();
            resolve(output);
          });
        });
      });

      conn.on("error", reject);

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
