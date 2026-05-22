import { describe, it, expect, beforeEach } from "vitest";
import { recordToolCall, renderPrometheus, resetMetrics } from "../../../src/observability/metrics.js";

describe("metrics", () => {
  beforeEach(() => resetMetrics());

  it("counts tool calls by tool name and status", () => {
    recordToolCall("list_routes", "success");
    recordToolCall("list_routes", "success");
    recordToolCall("manage_route", "error");
    const out = renderPrometheus();
    expect(out).toContain('mikromcp_tool_calls_total{tool="list_routes",status="success"} 2');
    expect(out).toContain('mikromcp_tool_calls_total{tool="manage_route",status="error"} 1');
  });

  it("emits a Prometheus HELP/TYPE header", () => {
    recordToolCall("ping", "success");
    const out = renderPrometheus();
    expect(out).toContain("# HELP mikromcp_tool_calls_total");
    expect(out).toContain("# TYPE mikromcp_tool_calls_total counter");
  });
});
