import { spawnSync } from "node:child_process";
import * as crypto from "node:crypto";
import {
  accessSync,
  chmodSync,
  constants,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { loadClientConfig } from "../config/loader.ts";
import { DEFAULT_AI_DISCLOSURE, DEFAULT_CHANNELS_CONFIG } from "../config/validator.ts";
import type { ClientConfig } from "../types/config.ts";
import { buildServiceUnit } from "./service.ts";

export const MIN_BUN_VERSION = "1.1.0";

export class InstallError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InstallError";
  }
}

export const STARTER_CLIENT_CONFIG: ClientConfig = {
  business: {
    name: "Sample Home Services",
    trade: "HVAC & Plumbing",
    timezone: "America/Chicago",
    hours: {
      monday: { open: "08:00", close: "17:00" },
      tuesday: { open: "08:00", close: "17:00" },
      wednesday: { open: "08:00", close: "17:00" },
      thursday: { open: "08:00", close: "17:00" },
      friday: { open: "08:00", close: "17:00" },
    },
    phoneNumbers: {
      main: "+14795550100",
    },
    address: {
      street: "100 Main St",
      city: "Fort Smith",
      state: "AR",
      zip: "72901",
    },
  },
  services: {
    services: [
      {
        id: "diagnostic-visit",
        name: "Standard Diagnostic & Tune-Up",
        description: "System inspection, diagnostic check, and upfront repair quote",
        durationMinutes: 60,
        price: 89,
        bufferMinutes: 15,
      },
    ],
  },
  staff: {
    staff: [
      {
        id: "tech-1",
        name: "Lead Technician",
        role: "Field Service Specialist",
      },
    ],
  },
  persona: {
    greeting: "Thank you for calling Sample Home Services, how can we help you today?",
    voiceChoice: "alloy",
    aiDisclosureWording: DEFAULT_AI_DISCLOSURE,
    tone: "friendly",
  },
  policies: {
    cancellation: {
      noticePeriodHours: 24,
      fee: 25,
      policyText: "Please let us know at least 24 hours in advance if you need to reschedule.",
    },
    deposit: {
      required: false,
      type: "fixed",
      amount: 0,
    },
    serviceArea: {
      primaryZipCodes: ["72901"],
    },
  },
  channels: DEFAULT_CHANNELS_CONFIG,
};

const ENV_EXAMPLE_TEMPLATE = `# AA Book Environment Secrets (env only, gitignored — never place secrets in client/*.json)
WEBHOOK_SECRET=
OPENAI_API_KEY=
ANTHROPIC_API_KEY=
GEMINI_API_KEY=
OPENROUTER_API_KEY=
NVIDIA_NIM_API_KEY=
RETELL_API_KEY=
ELEVENLABS_API_KEY=
GOOGLE_CALENDAR_ID=
GOOGLE_CLIENT_EMAIL=
GOOGLE_PRIVATE_KEY=

# Runtime settings (non-secret)
AABOOK_ENGINE=core
PORT=3000
DAILY_SPEND_CAP_USD=5.00
`;

const ENV_INITIAL_TEMPLATE = `# AA Book Local Environment (env only, gitignored)
WEBHOOK_SECRET=
AABOOK_ENGINE=core
PORT=3000
DAILY_SPEND_CAP_USD=5.00
`;

export interface InstallOptions {
  baseDir?: string;
  clientDir?: string;
  dataDir?: string;
  service?: boolean;
  serviceDir?: string;
  platform?: NodeJS.Platform;
  bunVersion?: string | null;
  minBunVersion?: string;
  bunExecutable?: string;
  installDeps?: boolean;
  depInstaller?: (baseDir: string, frozenLockfile: boolean) => { exitCode: number; stderr: string };
  linkCli?: boolean;
  cliBinDir?: string;
}

export interface InstallResult {
  success: boolean;
  changed: boolean;
  alreadyInstalled: boolean;
  clientDir: string;
  dataDir: string;
  actionsTaken: string[];
  serviceFile?: string;
  serviceUnitName?: string;
  serviceCommands?: {
    start: string;
    stop: string;
  };
}

