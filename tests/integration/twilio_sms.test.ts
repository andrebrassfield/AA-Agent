import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { FakeCalendar } from "../../src/calendar/calendar.ts";
import { ChannelAdapterRegistry } from "../../src/channels/registry.ts";
import {
  computeTwilioSignature,
  TwilioSmsProvider,
} from "../../src/channels/sms/twilio.ts";
import { validateChannelsConfig } from "../../src/config/validator.ts";
import { DataStore } from "../../src/db/store.ts";
import { FORT_SMITH_HVAC_CONFIG } from "../../src/demo/shop_data.ts";
import { CoreEngine } from "../../src/engine/core.ts";
import { ProviderRouter } from "../../src/router/router.ts";
import { StubModelProvider } from "../../src/router/stub.ts";
import { startWebhookServer, type RunningWebhookServer } from "../../src/server/server.ts";
import type { ClientConfig } from "../../src/types/config.ts";
import type { AgentTurnInput, EngineAdapter } from "../../src/types/engine.ts";
import { FollowUpDispatcher } from "../../src/workflows/dispatcher.ts";

const TEST_WEBHOOK_SECRET = "twilio-suite-webhook-secret-889900";
const FAKE_ACCOUNT_SID = `AC${"0123456789abcdef".repeat(2)}`;
const FAKE_AUTH_TOKEN = "fake-twilio-auth-token-secret-99887766";
const FAKE_ENV_FROM_NUMBER = "+14795550199";

interface RecordedCarrierRequest {
  method: string;
  pathname: string;
  authHeader: string | null;
  contentType: string | null;
  form: Record<string, string>;
}

interface FakeTwilioServer {
  url: string;
  requests: RecordedCarrierRequest[];
  nextErrorResponse: { status: number; body: string } | null;
  stop: () => void;
}

function startFakeTwilioCarrierServer(): FakeTwilioServer {
  const requests: RecordedCarrierRequest[] = [];
  let seq = 1;
  const state = {
    nextErrorResponse: null as { status: number; body: string } | null,
  };

  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req: Request): Promise<Response> {
      const url = new URL(req.url);
      const rawBody = await req.text();
      const form: Record<string, string> = {};
      new URLSearchParams(rawBody).forEach((val, key) => {
        form[key] = val;
      });

      requests.push({
        method: req.method,
        pathname: url.pathname,
        authHeader: req.headers.get("authorization"),
        contentType: req.headers.get("content-type"),
        form,
      });

      if (state.nextErrorResponse) {
        const err = state.nextErrorResponse;
        state.nextErrorResponse = null;
        return new Response(err.body, {
          status: err.status,
          headers: { "Content-Type": "application/json" },
        });
      }

      if (
        req.method === "POST" &&
        url.pathname === `/2010-04-01/Accounts/${FAKE_ACCOUNT_SID}/Messages.json`
      ) {
        const sid = `SMfake${String(seq++).padStart(28, "0")}`;
        return Response.json(
          {
            sid,
            account_sid: FAKE_ACCOUNT_SID,
            to: form.To,
            from: form.From,
            body: form.Body,
            status: "queued",
            date_created: "Sun, 01 Nov 2026 18:00:00 +0000",
          },
          { status: 201 }
        );
      }

      return Response.json({ message: "Not Found" }, { status: 404 });
    },
  });

  return {
    url: `http://127.0.0.1:${server.port}`,
    requests,
    get nextErrorResponse() {
      return state.nextErrorResponse;
    },
    set nextErrorResponse(val: { status: number; body: string } | null) {
      state.nextErrorResponse = val;
    },
    stop: () => {
      server.stop(true);
    },
  };
}

function buildTwilioClientConfig(overrides: Partial<ClientConfig> = {}): ClientConfig {
  return {
    ...FORT_SMITH_HVAC_CONFIG,
    ...overrides,
    channels: overrides.channels ?? {
      voice: { provider: "retell" },
      sms: { provider: "twilio" },
    },
  };
}

