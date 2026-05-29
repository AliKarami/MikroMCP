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
 * Concise one-line summary for list-tool `content`. The full per-item detail lives in
 * `structuredContent`, so the human-readable text only needs counts and the shown range —
 * avoids duplicating every record across both result fields.
 */
export function listSummary(
  label: string,
  routerId: string,
  shown: number,
  total: number,
  offset: number,
): string {
  const range = total === 0 ? "none" : `${offset + 1}-${offset + shown} of ${total}`;
  return `${label} on ${routerId}: ${range}. Full records in structuredContent.`;
}
