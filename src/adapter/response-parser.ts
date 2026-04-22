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

  // Numeric conversion
  if (NUMERIC_RE.test(value)) {
    const num = Number(value);
    if (Number.isFinite(num)) {
      return num;
    }
  }

  return value;
}

/**
 * Parse all values in a single RouterOS record.
 */
export function parseRecord<T = Record<string, unknown>>(
  raw: Record<string, string>,
): T {
  const parsed: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(raw)) {
    parsed[key] = parseRouterOSValue(key, value);
  }

  return parsed as T;
}

/**
 * Parse an array of RouterOS records.
 */
export function parseRecords<T = Record<string, unknown>>(
  raw: Array<Record<string, string>>,
): T[] {
  return raw.map((r) => parseRecord<T>(r));
}
