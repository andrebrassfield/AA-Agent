import { describe, it, expect } from "bun:test";
import { runDemo } from "../../src/demo/runner.ts";
import { FakeCalendar } from "../../src/calendar/calendar.ts";

describe("Demo Runner & Workflows", () => {
  it("runs the full demo mode without errors and logs all 4 workflows", async () => {
    const result = await runDemo(false);
    expect(result.success).toBe(true);
    expect(result.transcript.length).toBeGreaterThan(15);

    // Verify transcript includes the Fort Smith HVAC shop
    const transcriptText = result.transcript.join("\n");
    expect(transcriptText).toContain("Fort Smith Heating & Air");
    expect(transcriptText).toContain("[WORKFLOW 1/4] Missed-Call Text-Back");
    expect(transcriptText).toContain("[WORKFLOW 2/4] Service Booking & Calendar Scheduling");
    expect(transcriptText).toContain("[WORKFLOW 3/4] Estimate Follow-up Touches");
    expect(transcriptText).toContain("[WORKFLOW 4/4] Review Request After Completed Job");

    // Verify audit log has recorded the actions
    expect(result.auditLog.length).toBeGreaterThanOrEqual(4);
    const actions = (result.auditLog as { action: string }[]).map((a) => a.action);
    expect(actions).toContain("MISSED_CALL_TEXT_BACK_SENT");
    expect(actions).toContain("BOOKING_CONFIRMED");
    expect(actions).toContain("ESTIMATE_TOUCH_DAY_2");
    expect(actions).toContain("ESTIMATE_TOUCH_STOPPED");
    expect(actions).toContain("REVIEW_REQUEST_SENT");
  });

  it("FakeCalendar rejects conflicting booking times", async () => {
    const calendar = new FakeCalendar();
    const start = "2026-11-01T10:00:00.000Z";
    const end = "2026-11-01T11:00:00.000Z";

    await calendar.createEvent({
      id: "ev1",
      title: "Existing Appointment",
      startTime: start,
      endTime: end,
    });

    const isAvailable = await calendar.checkAvailability("2026-11-01T10:30:00.000Z", "2026-11-01T11:30:00.000Z");
    expect(isAvailable).toBe(false);

    expect(
      calendar.createEvent({
        id: "ev2",
        title: "Conflicting Appointment",
        startTime: "2026-11-01T10:30:00.000Z",
        endTime: "2026-11-01T11:30:00.000Z",
      })
    ).rejects.toThrow("not available");
  });
});
