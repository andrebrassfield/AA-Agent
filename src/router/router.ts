import type {
  ModelProvider,
  ModelCompletionRequest,
  ModelCompletionResponse,
  RouterConfig,
  TaskClass,
} from "../types/router.ts";
import type { DataStore } from "../db/store.ts";

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
    let provider = this.providers.get(route.defaultProvider);
    let modelName = route.defaultModel;

    if (!provider && route.fallbackProvider) {
      provider = this.providers.get(route.fallbackProvider);
      modelName = route.fallbackModel || "default";
    }

    if (!provider) {
      throw new Error(`No provider registered for ${route.defaultProvider} (taskClass: ${request.taskClass})`);
    }

    const response = await provider.complete(request, modelName);

    // SPEC: Every model call logs provider, model, task class, and token counts.
    if (this.store) {
      this.store.logModelUsage({
        id: `mu-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`,
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
