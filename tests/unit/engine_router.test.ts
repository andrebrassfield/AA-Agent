import { describe, it, expect, beforeEach } from "bun:test";
import { ProviderRouter } from "../../src/router/router.ts";
import { StubModelProvider } from "../../src/router/stub.ts";
import { CoreEngine } from "../../src/engine/core.ts";
import { OmpEngine } from "../../src/engine/omp.ts";
import { PiEngine } from "../../src/engine/pi.ts";
import { DataStore } from "../../src/db/store.ts";
import type { ClientConfig } from "../../src/types/config.ts";

const mockClientConfig: ClientConfig = {
  business: {
    name: "Fort Smith Heating & Air",
    trade: "HVAC",
    timezone: "America/Chicago",
    hours: { mon: { open: "08:00", close: "17:00" } },
    phoneNumbers: { main: "+14795550100" },
    address: { street: "100 Garrison Ave", city: "Fort Smith", state: "AR", zip: "72901" },
  },
  services: {
    services: [
      { id: "tuneup", name: "AC Tune-Up", durationMinutes: 60, price: 89, bufferMinutes: 15 },
    ],
  },
  staff: {
    staff: [{ id: "tech-1", name: "Dre", role: "HVAC Tech" }],
  },
  persona: {
    greeting: "Hello, Fort Smith Heating & Air here!",
    voiceChoice: "alloy",
    aiDisclosureWording: "I am an automated AI assistant helping the front desk at Arkansas Automated.",
    tone: "friendly",
  },
  policies: {
    cancellation: { noticePeriodHours: 24, fee: 25, policyText: "Standard" },
    deposit: { required: false, type: "fixed", amount: 0 },
    serviceArea: { primaryZipCodes: ["72901"] },
  },
};

