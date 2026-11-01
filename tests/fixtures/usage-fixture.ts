import { Database } from "bun:sqlite";
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DataStore } from "../../src/db/store.ts";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

export interface SeededUsageFixture {
  rootDir: string;
  clientDir: string;
  dataDir: string;
  dbPath: string;
  referenceDate: Date;
  dailySpendCapUsd: number;
}

function utcTimestampDaysAgo(referenceDate: Date, daysAgo: number, timeUtc: string): string {
  const baseMidnight = Date.UTC(
    referenceDate.getUTCFullYear(),
    referenceDate.getUTCMonth(),
    referenceDate.getUTCDate()
  );
  const dayIso = new Date(baseMidnight - daysAgo * 86_400_000).toISOString().slice(0, 10);
  return `${dayIso}T${timeUtc}Z`;
}

/**
 * Seeds a self-contained client folder + SQLite model_usage ledger for testing and CLI verification.
 * Uses the fictional Fort Smith Heating & Air template with a $1.00/day spend cap and 11 ledger rows
 * (10 inside the 7-day window across 3 active days including 1 day that exceeds the $1.00 cap,
 * plus 1 older row 9 days ago outside the 7-day window).
 */
export function seedUsageFixture(
  rootDir: string,
  referenceDate: Date = new Date(),
  dailySpendCapUsd: number = 1.0
): SeededUsageFixture {
  const resolvedRoot = resolve(rootDir);
  const clientDir = join(resolvedRoot, "client");
  const dataDir = join(resolvedRoot, "data");
  const dbPath = join(dataDir, "aabook.sqlite");

  mkdirSync(clientDir, { recursive: true });
  mkdirSync(dataDir, { recursive: true });

  cpSync(join(REPO_ROOT, "templates", "fort-smith-hvac"), clientDir, { recursive: true });

  const policiesPath = join(clientDir, "policies.json");
  const policies = JSON.parse(readFileSync(policiesPath, "utf-8")) as Record<string, unknown>;
  policies.dailySpendCapUsd = dailySpendCapUsd;
  writeFileSync(policiesPath, `${JSON.stringify(policies, null, 2)}\n`, "utf-8");

  const stagingDbPath = join(dataDir, "staging.sqlite");
  const store = new DataStore(stagingDbPath);
  try {
    // 9 days ago (outside default 7-day window, inside 14-day window)
    store.logModelUsage({
      id: "mu-d9-conv-1",
      provider: "openrouter",
      model: "anthropic/claude-3.5-sonnet",
      taskClass: "conversation",
      promptTokens: 1200,
      completionTokens: 400,
      costUsd: 0.5,
      timestamp: utcTimestampDaysAgo(referenceDate, 9, "15:10:00.000"),
    });

    // 4 days ago: $0.42 total (under $1.00 cap)
    store.logModelUsage({
      id: "mu-d4-conv-1",
      provider: "openrouter",
      model: "anthropic/claude-3.5-sonnet",
      taskClass: "conversation",
      promptTokens: 1500,
      completionTokens: 500,
      costUsd: 0.3,
      timestamp: utcTimestampDaysAgo(referenceDate, 4, "14:05:00.000"),
    });
    store.logModelUsage({
      id: "mu-d4-reas-1",
      provider: "gemini",
      model: "gemini-2.0-flash",
      taskClass: "reasoning",
      promptTokens: 900,
      completionTokens: 300,
      costUsd: 0.12,
      timestamp: utcTimestampDaysAgo(referenceDate, 4, "14:06:10.000"),
    });
    store.logModelUsage({
      id: "mu-d4-aux-1",
      provider: "nvidia-nim",
      model: "meta/llama-3.1-8b-instruct",
      taskClass: "aux",
      promptTokens: 600,
      completionTokens: 150,
      costUsd: 0.0,
      timestamp: utcTimestampDaysAgo(referenceDate, 4, "14:07:00.000"),
    });

    // 2 days ago: $1.35 total (EXCEEDS $1.00 daily cap by +$0.35 as live conversation continues)
    store.logModelUsage({
      id: "mu-d2-conv-1",
      provider: "openrouter",
      model: "anthropic/claude-3.5-sonnet",
      taskClass: "conversation",
      promptTokens: 2400,
      completionTokens: 800,
      costUsd: 0.65,
      timestamp: utcTimestampDaysAgo(referenceDate, 2, "13:20:00.000"),
    });
    store.logModelUsage({
      id: "mu-d2-reas-1",
      provider: "gemini",
      model: "gemini-2.0-flash",
      taskClass: "reasoning",
      promptTokens: 1400,
      completionTokens: 450,
      costUsd: 0.2,
      timestamp: utcTimestampDaysAgo(referenceDate, 2, "15:10:00.000"),
    });
    store.logModelUsage({
      id: "mu-d2-aux-1",
      provider: "openrouter",
      model: "openai/gpt-4o-mini",
      taskClass: "aux",
      promptTokens: 800,
      completionTokens: 250,
      costUsd: 0.05,
      timestamp: utcTimestampDaysAgo(referenceDate, 2, "16:00:00.000"),
    });
    store.logModelUsage({
      id: "mu-d2-conv-2",
      provider: "openrouter",
      model: "anthropic/claude-3.5-sonnet",
      taskClass: "conversation",
      promptTokens: 1800,
      completionTokens: 650,
      costUsd: 0.45,
      timestamp: utcTimestampDaysAgo(referenceDate, 2, "19:45:00.000"),
    });

    // Today (0 days ago): $0.68 total (under $1.00 cap)
    store.logModelUsage({
      id: "mu-d0-conv-1",
      provider: "openrouter",
      model: "anthropic/claude-3.5-sonnet",
      taskClass: "conversation",
      promptTokens: 1600,
      completionTokens: 550,
      costUsd: 0.48,
      timestamp: utcTimestampDaysAgo(referenceDate, 0, "10:15:00.000"),
    });
    store.logModelUsage({
      id: "mu-d0-reas-1",
      provider: "gemini",
      model: "gemini-2.0-flash",
      taskClass: "reasoning",
      promptTokens: 1100,
      completionTokens: 350,
      costUsd: 0.16,
      timestamp: utcTimestampDaysAgo(referenceDate, 0, "10:16:00.000"),
    });
    store.logModelUsage({
      id: "mu-d0-aux-1",
      provider: "openrouter",
      model: "openai/gpt-4o-mini",
      taskClass: "aux",
      promptTokens: 700,
      completionTokens: 200,
      costUsd: 0.04,
      timestamp: utcTimestampDaysAgo(referenceDate, 0, "11:00:00.000"),
    });
  } finally {
    store.close();
  }

  // Export a compact, single-file SQLite ledger via VACUUM INTO and remove staging sidecars
  rmSync(dbPath, { force: true });
  const stagingDb = new Database(stagingDbPath);
  try {
    const escapedTarget = dbPath.replace(/'/g, "''");
    stagingDb.exec(`VACUUM INTO '${escapedTarget}'`);
  } finally {
    stagingDb.close();
    rmSync(stagingDbPath, { force: true });
    rmSync(`${stagingDbPath}-wal`, { force: true });
    rmSync(`${stagingDbPath}-shm`, { force: true });
  }

  return {
    rootDir: resolvedRoot,
    clientDir,
    dataDir,
    dbPath,
    referenceDate,
    dailySpendCapUsd,
  };
}

if (import.meta.main) {
  const target = process.argv[2];
  if (!target) {
    console.error("Usage: bun tests/fixtures/usage-fixture.ts <target-dir>");
    process.exit(1);
  }
  const seeded = seedUsageFixture(target);
  console.log(`Seeded fixture ledger at ${seeded.dbPath} (client: ${seeded.clientDir})`);
}
