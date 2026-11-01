import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FakeCalendar } from "../../src/calendar/calendar.ts";
import { ChannelAdapterRegistry } from "../../src/channels/registry.ts";
import { StubSmsProvider } from "../../src/channels/sms/stub.ts";
import { startServe } from "../../src/cli/serve.ts";
import { runSetup } from "../../src/cli/setup.ts";
import { validateChannelsConfig } from "../../src/config/validator.ts";
import { DataStore } from "../../src/db/store.ts";
import { FORT_SMITH_HVAC_CONFIG } from "../../src/demo/shop_data.ts";
import { CoreEngine } from "../../src/engine/core.ts";
import { ProviderRouter } from "../../src/router/router.ts";
import { StubModelProvider } from "../../src/router/stub.ts";
import { startWebhookServer, type RunningWebhookServer } from "../../src/server/server.ts";
import type { AgentTurnInput, EngineAdapter } from "../../src/types/engine.ts";
import { processEstimateFollowUpTouch } from "../../src/workflows/estimate.ts";

const TEST_SECRET = "super-secret-webhook-token-998877";

describe("Channels: Webhook Server, Retell Voice Seam, & SMS", () => {
  let store: DataStore;
  let calendar: FakeCalendar;
  let stubSms: StubSmsProvider;
  let router: ProviderRouter;
  let server: RunningWebhookServer | null = null;

  beforeEach(() => {
    store = new DataStore(":memory:");
    calendar = new FakeCalendar();
    stubSms = new StubSmsProvider();
    router = new ProviderRouter(
      {
        dailySpendCapUsd: 1.0,
        routes: {
          conversation: { chain: [{ provider: "stub-conv", model: "stub-chat" }] },
          reasoning: { chain: [{ provider: "stub-reason", model: "stub-reason" }] },
          aux: { chain: [{ provider: "stub-aux", model: "stub-aux-summary" }] },
        },
      },
      store
    );
    router.registerProvider(new StubModelProvider("stub-conv"));
    router.registerProvider(new StubModelProvider("stub-reason"));
    router.registerProvider(
      new StubModelProvider("stub-aux", () => {
        return "Summary: Caller booked and rescheduled an AC Tune-Up, and cancelled a secondary diagnostic.";
      })
    );
  });

  afterEach(async () => {
    if (server) {
      await server.stop();
      server = null;
    }
    store.close();
  });

  it("rejects missing or bad webhook secrets with 401, writes audit entries, and redacts secrets", async () => {
    const engine = new CoreEngine(router);
    server = startWebhookServer({
      port: 0,
      webhookSecret: TEST_SECRET,
      clientConfig: FORT_SMITH_HVAC_CONFIG,
      store,
      calendar,
      engine,
      router,
      smsProvider: stubSms,
    });

    // 1. Missing secret header
    const missingRes = await fetch(`${server.url}/webhooks/voice`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ event: "call_started", call: { call_id: "c-1", from_number: "+14795550001" } }),
    });
    expect(missingRes.status).toBe(401);
    const missingJson = (await missingRes.json()) as { error: string };
    expect(missingJson.error).toContain("missing webhook secret");

    // 2. Bad secret header
    const wrongSecret = "wrong-secret-attempt-12345";
    const badRes = await fetch(`${server.url}/webhooks/sms`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-webhook-secret": wrongSecret,
      },
      body: JSON.stringify({ from: "+14795550001", body: "Hello" }),
    });
    expect(badRes.status).toBe(401);
    const badJson = (await badRes.json()) as { error: string };
    expect(badJson.error).toContain("invalid webhook secret");

    // 3. Valid secret with embedded Retell access_token to verify payload redaction
    const validRes = await fetch(`${server.url}/webhooks/voice`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${TEST_SECRET}`,
      },
      body: JSON.stringify({
        event: "call_started",
        call: {
          call_id: "c-valid-redact",
          from_number: "+14795550001",
          access_token: "eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9.sensitive",
        },
      }),
    });
    expect(validRes.status).toBe(200);

    const audits = store.listAuditLogs();
    const rejected = audits.filter((a) => a.action === "WEBHOOK_AUTH_REJECTED");
    expect(rejected.length).toBe(2);
    expect(rejected[0].details.reason).toBe("missing_secret");
    expect(rejected[1].details.reason).toBe("invalid_secret");

    const serializedAuditDump = JSON.stringify(audits);
    expect(serializedAuditDump).not.toContain(TEST_SECRET);
    expect(serializedAuditDump).not.toContain(wrongSecret);
    expect(serializedAuditDump).not.toContain("eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9.sensitive");
    expect(serializedAuditDump).toContain("[REDACTED]");
  });

  it("sends exactly one greeting SMS on a missed call and deduplicates duplicate provider call IDs", async () => {
    const engine = new CoreEngine(router);
    server = startWebhookServer({
      port: 0,
      webhookSecret: TEST_SECRET,
      clientConfig: FORT_SMITH_HVAC_CONFIG,
      store,
      calendar,
      engine,
      router,
      smsProvider: stubSms,
    });

    const missedPayload = {
      event: "call_ended",
      call: {
        call_id: "retell_missed_dup_test_42",
        from_number: "+14795551212",
        to_number: "+14795550100",
        direction: "inbound",
        disconnection_reason: "dial_no_answer",
        duration_ms: 0,
      },
    };

    const firstRes = await fetch(`${server.url}/webhooks/voice`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-webhook-secret": TEST_SECRET,
      },
      body: JSON.stringify(missedPayload),
    });
    expect(firstRes.status).toBe(200);
    const firstBody = (await firstRes.json()) as { smsSent: boolean; duplicate: boolean };
    expect(firstBody.smsSent).toBe(true);
    expect(firstBody.duplicate).toBe(false);
    expect(stubSms.sentMessages.length).toBe(1);
    expect(stubSms.sentMessages[0].to).toBe("+14795551212");
    expect(stubSms.sentMessages[0].body).toContain(FORT_SMITH_HVAC_CONFIG.persona.greeting);

    // Duplicate delivery of the exact same provider call_id
    const secondRes = await fetch(`${server.url}/webhooks/voice`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-webhook-secret": TEST_SECRET,
      },
      body: JSON.stringify(missedPayload),
    });
    expect(secondRes.status).toBe(200);
    const secondBody = (await secondRes.json()) as { smsSent: boolean; duplicate: boolean };
    expect(secondBody.smsSent).toBe(false);
    expect(secondBody.duplicate).toBe(true);

    // Still strictly 1 SMS sent
    expect(stubSms.sentMessages.length).toBe(1);

    const auditActions = store.listAuditLogs().map((a) => a.action);
    expect(auditActions.filter((a) => a === "MISSED_CALL_TEXT_BACK_SENT").length).toBe(1);
    expect(auditActions).toContain("MISSED_CALL_DUPLICATE_IGNORED");
  });

  it("books, reschedules, cancels, summarizes via aux router, and schedules follow-ups across a Retell voice call", async () => {
    const engine = new CoreEngine(router);
    server = startWebhookServer({
      port: 0,
      webhookSecret: TEST_SECRET,
      clientConfig: FORT_SMITH_HVAC_CONFIG,
      store,
      calendar,
      engine,
      router,
      smsProvider: stubSms,
    });

    const headers = {
      "Content-Type": "application/json",
      "x-webhook-secret": TEST_SECRET,
    };
    const callId = "retell_live_call_700";
    const callerPhone = "+14795557007";

    // 1. Call started
    const startRes = await fetch(`${server.url}/webhooks/voice`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        event: "call_started",
        call: {
          call_id: callId,
          from_number: callerPhone,
          to_number: "+14795550100",
          direction: "inbound",
          start_timestamp: 1793613600000,
        },
      }),
    });
    expect(startRes.status).toBe(200);

    // 2. Availability check (in-hours Monday 10:00 UTC vs out-of-hours Monday 22:00 UTC)
    const availOkRes = await fetch(`${server.url}/webhooks/voice/tools`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        name: "check_availability",
        call: { call_id: callId, from_number: callerPhone },
        args: {
          service_id: "ac-tuneup",
          requested_start_time: "2026-11-02T10:00:00.000Z",
        },
      }),
    });
    expect(availOkRes.status).toBe(200);
    const availOkBody = (await availOkRes.json()) as { available: boolean };
    expect(availOkBody.available).toBe(true);

    const availClosedRes = await fetch(`${server.url}/webhooks/voice/tools`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        name: "check_availability",
        call: { call_id: callId, from_number: callerPhone },
        args: {
          service_id: "ac-tuneup",
          requested_start_time: "2026-11-02T22:00:00.000Z",
        },
      }),
    });
    const availClosedBody = (await availClosedRes.json()) as { available: boolean };
    expect(availClosedBody.available).toBe(false);

    // 3. Book primary appointment + secondary appointment
    const bookRes1 = await fetch(`${server.url}/webhooks/voice/tools`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        name: "book_appointment",
        call: { call_id: callId, from_number: callerPhone },
        args: {
          customer_name: "Jordan Hayes",
          service_id: "ac-tuneup",
          requested_start_time: "2026-11-02T10:00:00.000Z",
        },
      }),
    });
    const bookBody1 = (await bookRes1.json()) as { success: boolean; booking_id: string };
    expect(bookBody1.success).toBe(true);
    expect(bookBody1.booking_id).toBeDefined();

    const bookRes2 = await fetch(`${server.url}/webhooks/voice/tools`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        name: "book_appointment",
        call: { call_id: callId, from_number: callerPhone },
        args: {
          customer_name: "Jordan Hayes",
          service_id: "furnace-diagnostic",
          requested_start_time: "2026-11-03T10:00:00.000Z",
        },
      }),
    });
    const bookBody2 = (await bookRes2.json()) as { success: boolean; booking_id: string };
    expect(bookBody2.success).toBe(true);

    // 4. Reschedule primary appointment to 13:00 UTC
    const reschedRes = await fetch(`${server.url}/webhooks/voice/tools`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        name: "reschedule_appointment",
        call: { call_id: callId, from_number: callerPhone },
        args: {
          booking_id: bookBody1.booking_id,
          requested_start_time: "2026-11-02T13:00:00.000Z",
        },
      }),
    });
    const reschedBody = (await reschedRes.json()) as { success: boolean; booking_id: string };
    expect(reschedBody.success).toBe(true);
    expect(reschedBody.booking_id).not.toBe(bookBody1.booking_id);

    // 5. Cancel secondary appointment
    const cancelRes = await fetch(`${server.url}/webhooks/voice/tools`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        name: "cancel_appointment",
        call: { call_id: callId, from_number: callerPhone },
        args: {
          booking_id: bookBody2.booking_id,
        },
      }),
    });
    const cancelBody = (await cancelRes.json()) as { success: boolean };
    expect(cancelBody.success).toBe(true);
    expect(store.getBooking(bookBody2.booking_id)?.status).toBe("cancelled");

    // 6. Call ended -> triggers aux summary through ProviderRouter and schedules follow-up reminders
    const endRes = await fetch(`${server.url}/webhooks/voice`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        event: "call_ended",
        call: {
          call_id: callId,
          from_number: callerPhone,
          to_number: "+14795550100",
          direction: "inbound",
          duration_ms: 95000,
          disconnection_reason: "user_hangup",
          transcript:
            "Agent: Thank you for calling Fort Smith Heating & Air!\nUser: Please book an AC Tune-Up, move it to 1 PM, and cancel my Tuesday furnace check.",
        },
      }),
    });
    expect(endRes.status).toBe(200);
    const endBody = (await endRes.json()) as { summary: string; followUpsScheduled: number };
    expect(endBody.summary).toContain("Summary:");
    expect(endBody.followUpsScheduled).toBe(2);

    // Verify ProviderRouter recorded aux model usage
    const auxUsage = store.listModelUsage().filter((u) => u.taskClass === "aux");
    expect(auxUsage.length).toBe(1);
    expect(auxUsage[0].provider).toBe("stub-aux");

    // Verify follow-ups scheduled ONLY for the confirmed rescheduled booking (not the old rescheduled or cancelled ones)
    const followUps = store.listFollowUps();
    expect(followUps.length).toBe(2);
    expect(followUps.every((f) => f.entityId === reschedBody.booking_id && f.status === "pending")).toBe(true);

    // Verify call log stored summary
    const callLogs = store.listCallLogs();
    expect(callLogs.length).toBe(1);
    expect(callLogs[0].summary).toContain("Summary:");
  });

  it("stops pending estimate follow-up touches when a customer replies via SMS or voice", async () => {
    const engine = new CoreEngine(router);
    server = startWebhookServer({
      port: 0,
      webhookSecret: TEST_SECRET,
      clientConfig: FORT_SMITH_HVAC_CONFIG,
      store,
      calendar,
      engine,
      router,
      smsProvider: stubSms,
    });

    const headers = {
      "Content-Type": "application/json",
      "x-webhook-secret": TEST_SECRET,
    };

    // Case A: Open estimate stopped by inbound SMS reply
    const smsCustomerPhone = "+14795553001";
    const estSmsId = store.createEstimate({
      customerName: "Casey Morgan",
      customerPhone: smsCustomerPhone,
      amount: 5400,
      status: "open",
      touchesSent: "[]",
    });

    const day2Sms = await processEstimateFollowUpTouch(estSmsId, 2, FORT_SMITH_HVAC_CONFIG, store, false);
    expect(day2Sms.touchSent).toBe(true);

    const inboundSmsRes = await fetch(`${server.url}/webhooks/sms`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        from: smsCustomerPhone,
        to: "+14795550100",
        body: "Hey, got your quote! Can we talk options?",
      }),
    });
    expect(inboundSmsRes.status).toBe(200);
    const inboundSmsBody = (await inboundSmsRes.json()) as { stoppedEstimates: string[] };
    expect(inboundSmsBody.stoppedEstimates).toContain(estSmsId);
    expect(store.getEstimate(estSmsId)?.status).toBe("replied");

    // Day 5 touch must now be blocked automatically via DataStore state
    const day5AfterSmsReply = await processEstimateFollowUpTouch(estSmsId, 5, FORT_SMITH_HVAC_CONFIG, store, false);
    expect(day5AfterSmsReply.touchSent).toBe(false);

    // Case B: Open estimate stopped by inbound Voice connection
    const voiceCustomerPhone = "+14795553002";
    const estVoiceId = store.createEstimate({
      customerName: "Taylor Reed",
      customerPhone: voiceCustomerPhone,
      amount: 7200,
      status: "open",
      touchesSent: "[]",
    });

    const inboundVoiceRes = await fetch(`${server.url}/webhooks/voice`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        event: "call_started",
        call: {
          call_id: "retell_est_reply_call",
          from_number: voiceCustomerPhone,
          direction: "inbound",
        },
      }),
    });
    expect(inboundVoiceRes.status).toBe(200);
    expect(store.getEstimate(estVoiceId)?.status).toBe("replied");

    const day2AfterVoiceReply = await processEstimateFollowUpTouch(estVoiceId, 2, FORT_SMITH_HVAC_CONFIG, store, false);
    expect(day2AfterVoiceReply.touchSent).toBe(false);
  });

  it("routes inbound SMS into the same conversation history as voice and enforces AI disclosure", async () => {
    const capturedInputs: AgentTurnInput[] = [];
    const coreEngine = new CoreEngine(router);
    const recordingEngine: EngineAdapter = {
      name: "recording-core",
      async processTurn(input) {
        capturedInputs.push(input);
        return coreEngine.processTurn(input);
      },
    };

    server = startWebhookServer({
      port: 0,
      webhookSecret: TEST_SECRET,
      clientConfig: FORT_SMITH_HVAC_CONFIG,
      store,
      calendar,
      engine: recordingEngine,
      router,
      smsProvider: stubSms,
    });

    const headers = {
      "Content-Type": "application/json",
      "x-webhook-secret": TEST_SECRET,
    };
    const sharedPhone = "+14795554004";

    // 1. Voice call ends with a transcript
    await fetch(`${server.url}/webhooks/voice`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        event: "call_ended",
        call: {
          call_id: "retell_shared_conv_1",
          from_number: sharedPhone,
          direction: "inbound",
          duration_ms: 25000,
          disconnection_reason: "user_hangup",
          transcript: "User: Checking on AC tune-up pricing.",
        },
      }),
    });

    // 2. Follow-up SMS from same customer asks AI disclosure question
    const smsRes = await fetch(`${server.url}/webhooks/sms`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        from: sharedPhone,
        to: "+14795550100",
        body: "Quick question before we book — are you an AI?",
      }),
    });
    expect(smsRes.status).toBe(200);
    const smsData = (await smsRes.json()) as { reply: string };
    expect(smsData.reply).toContain(FORT_SMITH_HVAC_CONFIG.persona.aiDisclosureWording);

    // Verify the SMS turn received the prior voice transcript in shared conversationHistory
    expect(capturedInputs.length).toBe(1);
    expect(capturedInputs[0].conversationHistory.length).toBeGreaterThanOrEqual(1);
    expect(capturedInputs[0].conversationHistory[0].content).toContain("Checking on AC tune-up pricing");
  });

  it("starts and stops aabook serve cleanly using client config provider selection and rejects secrets in channels.json", async () => {
    // 1. Validate channels.json schema & secret guardrail
    const badChannelsWithSecret = validateChannelsConfig({
      voice: { provider: "retell", apiKey: "sk-leaked" },
      sms: { provider: "stub" },
    });
    expect(badChannelsWithSecret.valid).toBe(false);
    expect(badChannelsWithSecret.errors.some((e) => e.message.includes(".env only"))).toBe(true);

    const badProviderChoice = validateChannelsConfig({
      voice: { provider: "unknown-provider" },
      sms: { provider: "stub" },
    });
    expect(badProviderChoice.valid).toBe(false);

    // 2. Verify unimplemented ElevenLabs config fails cleanly at registry seam without touching product code
    const registry = new ChannelAdapterRegistry();
    expect(() =>
      registry.resolveVoiceAdapter({
        ...FORT_SMITH_HVAC_CONFIG,
        channels: { voice: { provider: "elevenlabs" }, sms: { provider: "stub" } },
      })
    ).toThrow(/elevenlabs.*not registered/i);

    // 3. Boot `startServe` end-to-end against temp client + data directories and shut down cleanly
    const tempDir = mkdtempSync(join(tmpdir(), "aabook-serve-test-"));
    const clientDir = join(tempDir, "client");
    const dataDir = join(tempDir, "data");

    try {
      await runSetup({
        clientDir,
        nonInteractiveDefaults: {
          channels: { voice: { provider: "retell" }, sms: { provider: "stub" } },
        },
      });

      const handle = await startServe({
        port: 0,
        clientDir,
        dataDir,
        webhookSecret: TEST_SECRET,
        waitForSignal: false,
      });

      expect(handle.server.voiceAdapter.name).toBe("retell");
      expect(handle.server.smsProvider.name).toBe("stub");

      const probe = await fetch(`${handle.server.url}/webhooks/sms`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-webhook-secret": TEST_SECRET,
        },
        body: JSON.stringify({
          from: "+14795559090",
          to: "+15550000000",
          body: "Are you a robot?",
        }),
      });
      expect(probe.status).toBe(200);

      await handle.shutdown();
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
