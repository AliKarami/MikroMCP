import type { MaintenanceWindow } from "../types.js";

const DAY_ABBREVS: Record<string, MaintenanceWindow["days"][number]> = {
  Sun: "Sun", Mon: "Mon", Tue: "Tue", Wed: "Wed",
  Thu: "Thu", Fri: "Fri", Sat: "Sat",
};

const DAY_ORDER = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;

export function isWithinMaintenanceWindow(
  windows: MaintenanceWindow[],
  now: Date,
): boolean {
  if (windows.length === 0) return true;

  return windows.some((w) => {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: w.timezone,
      weekday: "short",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    }).formatToParts(now);

    const rawDay = parts.find((p) => p.type === "weekday")?.value ?? "";
    const day = DAY_ABBREVS[rawDay];
    if (!day) return false;

    const hour = parts.find((p) => p.type === "hour")?.value?.padStart(2, "0") ?? "00";
    const minute = parts.find((p) => p.type === "minute")?.value?.padStart(2, "0") ?? "00";
    const currentTime = `${hour}:${minute}`;

    if (w.startTime === w.endTime) return false;

    // Same-day window: the day must be listed and the time within [start, end].
    if (w.startTime < w.endTime) {
      return w.days.includes(day) && currentTime >= w.startTime && currentTime <= w.endTime;
    }

    // Overnight window (start > end): `days` names the day the window OPENS.
    // Match either the tail of the opening day (time >= start) or the head of
    // the following day (time <= end, belonging to the previous day's window).
    const prevDay = DAY_ORDER[(DAY_ORDER.indexOf(day) + 6) % 7];
    return (
      (w.days.includes(day) && currentTime >= w.startTime) ||
      (w.days.includes(prevDay) && currentTime <= w.endTime)
    );
  });
}
