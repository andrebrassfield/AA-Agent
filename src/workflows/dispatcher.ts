import type { DataStore } from "../db/store.ts";
import { collectEnvSecrets, redactString } from "../server/redact.ts";
import type { SmsProvider } from "../types/channels.ts";
import type { ClientConfig, QuietHoursPolicy } from "../types/config.ts";
import type { ScheduledFollowUp } from "../types/db.ts";

export const DEFAULT_FOLLOWUP_TICK_MS = 15_000;

interface LocalWallClock {
  year: number;
  month: number; // 1..12
  day: number;   // 1..31
  hour: number;  // 0..23
  minute: number;
  second: number;
}

function getLocalWallClock(date: Date, timeZone: string): LocalWallClock {
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  });

  const parts = dtf.formatToParts(date);
  const lookup = (type: Intl.DateTimeFormatPartTypes): number => {
    const val = parts.find((p) => p.type === type)?.value ?? "0";
    return Number(val);
  };

  return {
    year: lookup("year"),
    month: lookup("month"),
    day: lookup("day"),
    hour: lookup("hour") % 24,
    minute: lookup("minute"),
    second: lookup("second"),
  };
}

function parseTimeToMinutes(hhmm: string): { hour: number; minute: number; totalMinutes: number } {
  const [hRaw, mRaw] = hhmm.split(":");
  const hour = Number(hRaw ?? 0);
  const minute = Number(mRaw ?? 0);
  return {
    hour,
    minute,
    totalMinutes: hour * 60 + minute,
  };
}

function localWallClockToUtcDate(
  target: { year: number; month: number; day: number; hour: number; minute: number },
  timeZone: string
): Date {
  const desiredAsUtcMs = Date.UTC(
    target.year,
    target.month - 1,
    target.day,
    target.hour,
    target.minute,
    0,
    0
  );

  let candidateMs = desiredAsUtcMs;
  for (let pass = 0; pass < 3; pass++) {
    const actual = getLocalWallClock(new Date(candidateMs), timeZone);
    const actualAsUtcMs = Date.UTC(
      actual.year,
      actual.month - 1,
      actual.day,
      actual.hour,
      actual.minute,
      actual.second,
      0
    );
    const diffMs = desiredAsUtcMs - actualAsUtcMs;
    if (diffMs === 0) break;
    candidateMs += diffMs;
  }

  return new Date(candidateMs);
}

export interface QuietHoursDecision {
  inQuietHours: boolean;
  timezone: string;
  quietHours?: QuietHoursPolicy;
  resumeAtIso?: string;
}

/**
 * Evaluates whether `now` falls within `clientConfig.policies.quietHours` in the configured timezone,
 * and computes the next allowed send timestamp (`resumeAtIso`) so due follow-ups defer instead of dropping.
 */
export function evaluateQuietHours(now: Date, clientConfig: ClientConfig): QuietHoursDecision {
  const quietHours = clientConfig.policies.quietHours;
  const timezone = quietHours?.timezone || clientConfig.business.timezone || "UTC";

  if (!quietHours) {
    return { inQuietHours: false, timezone };
  }

  const start = parseTimeToMinutes(quietHours.start);
  const end = parseTimeToMinutes(quietHours.end);
  const local = getLocalWallClock(now, timezone);
  const localMinutes = local.hour * 60 + local.minute;

  let inQuietHours = false;
  let resumeLocalDate = { year: local.year, month: local.month, day: local.day };

  if (start.totalMinutes > end.totalMinutes) {
    // Overnight window, e.g. 20:00 -> 08:00
    if (localMinutes >= start.totalMinutes) {
      inQuietHours = true;
      const tomorrowUtc = new Date(Date.UTC(local.year, local.month - 1, local.day + 1));
      resumeLocalDate = {
        year: tomorrowUtc.getUTCFullYear(),
        month: tomorrowUtc.getUTCMonth() + 1,
        day: tomorrowUtc.getUTCDate(),
      };
    } else if (localMinutes < end.totalMinutes) {
      inQuietHours = true;
    }
  } else if (start.totalMinutes < end.totalMinutes) {
    // Same-day window, e.g. 12:00 -> 13:00
    if (localMinutes >= start.totalMinutes && localMinutes < end.totalMinutes) {
      inQuietHours = true;
    }
  }

  if (!inQuietHours) {
    return { inQuietHours: false, timezone, quietHours };
  }

  let resumeDate = localWallClockToUtcDate(
    {
      ...resumeLocalDate,
      hour: end.hour,
      minute: end.minute,
    },
    timezone
  );

  // Guard against ambiguous DST fall-back boundary
  if (resumeDate.getTime() <= now.getTime()) {
    resumeDate = new Date(now.getTime() + 60_000);
  }

  return {
    inQuietHours: true,
    timezone,
    quietHours,
    resumeAtIso: resumeDate.toISOString(),
  };
}

