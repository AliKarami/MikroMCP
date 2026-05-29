import { describe, it, expect } from "vitest";
import { paginate } from "../../../src/domain/tools/pagination.js";

describe("paginate", () => {
  const items = Array.from({ length: 10 }, (_, i) => i);

  it("returns a slice from offset with the given limit", () => {
    const page = paginate(items, 2, 3);
    expect(page.items).toEqual([2, 3, 4]);
    expect(page.total).toBe(10);
    expect(page.hasMore).toBe(true);
  });

  it("reports hasMore=false when the window reaches the end", () => {
    const page = paginate(items, 7, 5);
    expect(page.items).toEqual([7, 8, 9]);
    expect(page.total).toBe(10);
    expect(page.hasMore).toBe(false);
  });

  it("returns an empty slice when offset is past the end", () => {
    const page = paginate(items, 20, 5);
    expect(page.items).toEqual([]);
    expect(page.total).toBe(10);
    expect(page.hasMore).toBe(false);
  });
});
