import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { validateRouterConfig } from "../../src/config/validator.ts";
import { DataStore } from "../../src/db/store.ts";
import { FORT_SMITH_HVAC_CONFIG } from "../../src/demo/shop_data.ts";
import {
  AnthropicProvider,
  buildConfiguredRouter,
  GeminiProvider,
  OpenAiCompatibleProvider,
} from "../../src/router/providers.ts";
import { ProviderRouter } from "../../src/router/router.ts";

interface CapturedRequest {
  method: string;
  path: string;
  search: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
}

describe("Live HTTP Model Providers & Router Config", () => {
  const ENV_KEYS = [
    "OPENAI_API_KEY",
    "ANTHROPIC_API_KEY",
    "GEMINI_API_KEY",
    "GATEWAY_API_KEY",
  ] as const;
  const savedEnv: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>> = {};

  let store: DataStore;
  let fakeServer: ReturnType<typeof Bun.serve> | null = null;
  let captured: CapturedRequest[] = [];

  beforeEach(() => {
    for (const k of ENV_KEYS) {
      savedEnv[k] = process.env[k];
    }
    process.env.OPENAI_API_KEY = "sk-test-openai-secret-991122";
    process.env.ANTHROPIC_API_KEY = "sk-ant-test-secret-883344";
    process.env.GEMINI_API_KEY = "AIzaSyTestGeminiSecret77445566";
    process.env.GATEWAY_API_KEY = "sk-test-gateway-secret-665544";

    store = new DataStore(":memory:");
    captured = [];
  });

  afterEach(() => {
    if (fakeServer) {
      fakeServer.stop(true);
      fakeServer = null;
    }
    store.close();
    for (const k of ENV_KEYS) {
      if (savedEnv[k] === undefined) {
        delete process.env[k];
      } else {
        process.env[k] = savedEnv[k];
      }
    }
  });

  it("completes across OpenAI-compatible, Anthropic, and Gemini HTTP providers against a local server and writes real token usage to model_usage", async () => {
    fakeServer = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      async fetch(req) {
        const url = new URL(req.url);
        const headers: Record<string, string> = {};
        req.headers.forEach((v, k) => {
          headers[k.toLowerCase()] = v;
        });
        const body = (await req.json()) as Record<string, unknown>;
        captured.push({
          method: req.method,
          path: url.pathname,
          search: url.search,
          headers,
          body,
        });

        if (url.pathname === "/gateway/v1/chat/completions") {
          return Response.json({
            id: "chatcmpl-1",
            model: "gpt-4o-mini",
            choices: [
              {
                index: 0,
                message: {
                  role: "assistant",
                  content: "Hi! How can Fort Smith Heating & Air help you today?",
                },
              },
            ],
            usage: {
              prompt_tokens: 120,
              completion_tokens: 24,
              total_tokens: 144,
            },
          });
        }

        if (url.pathname === "/v1/messages") {
          return Response.json({
            id: "msg-1",
            type: "message",
            role: "assistant",
            model: "claude-3-5-sonnet-latest",
            content: [{ type: "text", text: "Slot at 10:00 AM is optimal given technician buffer." }],
            usage: {
              input_tokens: 210,
              output_tokens: 35,
            },
          });
        }

        if (url.pathname === "/v1beta/models/gemini-2.0-flash:generateContent") {
          return Response.json({
            candidates: [
              {
                content: {
                  role: "model",
                  parts: [{ text: "Caller scheduled an AC tune-up for Wednesday morning." }],
                },
              },
            ],
            usageMetadata: {
              promptTokenCount: 85,
              candidatesTokenCount: 15,
              totalTokenCount: 100,
            },
          });
        }

        return new Response("Not Found", { status: 404 });
      },
    });

    const baseUrl = `http://127.0.0.1:${fakeServer.port}`;
    const router = buildConfiguredRouter({
      dailySpendCapUsd: 5.0,
      store,
      clientConfig: {
        ...FORT_SMITH_HVAC_CONFIG,
        router: {
          providers: {
            "custom-gateway": {
              kind: "openai-compatible",
              baseUrl: `${baseUrl}/gateway/v1`,
              envVar: "GATEWAY_API_KEY",
            },
            anthropic: {
              kind: "anthropic",
              baseUrl,
            },
            gemini: {
              kind: "gemini",
              baseUrl,
            },
          },
          routes: {
            conversation: { chain: [{ provider: "custom-gateway", model: "gpt-4o-mini" }] },
            reasoning: { chain: [{ provider: "anthropic", model: "claude-3-5-sonnet-latest" }] },
            aux: { chain: [{ provider: "gemini", model: "gemini-2.0-flash" }] },
          },
        },
      },
    });

    expect(router.listRegisteredProviders()).not.toContain("stub");

    const convRes = await router.complete({
      taskClass: "conversation",
      messages: [
        { role: "system", content: "You are a helpful front desk agent." },
        { role: "user", content: "Hello, do you service Fort Smith?" },
      ],
      temperature: 0.4,
    });
    expect(convRes.provider).toBe("custom-gateway");
    expect(convRes.content).toContain("Fort Smith Heating & Air");
    expect(convRes.promptTokens).toBe(120);
    expect(convRes.completionTokens).toBe(24);
    expect(convRes.costUsd).toBeGreaterThan(0);

    const reasonRes = await router.complete({
      taskClass: "reasoning",
      messages: [
        { role: "system", content: "Check booking constraints." },
        { role: "user", content: "Can we fit a 60m tune-up at 10 AM?" },
      ],
      maxTokens: 256,
    });
    expect(reasonRes.provider).toBe("anthropic");
    expect(reasonRes.content).toContain("10:00 AM");
    expect(reasonRes.promptTokens).toBe(210);
    expect(reasonRes.completionTokens).toBe(35);

    const auxRes = await router.complete({
      taskClass: "aux",
      messages: [
        { role: "system", content: "Summarize phone call." },
        { role: "user", content: "Customer booked Wednesday morning tune-up." },
      ],
    });
    expect(auxRes.provider).toBe("gemini");
    expect(auxRes.content).toContain("Wednesday morning");
    expect(auxRes.promptTokens).toBe(85);
    expect(auxRes.completionTokens).toBe(15);

    // Verify wire headers and ensure Gemini never puts API key in URL query string
    expect(captured.length).toBe(3);
    expect(captured[0]!.headers["authorization"]).toBe("Bearer sk-test-gateway-secret-665544");
    expect(captured[1]!.headers["x-api-key"]).toBe("sk-ant-test-secret-883344");
    expect(captured[1]!.headers["anthropic-version"]).toBe("2023-06-01");
    expect(captured[1]!.body.system).toBe("Check booking constraints.");
    expect(captured[2]!.headers["x-goog-api-key"]).toBe("AIzaSyTestGeminiSecret77445566");
    expect(captured[2]!.search).toBe("");

    // Verify all 3 real usage entries landed in model_usage SQLite ledger
    const ledger = store.listModelUsage();
    expect(ledger.length).toBe(3);
    const byTask = new Map(ledger.map((row) => [row.taskClass, row]));
    expect(byTask.get("conversation")?.promptTokens).toBe(120);
    expect(byTask.get("conversation")?.completionTokens).toBe(24);
    expect(byTask.get("reasoning")?.promptTokens).toBe(210);
    expect(byTask.get("reasoning")?.completionTokens).toBe(35);
    expect(byTask.get("aux")?.promptTokens).toBe(85);
    expect(byTask.get("aux")?.completionTokens).toBe(15);
  });

  it("falls back across HTTP providers on upstream failure, enforces daily spend cap on aux, and redacts API keys in errors and config validation", async () => {
    let failAll = false;

    fakeServer = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      async fetch(req) {
        const url = new URL(req.url);
        if (url.pathname === "/v1/chat/completions") {
          // Simulate upstream 503 that accidentally echoes the caller's secret key
          return new Response(
            JSON.stringify({
              error: `Upstream gateway overloaded for key ${process.env.OPENAI_API_KEY}`,
            }),
            { status: 503, headers: { "Content-Type": "application/json" } }
          );
        }

        if (url.pathname === "/v1/messages") {
          if (failAll) {
            return new Response(
              JSON.stringify({
                error: `Invalid key ${process.env.ANTHROPIC_API_KEY}`,
              }),
              { status: 401, headers: { "Content-Type": "application/json" } }
            );
          }
          return Response.json({
            id: "msg-fallback-ok",
            model: "claude-3-5-haiku-latest",
            content: [{ type: "text", text: "Recovered via Anthropic fallback!" }],
            usage: {
              input_tokens: 100_000,
              output_tokens: 25_000,
            },
          });
        }

        if (url.pathname.includes(":generateContent")) {
          return Response.json({
            candidates: [{ content: { parts: [{ text: "Aux summary" }] } }],
            usageMetadata: { promptTokenCount: 30, candidatesTokenCount: 10 },
          });
        }

        return new Response("Not Found", { status: 404 });
      },
    });

    const baseUrl = `http://127.0.0.1:${fakeServer.port}`;
    const router = new ProviderRouter(
      {
        dailySpendCapUsd: 0.15, // 100k in ($0.08) + 25k out ($0.10) = $0.18 > $0.15 cap
        routes: {
          conversation: {
            chain: [
              { provider: "openai", model: "gpt-4o-mini" },
              { provider: "anthropic", model: "claude-3-5-haiku-latest" },
            ],
          },
          reasoning: { chain: [{ provider: "anthropic", model: "claude-3-5-haiku-latest" }] },
          aux: { chain: [{ provider: "gemini", model: "gemini-2.0-flash" }] },
        },
      },
      store
    );
    router.registerProvider(new OpenAiCompatibleProvider({ name: "openai", baseUrl: `${baseUrl}/v1` }));
    router.registerProvider(new AnthropicProvider({ name: "anthropic", baseUrl }));
    router.registerProvider(new GeminiProvider({ name: "gemini", baseUrl }));

    // 1. Primary OpenAI 503s -> falls through to Anthropic, logs fallback usage ($0.18)
    const fallbackRes = await router.complete({
      taskClass: "conversation",
      messages: [{ role: "user", content: "Need AC repair today" }],
    });
    expect(fallbackRes.provider).toBe("anthropic");
    expect(fallbackRes.content).toBe("Recovered via Anthropic fallback!");
    expect(store.listModelUsage().length).toBe(1);
    expect(store.listModelUsage()[0]!.costUsd).toBeCloseTo(0.18, 4);

    // 2. Daily spend cap ($0.15) is now exceeded -> aux degrades without calling Gemini HTTP, conversation stays live
    const degradedAux = await router.complete({
      taskClass: "aux",
      messages: [{ role: "user", content: "Summarize call" }],
    });
    expect(degradedAux.provider).toBe("internal-fallback");
    expect(degradedAux.content).toContain("[Degraded Aux Mode: Daily Spend Cap Reached]");

    const liveConvOverCap = await router.complete({
      taskClass: "conversation",
      messages: [{ role: "user", content: "Still available at 2 PM?" }],
    });
    expect(liveConvOverCap.provider).toBe("anthropic");

    // 3. When all providers in chain fail, thrown error redacts every API key
    failAll = true;
    let chainErrMessage = "";
    try {
      await router.complete({
        taskClass: "conversation",
        messages: [{ role: "user", content: "Will fail everywhere" }],
      });
    } catch (err) {
      chainErrMessage = (err as Error).message;
    }
    expect(chainErrMessage).toContain("All providers in chain");
    expect(chainErrMessage).not.toContain(process.env.OPENAI_API_KEY!);
    expect(chainErrMessage).not.toContain(process.env.ANTHROPIC_API_KEY!);
    expect(chainErrMessage).toContain("[REDACTED]");

    // 4. Client config validation rejects secrets and stub providers in router.json
    const secretInRouterConfig = validateRouterConfig({
      providers: {
        openai: {
          kind: "openai-compatible",
          baseUrl: "https://api.openai.com/v1",
          apiKey: "sk-proj-leakedSecretKeyValue123456",
        },
      },
      routes: {
        conversation: { chain: [{ provider: "openai", model: "gpt-4o-mini" }] },
        reasoning: { chain: [{ provider: "openai", model: "gpt-4o" }] },
        aux: { chain: [{ provider: "openai", model: "gpt-4o-mini" }] },
      },
    });
    expect(secretInRouterConfig.valid).toBe(false);
    expect(secretInRouterConfig.errors.some((e) => e.message.includes(".env only"))).toBe(true);

    const stubInRouterConfig = validateRouterConfig({
      routes: {
        conversation: { chain: [{ provider: "stub", model: "stub-chat" }] },
        reasoning: { chain: [{ provider: "openai", model: "gpt-4o" }] },
        aux: { chain: [{ provider: "openai", model: "gpt-4o-mini" }] },
      },
    });
    expect(stubInRouterConfig.valid).toBe(false);
    expect(stubInRouterConfig.errors.some((e) => e.message.includes("reserved for demo and tests"))).toBe(true);
  });
});
