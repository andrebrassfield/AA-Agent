import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface InstallOptions {
  baseDir?: string;
}

export function runInstall(options: InstallOptions = {}): { success: boolean; clientDir: string; dataDir: string } {
  console.log("Checking environment and machine prerequisites...");

  // Verify bun runtime
  if (typeof Bun === "undefined") {
    throw new Error("aabook requires the Bun runtime environment.");
  }

  const baseDir = options.baseDir || process.cwd();
  const clientDir = join(baseDir, "client");
  const dataDir = join(baseDir, "data");

  console.log(`Scaffolding AA Book client structure...`);
  console.log(`- Config dir: ${clientDir}`);
  console.log(`- Data dir:   ${dataDir}`);

  mkdirSync(clientDir, { recursive: true });
  mkdirSync(dataDir, { recursive: true });

  const envExamplePath = join(baseDir, ".env.example");
  if (!existsSync(envExamplePath)) {
    const envExample = `# AA Book Environment Secrets (env only, gitignored)
OPENROUTER_API_KEY=
NVIDIA_NIM_API_KEY=
GEMINI_API_KEY=
RETELL_API_KEY=
ELEVENLABS_API_KEY=
DAILY_SPEND_CAP_USD=5.00
`;
    writeFileSync(envExamplePath, envExample, "utf-8");
    console.log(`- Created .env.example`);
  }

  const envPath = join(baseDir, ".env");
  if (!existsSync(envPath)) {
    writeFileSync(envPath, `# AA Book Secrets\nDAILY_SPEND_CAP_USD=5.00\n`, "utf-8");
    console.log(`- Initialized .env`);
  }

  console.log("\nInstallation complete! Next step: run 'aabook setup' to configure the business profile.");
  return {
    success: true,
    clientDir,
    dataDir,
  };
}
