// ---------------------------------------------------------------------------
// MikroMCP - RouterOS REST API query builder
// ---------------------------------------------------------------------------

import type { QueryOptions } from "../types.js";

export interface BuiltQuery {
  method: "GET" | "POST";
  queryParams?: Record<string, string>;
  body?: Record<string, unknown>;
}

/**
 * Build a query for listing RouterOS resources.
 *
 * - Simple key=value filters without a proplist use **GET** with query params.
 * - Complex queries or those needing a proplist use **POST** with `.query` / `.proplist` body.
 */
export function buildListQuery(options?: QueryOptions): BuiltQuery {
  // No options at all -> plain GET
  if (!options) {
    return { method: "GET" };
  }

  const hasFilter = options.filter && Object.keys(options.filter).length > 0;
  const hasProplist = options.proplist && options.proplist.length > 0;

  // When a proplist is requested or filters are combined with a proplist,
  // use POST with structured body.
  if (hasProplist) {
    const body: Record<string, unknown> = {};

    if (hasProplist) {
      body[".proplist"] = options.proplist!.join(",");
    }

    if (hasFilter) {
      // Build the `.query` array: each filter becomes "?key=value"
      const queryParts: string[] = [];
      for (const [key, value] of Object.entries(options.filter!)) {
        queryParts.push(`${key}=${value}`);
      }
      body[".query"] = queryParts;
    }

    return { method: "POST", body };
  }

  // Simple key=value filters -> GET with query parameters
  if (hasFilter) {
    const queryParams: Record<string, string> = {};
    for (const [key, value] of Object.entries(options.filter!)) {
      queryParams[key] = value;
    }
    return { method: "GET", queryParams };
  }

  // No filters, no proplist
  return { method: "GET" };
}

/**
 * Apply client-side pagination to a full result set.
 *
 * RouterOS does not support server-side pagination, so we fetch everything
 * and slice here.
 */
export function applyPagination<T>(
  items: T[],
  limit?: number,
  offset?: number,
): { items: T[]; total: number; hasMore: boolean } {
  const total = items.length;
  const start = offset ?? 0;
  const sliced = limit !== undefined ? items.slice(start, start + limit) : items.slice(start);

  return {
    items: sliced,
    total,
    hasMore: start + sliced.length < total,
  };
}
