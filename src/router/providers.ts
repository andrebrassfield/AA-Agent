import type { DataStore } from "../db/store.ts";
import { collectEnvSecrets, redactString } from "../server/redact.ts";
import type { ClientConfig } from "../types/config.ts";
import type {
  ModelCompletionRequest,
  ModelCompletionResponse,
  ModelPricingRates,
  ModelProvider,
  ProviderEndpointConfig,
  RouterConfig,
} from "../types/router.ts";
import { ProviderRouter } from "./router.ts";

export const DEFAULT_HTTP_PROVIDER_TIMEOUT_MS = 30_000;

export const DEFAULT_LIVE_ROUTES: RouterConfig["routes"] = {
  conversation: {
    chain: [
      { provider: "openai", model: "gpt-4o-mini" },
      { provider: "anthropic", model: "claude-3-5-haiku-latest" },
      { provider: "gemini", model: "gemini-2.0-flash" },
      { provider: "openrouter", model: "openai/gpt-4o-mini" },
    ],
  },
  reasoning: {
    chain: [
      { provider: "openai", model: "gpt-4o" },
      { provider: "anthropic", model: "claude-3-5-sonnet-latest" },
      { provider: "gemini", model: "gemini-2.0-flash" },
      { provider: "openrouter", model: "anthropic/claude-3.5-sonnet" },
    ],
  },
  aux: {
    chain: [
      { provider: "nvidia-nim", model: "meta/llama-3.1-8b-instruct" },
      { provider: "gemini", model: "gemini-2.0-flash" },
      { provider: "openrouter", model: "meta-llama/llama-3.1-8b-instruct:free" },
      { provider: "openai", model: "gpt-4o-mini" },
      { provider: "anthropic", model: "claude-3-5-haiku-latest" },
    ],
  },
};

const MODEL_PRICING_TABLE: { match: RegExp; rates: ModelPricingRates }[] = [
  { match: /:free$/i, rates: { inputPerMillionUsd: 0, outputPerMillionUsd: 0 } },
  { match: /gpt-4\.1-nano/i, rates: { inputPerMillionUsd: 0.1, outputPerMillionUsd: 0.4 } },
  { match: /gpt-4\.1-mini/i, rates: { inputPerMillionUsd: 0.4, outputPerMillionUsd: 1.6 } },
  { match: /gpt-4\.1/i, rates: { inputPerMillionUsd: 2.0, outputPerMillionUsd: 8.0 } },
  { match: /gpt-4o-mini/i, rates: { inputPerMillionUsd: 0.15, outputPerMillionUsd: 0.6 } },
  { match: /gpt-4o/i, rates: { inputPerMillionUsd: 2.5, outputPerMillionUsd: 10.0 } },
  { match: /claude.*haiku/i, rates: { inputPerMillionUsd: 0.8, outputPerMillionUsd: 4.0 } },
  { match: /claude.*opus/i, rates: { inputPerMillionUsd: 15.0, outputPerMillionUsd: 75.0 } },
  { match: /claude.*sonnet/i, rates: { inputPerMillionUsd: 3.0, outputPerMillionUsd: 15.0 } },
  { match: /gemini.*flash-lite|gemini.*flash-8b/i, rates: { inputPerMillionUsd: 0.075, outputPerMillionUsd: 0.3 } },
  { match: /gemini.*flash/i, rates: { inputPerMillionUsd: 0.1, outputPerMillionUsd: 0.4 } },
  { match: /gemini.*pro/i, rates: { inputPerMillionUsd: 1.25, outputPerMillionUsd: 5.0 } },
];

const FALLBACK_PRICING_RATES: ModelPricingRates = {
  inputPerMillionUsd: 0.5,
  outputPerMillionUsd: 1.5,
};

export function estimateModelCostUsd(
  providerName: string,
  modelName: string,
  promptTokens: number,
  completionTokens: number,
  explicitPricing?: ModelPricingRates
): number {
  const safePrompt = Math.max(0, Number.isFinite(promptTokens) ? promptTokens : 0);
  const safeCompletion = Math.max(0, Number.isFinite(completionTokens) ? completionTokens : 0);

  let rates = explicitPricing;
  if (!rates) {
    if (providerName.toLowerCase() === "nvidia-nim" && !/:paid$/i.test(modelName)) {
      rates = { inputPerMillionUsd: 0, outputPerMillionUsd: 0 };
    } else {
      const matched = MODEL_PRICING_TABLE.find((entry) => entry.match.test(modelName));
      rates = matched ? matched.rates : FALLBACK_PRICING_RATES;
    }
  }

  const rawUsd =
    (safePrompt / 1_000_000) * rates.inputPerMillionUsd +
    (safeCompletion / 1_000_000) * rates.outputPerMillionUsd;

  return Math.round((rawUsd + Number.EPSILON) * 1_000_000) / 1_000_000;
}

