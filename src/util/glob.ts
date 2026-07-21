/**
 * Case-insensitive glob match anchored to the whole string. `*` is the only
 * wildcard and expands to `.*`; every other regex metacharacter is escaped.
 */
export function globMatch(pattern: string, value: string): boolean {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
  return new RegExp(`^${escaped}$`, "i").test(value);
}
