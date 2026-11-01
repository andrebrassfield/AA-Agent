import { spawn } from "child_process";
import type { EngineAdapter, AgentTurnInput, AgentTurnOutput } from "../types/engine.ts";

export const DEFAULT_OMP_TIMEOUT_MS = 30_000;

export interface OmpEngineOptions {
  timeoutMs?: number;
}

function resolveTimeoutMs(optionsOrTimeout?: number | OmpEngineOptions): number {
  const explicit =
    typeof optionsOrTimeout === "number" ? optionsOrTimeout : optionsOrTimeout?.timeoutMs;
  if (explicit !== undefined) {
    if (!Number.isFinite(explicit) || explicit <= 0) {
      throw new Error(`OmpEngine timeoutMs must be a positive number (received: ${explicit}).`);
    }
    return explicit;
  }

  const envRaw = process.env.AABOOK_OMP_TIMEOUT_MS;
  if (envRaw && envRaw.trim().length > 0) {
    const parsed = Number(envRaw.trim());
    if (Number.isFinite(parsed) && parsed > 0) {
      return parsed;
    }
  }

  return DEFAULT_OMP_TIMEOUT_MS;
}

export class OmpEngine implements EngineAdapter {
  name = "omp";
  private stdioCommand: string;
  private stdioArgs: string[];
  public readonly timeoutMs: number;

  constructor(
    stdioCommand: string = process.env.AABOOK_OMP_COMMAND || "omp-agent",
    stdioArgs: string[] = [],
    optionsOrTimeoutMs?: number | OmpEngineOptions
  ) {
    this.stdioCommand = stdioCommand;
    this.stdioArgs = stdioArgs;
    this.timeoutMs = resolveTimeoutMs(optionsOrTimeoutMs);
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

      const deadline = setTimeout(() => {
        if (!handled) {
          handled = true;
          try {
            child.kill("SIGKILL");
          } catch {
            // Process may have already exited
          }
          reject(
            new Error(
              `OmpEngine process turn timed out after ${this.timeoutMs}ms (command: "${this.stdioCommand}").`
            )
          );
        }
      }, this.timeoutMs);

      child.stdin.on("error", () => {
        // Handled via child 'error' or 'close'
      });

      child.on("error", (err: NodeJS.ErrnoException) => {
        if (!handled) {
          handled = true;
          clearTimeout(deadline);
          if (err.code === "ENOENT") {
            reject(
              new Error(
                `OmpEngine failed: the configured command "${this.stdioCommand}" is missing or could not be found.`
              )
            );
          } else {
            reject(
              new Error(`OmpEngine failed to spawn command "${this.stdioCommand}": ${err.message}`)
            );
          }
        }
      });

      child.stdout.on("data", (chunk: Buffer) => {
        outputData += chunk.toString("utf8");
        if (outputData.includes("\n")) {
          const lines = outputData.split("\n");
          const firstCompleteLine = lines[0] ?? "";
          try {
            const parsed = JSON.parse(firstCompleteLine);
            if (!handled) {
              handled = true;
              clearTimeout(deadline);
              try {
                child.kill("SIGKILL");
              } catch {
                // Already exited
              }
              resolve(parsed as AgentTurnOutput);
            }
          } catch {
            // Wait for complete JSON line or process close/timeout
          }
        }
      });

      child.stderr.on("data", (chunk: Buffer) => {
        errorData += chunk.toString("utf8");
      });

      child.on("close", (code) => {
        if (!handled) {
          handled = true;
          clearTimeout(deadline);
          reject(
            new Error(
              `OmpEngine process exited unexpectedly with code ${code}. Stderr: ${errorData}`
            )
          );
        }
      });

      const payload = JSON.stringify(input) + "\n";
      child.stdin.write(payload);
      child.stdin.end();
    });
  }
}
