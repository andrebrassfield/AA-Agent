import fs from 'fs';

let content = fs.readFileSync('src/demo/runner.ts', 'utf-8');

const extendDemoCode = `
  // --- Workflow 2b: Booking Reschedule (Demo Extension) ---
  log("");
  log("---------------------------------------------------------------");
  log("[WORKFLOW 2b/4] Service Booking Reschedule (In-Hours)");
  log("---------------------------------------------------------------");

  const tomorrowOnePm = new Date(tomorrowTenAm.getTime() + 3 * 3600 * 1000);

  const rescheduleEngineTurn = await engine.processTurn({
    userMessage: \`Actually, can we push that AC Tune-Up to 1 PM tomorrow instead? My booking is \${bookingResult.booking.id}.\`,
    context: {
      clientConfig: FORT_SMITH_HVAC_CONFIG,
      channel: "sms",
      senderPhone: callerNumber,
    },
    conversationHistory: [],
  });

  let rescheduledBookingResult: any;
  if (rescheduleEngineTurn.actionTaken?.type === "TOOL_CALL" && rescheduleEngineTurn.actionTaken?.details?.name === "manageBooking") {
    const args = rescheduleEngineTurn.actionTaken.details.args as any;
    log(\`[ENGINE] Output Tool Call: \${JSON.stringify(args)}\`);

    rescheduledBookingResult = await handleBookingWorkflow(
      {
        action: "reschedule",
        bookingId: args.bookingId || bookingResult.booking.id, // Fallback if LLM misses it
        requestedStartTime: tomorrowOnePm.toISOString(),
      },
      FORT_SMITH_HVAC_CONFIG,
      calendar,
      store
    );

    if (!rescheduledBookingResult.success || !rescheduledBookingResult.booking) {
      throw new Error(\`Reschedule failed: \${rescheduledBookingResult.error}\`);
    }

    log(\`[CALENDAR] Event rescheduled.\`);
    log(\`[BOOKING RESCHEDULED] ID: \${rescheduledBookingResult.booking.id} | Status: \${rescheduledBookingResult.booking.status}\`);
    log(\`[AGENT -> SMS Confirmation]: "\${rescheduledBookingResult.confirmationSms}"\`);
  } else {
    throw new Error("CoreEngine failed to emit the expected manageBooking tool call for reschedule.");
  }

  // Re-assign main variable so workflow 4 picks up the new booking ID
  bookingResult = rescheduledBookingResult;

  // --- Workflow 2c: Booking Rejection (After-Hours) ---
  log("");
  log("---------------------------------------------------------------");
  log("[WORKFLOW 2c/4] Service Booking Rejection (After-Hours)");
  log("---------------------------------------------------------------");
  const nightTime = new Date(tomorrowTenAm.getTime());
  nightTime.setUTCHours(23, 0, 0, 0); // 11 PM UTC (definitely closed)

  const afterHoursResult = await handleBookingWorkflow(
    {
      action: "create",
      customerName: "Night Owl",
      customerPhone: "+15550009999",
      serviceId: "ac-tuneup",
      requestedStartTime: nightTime.toISOString(),
    },
    FORT_SMITH_HVAC_CONFIG,
    calendar,
    store
  );

  log(\`[SYSTEM] After-hours request returned success: \${afterHoursResult.success}. Error: \${afterHoursResult.error}\`);
  if (afterHoursResult.success) {
    throw new Error("System failed to reject after-hours booking request.");
  }

  // --- Workflow 3: Estimate Follow-Up ---`;

content = content.replace(
  `  // --- Workflow 3: Estimate Follow-Up ---`,
  extendDemoCode
);

fs.writeFileSync('src/demo/runner.ts', content);