function readApiKeyFromEnv(providerName: string, envVar: string): string {
  const raw = process.env[envVar];
  if (!raw || raw.trim().length === 0) {
    throw new Error(
      `Provider "${providerName}" requires API key in environment variable ${envVar} (not set).`
    );
  }
  return raw.trim();
}

function sanitizeProviderError(message: string, apiKey?: string): string {
  return redactString(message, collectEnvSecrets(apiKey ? [apiKey] : []));
}

function toSafeTokenCount(val: unknown): number {
  const num = Number(val);
  return Number.isFinite(num) && num >= 0 ? Math.trunc(num) : 0;
}

export interface HttpProviderInit {
  name: string;
  baseUrl?: string;
  envVar?: string;
  timeoutMs?: number;
  pricing?: ModelPricingRates;
}

/**
 * OpenAI-compatible Chat Completions HTTP provider.
 * Covers OpenAI, OpenRouter, NVIDIA NIM, local vLLM/Ollama gateways, or any compatible endpoint
 * via configurable `baseUrl`. Uses Bun's built-in `fetch` only.
 */
export class OpenAiCompatibleProvider implements ModelProvider {
  public readonly name: string;
  public readonly baseUrl: string;
  public readonly envVar: string;
  public readonly timeoutMs: number;
  private readonly pricing?: ModelPricingRates;

  constructor(init: HttpProviderInit) {
    this.name = init.name;
    this.baseUrl = (init.baseUrl || "https://api.openai.com/v1").replace(/\/+$/, "");
    this.envVar = init.envVar || "OPENAI_API_KEY";
    this.timeoutMs = init.timeoutMs ?? DEFAULT_HTTP_PROVIDER_TIMEOUT_MS;
    this.pricing = init.pricing;
  }

  private resolveCompletionsUrl(): string {
    if (this.baseUrl.endsWith("/chat/completions")) {
      return this.baseUrl;
    }
    return `${this.baseUrl}/chat/completions`;
  }

  async complete(request: ModelCompletionRequest, modelName: string): Promise<ModelCompletionResponse> {
    const apiKey = readApiKeyFromEnv(this.name, this.envVar);
    const url = this.resolveCompletionsUrl();

    const payload: Record<string, unknown> = {
      model: modelName,
      messages: request.messages.map((m) => ({
        role: m.role,
        content: m.content,
      })),
    };
    if (request.temperature !== undefined) {
      payload.temperature = request.temperature;
    }
    if (request.maxTokens !== undefined) {
      payload.max_tokens = request.maxTokens;
    }

    let res: Response;
    try {
      res = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(
        `Provider "${this.name}" (${modelName}) network error: ${sanitizeProviderError(msg, apiKey)}`
      );
    }

    const rawBody = await res.text();
    if (!res.ok) {
      throw new Error(
        `Provider "${this.name}" (${modelName}) HTTP ${res.status}: ${sanitizeProviderError(
          rawBody.slice(0, 500),
          apiKey
        )}`
      );
    }

    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(rawBody) as Record<string, unknown>;
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(
        `Provider "${this.name}" (${modelName}) invalid JSON response: ${sanitizeProviderError(msg, apiKey)}`
      );
    }

    const choices = Array.isArray(parsed.choices) ? parsed.choices : [];
    const firstChoice = choices[0] as Record<string, unknown> | undefined;
    const messageObj = firstChoice?.message as Record<string, unknown> | undefined;
    const rawContent = messageObj?.content;

    let content = "";
    if (typeof rawContent === "string") {
      content = rawContent;
    } else if (Array.isArray(rawContent)) {
      content = rawContent
        .map((part) => {
          if (typeof part === "string") return part;
          if (typeof part === "object" && part !== null && typeof (part as { text?: unknown }).text === "string") {
            return (part as { text: string }).text;
          }
          return "";
        })
        .join("");
    }

    if (!firstChoice || messageObj === undefined) {
      throw new Error(`Provider "${this.name}" (${modelName}) returned an empty choices array.`);
    }

    const usage = (typeof parsed.usage === "object" && parsed.usage !== null
      ? parsed.usage
      : {}) as Record<string, unknown>;
    const promptTokens = toSafeTokenCount(usage.prompt_tokens);
    const completionTokens = toSafeTokenCount(usage.completion_tokens);

