/**
 * Slot generation and route ranking (v1).
 *
 * Ranking model: for a tech's day, existing appointments are stops anchored by
 * the home base at both ends of the day. Inserting a new stop between prev and
 * next adds detour miles = d(prev,new) + d(new,next) - d(prev,next). Slots are
 * ranked by ADDED drive minutes (haversine at avgSpeedMph), ascending, ties by
 * earlier start. A candidate is only feasible if the schedule gaps between
 * adjacent real stops can absorb the drive plus the configured drive-time
 * buffer. Home-base anchors have no gap constraint (start/end of day are
 * flexible within business hours).
 */

import type { ClientConfig, ServiceItem, StaffMember } from "../types/config.ts";
import {
  driveMinutes,
  haversineMiles,
  localDayMinuteToUtc,
  localWeekdayOf,
  type LatLng,
  parseHHMM,
} from "./geo.ts";

export interface RouteStop {
  startTime: string; // ISO
  endTime: string; // ISO
  latLng: LatLng | null; // null when the stop address could not be geocoded
  label?: string;
}

export interface SlotOffer {
  startTime: string; // exact ISO start, never a window
  endTime: string;
  techId: string;
  /** Haversine-based added drive minutes for inserting at this slot. Absent in fallback mode. */
  addedDriveMinutes?: number;
}

export interface DayWindow {
  day: string; // YYYY-MM-DD local
  openMin: number;
  closeMin: number;
}

/** Detour miles of inserting newStop between prev and next (null = home anchor). */
export function insertionDetourMiles(prev: LatLng | null, newStop: LatLng, next: LatLng | null): number {
  const dPrevNew = prev ? haversineMiles(prev, newStop) : 0;
  const dNewNext = next ? haversineMiles(newStop, next) : 0;
  const dPrevNext = prev && next ? haversineMiles(prev, next) : 0;
  return Math.max(0, dPrevNew + dNewNext - dPrevNext);
}

export function dayWindowsForHorizon(
  config: ClientConfig,
  staff: StaffMember | undefined,
  startDay: string,
  horizonDays: number,
  tz: string
): DayWindow[] {
  const windows: DayWindow[] = [];
  const [y, m, d] = startDay.split("-").map(Number);
  for (let i = 0; i < horizonDays; i++) {
    const date = new Date(Date.UTC(y, m - 1, d + i, 12, 0, 0));
    const day = `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}-${String(date.getUTCDate()).padStart(2, "0")}`;
    const weekday = localWeekdayOf(day, tz);
    const hours = (config.business.hours as Record<string, { open: string; close: string; closed?: boolean }>)[weekday];
    if (!hours || hours.closed) continue;
    let openMin = parseHHMM(hours.open);
    let closeMin = parseHHMM(hours.close);
    const sched = staff?.schedule?.[weekday];
    if (sched && !sched.off) {
      openMin = Math.max(openMin, parseHHMM(sched.start));
      closeMin = Math.min(closeMin, parseHHMM(sched.end));
    }
    if (closeMin - openMin > 0) windows.push({ day, openMin, closeMin });
  }
  return windows;
}

/** Candidate start instants for a day window, stepping from open, block must end by close. */
export function candidateStarts(win: DayWindow, blockMin: number, stepMin: number, tz: string): Date[] {
  const out: Date[] = [];
  for (let min = win.openMin; min + blockMin <= win.closeMin; min += stepMin) {
    out.push(localDayMinuteToUtc(win.day, min, tz));
  }
  return out;
}

export interface CandidateEvaluation {
  feasible: boolean;
  addedDriveMinutes: number; // rounded up; estimate only
}

/**
 * Evaluate inserting a stop at candidateStart. Stops without coordinates are
 * ignored for geometry (never invented) but still block time via calendar
 * availability upstream.
 */
export function evaluateCandidate(
  candidateStart: Date,
  blockMin: number,
  stops: RouteStop[],
  home: LatLng,
  customer: LatLng,
  avgSpeedMph: number,
  bufferMin: number
): CandidateEvaluation {
  const start = candidateStart.getTime();
  const end = start + blockMin * 60_000;
  const sorted = [...stops].sort((a, b) => a.startTime.localeCompare(b.startTime));
  let pos = 0;
  while (pos < sorted.length && new Date(sorted[pos].startTime).getTime() <= start) pos++;
  const prev = pos > 0 ? sorted[pos - 1] : null;
  const next = pos < sorted.length ? sorted[pos] : null;

  const prevLoc = prev?.latLng ?? home;
  const nextLoc = next?.latLng ?? home;
  const detourMiles = insertionDetourMiles(prevLoc, customer, nextLoc);
  const added = driveMinutes(detourMiles, avgSpeedMph);

  if (prev?.latLng) {
    const gapBeforeMin = (start - new Date(prev.endTime).getTime()) / 60_000;
    const drivePrevNew = driveMinutes(haversineMiles(prev.latLng, customer), avgSpeedMph);
    if (gapBeforeMin < drivePrevNew + bufferMin) {
      return { feasible: false, addedDriveMinutes: Math.ceil(added) };
    }
  }
  if (next?.latLng) {
    const gapAfterMin = (new Date(next.startTime).getTime() - end) / 60_000;
    const driveNewNext = driveMinutes(haversineMiles(customer, next.latLng), avgSpeedMph);
    if (gapAfterMin < driveNewNext + bufferMin) {
      return { feasible: false, addedDriveMinutes: Math.ceil(added) };
    }
  }
  return { feasible: true, addedDriveMinutes: Math.ceil(added) };
}

/** Block minutes a booking occupies: service duration plus buffer. */
export function blockMinutesFor(service: ServiceItem): number {
  return service.durationMinutes + (service.bufferMinutes || 0);
}
