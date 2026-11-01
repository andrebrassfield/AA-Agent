import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { DataStore } from "../../src/db/store.ts";
import type { Booking, CallLog, AuditLogEntry, ModelUsageLog } from "../../src/types/db.ts";

describe("Local Data Store (SQLite)", () => {
  let store: DataStore;

  beforeEach(() => {
    store = new DataStore(":memory:");
  });

  afterEach(() => {
    store.close();
  });

  it("creates and retrieves bookings", () => {
    const booking: Booking = {
      id: "b-001",
      customerName: "Jane Doe",
      customerPhone: "+14795550199",
      serviceId: "ac-tuneup",
      serviceName: "AC Tune-Up & Inspection",
      startTime: "2026-11-01T10:00:00Z",
      endTime: "2026-11-01T11:00:00Z",
      status: "confirmed",
      createdAt: new Date().toISOString(),
    };

    store.createBooking(booking);
    const found = store.getBooking("b-001");
    expect(found).not.toBeNull();
    expect(found?.customerName).toBe("Jane Doe");

    store.updateBookingStatus("b-001", "completed");
    const updated = store.getBooking("b-001");
    expect(updated?.status).toBe("completed");
  });

  it("logs calls and fetches call history", () => {
    const log: CallLog = {
      id: "call-1",
      callerPhone: "+14795550188",
      direction: "inbound",
      status: "missed",
      durationSeconds: 0,
      summary: "Missed call during business hours",
      timestamp: new Date().toISOString(),
    };

    store.logCall(log);
    const logs = store.listCallLogs();
    expect(logs.length).toBe(1);
    expect(logs[0].callerPhone).toBe("+14795550188");
    expect(logs[0].status).toBe("missed");
  });

  it("stores and retrieves audit log entries with JSON details", () => {
    const entry: AuditLogEntry = {
      id: "audit-1",
      action: "MISSED_CALL_TEXT_BACK",
      entityType: "call",
      entityId: "call-1",
      details: { text: "Hey! We missed your call.", phone: "+14795550188" },
      timestamp: new Date().toISOString(),
    };

    store.logAudit(entry);
    const auditLogs = store.listAuditLogs();
    expect(auditLogs.length).toBe(1);
    expect(auditLogs[0].action).toBe("MISSED_CALL_TEXT_BACK");
    expect(auditLogs[0].details.text).toBe("Hey! We missed your call.");
  });

  it("tracks model usage and calculates daily spend", () => {
    const today = new Date().toISOString().substring(0, 10);
    const usage1: ModelUsageLog = {
      id: "u-1",
      provider: "openrouter",
      model: "google/gemini-flash",
      taskClass: "conversation",
      promptTokens: 150,
      completionTokens: 50,
      costUsd: 0.005,
      timestamp: `${today}T10:00:00Z`,
    };
    const usage2: ModelUsageLog = {
      id: "u-2",
      provider: "nvidia-nim",
      model: "meta/llama-3-8b",
      taskClass: "aux",
      promptTokens: 80,
      completionTokens: 20,
      costUsd: 0.001,
      timestamp: `${today}T11:00:00Z`,
    };

    store.logModelUsage(usage1);
    store.logModelUsage(usage2);

    const spend = store.getTodaySpend(today);
    expect(spend).toBeCloseTo(0.006, 4);
  });

  it("mints collision-free IDs under a tight-loop audit write burst", () => {
    const count = 500;
    const returnedIds = new Set<string>();

    for (let i = 0; i < count; i++) {
      const id = store.logAudit({
        action: "TIGHT_LOOP_TEST",
        entityType: "audit_burst",
        entityId: `item-${i}`,
        details: { iteration: i },
      });
      returnedIds.add(id);
    }

    const storedLogs = store.listAuditLogs();
    expect(storedLogs.length).toBe(count);
    expect(returnedIds.size).toBe(count);

    const storedIds = new Set(storedLogs.map((entry) => entry.id));
    expect(storedIds.size).toBe(count);

    // Also verify helper mints unique prefixed IDs across other entity inserts
    const bookingId = store.createBooking({
      customerName: "Burst Customer",
      customerPhone: "+14795550177",
      serviceId: "ac-tuneup",
      serviceName: "AC Tune-Up",
      startTime: "2026-11-02T10:00:00Z",
      endTime: "2026-11-02T11:00:00Z",
      status: "confirmed",
    });
    const estimateId = store.createEstimate({
      customerName: "Burst Customer",
      customerPhone: "+14795550177",
      amount: 1200,
      status: "open",
      touchesSent: "[]",
    });
    const reviewId = store.createReview({
      bookingId,
      bookingLink: "https://example.com/review",
      sendAt: "2026-11-02T14:00:00Z",
      status: "pending",
    });
    const usageId = store.logModelUsage({
      provider: "stub",
      model: "stub-aux",
      taskClass: "aux",
      promptTokens: 10,
      completionTokens: 5,
      costUsd: 0.0001,
    });

    expect(bookingId.startsWith("bk-")).toBe(true);
    expect(estimateId.startsWith("est-")).toBe(true);
    expect(reviewId.startsWith("rev-")).toBe(true);
    expect(usageId.startsWith("mu-")).toBe(true);
  });
});
