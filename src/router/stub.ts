import type { ModelProvider, ModelCompletionRequest, ModelCompletionResponse } from "../types/router.ts";

export class StubModelProvider implements ModelProvider {
  name: string;
  private customHandler?: (req: ModelCompletionRequest, modelName: string) => string;

  constructor(name: string = "stub-provider", customHandler?: (req: ModelCompletionRequest, modelName: string) => string) {
    this.name = name;
    this.customHandler = customHandler;
  }

  async complete(request: ModelCompletionRequest, modelName: string): Promise<ModelCompletionResponse> {
    const promptLength = request.messages.reduce((acc, m) => acc + m.content.length, 0);
    const promptTokens = Math.max(10, Math.ceil(promptLength / 4));

    let reply = "I would be happy to help you with that.";
    if (this.customHandler) {
      reply = this.customHandler(request, modelName);
    } else {
      const lastMsg = request.messages[request.messages.length - 1]?.content.toLowerCase() || "";
      if (lastMsg.includes("are you an ai") || lastMsg.includes("are you a robot")) {
        reply = "I am an automated AI assistant helping the front desk at Arkansas Automated.";
      } else if (lastMsg.includes("book") || lastMsg.includes("tune-up") || lastMsg.includes("schedule")) {
        reply = "I have booked an AC Tune-Up & Inspection for you on tomorrow at 10:00 AM. You will receive an SMS reminder!";
      } else {
        reply = `Thanks for contacting us! How can we assist you with your home services today?`;
      }
    }

    const completionTokens = Math.max(10, Math.ceil(reply.length / 4));
    const costUsd = Number(((promptTokens * 0.0000005) + (completionTokens * 0.0000015)).toFixed(6));

    return {
      content: reply,
      provider: this.name,
      model: modelName,
      taskClass: request.taskClass,
      promptTokens,
      completionTokens,
      costUsd,
    };
  }
}
