import { describe, it, expect } from "vitest";
import { buildListQuery, applyPagination } from "../../../src/adapter/query-builder.js";

describe("buildListQuery", () => {
  it("returns GET with no params when no options", () => {
    const query = buildListQuery();
    expect(query.method).toBe("GET");
    expect(query.queryParams).toBeUndefined();
    expect(query.body).toBeUndefined();
  });

  it("builds GET with filter query params", () => {
    const query = buildListQuery({ filter: { name: "ether1" } });
    expect(query.method).toBe("GET");
    expect(query.queryParams).toEqual({ name: "ether1" });
  });

  it("builds POST when proplist is specified", () => {
    const query = buildListQuery({ proplist: ["name", "mtu", ".id"] });
    expect(query.method).toBe("POST");
    expect(query.body).toBeDefined();
    // RouterOS accepts proplist as comma-separated string
    expect((query.body as Record<string, unknown>)[".proplist"]).toBe("name,mtu,.id");
  });
});

describe("applyPagination", () => {
  const items = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];

  it("returns all items when no limit/offset", () => {
    const result = applyPagination(items);
    expect(result.items).toEqual(items);
    expect(result.total).toBe(10);
    expect(result.hasMore).toBe(false);
  });

  it("applies limit", () => {
    const result = applyPagination(items, 3);
    expect(result.items).toEqual([1, 2, 3]);
    expect(result.total).toBe(10);
    expect(result.hasMore).toBe(true);
  });

  it("applies offset", () => {
    const result = applyPagination(items, undefined, 5);
    expect(result.items).toEqual([6, 7, 8, 9, 10]);
    expect(result.total).toBe(10);
    expect(result.hasMore).toBe(false);
  });

  it("applies both limit and offset", () => {
    const result = applyPagination(items, 3, 2);
    expect(result.items).toEqual([3, 4, 5]);
    expect(result.total).toBe(10);
    expect(result.hasMore).toBe(true);
  });

  it("handles offset beyond array length", () => {
    const result = applyPagination(items, 5, 20);
    expect(result.items).toEqual([]);
    expect(result.total).toBe(10);
    expect(result.hasMore).toBe(false);
  });
});
