import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StubSmsProvider } from "../../src/channels/sms/stub.ts";
import { startServe } from "../../src/cli/serve.ts";
import { writeClientConfig } from "../../src/config/loader.ts";
import { FORT_SMITH_HVAC_CONFIG } from "../../src/demo/shop_data.ts";

/**
 * Runnable serve-mode smoke check:
 *   bun tests/fixtures/serve-smoke.ts
 *
 * Boots a local fake OpenAI-compatible HTTP server + `aabook serve` against a fixture client config,
 * simulates an unanswered inbound call -> missed-call greeting SMS -> inbound SMS booking turn
 * -> shows `scheduled_followups` queued in SQLite -> shows the due follow-up claimed and dispatched on the tick.
 */
export async function runServeSmokeCheck(): Promise<void> {
  const tempRoot = mkdtempSync(join(tmpdir(), "aabook-serve-smoke-"));
  const clientDir = join(tempRoot, "client");
  const dataDir = join(tempRoot, "data");
  const webhookSecret = "smoke-webhook-secret-local-only";

  const prevOpenAiKey = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = "sk-smoke-fake-provider-key-local";

  // Fixed reference clock: Wednesday 2026-11-04 12:00 UTC (06:00 CST; quietHours set 21:00–05:00 CST so daytime is open)
  // Booking slot is Wednesday 2026-11-04 15:00 UTC:
  // - 24h reminder (2026-11-03T15:00:00.000Z) is due immediately on the next dispatcher tick
  // - 2h reminder  (2026-11-04T13:00:00.000Z) remains pending in the future
  const smokeNow = new Date("2026-11-04T12:00:00.000Z");
  const bookingSlotIso = "2026-11-04T15:00:00.000Z";
  const callerPhone = "+14795550177";

  const fakeProviderServer = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req) {
      const url = new URL(req.url);
      if (url.pathname === "/v1/chat/completions") {
        return Response.json({
          id: "chatcmpl-smoke-01",
          model: "gpt-4o-mini",
          choices: [
            {
              index: 0,
              message: {
                role: "assistant",
                content:
                  `I've booked your AC Tune-Up & Precision Inspection!\n` +
                  `<tool_call>{"name":"manageBooking","args":{"action":"create","input":{"customerName":"Jordan Hayes","customerPhone":"${callerPhone}","serviceId":"ac-tuneup","requestedStartTime":"${bookingSlotIso}"}}}</tool_call>`,
              },
            },
          ],
          usage: {
            prompt_tokens: 112,
            completion_tokens: 46,
            total_tokens: 158,
          },
        });
      }
      return new Response("Not Found", { status: 404 });
    },
  });

  const smsProvider = new StubSmsProvider();

  try {
    writeClientConfig(clientDir, {
      ...FORT_SMITH_HVAC_CONFIG,
      policies: {
        ...FORT_SMITH_HVAC_CONFIG.policies,
        quietHours: {
          start: "21:00",
          end: "05:00",
          timezone: "America/Chicago",
        },
      },
      router: {
        dailySpendCapUsd: 5.0,
        providers: {
          "fake-openai-gateway": {
            kind: "openai-compatible",
            baseUrl: `http://127.0.0.1:${fakeProviderServer.port}/v1`,
            envVar: "OPENAI_API_KEY",
          },
        },
        routes: {
          conversation: { chain: [{ provider: "fake-openai-gateway", model: "gpt-4o-mini" }] },
          reasoning: { chain: [{ provider: "fake-openai-gateway", model: "gpt-4o-mini" }] },
          aux: { chain: [{ provider: "fake-openai-gateway", model: "gpt-4o-mini" }] },
        },
      },
    });

    console.log("===============================================================");
    console.log("              AA BOOK SERVE-MODE SMOKE CHECK                   ");
    console.log("===============================================================");
    console.log(`Fake HTTP model server: http://127.0.0.1:${fakeProviderServer.port}/v1`);

    const handle = await startServe({
      port: 0,
      clientDir,
      dataDir,
      webhookSecret,
      followUpTickMs: 250,
      now: () => smokeNow,
      smsProvider,
      waitForSignal: false,
    });

    try {
      // 1. Simulate inbound missed call via Retell voice webhook
      console.log("\n[1] Simulating unanswered inbound call on POST /webhooks/voice...");
      const missedCallRes = await fetch(`${handle.server.url}/webhooks/voice`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-webhook-secret": webhookSecret,
        },
        body: JSON.stringify({
          event: "call_ended",
          call: {
            call_id: "retell_smoke_missed_call_01",
            from_number: callerPhone,
            to_number: FORT_SMITH_HVAC_CONFIG.business.phoneNumbers.main,
            direction: "inbound",
            disconnection_reason: "dial_no_answer",
            duration_ms: 0,
          },
        }),
      });
      const missedAck = await missedCallRes.json();
      console.log(`    Webhook response (${missedCallRes.status}): ${JSON.stringify(missedAck)}`);
      console.log(`    Immediate text-back SMS -> ${smsProvider.sentMessages[0]?.to}: "${smsProvider.sentMessages[0]?.body}"`);

      // 2. Caller texts back to book -> hits fake HTTP provider -> schedules follow-ups
      console.log("\n[2] Caller replies on POST /webhooks/sms to book appointment via HTTP provider...");
      const smsRes = await fetch(`${handle.server.url}/webhooks/sms`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-webhook-secret": webhookSecret,
        },
        body: JSON.stringify({
          messageId: "sms_smoke_in_01",
          from: callerPhone,
          to: FORT_SMITH_HVAC_CONFIG.business.phoneNumbers.sms,
          body: "Hi, Jordan Hayes here — please book an AC Tune-Up for today at 3 PM.",
        }),
      });
      const smsAck = (await smsRes.json()) as { bookingId: string; reply: string };
      console.log(`    Booking created: ${smsAck.bookingId}`);
      console.log(`    Confirmation SMS -> ${callerPhone}: "${smsAck.reply}"`);

      const beforeTick = handle.store.listFollowUps();
      console.log(`\n[3] Scheduled follow-ups in SQLite before dispatcher tick (${beforeTick.length} rows):`);
      for (const fup of beforeTick) {
        console.log(
          `    - ${fup.id} | type=${fup.type} | status=${fup.status} | scheduledFor=${fup.scheduledFor}`
        );
      }

      // 3. Wait for the 250ms background tick inside `aabook serve` to claim and dispatch due follow-up
      console.log("\n[4] Waiting for FollowUpDispatcher tick to fire...");
      for (let i = 0; i < 20 && smsProvider.sentMessages.length < 3; i++) {
        await Bun.sleep(40);
      }

      const afterTick = handle.store.listFollowUps();
      console.log(`    Scheduled follow-ups after dispatcher tick:`);
      for (const fup of afterTick) {
        console.log(
          `    - ${fup.id} | type=${fup.type} | status=${fup.status} | scheduledFor=${fup.scheduledFor} | sentAt=${fup.sentAt ?? "-"}`
        );
      }

      const dispatchedSms = smsProvider.sentMessages[2];
      if (!dispatchedSms) {
        throw new Error("Expected due follow-up reminder SMS to be dispatched on tick.");
      }
      console.log(`    Dispatched follow-up SMS -> ${dispatchedSms.to}: "${dispatchedSms.body}"`);

      const usageRows = handle.store.listModelUsage();
      console.log(
        `\n[5] Model usage ledger (${usageRows.length} call): provider=${usageRows[0]?.provider}, model=${usageRows[0]?.model}, promptTokens=${usageRows[0]?.promptTokens}, completionTokens=${usageRows[0]?.completionTokens}, costUsd=$${usageRows[0]?.costUsd.toFixed(6)}`
      );

      const relevantAudits = handle.store
        .listAuditLogs()
        .filter((a) =>
          [
            "MISSED_CALL_TEXT_BACK_SENT",
            "BOOKING_CONFIRMED",
            "SMS_TURN_COMPLETED",
            "FOLLOWUP_DISPATCHED",
          ].includes(a.action)
        );
      console.log(`\n[6] Key Audit Log Entries:`);
      for (const a of relevantAudits) {
        console.log(`    - ${a.action} (${a.entityType}:${a.entityId})`);
      }
      console.log("===============================================================");
      console.log("SMOKE CHECK PASSED.");
    } finally {
      await handle.shutdown();
    }
  } finally {
    fakeProviderServer.stop(true);
    if (prevOpenAiKey === undefined) {
      delete process.env.OPENAI_API_KEY;
    } else {
      process.env.OPENAI_API_KEY = prevOpenAiKey;
    }
    rmSync(tempRoot, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  await runServeSmokeCheck();
}