describe("Twilio Carrier SMS Adapter, Signed Inbound Webhook, & 10DLC Opt-Out Compliance", () => {
  let store: DataStore;
  let calendar: FakeCalendar;
  let router: ProviderRouter;
  let fakeCarrier: FakeTwilioServer;
  let webhookServer: RunningWebhookServer | null = null;
  let savedEnv: Record<string, string | undefined>;

  beforeEach(() => {
    savedEnv = {
      TWILIO_ACCOUNT_SID: process.env.TWILIO_ACCOUNT_SID,
      TWILIO_AUTH_TOKEN: process.env.TWILIO_AUTH_TOKEN,
      TWILIO_PHONE_NUMBER: process.env.TWILIO_PHONE_NUMBER,
      TWILIO_API_BASE_URL: process.env.TWILIO_API_BASE_URL,
      TWILIO_WEBHOOK_URL: process.env.TWILIO_WEBHOOK_URL,
    };

    fakeCarrier = startFakeTwilioCarrierServer();
    process.env.TWILIO_ACCOUNT_SID = FAKE_ACCOUNT_SID;
    process.env.TWILIO_AUTH_TOKEN = FAKE_AUTH_TOKEN;
    process.env.TWILIO_PHONE_NUMBER = FAKE_ENV_FROM_NUMBER;
    process.env.TWILIO_API_BASE_URL = fakeCarrier.url;
    delete process.env.TWILIO_WEBHOOK_URL;

    store = new DataStore(":memory:");
    calendar = new FakeCalendar();
    router = new ProviderRouter(
      {
        dailySpendCapUsd: 1.0,
        routes: {
          conversation: { chain: [{ provider: "stub-conv", model: "stub-chat" }] },
          reasoning: { chain: [{ provider: "stub-reason", model: "stub-reason" }] },
          aux: { chain: [{ provider: "stub-aux", model: "stub-aux" }] },
        },
      },
      store
    );
    router.registerProvider(new StubModelProvider("stub-conv"));
    router.registerProvider(new StubModelProvider("stub-reason"));
    router.registerProvider(new StubModelProvider("stub-aux"));
  });

  afterEach(async () => {
    if (webhookServer) {
      await webhookServer.stop();
      webhookServer = null;
    }
    fakeCarrier.stop();
    store.close();

    for (const [key, val] of Object.entries(savedEnv)) {
      if (val === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = val;
      }
    }
  });

  it("sends outbound SMS via Twilio REST API with Basic auth, form payload, env/config sender resolution, and secret redaction", async () => {
    // 1. Guardrail: client JSON config rejects Twilio credentials
    const rejectedCfg = validateChannelsConfig({
      voice: { provider: "retell" },
      sms: { provider: "twilio", accountSid: FAKE_ACCOUNT_SID, authToken: FAKE_AUTH_TOKEN },
    });
    expect(rejectedCfg.valid).toBe(false);
    expect(rejectedCfg.errors.some((e) => e.message.includes(".env only"))).toBe(true);

    // 2. Resolve TwilioSmsProvider through ChannelAdapterRegistry using client config SMS number
    const registry = new ChannelAdapterRegistry();
    const providerWithConfigFrom = registry.resolveSmsProvider(
      buildTwilioClientConfig({
        channels: {
          voice: { provider: "retell" },
          sms: { provider: "twilio", fromNumber: "+14795550155" },
        },
      })
    );
    expect(providerWithConfigFrom.name).toBe("twilio");

    const res1 = await providerWithConfigFrom.sendSms({
      to: "+14795552001",
      from: "",
      body: "Your technician is on the way.",
    });
    expect(res1.provider).toBe("twilio");
    expect(res1.status).toBe("queued");
    expect(res1.messageId).toStartWith("SMfake");

    expect(fakeCarrier.requests).toHaveLength(1);
    const expectedBasic = `Basic ${Buffer.from(
      `${FAKE_ACCOUNT_SID}:${FAKE_AUTH_TOKEN}`,
      "utf-8"
    ).toString("base64")}`;
    expect(fakeCarrier.requests[0]?.pathname).toBe(
      `/2010-04-01/Accounts/${FAKE_ACCOUNT_SID}/Messages.json`
    );
    expect(fakeCarrier.requests[0]?.authHeader).toBe(expectedBasic);
    expect(fakeCarrier.requests[0]?.contentType).toContain("application/x-www-form-urlencoded");
    expect(fakeCarrier.requests[0]?.form).toEqual({
      To: "+14795552001",
      From: "+14795550155",
      Body: "Your technician is on the way.",
    });

    // 3. Fallback to TWILIO_PHONE_NUMBER in env when client config omits SMS sending number
    const providerEnvFallback = new TwilioSmsProvider();
    await providerEnvFallback.sendSms({
      to: "+14795552002",
      from: "",
      body: "Appointment confirmed for Tuesday.",
    });
    expect(fakeCarrier.requests[1]?.form.From).toBe(FAKE_ENV_FROM_NUMBER);

    // 4. Upstream carrier error redacts TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, and Basic credentials
    fakeCarrier.nextErrorResponse = {
      status: 401,
      body: JSON.stringify({
        code: 20003,
        message: `Auth failed for ${FAKE_ACCOUNT_SID} with token ${FAKE_AUTH_TOKEN} (${expectedBasic})`,
      }),
    };

    let caughtMessage = "";
    try {
      await providerEnvFallback.sendSms({
        to: "+14795552002",
        from: FAKE_ENV_FROM_NUMBER,
        body: "Should fail and redact",
      });
    } catch (err) {
      caughtMessage = (err as Error).message;
    }
    expect(caughtMessage).toContain("Twilio SMS HTTP 401");
    expect(caughtMessage).toContain("[REDACTED]");
    expect(caughtMessage).not.toContain(FAKE_AUTH_TOKEN);
    expect(caughtMessage).not.toContain(FAKE_ACCOUNT_SID);
    expect(caughtMessage).not.toContain(expectedBasic.slice(6));

    // 5. Missing env credentials fail fast with explicit .env guidance
    delete process.env.TWILIO_AUTH_TOKEN;
    await expect(
      providerEnvFallback.sendSms({
        to: "+14795552002",
        from: FAKE_ENV_FROM_NUMBER,
        body: "Missing token check",
      })
    ).rejects.toThrow(/TWILIO_AUTH_TOKEN/);
  });

  it("validates X-Twilio-Signature on /webhooks/twilio/sms and routes valid messages into the shared conversation path", async () => {
    const bookingSlotIso = "2026-11-04T15:00:00.000Z";
    const customerPhone = "+14795556161";
    const capturedTurns: AgentTurnInput[] = [];

    router = new ProviderRouter(
      {
        dailySpendCapUsd: 1.0,
        routes: {
          conversation: { chain: [{ provider: "stub-conv-book", model: "stub-chat" }] },
          reasoning: { chain: [{ provider: "stub-reason", model: "stub-reason" }] },
          aux: { chain: [{ provider: "stub-aux", model: "stub-aux" }] },
        },
      },
      store
    );
    router.registerProvider(
      new StubModelProvider("stub-conv-book", () => {
        return (
          `Booked your AC Tune-Up!\n` +
          `<tool_call>{"name":"manageBooking","args":{"action":"create","input":{"customerName":"Riley Brooks","customerPhone":"${customerPhone}","serviceId":"ac-tuneup","requestedStartTime":"${bookingSlotIso}"}}}</tool_call>`
        );
      })
    );
    router.registerProvider(new StubModelProvider("stub-reason"));
    router.registerProvider(new StubModelProvider("stub-aux"));

    const core = new CoreEngine(router);
    const recordingEngine: EngineAdapter = {
      name: "recording-core",
      async processTurn(input) {
        capturedTurns.push(input);
        return core.processTurn(input);
      },
    };

    // Seed prior voice transcript to prove /webhooks/twilio/sms shares the exact same conversation path
    store.appendConversationMessage({
      customerPhone,
      channel: "voice",
      role: "user",
      content: "[Voice Call Transcript] Caller asked about Wednesday afternoon AC tune-up availability.",
      providerCallId: "retell_prior_voice_01",
    });

    webhookServer = startWebhookServer({
      port: 0,
      webhookSecret: TEST_WEBHOOK_SECRET,
      clientConfig: buildTwilioClientConfig(),
      store,
      calendar,
      engine: recordingEngine,
      router,
    });
    expect(webhookServer.smsProvider.name).toBe("twilio");

    const twilioWebhookUrl = `${webhookServer.url}/webhooks/twilio/sms`;
    const inboundForm = {
      MessageSid: "SM_inbound_valid_001",
      AccountSid: FAKE_ACCOUNT_SID,
      From: customerPhone,
      To: FORT_SMITH_HVAC_CONFIG.business.phoneNumbers.sms!,
      Body: "Hi, Riley Brooks here — please book the AC Tune-Up for Wednesday at 3 PM.",
    };
    const validSignature = computeTwilioSignature(
      FAKE_AUTH_TOKEN,
      twilioWebhookUrl,
      inboundForm
    );

    const res = await fetch(twilioWebhookUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "X-Twilio-Signature": validSignature,
      },
      body: new URLSearchParams(inboundForm).toString(),
    });

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/xml");
    expect(await res.text()).toContain("<Response></Response>");

    // Shared conversation context was passed into the engine and booking was created
    expect(capturedTurns).toHaveLength(1);
    expect(capturedTurns[0]?.conversationHistory[0]?.content).toContain(
      "Wednesday afternoon AC tune-up availability"
    );
    const bookings = store.listBookings();
    expect(bookings).toHaveLength(1);
    expect(bookings[0]?.customerName).toBe("Riley Brooks");

    // Outbound confirmation SMS was delivered to the local fake Twilio carrier API
    expect(fakeCarrier.requests).toHaveLength(1);
    expect(fakeCarrier.requests[0]?.form.To).toBe(customerPhone);
    expect(fakeCarrier.requests[0]?.form.Body).toContain("AC Tune-Up");
  });

  it("rejects missing or invalid X-Twilio-Signature on /webhooks/twilio/sms and writes redacted audit entries", async () => {
    const engine = new CoreEngine(router);
    webhookServer = startWebhookServer({
      port: 0,
      webhookSecret: TEST_WEBHOOK_SECRET,
      clientConfig: buildTwilioClientConfig(),
      store,
      calendar,
      engine,
      router,
    });

    const twilioWebhookUrl = `${webhookServer.url}/webhooks/twilio/sms`;
    const formPayload = {
      MessageSid: "SM_forged_001",
      AccountSid: FAKE_ACCOUNT_SID,
      From: "+14795550099",
      To: "+14795550100",
      Body: "Book me an appointment",
    };

    // 1. Missing X-Twilio-Signature header
    const missingSigRes = await fetch(twilioWebhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(formPayload).toString(),
    });
    expect(missingSigRes.status).toBe(403);

    // 2. Invalid X-Twilio-Signature (signed with wrong token / tampered body)
    const badSignature = computeTwilioSignature(
      "wrong-attacker-token-0000",
      twilioWebhookUrl,
      formPayload
    );
    const invalidSigRes = await fetch(twilioWebhookUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "X-Twilio-Signature": badSignature,
      },
      body: new URLSearchParams(formPayload).toString(),
    });
    expect(invalidSigRes.status).toBe(403);

    // Neither message entered conversation history or triggered any outbound carrier call
    expect(store.getConversationHistory("+14795550099")).toHaveLength(0);
    expect(fakeCarrier.requests).toHaveLength(0);

    const audits = store.listAuditLogs();
    const sigRejections = audits.filter((a) => a.action === "WEBHOOK_SIGNATURE_REJECTED");
    expect(sigRejections).toHaveLength(2);
    expect(sigRejections[0]?.details.reason).toBe("missing_signature");
    expect(sigRejections[1]?.details.reason).toBe("invalid_signature");

    const serializedAudits = JSON.stringify(audits);
    expect(serializedAudits).not.toContain(FAKE_AUTH_TOKEN);
    expect(serializedAudits).not.toContain(FAKE_ACCOUNT_SID);
    expect(serializedAudits).not.toContain(badSignature);
  });

  it("enforces STOP (and variants) to suppress conversation, missed-call text-back, and dispatcher sends, and restores them on START", async () => {
    const engine = new CoreEngine(router);
    const clientConfig = buildTwilioClientConfig();
    webhookServer = startWebhookServer({
      port: 0,
      webhookSecret: TEST_WEBHOOK_SECRET,
      clientConfig,
      store,
      calendar,
      engine,
      router,
    });

    const dispatcher = new FollowUpDispatcher({
      clientConfig,
      store,
      smsProvider: webhookServer.smsProvider,
      now: () => new Date("2026-11-04T15:00:00.000Z"),
    });

    const twilioWebhookUrl = `${webhookServer.url}/webhooks/twilio/sms`;
    const customerPhone = "+14795558282";

    const postSignedCarrierSms = async (messageSid: string, from: string, body: string) => {
      const form = {
        MessageSid: messageSid,
        AccountSid: FAKE_ACCOUNT_SID,
        From: from,
        To: FORT_SMITH_HVAC_CONFIG.business.phoneNumbers.sms!,
        Body: body,
      };
      const sig = computeTwilioSignature(FAKE_AUTH_TOKEN, twilioWebhookUrl, form);
      return fetch(twilioWebhookUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          "X-Twilio-Signature": sig,
        },
        body: new URLSearchParams(form).toString(),
      });
    };

    // 1. Inbound STOP marks contact opted out in DataStore, logs SMS_OPT_OUT, and sends nothing outbound
    const stopRes = await postSignedCarrierSms("SM_stop_01", customerPhone, "  stop  ");
    expect(stopRes.status).toBe(200);
    expect(store.isSmsOptedOut(customerPhone)).toBe(true);
    expect(fakeCarrier.requests).toHaveLength(0);

    // Also verify standard variant UNSUBSCRIBE marks a contact opted out with zero outbound sends
    const variantPhone = "+14795558383";
    const unsubRes = await postSignedCarrierSms("SM_unsub_01", variantPhone, "UNSUBSCRIBE");
    expect(unsubRes.status).toBe(200);
    expect(store.isSmsOptedOut(variantPhone)).toBe(true);
    expect(fakeCarrier.requests).toHaveLength(0);

    // 2a. Inbound conversational SMS while opted out sends nothing
    const convWhileOptedOut = await postSignedCarrierSms(
      "SM_conv_blocked_01",
      customerPhone,
      "Do you have openings tomorrow morning?"
    );
    expect(convWhileOptedOut.status).toBe(200);
    expect(fakeCarrier.requests).toHaveLength(0);

    // 2b. Missed call while opted out suppresses missed-call text-back
    const missedWhileOptedOut = await fetch(`${webhookServer.url}/webhooks/voice`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-webhook-secret": TEST_WEBHOOK_SECRET,
      },
      body: JSON.stringify({
        event: "call_ended",
        call: {
          call_id: "retell_missed_opted_out_01",
          from_number: customerPhone,
          to_number: clientConfig.business.phoneNumbers.main,
          direction: "inbound",
          disconnection_reason: "dial_no_answer",
          duration_ms: 0,
        },
      }),
    });
    expect(missedWhileOptedOut.status).toBe(200);
    const missedOptOutBody = (await missedWhileOptedOut.json()) as {
      smsSent: boolean;
      optedOut: boolean;
    };
    expect(missedOptOutBody.smsSent).toBe(false);
    expect(missedOptOutBody.optedOut).toBe(true);
    expect(fakeCarrier.requests).toHaveLength(0);

    // 2c. Due follow-up in FollowUpDispatcher while opted out is skipped with zero sends
    const blockedBookingId = store.createBooking({
      customerName: "Opted Out Customer",
      customerPhone,
      serviceId: "ac-tuneup",
      serviceName: "AC Tune-Up & Precision Inspection",
      startTime: "2026-11-05T15:00:00.000Z",
      endTime: "2026-11-05T16:00:00.000Z",
      status: "confirmed",
    });
    const blockedFollowUpId = store.scheduleFollowUp({
      type: "booking_reminder",
      entityType: "booking",
      entityId: blockedBookingId,
      recipientPhone: customerPhone,
      message: "Reminder: AC Tune-Up tomorrow at 9 AM.",
      scheduledFor: "2026-11-04T14:00:00.000Z",
      status: "pending",
    });

    const optOutTick = await dispatcher.runTick();
    expect(optOutTick.sent).toBe(0);
    expect(optOutTick.skipped).toBe(1);
    expect(store.getFollowUp(blockedFollowUpId)?.status).toBe("cancelled");
    expect(fakeCarrier.requests).toHaveLength(0);

    // 3. Inbound START reverses opt-out in DataStore, logs SMS_OPT_IN, and sends opt-in confirmation
    const startRes = await postSignedCarrierSms("SM_start_01", customerPhone, "START");
    expect(startRes.status).toBe(200);
    expect(store.isSmsOptedOut(customerPhone)).toBe(false);
    expect(fakeCarrier.requests).toHaveLength(1);
    expect(fakeCarrier.requests[0]?.form.To).toBe(customerPhone);
    expect(fakeCarrier.requests[0]?.form.Body).toContain("opted back in");

    // 4a. Missed-call text-back is restored after START
    const missedAfterStart = await fetch(`${webhookServer.url}/webhooks/voice`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-webhook-secret": TEST_WEBHOOK_SECRET,
      },
      body: JSON.stringify({
        event: "call_ended",
        call: {
          call_id: "retell_missed_restored_02",
          from_number: customerPhone,
          to_number: clientConfig.business.phoneNumbers.main,
          direction: "inbound",
          disconnection_reason: "dial_no_answer",
          duration_ms: 0,
        },
      }),
    });
    expect(missedAfterStart.status).toBe(200);
    const missedRestoredBody = (await missedAfterStart.json()) as { smsSent: boolean };
    expect(missedRestoredBody.smsSent).toBe(true);
    expect(fakeCarrier.requests).toHaveLength(2);
    expect(fakeCarrier.requests[1]?.form.Body).toContain(clientConfig.persona.greeting);

    // 4b. FollowUpDispatcher sends are restored after START
    const restoredFollowUpId = store.scheduleFollowUp({
      type: "booking_reminder",
      entityType: "booking",
      entityId: blockedBookingId,
      recipientPhone: customerPhone,
      message: "Reminder: Your technician arrives in 2 hours.",
      scheduledFor: "2026-11-04T14:30:00.000Z",
      status: "pending",
    });

    const restoredTick = await dispatcher.runTick();
    expect(restoredTick.sent).toBe(1);
    expect(store.getFollowUp(restoredFollowUpId)?.status).toBe("sent");
    expect(fakeCarrier.requests).toHaveLength(3);
    expect(fakeCarrier.requests[2]?.form.Body).toContain("arrives in 2 hours");

    // Verify every opt-out, suppression, and opt-in was audit-logged
    const auditActions = store.listAuditLogs().map((a) => a.action);
    expect(auditActions.filter((a) => a === "SMS_OPT_OUT")).toHaveLength(2);
    expect(auditActions).toContain("SMS_OUTBOUND_SUPPRESSED");
    expect(auditActions).toContain("MISSED_CALL_TEXT_BACK_SUPPRESSED");
    expect(auditActions).toContain("FOLLOWUP_SKIPPED");
    expect(auditActions).toContain("SMS_OPT_IN");
    expect(auditActions).toContain("FOLLOWUP_DISPATCHED");
  });

  it("replies to inbound HELP with standard informational copy and audit entry without calling the model router", async () => {
    const engine = new CoreEngine(router);
    const clientConfig = buildTwilioClientConfig();
    webhookServer = startWebhookServer({
      port: 0,
      webhookSecret: TEST_WEBHOOK_SECRET,
      clientConfig,
      store,
      calendar,
      engine,
      router,
    });

    const twilioWebhookUrl = `${webhookServer.url}/webhooks/twilio/sms`;
    const customerPhone = "+14795559191";
    const helpForm = {
      MessageSid: "SM_help_01",
      AccountSid: FAKE_ACCOUNT_SID,
      From: customerPhone,
      To: clientConfig.business.phoneNumbers.sms!,
      Body: "help",
    };
    const sig = computeTwilioSignature(FAKE_AUTH_TOKEN, twilioWebhookUrl, helpForm);

    const res = await fetch(twilioWebhookUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "X-Twilio-Signature": sig,
      },
      body: new URLSearchParams(helpForm).toString(),
    });

    expect(res.status).toBe(200);
    expect(fakeCarrier.requests).toHaveLength(1);
    expect(fakeCarrier.requests[0]?.form.To).toBe(customerPhone);
    expect(fakeCarrier.requests[0]?.form.Body).toContain(clientConfig.business.name);
    expect(fakeCarrier.requests[0]?.form.Body).toContain(clientConfig.business.phoneNumbers.main);
    expect(fakeCarrier.requests[0]?.form.Body).toContain("STOP");
    expect(fakeCarrier.requests[0]?.form.Body).toContain("START");

    expect(store.listModelUsage()).toHaveLength(0);
    const helpAudit = store.listAuditLogs().find((a) => a.action === "SMS_HELP_REPLIED");
    expect(helpAudit).toBeDefined();
    expect(helpAudit?.details.keyword).toBe("HELP");
  });
});
