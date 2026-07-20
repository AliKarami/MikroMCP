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
 */
export function isTrue(v: unknown): boolean {
  return v === true || v === "true" || v === "yes";
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
