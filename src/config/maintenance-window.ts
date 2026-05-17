import type { MaintenanceWindow } from "../types.js";

const DAY_ABBREVS: Record<string, MaintenanceWindow["days"][number]> = {
  Sun: "Sun", Mon: "Mon", Tue: "Tue", Wed: "Wed",
  Thu: "Thu", Fri: "Fri", Sat: "Sat",
};

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
    if (!day || !w.days.includes(day)) return false;

    const hour = parts.find((p) => p.type === "hour")?.value?.padStart(2, "0") ?? "00";
    const minute = parts.find((p) => p.type === "minute")?.value?.padStart(2, "0") ?? "00";
    const currentTime = `${hour}:${minute}`;

    return w.startTime !== w.endTime && currentTime >= w.startTime && currentTime <= w.endTime;
  });
}
