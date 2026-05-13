import { Client } from "basic-ftp";
import { Readable } from "node:stream";
import { createLogger } from "../observability/logger.js";

const log = createLogger("ftp-client");

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
  log.info({ host: options.host, remoteName }, "Uploading file via FTP");
  const client = new Client();
  try {
    await client.access({
      host: options.host,
      port: options.port ?? 21,
      user: options.user,
      password: options.password,
    });
    await client.uploadFrom(Readable.from(Buffer.from(content, "utf-8")), remoteName);
    log.info({ host: options.host, remoteName }, "FTP upload complete");
  } finally {
    client.close();
  }
}

// Connectivity probe used for dry-run: connects and immediately disconnects to verify credentials.
export async function ftpConnect(options: FtpUploadOptions): Promise<void> {
  const client = new Client();
  try {
    await client.access({
      host: options.host,
      port: options.port ?? 21,
      user: options.user,
      password: options.password,
    });
  } finally {
    client.close();
  }
}
