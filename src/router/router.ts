import type {
  ModelProvider,
  ModelCompletionRequest,
  ModelCompletionResponse,
  RouterConfig,
} from "../types/router.ts";
import type { DataStore } from "../db/store.ts";
import { collectEnvSecrets, redactString } from "../server/redact.ts";

export class ProviderRouter {
  private providers = new Map<string, ModelProvider>();
  private config: RouterConfig;
  private store?: DataStore;

  constructor(config: RouterConfig, store?: DataStore) {
    this.config = config;
    this.store = store;
  }

  registerProvider(provider: ModelProvider): void {
    this.providers.set(provider.name, provider);
  }

  listRegisteredProviders(): string[] {
    return Array.from(this.providers.keys());
  }

  async complete(request: ModelCompletionRequest): Promise<ModelCompletionResponse> {
    const today = new Date().toISOString().substring(0, 10);
    const todaySpend = this.store ? this.store.getTodaySpend(today) : 0;
    const isOverCap = todaySpend >= this.config.dailySpendCapUsd;

    // Per SPEC: hitting the cap degrades aux first, never the conversation
    if (isOverCap && request.taskClass === "aux") {
      return {
        content: "[Degraded Aux Mode: Daily Spend Cap Reached]",
        provider: "internal-fallback",
        model: "rule-based",
        taskClass: request.taskClass,
        promptTokens: 0,
        completionTokens: 0,
        costUsd: 0,
      };
    }

    const route = this.config.routes[request.taskClass];
    let response: ModelCompletionResponse | null = null;
    let lastError: unknown = null;

    for (const entry of route.chain) {
      const provider = this.providers.get(entry.provider);
      if (!provider) {
        lastError = new Error(`Provider "${entry.provider}" not registered.`);
        continue;
      }

      try {
        response = await provider.complete(request, entry.model);
        break; // Success, exit chain
      } catch (err: unknown) {
        lastError = err;
        // Continue to the next provider in the chain on HTTP/network/config error
      }
    }

    if (!response) {
      const rawMessage = lastError instanceof Error ? lastError.message : String(lastError || "Unknown");
      const safeMessage = redactString(rawMessage, collectEnvSecrets());
      throw new Error(
        `All providers in chain for taskClass "${request.taskClass}" failed. Last error: ${safeMessage}`
      );
    }

    // SPEC: Every model call logs provider, model, task class, and token counts.
    if (this.store) {
      this.store.logModelUsage({
        id: this.store.generateId("mu"),
        provider: response.provider,
        model: response.model,
        taskClass: response.taskClass,
        promptTokens: response.promptTokens,
        completionTokens: response.completionTokens,
        costUsd: response.costUsd,
        timestamp: new Date().toISOString(),
      });
    }

    return response;
  }
}
