import { describe, it, expect, vi } from "vitest";
import { findRuleByComment, ruleCommentKey } from "../../../src/domain/tools/rule-comment.js";
import type { ToolContext } from "../../../src/domain/tools/tool-definition.js";

describe("ruleCommentKey", () => {
  it("strips control characters", () => {
    expect(ruleCommentKey("allow\nweb\x7f")).toBe("allowweb");
  });

  it("keeps a printable comment, spaces included", () => {
    expect(ruleCommentKey("allow web")).toBe("allow web");
  });

  it("throws COMMENT_EMPTY when nothing printable is left", () => {
    expect(() => ruleCommentKey("\x01\n\x7f")).toThrow(
      expect.objectContaining({ code: "COMMENT_EMPTY", category: "VALIDATION" }),
    );
  });
});

describe("findRuleByComment", () => {
  it("filters on the router by comment and returns the first match", async () => {
    const get = vi.fn().mockResolvedValue([{ ".id": "*1" }, { ".id": "*2" }]);
    const context = { routerClient: { get } } as unknown as ToolContext;

    expect(await findRuleByComment(context, "ip/firewall/mangle", "c")).toEqual({ ".id": "*1" });
    expect(get).toHaveBeenCalledWith("ip/firewall/mangle", { filter: { comment: "c" } });
  });

  it("returns undefined when nothing matches", async () => {
    const context = {
      routerClient: { get: vi.fn().mockResolvedValue([]) },
    } as unknown as ToolContext;

    expect(await findRuleByComment(context, "ip/firewall/filter", "c")).toBeUndefined();
  });
});