    const resolvedModel =
      typeof parsed.model === "string" && parsed.model.trim().length > 0
        ? parsed.model.trim()
        : modelName;

    const explicitGatewayCost =
      typeof usage.cost === "number" && Number.isFinite(usage.cost) && usage.cost >= 0
        ? Math.round((usage.cost + Number.EPSILON) * 1_000_000) / 1_000_000
        : undefined;

    const costUsd =
      explicitGatewayCost ??
      estimateModelCostUsd(this.name, resolvedModel, promptTokens, completionTokens, this.pricing);

    return {
      content,
      provider: this.name,
      model: resolvedModel,
      taskClass: request.taskClass,
      promptTokens,
      completionTokens,
      costUsd,
    };
  }
}

/**
 * Native Anthropic Messages API HTTP provider (`/v1/messages`).
 * Uses Bun's built-in `fetch` with zero external SDK dependencies.
 */
export class AnthropicProvider implements ModelProvider {
  public readonly name: string;
  public readonly baseUrl: string;
  public readonly envVar: string;
  public readonly timeoutMs: number;
  private readonly pricing?: ModelPricingRates;

  constructor(init: HttpProviderInit) {
    this.name = init.name;
    this.baseUrl = (init.baseUrl || "https://api.anthropic.com").replace(/\/+$/, "");
    this.envVar = init.envVar || "ANTHROPIC_API_KEY";
    this.timeoutMs = init.timeoutMs ?? DEFAULT_HTTP_PROVIDER_TIMEOUT_MS;
    this.pricing = init.pricing;
  }

  private resolveMessagesUrl(): string {
    if (this.baseUrl.endsWith("/messages")) {
      return this.baseUrl;
    }
    if (this.baseUrl.endsWith("/v1")) {
      return `${this.baseUrl}/messages`;
    }
    return `${this.baseUrl}/v1/messages`;
  }

  async complete(request: ModelCompletionRequest, modelName: string): Promise<ModelCompletionResponse> {
    const apiKey = readApiKeyFromEnv(this.name, this.envVar);
    const url = this.resolveMessagesUrl();

    const systemParts: string[] = [];
    const turns: { role: "user" | "assistant"; content: string }[] = [];

    for (const msg of request.messages) {
      if (msg.role === "system") {
        systemParts.push(msg.content);
      } else {
        turns.push({ role: msg.role, content: msg.content });
      }
    }

    const payload: Record<string, unknown> = {
      model: modelName,
      max_tokens: request.maxTokens ?? 1024,
      messages:
        turns.length > 0
          ? turns
          : [{ role: "user", content: systemParts.join("\n\n") || "Hello" }],
    };

    if (turns.length > 0 && systemParts.length > 0) {
      payload.system = systemParts.join("\n\n");
    }
    if (request.temperature !== undefined) {
      payload.temperature = request.temperature;
    }

    let res: Response;
    try {
      res = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": apiKey,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(
        `Provider "${this.name}" (${modelName}) network error: ${sanitizeProviderError(msg, apiKey)}`
      );
    }

    const rawBody = await res.text();
    if (!res.ok) {
      throw new Error(
        `Provider "${this.name}" (${modelName}) HTTP ${res.status}: ${sanitizeProviderError(
          rawBody.slice(0, 500),
          apiKey
        )}`
      );
    }

    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(rawBody) as Record<string, unknown>;
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(
        `Provider "${this.name}" (${modelName}) invalid JSON response: ${sanitizeProviderError(msg, apiKey)}`
      );
    }

    if (!Array.isArray(parsed.content)) {
      throw new Error(`Provider "${this.name}" (${modelName}) returned an invalid content array.`);
    }

    const content = parsed.content
      .map((block: unknown) => {
        if (
          typeof block === "object" &&
          block !== null &&
          (block as { type?: unknown }).type === "text" &&
          typeof (block as { text?: unknown }).text === "string"
        ) {
          return (block as { text: string }).text;
        }
        return "";
      })
      .join("");

    const usage = (typeof parsed.usage === "object" && parsed.usage !== null
      ? parsed.usage
      : {}) as Record<string, unknown>;
    const promptTokens = toSafeTokenCount(usage.input_tokens);
    const completionTokens = toSafeTokenCount(usage.output_tokens);

    const resolvedModel =
      typeof parsed.model === "string" && parsed.model.trim().length > 0
        ? parsed.model.trim()
        : modelName;

    const costUsd = estimateModelCostUsd(
      this.name,
      resolvedModel,
      promptTokens,
      completionTokens,
      this.pricing
    );

    return {
      content,
      provider: this.name,
      model: resolvedModel,
      taskClass: request.taskClass,
      promptTokens,
      completionTokens,
      costUsd,
    };
  }
}

