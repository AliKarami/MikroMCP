// Single source of truth for the CHR endpoints the integration suite talks
// to — both the vitest global setup and the per-file harness resolve the
// containers from here, so a port or password override cannot skew between
// provisioning and the tests themselves.

export interface ChrEndpoint {
  host: string;
  httpPort: number;
  sshPort: number;
  password: string;
}

export const chrConnection: ChrEndpoint = {
  host: process.env.MIKROMCP_ITEST_HOST ?? "127.0.0.1",
  httpPort: Number(process.env.MIKROMCP_ITEST_HTTP_PORT ?? "18080"),
  sshPort: Number(process.env.MIKROMCP_ITEST_SSH_PORT ?? "12222"),
  password: process.env.MIKROMCP_ITEST_PASSWORD ?? "mikromcp-itest",
};

/** True when a second CHR is declared for fleet/pair tests ("0"/"false" disable). */
const pairFlag = (process.env.MIKROMCP_ITEST_PAIR ?? "").toLowerCase();
export const pairEnabled = pairFlag !== "" && pairFlag !== "0" && pairFlag !== "false";

export const pairConnection: ChrEndpoint = {
  host: process.env.MIKROMCP_ITEST_PAIR_HOST ?? "127.0.0.1",
  httpPort: Number(process.env.MIKROMCP_ITEST_PAIR_HTTP_PORT ?? "18081"),
  sshPort: Number(process.env.MIKROMCP_ITEST_PAIR_SSH_PORT ?? "12223"),
  password: chrConnection.password,
};
