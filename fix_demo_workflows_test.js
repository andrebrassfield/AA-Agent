import fs from 'fs';

let content = fs.readFileSync('tests/unit/demo_workflows.test.ts', 'utf-8');

const additionalTests = `
  it("manageBooking respects business hours for creation and rescheduling", async () => {
    const store = new DataStore(":memory:");
    const calendar = new FakeCalendar();
    const config = FORT_SMITH_HVAC_CONFIG;

    // Create out of hours (Fort Smith closes at 17:00, let's try 20:00 UTC representing night time depending on offset but purely mechanically checking hours)
    // Fort Smith mock config sets mon: { open: "08:00", close: "17:00" }
    // Note: JS Date getUTCDay() for 2026-11-02T20:00:00.000Z is a Monday, hours are 20, > 17, so it should fail.

    const outOfHoursRes = await handleBookingWorkflow(
      {
        action: "create",
        customerName: "Late Night",
        customerPhone: "+15555555555",
        serviceId: "ac-tuneup",
        requestedStartTime: "2026-11-02T20:00:00.000Z" // 8 PM UTC
      },
      config,
      calendar,
      store
    );
    expect(outOfHoursRes.success).toBe(false);
    expect(outOfHoursRes.error).toContain("outside business hours");

    // Success case
    const successRes = await handleBookingWorkflow(
      {
        action: "create",
        customerName: "In Hours",
        customerPhone: "+15555555555",
        serviceId: "ac-tuneup",
        requestedStartTime: "2026-11-02T10:00:00.000Z" // 10 AM UTC
      },
      config,
      calendar,
      store
    );
    expect(successRes.success).toBe(true);

    // Reschedule out of hours
    const rescheduleFailRes = await handleBookingWorkflow(
      {
        action: "reschedule",
        bookingId: successRes.booking!.id,
        requestedStartTime: "2026-11-02T20:00:00.000Z"
      },
      config,
      calendar,
      store
    );
    expect(rescheduleFailRes.success).toBe(false);
    expect(rescheduleFailRes.error).toContain("outside business hours");

    // Reschedule valid
    const rescheduleSuccessRes = await handleBookingWorkflow(
      {
        action: "reschedule",
        bookingId: successRes.booking!.id,
        requestedStartTime: "2026-11-02T14:00:00.000Z"
      },
      config,
      calendar,
      store
    );
    expect(rescheduleSuccessRes.success).toBe(true);
    expect(rescheduleSuccessRes.booking?.status).toBe("confirmed");

    // Cancel
    const cancelRes = await handleBookingWorkflow(
      {
        action: "cancel",
        bookingId: rescheduleSuccessRes.booking!.id
      },
      config,
      calendar,
      store
    );
    expect(cancelRes.success).toBe(true);
    expect(cancelRes.booking?.status).toBe("cancelled");
  });
`;

content = content.replace(
  `import { FakeCalendar } from "../../src/calendar/calendar.ts";`,
  `import { FakeCalendar } from "../../src/calendar/calendar.ts";\nimport { handleBookingWorkflow } from "../../src/workflows/booking.ts";\nimport { FORT_SMITH_HVAC_CONFIG } from "../../src/demo/shop_data.ts";\nimport { DataStore } from "../../src/db/store.ts";`
);

content = content.replace(
  `  it("FakeCalendar rejects conflicting booking times", async () => {`,
  additionalTests + `\n  it("FakeCalendar rejects conflicting booking times", async () => {`
);

fs.writeFileSync('tests/unit/demo_workflows.test.ts', content);