/**
 * Native Google Gemini Generative Language API HTTP provider (`/v1beta/models/{model}:generateContent`).
 * Sends API key via `x-goog-api-key` header (never in URL query string) using Bun's built-in `fetch`.
 */
export class GeminiProvider implements ModelProvider {
  public readonly name: string;
  public readonly baseUrl: string;
  public readonly envVar: string;
  public readonly timeoutMs: number;
  private readonly pricing?: ModelPricingRates;

  constructor(init: HttpProviderInit) {
    this.name = init.name;
    this.baseUrl = (init.baseUrl || "https://generativelanguage.googleapis.com").replace(/\/+$/, "");
    this.envVar = init.envVar || "GEMINI_API_KEY";
    this.timeoutMs = init.timeoutMs ?? DEFAULT_HTTP_PROVIDER_TIMEOUT_MS;
    this.pricing = init.pricing;
  }

  private resolveGenerateUrl(modelName: string): string {
    const cleanModel = modelName.replace(/^(?:models\/|google\/)/i, "");
    const prefix = this.baseUrl.endsWith("/v1beta") ? this.baseUrl : `${this.baseUrl}/v1beta`;
    return `${prefix}/models/${encodeURIComponent(cleanModel)}:generateContent`;
  }

  async complete(request: ModelCompletionRequest, modelName: string): Promise<ModelCompletionResponse> {
    const apiKey = readApiKeyFromEnv(this.name, this.envVar);
    const url = this.resolveGenerateUrl(modelName);

    const systemParts: string[] = [];
    const contents: { role: "user" | "model"; parts: { text: string }[] }[] = [];

    for (const msg of request.messages) {
      if (msg.role === "system") {
        systemParts.push(msg.content);
      } else {
        contents.push({
          role: msg.role === "assistant" ? "model" : "user",
          parts: [{ text: msg.content }],
        });
      }
    }

    const payload: Record<string, unknown> = {
      contents:
        contents.length > 0
          ? contents
          : [{ role: "user", parts: [{ text: systemParts.join("\n\n") || "Hello" }] }],
    };

    if (contents.length > 0 && systemParts.length > 0) {
      payload.systemInstruction = {
        parts: [{ text: systemParts.join("\n\n") }],
      };
    }

    if (request.temperature !== undefined || request.maxTokens !== undefined) {
      const generationConfig: Record<string, unknown> = {};
      if (request.temperature !== undefined) {
        generationConfig.temperature = request.temperature;
      }
      if (request.maxTokens !== undefined) {
        generationConfig.maxOutputTokens = request.maxTokens;
      }
      payload.generationConfig = generationConfig;
    }

    let res: Response;
    try {
      res = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-goog-api-key": apiKey,
        },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(
        `Provider "${this.name}" (${modelName}) network error: ${sanitizeProviderError(msg, apiKey)}`
      );
    }

    const rawBody = await res.text();
    if (!res.ok) {
      throw new Error(
        `Provider "${this.name}" (${modelName}) HTTP ${res.status}: ${sanitizeProviderError(
          rawBody.slice(0, 500),
          apiKey
        )}`
      );
    }

    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(rawBody) as Record<string, unknown>;
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(
        `Provider "${this.name}" (${modelName}) invalid JSON response: ${sanitizeProviderError(msg, apiKey)}`
      );
    }

    const candidates = Array.isArray(parsed.candidates) ? parsed.candidates : [];
    const firstCandidate = candidates[0] as Record<string, unknown> | undefined;
    const candidateContent = firstCandidate?.content as Record<string, unknown> | undefined;
    const parts = Array.isArray(candidateContent?.parts) ? candidateContent.parts : [];

    if (!firstCandidate) {
      throw new Error(`Provider "${this.name}" (${modelName}) returned no candidates.`);
    }

    const content = parts
      .map((p: unknown) => {
        if (typeof p === "object" && p !== null && typeof (p as { text?: unknown }).text === "string") {
          return (p as { text: string }).text;
        }
        return "";
      })
      .join("");

    const usageMeta = (typeof parsed.usageMetadata === "object" && parsed.usageMetadata !== null
      ? parsed.usageMetadata
      : {}) as Record<string, unknown>;
    const promptTokens = toSafeTokenCount(usageMeta.promptTokenCount);
    const completionTokens = toSafeTokenCount(usageMeta.candidatesTokenCount);

    const resolvedModel =
      typeof parsed.modelVersion === "string" && parsed.modelVersion.trim().length > 0
        ? parsed.modelVersion.trim()
        : modelName;

    const costUsd = estimateModelCostUsd(
      this.name,
      resolvedModel,
      promptTokens,
      completionTokens,
      this.pricing
    );

    return {
      content,
      provider: this.name,
      model: resolvedModel,
      taskClass: request.taskClass,
      promptTokens,
      completionTokens,
      costUsd,
    };
  }
}

