/**
 * The RouterOS version each router last reported, for list_routers to show next
 * to the one written in routers.yaml. In memory only: it is a hint from the
 * current process, not configuration. An entry also records the host it was
 * seen on, so one observed before a host change is not shown for the new host.
 */
interface Observation {
  version: string;
  host: string;
  seenAt: string;
}

const observed = new Map<string, Observation>();

export function recordRouterVersion(routerId: string, host: string, version: unknown): void {
  if (typeof version !== "string" || version.length === 0) return;
  observed.set(routerId, { version, host, seenAt: new Date().toISOString() });
}

export function observedRouterVersion(routerId: string, host: string): Observation | undefined {
  const entry = observed.get(routerId);
  return entry && entry.host === host ? entry : undefined;
}

/** For tests. */
export function clearRouterObservations(): void {
  observed.clear();
}