export function parseSemver(version: string): [number, number, number] | null {
  const clean = version.trim().replace(/^v/i, "").split("-")[0]?.split("+")[0] ?? "";
  const parts = clean.split(".");
  if (parts.length < 3) return null;
  const nums = [Number(parts[0]), Number(parts[1]), Number(parts[2])] as [number, number, number];
  if (nums.some((n) => !Number.isInteger(n) || n < 0)) return null;
  return nums;
}

export function isBunVersionSupported(current: string, minimum: string = MIN_BUN_VERSION): boolean {
  const cur = parseSemver(current);
  const min = parseSemver(minimum);
  if (!cur || !min) return false;
  for (let i = 0; i < 3; i++) {
    if (cur[i] > min[i]) return true;
    if (cur[i] < min[i]) return false;
  }
  return true;
}

export function verifyBunRuntime(currentVersion?: string | null, minVersion: string = MIN_BUN_VERSION): string {
  const detected =
    currentVersion !== undefined ? currentVersion : typeof Bun !== "undefined" ? Bun.version : null;

  if (!detected || detected.trim().length === 0) {
    throw new InstallError(
      `AA Book requires Bun v${minVersion} or newer, and Bun was not detected on this machine. ` +
        `Install Bun with 'curl -fsSL https://bun.sh/install | bash', reopen your terminal, and run 'aabook install' again.`
    );
  }

  if (!isBunVersionSupported(detected, minVersion)) {
    throw new InstallError(
      `AA Book requires Bun v${minVersion} or newer, and this machine has Bun v${detected}. ` +
        `Update Bun by running 'bun upgrade' (or visit https://bun.sh), then run 'aabook install' again.`
    );
  }

  return detected;
}

export function parseInstallArgs(args: string[]): InstallOptions {
  const parsed: InstallOptions = {};
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--service") {
      parsed.service = true;
    } else if (arg === "--service-dir" && args[i + 1]) {
      parsed.serviceDir = args[++i];
    } else if (arg === "--client-dir" && args[i + 1]) {
      parsed.clientDir = args[++i];
    } else if (arg === "--data-dir" && args[i + 1]) {
      parsed.dataDir = args[++i];
    } else if (arg === "--base-dir" && args[i + 1]) {
      parsed.baseDir = args[++i];
    } else if (arg === "--no-link") {
      parsed.linkCli = false;
    }
  }
  return parsed;
}

function computeDepsSignature(baseDir: string): string {
  const hash = crypto.createHash("sha256");
  const pkgPath = join(baseDir, "package.json");
  hash.update(readFileSync(pkgPath));
  const lockPath = join(baseDir, "bun.lock");
  if (existsSync(lockPath)) {
    hash.update(readFileSync(lockPath));
  }
  return hash.digest("hex");
}

function areDeclaredPackagesPresent(baseDir: string): boolean {
  const pkgPath = join(baseDir, "package.json");
  if (!existsSync(pkgPath)) return true;

  try {
    const pkg = JSON.parse(readFileSync(pkgPath, "utf-8")) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    const names = [
      ...Object.keys(pkg.dependencies ?? {}),
      ...Object.keys(pkg.devDependencies ?? {}),
    ];
    for (const name of names) {
      const depPkgPath = join(baseDir, "node_modules", ...name.split("/"), "package.json");
      if (!existsSync(depPkgPath)) {
        return false;
      }
    }
    return true;
  } catch {
    return false;
  }
}

function findWritableBinDir(preferredDir?: string): string | null {
  if (preferredDir) {
    mkdirSync(preferredDir, { recursive: true });
    return resolve(preferredDir);
  }

  const pathDirs = (process.env.PATH ?? "")
    .split(delimiter)
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => resolve(p));

  const home = homedir();
  const candidates = [
    join(home, ".bun", "bin"),
    dirname(resolve(process.execPath)),
    join(home, ".local", "bin"),
  ].map((p) => resolve(p));

  for (const candidate of candidates) {
    if (!pathDirs.includes(candidate)) continue;
    try {
      if (existsSync(candidate)) {
        accessSync(candidate, constants.W_OK);
        return candidate;
      }
    } catch {
      // Try next candidate
    }
  }

  return null;
}