export interface FollowUpTickResult {
  claimed: number;
  sent: number;
  deferred: number;
  skipped: number;
  failed: number;
}

export interface FollowUpDispatcherOptions {
  clientConfig: ClientConfig;
  store: DataStore;
  smsProvider: SmsProvider;
  tickIntervalMs?: number;
  batchSize?: number;
  demoMode?: boolean;
  now?: () => Date;
}

export class FollowUpDispatcher {
  private readonly clientConfig: ClientConfig;
  private readonly store: DataStore;
  private readonly smsProvider: SmsProvider;
  public readonly tickIntervalMs: number;
  private readonly batchSize: number;
  public readonly demoMode: boolean;
  private readonly nowFn: () => Date;

  private timer: ReturnType<typeof setInterval> | null = null;
  private inFlightTick: Promise<FollowUpTickResult> | null = null;

  constructor(options: FollowUpDispatcherOptions) {
    this.clientConfig = options.clientConfig;
    this.store = options.store;
    this.smsProvider = options.smsProvider;
    this.demoMode = Boolean(options.demoMode);
    this.tickIntervalMs = this.demoMode ? 0 : (options.tickIntervalMs ?? DEFAULT_FOLLOWUP_TICK_MS);
    this.batchSize = options.batchSize ?? 50;
    this.nowFn = options.now ?? (() => new Date());
  }

  get isRunning(): boolean {
    return this.timer !== null;
  }

  start(): void {
    if (this.demoMode || this.tickIntervalMs <= 0 || this.timer !== null) {
      return;
    }

    this.timer = setInterval(() => {
      void this.runTick().catch(() => {
        // Individual row errors are caught and logged inside executeTick; guard timer loop
      });
    }, this.tickIntervalMs);

    if (typeof (this.timer as { unref?: () => void }).unref === "function") {
      (this.timer as { unref: () => void }).unref();
    }
  }

  async stop(): Promise<void> {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
    if (this.inFlightTick) {
      await this.inFlightTick;
    }
  }

  async runTick(): Promise<FollowUpTickResult> {
    if (this.inFlightTick) {
      return this.inFlightTick;
    }

    this.inFlightTick = this.executeTick();
    try {
      return await this.inFlightTick;
    } finally {
      this.inFlightTick = null;
    }
  }

  private getSkipReason(item: ScheduledFollowUp): string | null {
    if (item.type === "estimate_touch" || item.entityType === "estimate") {
      const estimate = this.store.getEstimate(item.entityId);
      if (estimate && (estimate.status !== "open" || Boolean(estimate.stopReason))) {
        return estimate.stopReason || `Estimate status is "${estimate.status}"`;
      }
    }

    if (item.type === "booking_reminder") {
      const booking = this.store.getBooking(item.entityId);
      if (booking && booking.status !== "confirmed") {
        return `Booking status is "${booking.status}"`;
      }
    }

    if (item.type === "review_request") {
      const booking =
        item.entityType === "booking" ? this.store.getBooking(item.entityId) : null;
      if (booking && booking.status === "cancelled") {
        return "Booking was cancelled";
      }
      const review = this.store.getReview(item.entityId);
      if (review && (review.status === "sent" || review.status === "cancelled")) {
        return `Review status is "${review.status}"`;
      }
    }

    return null;
  }

