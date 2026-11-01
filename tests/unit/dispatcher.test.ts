import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StubSmsProvider } from "../../src/channels/sms/stub.ts";
import { startServe } from "../../src/cli/serve.ts";
import { writeClientConfig } from "../../src/config/loader.ts";
import { DataStore } from "../../src/db/store.ts";
import { FORT_SMITH_HVAC_CONFIG } from "../../src/demo/shop_data.ts";
import { FollowUpDispatcher } from "../../src/workflows/dispatcher.ts";
import {
  scheduleEstimateFollowUps,
  stopOpenEstimatesForCustomerReply,
} from "../../src/workflows/estimate.ts";

describe("FollowUpDispatcher", () => {
  let store: DataStore;
  let sms: StubSmsProvider;

  beforeEach(() => {
    store = new DataStore(":memory:");
    sms = new StubSmsProvider();
  });

  afterEach(() => {
    store.close();
  });

  it("dispatches a due follow-up exactly once, records outcome in audit_logs, and sends nothing for cancelled bookings", async () => {
    const now = new Date("2026-11-02T16:00:00.000Z"); // 10:00 AM America/Chicago

    const confirmedId = store.createBooking({
      id: "bk-confirmed-1",
      customerName: "Marcus Vance",
      customerPhone: "+14795551100",
      serviceId: "ac-tuneup",
      serviceName: "AC Tune-Up & Precision Inspection",
      startTime: "2026-11-02T18:00:00.000Z",
      endTime: "2026-11-02T19:15:00.000Z",
      status: "confirmed",
    });

    const cancelledId = store.createBooking({
      id: "bk-cancelled-1",
      customerName: "Dana K.",
      customerPhone: "+14795552200",
      serviceId: "ac-tuneup",
      serviceName: "AC Tune-Up & Precision Inspection",
      startTime: "2026-11-02T18:00:00.000Z",
      endTime: "2026-11-02T19:15:00.000Z",
      status: "cancelled",
    });

    const dueFupId = store.scheduleFollowUp({
      type: "booking_reminder",
      entityType: "booking",
      entityId: confirmedId,
      recipientPhone: "+14795551100",
      message: "Reminder: Your AC Tune-Up is in 2 hours.",
      scheduledFor: "2026-11-02T15:55:00.000Z",
      status: "pending",
    });

    const cancelledFupId = store.scheduleFollowUp({
      type: "booking_reminder",
      entityType: "booking",
      entityId: cancelledId,
      recipientPhone: "+14795552200",
      message: "Reminder for cancelled booking (must never send).",
      scheduledFor: "2026-11-02T15:55:00.000Z",
      status: "pending",
    });

    const futureFupId = store.scheduleFollowUp({
      type: "booking_reminder",
      entityType: "booking",
      entityId: confirmedId,
      recipientPhone: "+14795551100",
      message: "Future reminder not yet due.",
      scheduledFor: "2026-11-03T16:00:00.000Z",
      status: "pending",
    });

    const dispatcher = new FollowUpDispatcher({
      clientConfig: FORT_SMITH_HVAC_CONFIG,
      store,
      smsProvider: sms,
      now: () => now,
    });

    const firstTick = await dispatcher.runTick();
    expect(firstTick).toEqual({
      claimed: 2,
      sent: 1,
      deferred: 0,
      skipped: 1,
      failed: 0,
    });

    expect(sms.sentMessages.length).toBe(1);
    expect(sms.sentMessages[0]!.to).toBe("+14795551100");
    expect(sms.sentMessages[0]!.body).toContain("AC Tune-Up is in 2 hours");

    expect(store.getFollowUp(dueFupId)?.status).toBe("sent");
    expect(store.getFollowUp(cancelledFupId)?.status).toBe("cancelled");
    expect(store.getFollowUp(futureFupId)?.status).toBe("pending");

    // Second tick at the same timestamp must send nothing (exactly-once delivery)
    const secondTick = await dispatcher.runTick();
    expect(secondTick.claimed).toBe(0);
    expect(secondTick.sent).toBe(0);
    expect(sms.sentMessages.length).toBe(1);

    const audits = store.listAuditLogs();
    expect(audits.some((a) => a.action === "FOLLOWUP_DISPATCHED" && a.details.followUpId === dueFupId)).toBe(true);
    expect(audits.some((a) => a.action === "FOLLOWUP_SKIPPED" && a.details.followUpId === cancelledFupId)).toBe(true);
  });

  it("sends nothing for an estimate whose customer replied or whose touches were stopped", async () => {
    const baseTime = new Date("2026-11-01T15:00:00.000Z");

    // Case A: Customer replies via SMS, cancelling pending follow-ups
    const repliedEstId = store.createEstimate({
      id: "est-replied-1",
      customerName: "Sarah Miller",
      customerPhone: "+14795558831",
      amount: 6850,
      status: "open",
      touchesSent: "[]",
      createdAt: baseTime.toISOString(),
    });
    scheduleEstimateFollowUps(repliedEstId, FORT_SMITH_HVAC_CONFIG, store, "HVAC replacement", baseTime);
    stopOpenEstimatesForCustomerReply("+14795558831", "sms", store);

    // Case B: Estimate has stopReason / non-open state directly on estimates row while follow-up row is still pending
    const stoppedEstId = store.createEstimate({
      id: "est-stopped-2",
      customerName: "Tom Henderson",
      customerPhone: "+14795558832",
      amount: 4200,
      status: "closed",
      stopReason: "Owner paused touches manually",
      touchesSent: "[]",
      createdAt: baseTime.toISOString(),
    });
    const lingeringTouchId = store.scheduleFollowUp({
      type: "estimate_touch",
      entityType: "estimate",
      entityId: stoppedEstId,
      recipientPhone: "+14795558832",
      message: "Checking in on your quote",
      scheduledFor: "2026-11-03T15:00:00.000Z",
      status: "pending",
    });

    // Advance clock past day 10 so every touch window is in the past
    const day12 = new Date("2026-11-13T16:00:00.000Z");
    const dispatcher = new FollowUpDispatcher({
      clientConfig: FORT_SMITH_HVAC_CONFIG,
      store,
      smsProvider: sms,
      now: () => day12,
    });

    const tick = await dispatcher.runTick();
    expect(tick.sent).toBe(0);
    expect(tick.skipped).toBe(1);
    expect(sms.sentMessages.length).toBe(0);
    expect(store.getFollowUp(lingeringTouchId)?.status).toBe("cancelled");
  });

  it("does not resend a claimed item after a mid-tick process restart", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "aabook-restart-claim-"));
    const dbPath = join(tempDir, "aabook.sqlite");

    try {
      const storeBeforeCrash = new DataStore(dbPath);
      const claimedItemId = storeBeforeCrash.scheduleFollowUp({
        type: "booking_reminder",
        entityType: "booking",
        entityId: "bk-inflight",
        recipientPhone: "+14795553300",
        message: "In-flight reminder claimed before crash",
        scheduledFor: "2026-11-02T14:00:00.000Z",
        status: "pending",
      });
      const freshItemId = storeBeforeCrash.scheduleFollowUp({
        type: "booking_reminder",
        entityType: "booking",
        entityId: "bk-fresh",
        recipientPhone: "+14795553301",
        message: "Unclaimed pending reminder due after restart",
        scheduledFor: "2026-11-02T15:00:00.000Z",
        status: "pending",
      });

      // Process 1 claims the first due item at 14:30 UTC, then crashes before marking sent
      const claimed = storeBeforeCrash.claimDueFollowUps("2026-11-02T14:30:00.000Z", 10);
      expect(claimed.map((r) => r.id)).toEqual([claimedItemId]);
      expect(storeBeforeCrash.getFollowUp(claimedItemId)?.status).toBe("claimed");
      storeBeforeCrash.close();

      // Process 2 boots against the same SQLite file at 15:30 UTC
      const storeAfterRestart = new DataStore(dbPath);
      try {
        const restartSms = new StubSmsProvider();
        const restartedDispatcher = new FollowUpDispatcher({
          clientConfig: FORT_SMITH_HVAC_CONFIG,
          store: storeAfterRestart,
          smsProvider: restartSms,
          now: () => new Date("2026-11-02T15:30:00.000Z"),
        });

        const tick = await restartedDispatcher.runTick();
        expect(tick.claimed).toBe(1);
        expect(tick.sent).toBe(1);

        // Only the unclaimed pending item was sent; the previously claimed item was never double-sent
        expect(restartSms.sentMessages.length).toBe(1);
        expect(restartSms.sentMessages[0]!.to).toBe("+14795553301");
        expect(storeAfterRestart.getFollowUp(claimedItemId)?.status).toBe("claimed");
        expect(storeAfterRestart.getFollowUp(freshItemId)?.status).toBe("sent");
      } finally {
        storeAfterRestart.close();
      }
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("defers due follow-ups during client quiet hours in the policy timezone and sends once quiet hours end", async () => {
    const configWithQuietHours = {
      ...FORT_SMITH_HVAC_CONFIG,
      policies: {
        ...FORT_SMITH_HVAC_CONFIG.policies,
        quietHours: {
          start: "20:00", // 8:00 PM America/Chicago
          end: "08:00",   // 8:00 AM America/Chicago
          timezone: "America/Chicago",
        },
      },
    };

    // 2026-11-03T03:30:00.000Z == Monday 2026-11-02 21:30:00 CST (inside 20:00–08:00 quiet hours)
    let currentTime = new Date("2026-11-03T03:30:00.000Z");

    const fupId = store.scheduleFollowUp({
      type: "review_request",
      entityType: "booking",
      entityId: "bk-completed-quiet",
      recipientPhone: "+14795554400",
      message: "Thanks for choosing Fort Smith Heating & Air! Leave a review: https://example.com/review",
      scheduledFor: "2026-11-03T03:00:00.000Z",
      status: "pending",
    });

    const dispatcher = new FollowUpDispatcher({
      clientConfig: configWithQuietHours,
      store,
      smsProvider: sms,
      now: () => currentTime,
    });

    // Tick during quiet hours: defers to 08:00 AM CST (2026-11-03T14:00:00.000Z) instead of dropping or sending
    const nightTick = await dispatcher.runTick();
    expect(nightTick).toEqual({
      claimed: 1,
      sent: 0,
      deferred: 1,
      skipped: 0,
      failed: 0,
    });
    expect(sms.sentMessages.length).toBe(0);

    const deferredRow = store.getFollowUp(fupId);
    expect(deferredRow?.status).toBe("pending");
    expect(deferredRow?.scheduledFor).toBe("2026-11-03T14:00:00.000Z");

    const deferAudits = store
      .listAuditLogs()
      .filter((a) => a.action === "FOLLOWUP_DEFERRED_QUIET_HOURS");
    expect(deferAudits.length).toBe(1);
    expect(deferAudits[0]!.details.deferredUntil).toBe("2026-11-03T14:00:00.000Z");

    // Advance clock past 08:00 AM CST (to 08:05 AM CST == 14:05 UTC): item dispatches cleanly
    currentTime = new Date("2026-11-03T14:05:00.000Z");
    const morningTick = await dispatcher.runTick();
    expect(morningTick.sent).toBe(1);
    expect(sms.sentMessages.length).toBe(1);
    expect(store.getFollowUp(fupId)?.status).toBe("sent");
  });

  it("runs configurable tick loop inside aabook serve with live HTTP provider and disables timer in demo mode", async () => {
    const demoDispatcher = new FollowUpDispatcher({
      clientConfig: FORT_SMITH_HVAC_CONFIG,
      store,
      smsProvider: sms,
      tickIntervalMs: 50,
      demoMode: true,
    });
    demoDispatcher.start();
    expect(demoDispatcher.isRunning).toBe(false);
    expect(demoDispatcher.tickIntervalMs).toBe(0);

    const tempDir = mkdtempSync(join(tmpdir(), "aabook-serve-dispatch-"));
    const clientDir = join(tempDir, "client");
    const dataDir = join(tempDir, "data");
    const prevKey = process.env.OPENAI_API_KEY;
    process.env.OPENAI_API_KEY = "sk-test-serve-live-provider-123456";

    // Wednesday 2026-11-04 15:00 UTC is within business hours; booking at 15:00 UTC -> 24h reminder is already due
    const bookingSlotIso = "2026-11-04T15:00:00.000Z";
    const nowAtTest = new Date("2026-11-04T12:00:00.000Z");

    const fakeModelServer = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      async fetch() {
        return Response.json({
          id: "chatcmpl-serve-1",
          model: "gpt-4o-mini",
          choices: [
            {
              index: 0,
              message: {
                role: "assistant",
                content: `Booking confirmed!\n<tool_call>{"name":"manageBooking","args":{"action":"create","input":{"customerName":"Nora Bell","customerPhone":"+14795556677","serviceId":"ac-tuneup","requestedStartTime":"${bookingSlotIso}"}}}</tool_call>`,
              },
            },
          ],
          usage: {
            prompt_tokens: 95,
            completion_tokens: 42,
          },
        });
      },
    });

    try {
      const stubSms = new StubSmsProvider();
      writeClientConfig(clientDir, {
        ...FORT_SMITH_HVAC_CONFIG,
        router: {
          providers: {
            openai: {
              kind: "openai-compatible",
              baseUrl: `http://127.0.0.1:${fakeModelServer.port}/v1`,
              envVar: "OPENAI_API_KEY",
            },
          },
          routes: {
            conversation: { chain: [{ provider: "openai", model: "gpt-4o-mini" }] },
            reasoning: { chain: [{ provider: "openai", model: "gpt-4o-mini" }] },
            aux: { chain: [{ provider: "openai", model: "gpt-4o-mini" }] },
          },
        },
      });

      const handle = await startServe({
        port: 0,
        clientDir,
        dataDir,
        webhookSecret: "serve-dispatch-test-secret",
        followUpTickMs: 40,
        now: () => nowAtTest,
        smsProvider: stubSms,
        waitForSignal: false,
      });

      try {
        expect(handle.dispatcher.isRunning).toBe(true);

        // 1. Simulate missed call -> text-back greeting SMS (#1)
        const missedRes = await fetch(`${handle.server.url}/webhooks/voice`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-webhook-secret": "serve-dispatch-test-secret",
          },
          body: JSON.stringify({
            event: "call_ended",
            call: {
              call_id: "retell_serve_smoke_01",
              from_number: "+14795556677",
              to_number: "+14795550100",
              direction: "inbound",
              disconnection_reason: "dial_no_answer",
              duration_ms: 0,
            },
          }),
        });
        expect(missedRes.status).toBe(200);
        expect(stubSms.sentMessages.length).toBe(1);

        // 2. Caller replies via SMS -> hits fake HTTP provider -> creates booking (#2 confirmation SMS) + schedules 2 reminders (24h due now, 2h at 13:00 UTC)
        const smsRes = await fetch(`${handle.server.url}/webhooks/sms`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-webhook-secret": "serve-dispatch-test-secret",
          },
          body: JSON.stringify({
            messageId: "sms-in-serve-01",
            from: "+14795556677",
            to: "+14795550100",
            body: "Hi Nora Bell here, book an AC Tune-Up for 3 PM please.",
          }),
        });
        expect(smsRes.status).toBe(200);

        // Wait for background tick to claim and dispatch the due 24h reminder (#3 reminder SMS)
        for (let i = 0; i < 20 && stubSms.sentMessages.length < 3; i++) {
          await Bun.sleep(25);
        }

        expect(stubSms.sentMessages.length).toBe(3);
        expect(stubSms.sentMessages[2]!.body).toContain("Reminder:");

        const followUps = handle.store.listFollowUps();
        expect(followUps.length).toBe(2);
        expect(followUps.filter((f) => f.status === "sent").length).toBe(1);
        expect(followUps.filter((f) => f.status === "pending").length).toBe(1);

        const usage = handle.store.listModelUsage();
        expect(usage.length).toBe(1);
        expect(usage[0]!.provider).toBe("openai");
        expect(usage[0]!.promptTokens).toBe(95);
        expect(usage[0]!.completionTokens).toBe(42);
      } finally {
        await handle.shutdown();
      }
    } finally {
      fakeModelServer.stop(true);
      if (prevKey === undefined) {
        delete process.env.OPENAI_API_KEY;
      } else {
        process.env.OPENAI_API_KEY = prevKey;
      }
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