export function createHttpProviderFromConfig(
  name: string,
  config: ProviderEndpointConfig
): ModelProvider {
  if (config.kind === "anthropic") {
    return new AnthropicProvider({
      name,
      baseUrl: config.baseUrl || process.env.ANTHROPIC_BASE_URL || "https://api.anthropic.com",
      envVar: config.envVar || "ANTHROPIC_API_KEY",
      timeoutMs: config.timeoutMs,
      pricing: config.pricing,
    });
  }

  if (config.kind === "gemini") {
    return new GeminiProvider({
      name,
      baseUrl:
        config.baseUrl ||
        process.env.GEMINI_BASE_URL ||
        "https://generativelanguage.googleapis.com",
      envVar: config.envVar || "GEMINI_API_KEY",
      timeoutMs: config.timeoutMs,
      pricing: config.pricing,
    });
  }

  const defaultEnvByName: Record<string, string> = {
    openai: "OPENAI_API_KEY",
    openrouter: "OPENROUTER_API_KEY",
    "nvidia-nim": "NVIDIA_NIM_API_KEY",
  };
  const defaultBaseUrlByName: Record<string, string> = {
    openai: process.env.OPENAI_BASE_URL || "https://api.openai.com/v1",
    openrouter: process.env.OPENROUTER_BASE_URL || "https://openrouter.ai/api/v1",
    "nvidia-nim": process.env.NVIDIA_NIM_BASE_URL || "https://integrate.api.nvidia.com/v1",
  };

  return new OpenAiCompatibleProvider({
    name,
    baseUrl: config.baseUrl || defaultBaseUrlByName[name] || "https://api.openai.com/v1",
    envVar: config.envVar || defaultEnvByName[name] || "OPENAI_API_KEY",
    timeoutMs: config.timeoutMs,
    pricing: config.pricing,
  });
}

export interface BuildConfiguredRouterOptions {
  clientConfig: ClientConfig;
  dailySpendCapUsd: number;
  store?: DataStore;
}

/**
 * Builds a live `ProviderRouter` from client config (`client/router.json` or default chains).
 * Never registers `StubModelProvider`; stub remains strictly for demo and unit tests.
 */
export function buildConfiguredRouter(options: BuildConfiguredRouterOptions): ProviderRouter {
  const routes = options.clientConfig.router?.routes ?? DEFAULT_LIVE_ROUTES;
  const router = new ProviderRouter(
    {
      dailySpendCapUsd: options.dailySpendCapUsd,
      routes,
    },
    options.store
  );

  // Register standard HTTP providers first (all read keys strictly from env)
  router.registerProvider(
    new OpenAiCompatibleProvider({
      name: "openai",
      baseUrl: process.env.OPENAI_BASE_URL || "https://api.openai.com/v1",
      envVar: "OPENAI_API_KEY",
    })
  );
  router.registerProvider(
    new OpenAiCompatibleProvider({
      name: "openrouter",
      baseUrl: process.env.OPENROUTER_BASE_URL || "https://openrouter.ai/api/v1",
      envVar: "OPENROUTER_API_KEY",
    })
  );
  router.registerProvider(
    new OpenAiCompatibleProvider({
      name: "nvidia-nim",
      baseUrl: process.env.NVIDIA_NIM_BASE_URL || "https://integrate.api.nvidia.com/v1",
      envVar: "NVIDIA_NIM_API_KEY",
    })
  );
  router.registerProvider(
    new AnthropicProvider({
      name: "anthropic",
      baseUrl: process.env.ANTHROPIC_BASE_URL || "https://api.anthropic.com",
      envVar: "ANTHROPIC_API_KEY",
    })
  );
  router.registerProvider(
    new GeminiProvider({
      name: "gemini",
      baseUrl: process.env.GEMINI_BASE_URL || "https://generativelanguage.googleapis.com",
      envVar: "GEMINI_API_KEY",
    })
  );

  // Apply per-client provider definitions or gateway overrides from client/router.json
  const customProviders = options.clientConfig.router?.providers;
  if (customProviders) {
    for (const [providerName, endpointCfg] of Object.entries(customProviders)) {
      router.registerProvider(createHttpProviderFromConfig(providerName, endpointCfg));
    }
  }

  return router;
}
