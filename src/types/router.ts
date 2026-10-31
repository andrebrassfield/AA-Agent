export type TaskClass = "conversation" | "reasoning" | "aux";

export interface ModelMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface ModelCompletionRequest {
  taskClass: TaskClass;
  messages: ModelMessage[];
  temperature?: number;
  maxTokens?: number;
}

export interface ModelCompletionResponse {
  content: string;
  provider: string;
  model: string;
  taskClass: TaskClass;
  promptTokens: number;
  completionTokens: number;
  costUsd: number;
}

export interface ProviderRouteConfig {
  defaultProvider: string;
  defaultModel: string;
  fallbackProvider?: string;
  fallbackModel?: string;
}

export interface RouterConfig {
  dailySpendCapUsd: number;
  routes: {
    conversation: ProviderRouteConfig;
    reasoning: ProviderRouteConfig;
    aux: ProviderRouteConfig;
  };
}

export interface ModelProvider {
  name: string;
  complete(request: ModelCompletionRequest, modelName: string): Promise<ModelCompletionResponse>;
}
