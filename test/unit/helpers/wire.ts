import { parseRecord } from "../../../src/adapter/response-parser.js";

/** A RouterOS REST record as it arrives over HTTP: every value is a string. */
export type WireRecord = Record<string, string>;

/**
 * Turn raw RouterOS records into what `routerClient.get` returns: each record goes
 * through the REST client's parser, so `"53"` becomes 53 and `"true"` becomes true.
 * Mocking `get` with pre-parsed objects hides type mismatches in idempotency checks
 * (a stored port 53 compared with a requested "53"), so fixtures for those checks
 * should be written in wire form and passed through this helper.
 *
 * Throws on a non-string value: tests are not type-checked, and a number in a
 * fixture would silently skip the parser this helper exists to exercise.
 */
export function fromWire(records: WireRecord[]): Record<string, unknown>[] {
  return records.map((record) => {
    for (const [key, value] of Object.entries(record)) {
      if (typeof value !== "string") {
        throw new TypeError(
          `fromWire: "${key}" is ${typeof value}; RouterOS sends every value as a string`,
        );
      }
    }
    return parseRecord(record);
  });
}
