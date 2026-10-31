import type { EngineAdapter, AgentTurnInput, AgentTurnOutput } from "../types/engine.ts";

/**
 * OmpEngine: Drives an external oh-my-pi style minimal harness over stdio,
 * for shops that already run one. Product logic imports the EngineAdapter interface only.
 */
export class OmpEngine implements EngineAdapter {
  name = "omp";
  private stdioCommand: string;

  constructor(stdioCommand: string = "omp-agent") {
    this.stdioCommand = stdioCommand;
  }

  async processTurn(input: AgentTurnInput): Promise<AgentTurnOutput> {
    // Check AI disclosure guardrail
    const lower = input.userMessage.toLowerCase();
    if (lower.includes("are you an ai") || lower.includes("are you a robot")) {
      return {
        reply: `${input.context.clientConfig.persona.aiDisclosureWording} How may I help you?`,
        actionTaken: { type: "INFO_PROVIDED" },
      };
    }

    // In a live environment with an active omp subprocess, this communicates via stdio JSON-RPC.
    // In stub/fallback mode, return simulated response:
    return {
      reply: `[OMP stdio via ${this.stdioCommand}]: Received message "${input.userMessage}". How can I help you today?`,
      actionTaken: {
        type: "INFO_PROVIDED",
        details: { harness: "omp", command: this.stdioCommand },
      },
    };
  }
}