describe("Engine Adapters & Provider Router", () => {
  let store: DataStore;
  let router: ProviderRouter;
  let stubProvider: StubModelProvider;

  beforeEach(() => {
    store = new DataStore(":memory:");
    router = new ProviderRouter(
      {
        dailySpendCapUsd: 0.05,
        routes: {
          conversation: { chain: [{ provider: "stub", model: "stub-chat" }] },
          reasoning: { chain: [{ provider: "stub", model: "stub-reason" }] },
          aux: { chain: [{ provider: "stub", model: "stub-aux" }] },
        },
      },
      store
    );
    stubProvider = new StubModelProvider("stub");
    router.registerProvider(stubProvider);
  });

  it("falls back to the next provider in the chain if the first one throws (e.g. 404)", async () => {
    const chainRouter = new ProviderRouter(
      {
        dailySpendCapUsd: 1.0,
        routes: {
          conversation: {
            chain: [
              { provider: "stub-fail", model: "fail-chat" },
              { provider: "stub-success", model: "success-chat" }
            ]
          },
          reasoning: { chain: [{ provider: "stub", model: "stub-reason" }] },
          aux: { chain: [{ provider: "stub", model: "stub-aux" }] },
        },
      },
      store
    );

    const failProvider = new StubModelProvider("stub-fail", () => {
      throw new Error("HTTP 404 Not Found");
    });

    const successProvider = new StubModelProvider("stub-success", () => {
      return "Success from fallback provider!";
    });

    chainRouter.registerProvider(failProvider);
    chainRouter.registerProvider(successProvider);

    const res = await chainRouter.complete({
      taskClass: "conversation",
      messages: [{ role: "user", content: "Hello!" }],
    });

    expect(res.provider).toBe("stub-success");
    expect(res.content).toBe("Success from fallback provider!");
  });

  it("routes conversation completions and logs token usage", async () => {
    const res = await router.complete({
      taskClass: "conversation",
      messages: [{ role: "user", content: "Hello!" }],
    });

    expect(res.provider).toBe("stub");
    expect(res.promptTokens).toBeGreaterThan(0);
    expect(res.costUsd).toBeGreaterThan(0);

    const logs = store.listModelUsage();
    expect(logs.length).toBe(1);
    expect(logs[0].taskClass).toBe("conversation");
  });

  it("enforces daily spend caps by degrading aux first, never conversation", async () => {
    const today = new Date().toISOString().substring(0, 10);
    store.logModelUsage({
      id: "u-exceed",
      provider: "stub",
      model: "stub-test",
      taskClass: "aux",
      promptTokens: 100000,
      completionTokens: 50000,
      costUsd: 1.0, // cap is 0.05
      timestamp: `${today}T12:00:00Z`,
    });

    const auxRes = await router.complete({
      taskClass: "aux",
      messages: [{ role: "user", content: "Summarize call" }],
    });
    expect(auxRes.content).toContain("[Degraded Aux Mode: Daily Spend Cap Reached]");

    const convRes = await router.complete({
      taskClass: "conversation",
      messages: [{ role: "user", content: "Can I book a tuneup?" }],
    });
    expect(convRes.content).not.toContain("[Degraded");
    expect(convRes.provider).toBe("stub");
  });

  it("CoreEngine enforces AI disclosure guardrail", async () => {
    const engine = new CoreEngine(router);
    const output = await engine.processTurn({
      userMessage: "Are you an AI or a real human?",
      context: {
        clientConfig: mockClientConfig,
        channel: "sms",
        senderPhone: "+14795559999",
      },
      conversationHistory: [],
    });

    expect(output.reply).toContain("I am an automated AI assistant");
    expect(output.actionTaken?.type).toBe("INFO_PROVIDED");
  });

  it("CoreEngine processes booking intent into structured booking", async () => {
    const engine = new CoreEngine(router);
    const output = await engine.processTurn({
      userMessage: "I would like to book a tune-up for tomorrow please",
      context: {
        clientConfig: mockClientConfig,
        channel: "sms",
        senderPhone: "+14795559999",
      },
      conversationHistory: [],
    });

    expect(output.actionTaken?.type).toBe("TOOL_CALL");
    expect((output.actionTaken?.details as any)?.args?.input?.serviceId).toBe("tuneup");
    expect((output.actionTaken?.details as any)?.args?.input?.customerPhone).toBe("+14795559999");
  });

  it("OmpEngine handles stdio requests and honors AI disclosure", async () => {
    const omp = new OmpEngine("node", ["tests/fixtures/fake-omp.js"]);
    const disclosureTurn = await omp.processTurn({
      userMessage: "Are you a robot?",
      context: {
        clientConfig: mockClientConfig,
        channel: "sms",
        senderPhone: "+14795559999",
      },
      conversationHistory: [],
    });
    expect(disclosureTurn.reply).toContain("I am an automated AI assistant");

    const regularTurn = await omp.processTurn({
      userMessage: "Hello harness",
      context: {
        clientConfig: mockClientConfig,
        channel: "sms",
        senderPhone: "+14795559999",
      },
      conversationHistory: [],
    });
    expect(regularTurn.reply).toContain("Echoing from fake harness: Hello harness");
  });


  it("PiEngine processes a turn via JSONL stdout matching agent_settled", async () => {
    const pi = new PiEngine(router);
    pi.spawnCommand = "node";
    pi.spawnArgsPrefix = ["tests/fixtures/fake-pi.js"];

    const turn = await pi.processTurn({
      userMessage: "Hello Pi",
      context: {
        clientConfig: mockClientConfig,
        channel: "sms",
        senderPhone: "+14795559999",
      },
      conversationHistory: [],
    });

    expect(turn.reply).toContain("Echoing Pi: Hello Pi");

    const logs = store.listModelUsage();
    const piLog = logs.find(l => l.provider === "pi-stub");
    expect(piLog).toBeDefined();
    expect(piLog?.promptTokens).toBe(10);
  });

  it("PiEngine parses a tool call out of assistant message", async () => {
    const pi = new PiEngine(router);
    pi.spawnCommand = "node";
    pi.spawnArgsPrefix = ["tests/fixtures/fake-pi.js"];

    const turn = await pi.processTurn({
      userMessage: "Book an AC Tune-Up",
      context: {
        clientConfig: mockClientConfig,
        channel: "sms",
        senderPhone: "+14795559999",
      },
      conversationHistory: [],
    });

    expect(turn.actionTaken?.type).toBe("TOOL_CALL");
    expect((turn.actionTaken?.details as any)?.name).toBe("manageBooking");
    expect((turn.actionTaken?.details as any)?.args?.input?.serviceId).toBe("ac-tuneup");
  });



  it("OmpEngine throws an explicit error when binary is missing", async () => {
    const omp = new OmpEngine("missing-omp-binary-12345");

    let errorCaught = false;
    try {
      await omp.processTurn({
        userMessage: "Hello",
        context: {
          clientConfig: mockClientConfig,
          channel: "sms",
          senderPhone: "+14795559999",
        },
        conversationHistory: [],
      });
    } catch (e: any) {
      errorCaught = true;
      expect(e.message).toContain("missing or could not be found");
    }

    expect(errorCaught).toBe(true);
  });
});
