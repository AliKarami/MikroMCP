import { describe, it, expect } from "vitest";
import { isWithinMaintenanceWindow } from "../../../src/config/maintenance-window.js";
import type { MaintenanceWindow } from "../../../src/types.js";

// Monday 2026-05-18 03:00 UTC = 06:00 Helsinki (EEST = UTC+3)
const MONDAY_03_UTC = new Date("2026-05-18T03:00:00.000Z");
// Monday 2026-05-18 10:00 UTC = 13:00 Helsinki
const MONDAY_10_UTC = new Date("2026-05-18T10:00:00.000Z");
// Sunday 2026-05-17 03:00 UTC = 06:00 Helsinki
const SUNDAY_03_UTC = new Date("2026-05-17T03:00:00.000Z");

const WEEKDAY_NIGHT: MaintenanceWindow = {
  days: ["Mon", "Tue", "Wed", "Thu", "Fri"],
  startTime: "02:00",
  endTime: "06:00",
  timezone: "Europe/Helsinki",
};

describe("isWithinMaintenanceWindow", () => {
  it("returns true when no windows configured", () => {
    expect(isWithinMaintenanceWindow([], MONDAY_03_UTC)).toBe(true);
  });

  it("returns true when inside a window (Mon 06:00 Helsinki)", () => {
    expect(isWithinMaintenanceWindow([WEEKDAY_NIGHT], MONDAY_03_UTC)).toBe(true);
  });

  it("returns false when outside window hours (Mon 13:00 Helsinki)", () => {
    expect(isWithinMaintenanceWindow([WEEKDAY_NIGHT], MONDAY_10_UTC)).toBe(false);
  });

  it("returns false when outside window days (Sun 06:00 Helsinki)", () => {
    expect(isWithinMaintenanceWindow([WEEKDAY_NIGHT], SUNDAY_03_UTC)).toBe(false);
  });

  it("returns true when at least one window matches", () => {
    const weekend: MaintenanceWindow = {
      days: ["Sat", "Sun"],
      startTime: "00:00",
      endTime: "23:59",
      timezone: "Europe/Helsinki",
    };
    expect(isWithinMaintenanceWindow([WEEKDAY_NIGHT, weekend], SUNDAY_03_UTC)).toBe(true);
  });

  it("returns false when startTime equals endTime (zero-length window)", () => {
    const w: MaintenanceWindow = { days: ["Mon"], startTime: "03:00", endTime: "03:00", timezone: "Europe/Helsinki" };
    expect(isWithinMaintenanceWindow([w], MONDAY_03_UTC)).toBe(false);
  });
});
