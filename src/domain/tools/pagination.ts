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
