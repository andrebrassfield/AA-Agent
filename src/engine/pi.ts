import { spawn } from "child_process";
import type { EngineAdapter, AgentTurnInput, AgentTurnOutput } from "../types/engine.ts";
import type { ProviderRouter } from "../router/router.ts";
import { resolve } from "path";
import * as crypto from "crypto";

export class PiEngine implements EngineAdapter {
  name = "pi";
  private router: ProviderRouter;

  public spawnCommand: string = "bun";
  public spawnArgsPrefix: string[] = ["run", "pi"];
  constructor(router: ProviderRouter) {
    this.router = router;
  }

  async processTurn(input: AgentTurnInput): Promise<AgentTurnOutput> {
    const lower = input.userMessage.toLowerCase();
    if (lower.includes("are you an ai") || lower.includes("are you a robot")) {
      return {
        reply: `${input.context.clientConfig.persona.aiDisclosureWording} How may I help you?`,
        actionTaken: { type: "INFO_PROVIDED" },
      };
    }

    return new Promise((res, rej) => {
      const sessionId = crypto.randomUUID();
      const mcpServerPath = resolve(__dirname, "../mcp/booking-server.ts");

      const args = [
        ...this.spawnArgsPrefix,
        "--mode", "json",
        "--no-builtin-tools",
        "--mcp", `node ${mcpServerPath}`,
        "--session", sessionId
      ];

      const child = spawn(this.spawnCommand, args, { stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, PI_LOG_LEVEL: "none" } });

      let reply = "";
      let actionTaken: any = undefined;
      let handled = false;
      let buffer = "";

      const deadline = setTimeout(() => {
        if (!handled) {
          handled = true;
          child.kill("SIGKILL");
          rej(new Error("PiEngine process turn timed out."));
        }
      }, 30000);

      const finalize = () => {
        if (!handled) {
          handled = true;
          clearTimeout(deadline);
          child.kill("SIGKILL");
          res({ reply, actionTaken });
        }
      };

      child.stdout.on("data", (chunk: Buffer) => {
        buffer += chunk.toString("utf8");
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";

        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const parsed = JSON.parse(line);

            if (parsed.type === "message" && parsed.message.role === "assistant") {
               reply += parsed.message.content || "";

               if (parsed.message.tool_calls && parsed.message.tool_calls.length > 0) {
                 const tc = parsed.message.tool_calls[0];
                 if (tc.function.name === "manageBooking") {
                   actionTaken = {
                     type: "TOOL_CALL",
                     details: {
                       name: tc.function.name,
                       args: typeof tc.function.arguments === "string" ? JSON.parse(tc.function.arguments) : tc.function.arguments
                     }
                   };
                 }
               }
            }

            if (parsed.type === "usage") {
               const store = (this.router as any).store;
               if (store) {
                 store.logModelUsage({
                    id: store.generateId("mu-pi"),
                    provider: parsed.usage.provider || "pi-agent",
                    model: parsed.usage.model || "unknown",
                    taskClass: "conversation",
                    promptTokens: parsed.usage.prompt_tokens || 0,
                    completionTokens: parsed.usage.completion_tokens || 0,
                    costUsd: parsed.usage.cost_usd || 0,
                    timestamp: new Date().toISOString(),
                 });
               }
            }

            if (parsed.type === "agent_settled") {
               finalize();
            }

          } catch (err) {}
        }
      });

      child.on("error", (err) => {
        if (!handled) {
          handled = true;
          clearTimeout(deadline);
          rej(err);
        }
      });

      child.on("close", () => {
         if (!handled) {
           handled = true;
           clearTimeout(deadline);
           rej(new Error("PiEngine process exited before agent_settled."));
         }
      });

      child.stdin.write(JSON.stringify({ type: "user_message", content: input.userMessage }) + "\n");
      child.stdin.end();
    });
  }
}