  private async executeTick(): Promise<FollowUpTickResult> {
    const now = this.nowFn();
    const nowIso = now.toISOString();
    const claimedRows = this.store.claimDueFollowUps(nowIso, this.batchSize);

    let sent = 0;
    let deferred = 0;
    let skipped = 0;
    let failed = 0;

    if (claimedRows.length === 0) {
      return { claimed: 0, sent: 0, deferred: 0, skipped: 0, failed: 0 };
    }

    const fromNumber =
      this.clientConfig.business.phoneNumbers.sms ||
      this.clientConfig.business.phoneNumbers.main;

    for (const item of claimedRows) {
      // 1. Honor entity state (replied/stopped estimates, cancelled/rescheduled bookings, sent/cancelled reviews)
      const skipReason = this.getSkipReason(item);
      if (skipReason !== null) {
        this.store.markFollowUpCancelled(item.id);
        this.store.logAudit({
          id: this.store.generateId("aud-fup-skip"),
          action: "FOLLOWUP_SKIPPED",
          entityType: item.entityType,
          entityId: item.entityId,
          details: {
            followUpId: item.id,
            type: item.type,
            recipientPhone: item.recipientPhone,
            reason: skipReason,
          },
          timestamp: nowIso,
        });
        skipped++;
        continue;
      }

      // 2. Honor quiet hours and timezone in client policies (defer rather than drop)
      const quiet = evaluateQuietHours(now, this.clientConfig);
      if (quiet.inQuietHours && quiet.resumeAtIso) {
        this.store.deferFollowUp(item.id, quiet.resumeAtIso);
        this.store.logAudit({
          id: this.store.generateId("aud-fup-defer"),
          action: "FOLLOWUP_DEFERRED_QUIET_HOURS",
          entityType: item.entityType,
          entityId: item.entityId,
          details: {
            followUpId: item.id,
            type: item.type,
            recipientPhone: item.recipientPhone,
            previousScheduledFor: item.scheduledFor,
            deferredUntil: quiet.resumeAtIso,
            timezone: quiet.timezone,
            quietHours: quiet.quietHours,
          },
          timestamp: nowIso,
        });
        deferred++;
        continue;
      }

      // 3. Send via existing SmsProvider seam and record outcome in audit_logs
      try {
        const smsResult = await this.smsProvider.sendSms({
          to: item.recipientPhone,
          from: fromNumber,
          body: item.message,
          metadata: {
            followUpId: item.id,
            followUpType: item.type,
            entityType: item.entityType,
            entityId: item.entityId,
          },
        });

        this.store.markFollowUpSent(item.id, smsResult.timestamp || nowIso);

        if (item.type === "review_request") {
          const rev = this.store.getReview(item.entityId);
          if (rev && rev.status === "pending") {
            this.store.updateReviewStatus(item.entityId, "sent");
          }
        }

        this.store.logAudit({
          id: this.store.generateId("aud-fup-sent"),
          action: "FOLLOWUP_DISPATCHED",
          entityType: item.entityType,
          entityId: item.entityId,
          details: {
            followUpId: item.id,
            type: item.type,
            recipientPhone: item.recipientPhone,
            smsProvider: this.smsProvider.name,
            smsMessageId: smsResult.messageId,
            message: item.message,
            guardrailBypassReason: "one_to_one_operational_flow",
          },
          timestamp: nowIso,
        });
        sent++;
      } catch (err: unknown) {
        const rawErr = err instanceof Error ? err.message : String(err);
        const safeErr = redactString(rawErr, collectEnvSecrets());
        this.store.markFollowUpFailed(item.id, safeErr);
        this.store.logAudit({
          id: this.store.generateId("aud-fup-err"),
          action: "FOLLOWUP_DISPATCH_FAILED",
          entityType: item.entityType,
          entityId: item.entityId,
          details: {
            followUpId: item.id,
            type: item.type,
            recipientPhone: item.recipientPhone,
            error: safeErr,
          },
          timestamp: nowIso,
        });
        failed++;
      }
    }

    return {
      claimed: claimedRows.length,
      sent,
      deferred,
      skipped,
      failed,
    };
  }
}
