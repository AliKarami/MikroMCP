import { describe, it, expect } from "vitest";
import { paginate, listContent, compactFields } from "../../../src/domain/tools/pagination.js";

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

describe("compactFields", () => {
  it("renders curated fields as key=value, in the given order", () => {
    const rec = { chain: "forward", action: "drop", protocol: "tcp" };
    expect(compactFields(rec, ["chain", "action", "protocol"])).toBe(
      "chain=forward action=drop protocol=tcp",
    );
  });

  it("skips fields that are missing, null, or empty", () => {
    const rec = { chain: "forward", action: "", comment: undefined, protocol: null };
    expect(compactFields(rec as Record<string, unknown>, ["chain", "action", "comment", "protocol"])).toBe(
      "chain=forward",
    );
  });

  it("quotes values containing spaces", () => {
    const rec = { comment: "drop ssh brute force" };
    expect(compactFields(rec, ["comment"])).toBe('comment="drop ssh brute force"');
  });

  it("returns an empty string when no fields have values", () => {
    expect(compactFields({}, ["a", "b"])).toBe("");
  });
});

describe("listContent", () => {
  const render = (r: { name: string }) => `name=${r.name}`;

  it("renders a header plus one indented line per item", () => {
    const page = [{ name: "a" }, { name: "b" }];
    expect(listContent("Widgets", "r1", page, 2, 0, render)).toBe(
      "Widgets on r1: 1-2 of 2.\n  name=a\n  name=b",
    );
  });

  it("reflects offset and total in the range header", () => {
    const page = [{ name: "c" }];
    expect(listContent("Widgets", "r1", page, 57, 2, render)).toBe(
      "Widgets on r1: 3-3 of 57.\n  name=c",
    );
  });

  it("returns a header-only 'none' line for an empty page", () => {
    expect(listContent("Widgets", "r1", [], 0, 0, render)).toBe("Widgets on r1: none.");
  });
});