export function runInstall(options: InstallOptions = {}): InstallResult {
  const detectedBun = verifyBunRuntime(options.bunVersion, options.minBunVersion ?? MIN_BUN_VERSION);
  console.log(`Checking environment and machine prerequisites (Bun v${detectedBun})...`);

  const baseDir = resolve(options.baseDir || process.cwd());
  const clientDir = resolve(options.clientDir || join(baseDir, "client"));
  const dataDir = resolve(options.dataDir || join(baseDir, "data"));
  const actionsTaken: string[] = [];

  // 1. Dependency installation (when package.json is present or explicitly requested)
  const pkgJsonPath = join(baseDir, "package.json");
  const shouldInstallDeps = options.installDeps ?? existsSync(pkgJsonPath);
  if (shouldInstallDeps && existsSync(pkgJsonPath)) {
    const signature = computeDepsSignature(baseDir);
    const stampPath = join(baseDir, "node_modules", ".aabook-deps-hash");
    const existingStamp = existsSync(stampPath) ? readFileSync(stampPath, "utf-8").trim() : "";

    if (areDeclaredPackagesPresent(baseDir) && existingStamp === signature) {
      console.log("- Dependencies: already up to date");
    } else {
      console.log("- Installing project dependencies with Bun...");
      const hasLockfile = existsSync(join(baseDir, "bun.lock")) || existsSync(join(baseDir, "bun.lockb"));
      const installer =
        options.depInstaller ??
        ((cwd: string, frozen: boolean) => {
          const bunBin = options.bunExecutable || process.execPath;
          const args = frozen ? ["install", "--frozen-lockfile"] : ["install"];
          const res = spawnSync(bunBin, args, { cwd, encoding: "utf-8" });
          return {
            exitCode: res.status ?? 1,
            stderr: (res.stderr || res.error?.message || "").toString().trim(),
          };
        });

      const installRes = installer(baseDir, hasLockfile);
      if (installRes.exitCode !== 0) {
        throw new InstallError(
          `Dependency install failed (exit code ${installRes.exitCode}). ` +
            `Check your internet connection and run 'aabook install' again.` +
            (installRes.stderr ? ` Details: ${installRes.stderr}` : "")
        );
      }

      const nodeModulesDir = join(baseDir, "node_modules");
      mkdirSync(nodeModulesDir, { recursive: true });
      writeFileSync(stampPath, `${signature}\n`, "utf-8");
      actionsTaken.push("Installed dependencies");
    }
  }

  // 2. Data directory & Client configuration scaffold (per-file idempotent; never overwrites user edits)
  if (!existsSync(dataDir)) {
    mkdirSync(dataDir, { recursive: true });
    actionsTaken.push(`Created data directory (${dataDir})`);
    console.log(`- Created data dir:   ${dataDir}`);
  } else {
    console.log(`- Data dir exists:    ${dataDir}`);
  }

  if (!existsSync(clientDir)) {
    mkdirSync(clientDir, { recursive: true });
    actionsTaken.push(`Created client config directory (${clientDir})`);
    console.log(`- Created config dir: ${clientDir}`);
  } else {
    console.log(`- Config dir exists:  ${clientDir}`);
  }

  const starterFiles: [string, unknown][] = [
    ["business.json", STARTER_CLIENT_CONFIG.business],
    ["services.json", STARTER_CLIENT_CONFIG.services],
    ["staff.json", STARTER_CLIENT_CONFIG.staff],
    ["persona.json", STARTER_CLIENT_CONFIG.persona],
    ["policies.json", STARTER_CLIENT_CONFIG.policies],
    ["channels.json", STARTER_CLIENT_CONFIG.channels ?? DEFAULT_CHANNELS_CONFIG],
  ];

  for (const [filename, payload] of starterFiles) {
    const filePath = join(clientDir, filename);
    if (!existsSync(filePath)) {
      writeFileSync(filePath, `${JSON.stringify(payload, null, 2)}\n`, "utf-8");
      actionsTaken.push(`Scaffolded client/${filename}`);
      console.log(`- Scaffolded client/${filename}`);
    }
  }

  // 3. Environment templates (secrets from env only — no secret values in templates)
  const envExamplePath = join(baseDir, ".env.example");
  if (!existsSync(envExamplePath)) {
    writeFileSync(envExamplePath, ENV_EXAMPLE_TEMPLATE, "utf-8");
    actionsTaken.push("Created .env.example");
    console.log("- Created .env.example");
  }

  const envPath = join(baseDir, ".env");
  if (!existsSync(envPath)) {
    writeFileSync(envPath, ENV_INITIAL_TEMPLATE, "utf-8");
    actionsTaken.push("Initialized .env");
    console.log("- Initialized .env");
  }

  // 4. Executable bit & optional CLI symlink on PATH
  const binScriptPath = join(baseDir, "bin", "aabook.js");
  if (existsSync(binScriptPath)) {
    const st = statSync(binScriptPath);
    if ((st.mode & 0o111) === 0) {
      chmodSync(binScriptPath, 0o755);
      actionsTaken.push("Marked bin/aabook.js executable");
    }

    const shouldLinkCli = options.linkCli ?? options.baseDir === undefined;
    if (shouldLinkCli) {
      const targetBinDir = findWritableBinDir(options.cliBinDir);
      if (targetBinDir) {
        const linkPath = join(targetBinDir, "aabook");
        const resolvedTarget = resolve(binScriptPath);
        let alreadyLinked = false;
        try {
          const linkStat = lstatSync(linkPath);
          if (linkStat.isSymbolicLink()) {
            const currentDest = resolve(dirname(linkPath), readlinkSync(linkPath));
            alreadyLinked = currentDest === resolvedTarget;
          }
        } catch {
          alreadyLinked = false;
        }

        if (!alreadyLinked) {
          rmSync(linkPath, { force: true });
          symlinkSync(resolvedTarget, linkPath);
          actionsTaken.push(`Linked 'aabook' command at ${linkPath}`);
          console.log(`- Linked CLI command: ${linkPath} -> ${resolvedTarget}`);
        }
      }
    }
  }

  // 5. Optional background service unit (--service)
  let serviceFile: string | undefined;
  let serviceUnitName: string | undefined;
  let serviceCommands: { start: string; stop: string } | undefined;

  if (options.service) {
    const loaded = loadClientConfig(clientDir);
    if (!loaded.success || !loaded.config) {
      const details = loaded.errors.map((e) => `${e.file}: ${e.issues.join("; ")}`).join(" | ");
      throw new InstallError(
        `Cannot generate background service unit because client config in ${clientDir} is incomplete: ${details}. ` +
          `Run 'aabook setup' first, then run 'aabook install --service'.`
      );
    }

    const spec = buildServiceUnit({
      baseDir,
      clientDir,
      dataDir,
      clientConfig: loaded.config,
      platform: options.platform,
      serviceDir: options.serviceDir,
      bunExecutable: options.bunExecutable,
    });

    if (spec.platform === "darwin") {
      const logsDir = join(baseDir, "logs");
      if (!existsSync(logsDir)) {
        mkdirSync(logsDir, { recursive: true });
      }
    }

    const existingUnitContent = existsSync(spec.filePath) ? readFileSync(spec.filePath, "utf-8") : null;
    if (existingUnitContent !== spec.content) {
      mkdirSync(dirname(spec.filePath), { recursive: true });
      writeFileSync(spec.filePath, spec.content, "utf-8");
      actionsTaken.push(`Wrote ${spec.platform === "darwin" ? "launchd plist" : "systemd user unit"} (${spec.filePath})`);
      console.log(`- Wrote service unit: ${spec.filePath}`);
    } else {
      console.log(`- Service unit already up to date: ${spec.filePath}`);
    }

    serviceFile = spec.filePath;
    serviceUnitName = spec.unitName;
    serviceCommands = {
      start: spec.startCommand,
      stop: spec.stopCommand,
    };

    console.log(`\nService commands (${loaded.config.business.name}):`);
    console.log(`  Start: ${spec.startCommand}`);
    console.log(`  Stop:  ${spec.stopCommand}`);
  }

  const changed = actionsTaken.length > 0;
  const alreadyInstalled = !changed;

  if (alreadyInstalled) {
    console.log("\nAlready installed — nothing changed.");
  } else {
    console.log("\nInstallation complete!");
  }

  if (options.service && serviceCommands) {
    console.log(
      "Next steps: set WEBHOOK_SECRET in .env, then run the Start command above (or run 'aabook demo' to verify offline first)."
    );
  } else {
    console.log(
      "Next steps: run 'aabook demo' to verify the full booking flow offline, or 'aabook setup' to configure your client shop."
    );
  }

  return {
    success: true,
    changed,
    alreadyInstalled,
    clientDir,
    dataDir,
    actionsTaken,
    serviceFile,
    serviceUnitName,
    serviceCommands,
  };
}
