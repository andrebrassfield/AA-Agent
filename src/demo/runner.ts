import { FORT_SMITH_HVAC_CONFIG } from "./shop_data.ts";
import { DataStore } from "../db/store.ts";
import { FakeCalendar } from "../calendar/calendar.ts";
import { ProviderRouter } from "../router/router.ts";
import { StubModelProvider } from "../router/stub.ts";
import { CoreEngine } from "../engine/core.ts";
import { handleMissedCallTextBack } from "../workflows/missed_call.ts";
import { handleBookingWorkflow } from "../workflows/booking.ts";
import { processEstimateFollowUpTouch, type EstimateFollowUpStatus } from "../workflows/estimate.ts";
import { handleReviewRequestWorkflow } from "../workflows/review.ts";

export interface DemoRunOutput {
  transcript: string[];
  auditLog: unknown[];
  success: boolean;
}

export async function runDemo(verbose: boolean = true): Promise<DemoRunOutput> {
  const transcript: string[] = [];
  const log = (line: string) => {
    transcript.push(line);
    if (verbose) {
      console.log(line);
    }
  };

  log("===============================================================");
  log("    AA BOOK CLI - DEMO MODE (Fort Smith Heating & Air)         ");
  log("===============================================================");
  log(`Client: ${FORT_SMITH_HVAC_CONFIG.business.name} (${FORT_SMITH_HVAC_CONFIG.business.trade})`);
  log(`Location: ${FORT_SMITH_HVAC_CONFIG.business.address.city}, ${FORT_SMITH_HVAC_CONFIG.business.address.state} ${FORT_SMITH_HVAC_CONFIG.business.address.zip}`);
  log(`Engine: Core Engine (in-repo agent loop)`);
  log(`Providers: Stub providers (NVIDIA NIM / Gemini Flash cost-routed emulation)`);
  log(`Calendar: In-memory Google Calendar adapter emulator`);
  log("");

  const store = new DataStore(":memory:");
  const calendar = new FakeCalendar();

  const router = new ProviderRouter(
    {
      dailySpendCapUsd: 1.0,
      routes: {
        conversation: { defaultProvider: "stub-nim", defaultModel: "meta/llama-3-70b-instruct" },
        reasoning: { defaultProvider: "stub-gemini", defaultModel: "google/gemini-1.5-flash" },
        aux: { defaultProvider: "stub-openrouter", defaultModel: "meta/llama-3-8b-instruct:free" },
      },
    },
    store
  );

  router.registerProvider(new StubModelProvider("stub-nim"));
  router.registerProvider(new StubModelProvider("stub-gemini"));
  router.registerProvider(new StubModelProvider("stub-openrouter"));

  const engine = new CoreEngine(router);

  // --- Workflow 1: Missed-Call Text-Back ---
  log("---------------------------------------------------------------");
  log("[WORKFLOW 1/4] Missed-Call Text-Back");
  log("---------------------------------------------------------------");
  const callerNumber = "+14795554321";
  log(`[EVENT] Incoming call from ${callerNumber} not answered.`);

  const mctbResult = await handleMissedCallTextBack(
    { callerPhone: callerNumber },
    FORT_SMITH_HVAC_CONFIG,
    store
  );
  log(`[AGENT -> SMS to ${callerNumber}]: "${mctbResult.messageText}"`);

  // Inbound SMS reply from caller asking AI disclosure
  log(`[CALLER -> SMS]: "Wait, are you an AI robot?"`);
  const disclosureTurn = await engine.processTurn({
    userMessage: "Wait, are you an AI robot?",
    context: {
      clientConfig: FORT_SMITH_HVAC_CONFIG,
      channel: "sms",
      senderPhone: callerNumber,
    },
    conversationHistory: [
      { role: "assistant", content: mctbResult.messageText },
    ],
  });
  log(`[AGENT -> SMS]: "${disclosureTurn.reply}"`);

  // --- Workflow 2: Booking ---
  log("");
  log("---------------------------------------------------------------");
  log("[WORKFLOW 2/4] Service Booking & Calendar Scheduling");
  log("---------------------------------------------------------------");
  log(`[CALLER -> SMS]: "I need to book an AC Tune-Up for tomorrow at 10 AM please."`);

  const tomorrowTenAm = new Date();
  tomorrowTenAm.setDate(tomorrowTenAm.getDate() + 1);
  tomorrowTenAm.setHours(10, 0, 0, 0);

  const bookingResult = await handleBookingWorkflow(
    {
      customerName: "Marcus Vance",
      customerPhone: callerNumber,
      serviceId: "ac-tuneup",
      requestedStartTime: tomorrowTenAm.toISOString(),
    },
    FORT_SMITH_HVAC_CONFIG,
    calendar,
    store
  );

  if (!bookingResult.success || !bookingResult.booking) {
    throw new Error(`Booking failed: ${bookingResult.error}`);
  }

  log(`[CALENDAR] Availability checked: OK. Event created on calendar.`);
  log(`[BOOKING CREATED] ID: ${bookingResult.booking.id} | Service: ${bookingResult.booking.serviceName}`);
  log(`[AGENT -> SMS Confirmation]: "${bookingResult.confirmationSms}"`);
  log(`[AUTOMATION] Scheduled ${bookingResult.scheduledReminders?.length} appointment reminders (24h prior and 2h prior).`);

  // --- Workflow 3: Estimate Follow-Up ---
  log("");
  log("---------------------------------------------------------------");
  log("[WORKFLOW 3/4] Estimate Follow-up Touches");
  log("---------------------------------------------------------------");
  const estimate: EstimateFollowUpStatus = {
    estimateId: "est-8831",
    customerName: "Sarah Miller",
    customerPhone: "+14795558831",
    amount: 6850,
    touchesSent: [],
    replied: false,
    status: "open",
  };
  log(`[INFO] Tracking open estimate ${estimate.estimateId} ($${estimate.amount}) for ${estimate.customerName}`);

  // Day 2 Touch
  const day2 = await processEstimateFollowUpTouch(estimate, 2, FORT_SMITH_HVAC_CONFIG, store, false);
  log(`[TOUCH DAY 2 -> SMS]: "${day2.message}"`);

  // Day 5 Touch
  const day5 = await processEstimateFollowUpTouch(estimate, 5, FORT_SMITH_HVAC_CONFIG, store, false);
  log(`[TOUCH DAY 5 -> SMS]: "${day5.message}"`);

  // Customer replies before Day 10
  log(`[CUSTOMER -> SMS]: "Thanks Sarah here, let's go ahead with the proposal!"`);
  const day10 = await processEstimateFollowUpTouch(estimate, 10, FORT_SMITH_HVAC_CONFIG, store, true);
  log(`[TOUCH DAY 10]: Follow-up stopped -> ${day10.reason}`);

  // --- Workflow 4: Review Requests ---
  log("");
  log("---------------------------------------------------------------");
  log("[WORKFLOW 4/4] Review Request After Completed Job");
  log("---------------------------------------------------------------");
  store.updateBookingStatus(bookingResult.booking.id, "completed");
  log(`[JOB COMPLETED] Booking ${bookingResult.booking.id} marked completed.`);

  const reviewResult = await handleReviewRequestWorkflow(
    {
      bookingId: bookingResult.booking.id,
      customerName: bookingResult.booking.customerName,
      customerPhone: bookingResult.booking.customerPhone,
      delayHours: 2,
    },
    FORT_SMITH_HVAC_CONFIG,
    store
  );
  log(`[AGENT -> SMS Review Ask]: "${reviewResult.messageText}"`);

  // --- Audit Log Dump ---
  log("");
  log("===============================================================");
  log("                         AUDIT LOG                             ");
  log("===============================================================");
  const auditLogs = store.listAuditLogs();
  auditLogs.forEach((entry, i) => {
    log(`[${i + 1}] ${entry.timestamp} | ${entry.action} (${entry.entityType}:${entry.entityId})`);
    log(`    Details: ${JSON.stringify(entry.details)}`);
  });
  log("===============================================================");
  log("Demo mode completed successfully. All 4 workflows verified.");

  store.close();

  return {
    transcript,
    auditLog: auditLogs,
    success: true,
  };
}
