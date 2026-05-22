type Status = "success" | "error";

const toolCalls = new Map<string, number>();

function key(tool: string, status: Status): string {
  return `${tool}\0${status}`;
}

/** Increment the call counter for a tool/status pair. */
export function recordToolCall(tool: string, status: Status): void {
  const k = key(tool, status);
  toolCalls.set(k, (toolCalls.get(k) ?? 0) + 1);
}

/** Render all metrics in Prometheus text exposition format. */
export function renderPrometheus(): string {
  const lines: string[] = [
    "# HELP mikromcp_tool_calls_total Total MCP tool calls by tool and status.",
    "# TYPE mikromcp_tool_calls_total counter",
  ];
  for (const [k, count] of toolCalls) {
    const [tool, status] = k.split("\0");
    lines.push(`mikromcp_tool_calls_total{tool="${tool}",status="${status}"} ${count}`);
  }
  return lines.join("\n") + "\n";
}

/** Test helper — clear all counters. */
export function resetMetrics(): void {
  toolCalls.clear();
}
