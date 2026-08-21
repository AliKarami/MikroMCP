// ---------------------------------------------------------------------------
// MikroMCP - RouterOS REST API response parser
// ---------------------------------------------------------------------------

/**
 * Pattern matching numeric strings (integer or decimal, optionally negative).
 * Examples: "42", "-7", "3.14", "-0.5"
 */
const NUMERIC_RE = /^-?\d+(\.\d+)?$/;

/**
 * RouterOS duration pattern, e.g. "1d2h3m4s", "5m30s", "2w1d".
 * These should remain as human-readable strings.
 */
const DURATION_RE = /^\d+[wdhms](\d+[wdhms])*$/;

/**
 * Parse a single RouterOS string value into an appropriate JS type.
 *
 * RouterOS returns **everything** as strings. This function converts:
 * - `"true"` / `"false"` to booleans
 * - Numeric strings to numbers
 * - `.id` values stay as strings (e.g. `"*A"`)
 * - Duration strings stay as strings (e.g. `"1d2h3m4s"`)
 * - Everything else stays as string
 */
export function parseRouterOSValue(key: string, value: string): unknown {
  // .id values are always kept as-is
  if (key === ".id") {
    return value;
  }

  // Boolean coercion
  if (value === "true") return true;
  if (value === "false") return false;

  // Duration strings - keep as human-readable
  if (DURATION_RE.test(value)) {
    return value;
  }

  // Numeric conversion. Integers must be safe (64-bit RouterOS counters like
  // rx-byte exceed 2^53 and would lose precision as JS numbers — keep those as
  // strings); decimals keep the finite check.
  if (NUMERIC_RE.test(value)) {
    const num = Number(value);
    const isInteger = !value.includes(".");
    if (isInteger ? Number.isSafeInteger(num) : Number.isFinite(num)) {
      return num;
    }
  }

  return value;
}

/**
 * True when a RouterOS boolean-ish field is set. Records go through the parser,
 * which converts `"true"`/`"false"` to real booleans — but some fields arrive
 * unparsed (raw string) or as `"yes"`/`"no"`. This accepts all of them.
 *
 * @example
 * // RouterOS sends disabled as "yes", parser converts to boolean true
 * isTrue(record.disabled) // true for "yes", true, or "true"
 * record.disabled === "yes" // false if parser converted to boolean
 *
 * @param v - Value from a RouterOS record (may be parsed or raw string)
 * @returns true if the value represents a truthy RouterOS boolean
 */
export function isTrue(v: unknown): boolean {
  return v === true || v === "true" || v === "yes";
}

/**
 * Compare a (possibly parsed) record value against a desired value by
 * normalising both to their wire-string form. The parser turns numeric wire
 * strings into numbers, so `record.port === String(desired)` silently never
 * matches — use this instead for any non-boolean field (booleans go through
 * `isTrue`).
 *
 * Handles `null` and `undefined` by converting them to their string representations
 * ("null", "undefined"), which correctly distinguishes them from actual values.
 * RouterOS typically omits absent fields rather than sending `null`, so this works
 * as intended for idempotency checks.
 *
 * @example
 * // RouterOS sends port as "8080", parser converts to number 8080
 * record.port === "8080" // false (number !== string)
 * sameValue(record.port, "8080") // true ("8080" === "8080")
 *
 * @example
 * // Works with VLAN IDs, VRIDs, and other numeric identifiers
 * record.vlanId === 100 // parser converted "100" to number 100
 * sameValue(record.vlanId, 100) // true ("100" === "100")
 *
 * @param recordValue - Value from a RouterOS record (may be parsed to number/boolean)
 * @param desired - Expected value (typically from tool parameters)
 * @returns true if both values stringify to the same string
 */
export function sameValue(recordValue: unknown, desired: unknown): boolean {
  return String(recordValue) === String(desired);
}

/**
 * Parse all values in a single RouterOS record.
 */
export function parseRecord<T = Record<string, unknown>>(raw: Record<string, string>): T {
  const parsed: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(raw)) {
    parsed[key] = parseRouterOSValue(key, value);
  }

  return parsed as T;
}

/**
 * Parse an array of RouterOS records.
 */
export function parseRecords<T = Record<string, unknown>>(raw: Array<Record<string, string>>): T[] {
  return raw.map((r) => parseRecord<T>(r));
}
