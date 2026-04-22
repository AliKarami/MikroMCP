// ---------------------------------------------------------------------------
// MikroMCP - Correlation ID propagation via AsyncLocalStorage
// ---------------------------------------------------------------------------

import { AsyncLocalStorage } from "node:async_hooks";
import { nanoid } from "nanoid";

export interface RequestContext {
  correlationId: string;
  routerId?: string;
  tool?: string;
  identity?: string;
}

/** AsyncLocalStorage instance that carries the current request context. */
export const requestContext = new AsyncLocalStorage<RequestContext>();

/**
 * Return the correlation ID for the current async context, or "unknown" if
 * no context has been established.
 */
export function getCorrelationId(): string {
  return requestContext.getStore()?.correlationId ?? "unknown";
}

/**
 * Run `fn` inside a new async context. A `correlationId` is generated
 * automatically via nanoid if one is not provided in `ctx`.
 */
export function withContext<T>(
  ctx: Partial<RequestContext>,
  fn: () => T | Promise<T>,
): T | Promise<T> {
  const fullContext: RequestContext = {
    correlationId: ctx.correlationId ?? nanoid(),
    routerId: ctx.routerId,
    tool: ctx.tool,
    identity: ctx.identity,
  };
  return requestContext.run(fullContext, fn);
}
