import { describe, expect, it } from "vitest";
import { buildRouterOsCommand } from "../../../src/adapter/routeros-command.js";

describe("buildRouterOsCommand", () => {
  it("quotes every string value and escapes RouterOS substitutions", () => {
    expect(
      buildRouterOsCommand("/tool ping", {
        address: 'router\"; :put $identity\\tail',
        count: 1,
      }),
    ).toBe('/tool ping address="router\\\"; :put \\$identity\\\\tail" count=1');
  });

  it("rejects control characters so the result stays a single command", () => {
    expect(() => buildRouterOsCommand("/tool ping", { address: "router\n:put owned" })).toThrow(
      "control characters",
    );
  });

  it("rejects an unsafe command name", () => {
    expect(() => buildRouterOsCommand("/tool ping; /user add", { count: 1 })).toThrow(
      "Invalid RouterOS command",
    );
  });

  it("rejects an unsafe parameter name", () => {
    expect(() => buildRouterOsCommand("/tool ping", { "count; /user add": 1 })).toThrow(
      "Invalid RouterOS parameter",
    );
  });
});
