export interface Page<T> {
  items: T[];
  total: number;
  hasMore: boolean;
}

/** Client-side pagination over a fully-fetched result set. RouterOS has no server-side paging. */
export function paginate<T>(items: T[], offset: number, limit: number): Page<T> {
  const total = items.length;
  return {
    items: items.slice(offset, offset + limit),
    total,
    hasMore: offset + limit < total,
  };
}

/**
 * Render a curated set of record fields as a compact `key=value` line for list-tool
 * `content`. Fields that are missing, null, or empty are skipped; values containing spaces
 * are quoted. Field order is preserved from `fields`.
 */
export function compactFields(record: Record<string, unknown>, fields: string[]): string {
  const parts: string[] = [];
  for (const field of fields) {
    const value = record[field];
    if (value === undefined || value === null || value === "") continue;
    const str = String(value);
    parts.push(str.includes(" ") ? `${field}="${str}"` : `${field}=${str}`);
  }
  return parts.join(" ");
}

/**
 * Human-readable itemized list for a list-tool's `content` field: a header line with the
 * shown range, then one `renderItem` line per record on the current page. Mirrors how
 * `get_log` serializes entries so `content`-only MCP clients see the actual rows, not just a
 * count. `structuredContent` still carries the full untruncated records for structured clients.
 */
export function listContent<T>(
  label: string,
  routerId: string,
  page: T[],
  total: number,
  offset: number,
  renderItem: (item: T) => string,
): string {
  const range = total === 0 ? "none" : `${offset + 1}-${offset + page.length} of ${total}`;
  const header = `${label} on ${routerId}: ${range}.`;
  if (page.length === 0) return header;
  return [header, ...page.map((item) => `  ${renderItem(item)}`)].join("\n");
}
