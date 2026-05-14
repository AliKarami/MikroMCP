import { Client } from "basic-ftp";
import { Readable } from "node:stream";
import { createLogger } from "../observability/logger.js";

const log = createLogger("ftp-client");

export class FtpClient {
  readonly #host: string;
  readonly #port: number;
  readonly #user: string;
  readonly #password: string;

  constructor(host: string, port: number, user: string, password: string) {
    this.#host = host;
    this.#port = port;
    this.#user = user;
    this.#password = password;
  }

  async upload(remoteName: string, content: string): Promise<void> {
    log.info({ host: this.#host, remoteName }, "Uploading file via FTP");
    const client = new Client();
    try {
      await client.access({
        host: this.#host,
        port: this.#port,
        user: this.#user,
        password: this.#password,
      });
      await client.uploadFrom(Readable.from(Buffer.from(content, "utf-8")), remoteName);
      log.info({ host: this.#host, remoteName }, "FTP upload complete");
    } finally {
      client.close();
    }
  }

  // Credential probe for dry-run: verifies FTP access without transferring data.
  async connect(): Promise<void> {
    const client = new Client();
    try {
      await client.access({
        host: this.#host,
        port: this.#port,
        user: this.#user,
        password: this.#password,
      });
    } finally {
      client.close();
    }
  }
}

export interface FtpUploadOptions {
  host: string;
  port?: number;
  user: string;
  password: string;
}

export async function ftpUpload(
  options: FtpUploadOptions,
  remoteName: string,
  content: string,
): Promise<void> {
  const c = new FtpClient(options.host, options.port ?? 21, options.user, options.password);
  await c.upload(remoteName, content);
}

// Connectivity probe used for dry-run: connects and immediately disconnects to verify credentials.
export async function ftpConnect(options: FtpUploadOptions): Promise<void> {
  const c = new FtpClient(options.host, options.port ?? 21, options.user, options.password);
  await c.connect();
}
