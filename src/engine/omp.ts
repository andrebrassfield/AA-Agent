import { spawn } from "child_process";
import type { EngineAdapter, AgentTurnInput, AgentTurnOutput } from "../types/engine.ts";

export class OmpEngine implements EngineAdapter {
  name = "omp";
  private stdioCommand: string;
  private stdioArgs: string[];

  constructor(stdioCommand: string = "omp-agent", stdioArgs: string[] = []) {
    this.stdioCommand = stdioCommand;
    this.stdioArgs = stdioArgs;
  }

  async processTurn(input: AgentTurnInput): Promise<AgentTurnOutput> {
    const lower = input.userMessage.toLowerCase();
    if (lower.includes("are you an ai") || lower.includes("are you a robot")) {
      return {
        reply: `${input.context.clientConfig.persona.aiDisclosureWording} How may I help you?`,
        actionTaken: { type: "INFO_PROVIDED" },
      };
    }

    return new Promise((resolve, reject) => {
      const child = spawn(this.stdioCommand, this.stdioArgs, { stdio: ["pipe", "pipe", "pipe"] });

      let outputData = "";
      let errorData = "";
      let handled = false;

      child.on("error", (err: any) => {
        if (!handled) {
          handled = true;
          if (err.code === "ENOENT") {
            reject(new Error(`OmpEngine failed: the configured command "${this.stdioCommand}" is missing or could not be found.`));
          } else {
            reject(new Error(`OmpEngine failed to spawn command "${this.stdioCommand}": ${err.message}`));
          }
        }
      });

      child.stdout.on("data", (chunk) => {
        outputData += chunk.toString();
        // Since it's JSON lines, if we have a newline we can try parsing
        if (outputData.includes("\n")) {
          const lines = outputData.split("\n");
          const firstCompleteLine = lines[0];
          try {
            const parsed = JSON.parse(firstCompleteLine);
            if (!handled) {
              handled = true;
              child.kill(); // Done with this turn
              resolve(parsed as AgentTurnOutput);
            }
          } catch (e) {
            // Keep buffering if JSON isn't fully ready, though splitting by newline should guarantee it
          }
        }
      });

      child.stderr.on("data", (chunk) => {
        errorData += chunk.toString();
      });

      child.on("close", (code) => {
        if (!handled) {
          handled = true;
          reject(new Error(`OmpEngine process exited unexpectedly with code ${code}. Stderr: ${errorData}`));
        }
      });

      const payload = JSON.stringify(input) + "\n";
      child.stdin.write(payload);
      child.stdin.end();
    });
  }
}
