import { Database } from "bun:sqlite";
import { existsSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { isTodoPlaceholder } from "../config/validator.ts";
import type { ModelUsageLog } from "../types/db.ts";
import type { TaskClass } from "../types/router.ts";

export const DEFAULT_USAGE_DAYS = 7;
export const DEFAULT_DAILY_SPEND_CAP_USD = 5.0;

const CANONICAL_TASK_CLASSES: TaskClass[] = ["conversation", "reasoning", "aux"];

export class UsageReportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UsageReportError";
  }
}

export interface UsageOptions {
  days?: number;
  client?: string;
  baseDir?: string;
  dataDir?: string;
  dbPath?: string;
  dailySpendCapUsd?: number;
  now?: Date;
  silent?: boolean;
}

export interface UsageTotals {
  callCount: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  costUsd: number;
}

export interface DayUsageSummary extends UsageTotals {
  date: string;
  dailyCapUsd: number;
  capUtilizationPct: number;
  remainingCapUsd: number;
  overCapUsd: number;
  exceededCap: boolean;
  reachedCap: boolean;
}

export interface TaskClassUsageSummary extends UsageTotals {
  taskClass: string;
  shareOfSpendPct: number;
}

export interface ProviderUsageSummary extends UsageTotals {
  provider: string;
  shareOfSpendPct: number;
}

export interface ModelUsageSummary extends UsageTotals {
  model: string;
  providers: string[];
  shareOfSpendPct: number;
}

export interface CapSummary {
  dailySpendCapUsd: number;
  capSource: string;
  windowCapBudgetUsd: number;
  windowSpendPctOfBudget: number;
  averageDailySpendUsd: number;
  todayDate: string;
  todaySpendUsd: number;
  todayCapUtilizationPct: number;
  peakDay: {
    date: string;
    costUsd: number;
    capUtilizationPct: number;
    exceededCap: boolean;
  } | null;
  daysExceedingCap: DayUsageSummary[];
}

export interface UsageReportResult {
  clientName: string;
  clientConfigDir: string;
  dbPath: string;
  ledgerExists: boolean;
  window: {
    days: number;
    startDate: string;
    endDate: string;
  };
  totals: UsageTotals;
  capSummary: CapSummary;
  byDay: DayUsageSummary[];
  byTaskClass: TaskClassUsageSummary[];
  byProvider: ProviderUsageSummary[];
  byModel: ModelUsageSummary[];
  plainSummary: string;
  formattedReport: string;
}

function roundUsd(value: number): number {
  return Math.round((value + Number.EPSILON) * 1_000_000) / 1_000_000;
}

function roundPct(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

export function formatApproxDollars(costUsd: number): string {
  if (costUsd <= 0) {
    return "$0.00";
  }
  if (costUsd < 0.01) {
    return `$${costUsd.toFixed(4)}`;
  }
  return `$${costUsd.toFixed(2)}`;
}

export function formatPlainUsageSummary(days: number, totalCostUsd: number): string {
  const approx = formatApproxDollars(totalCostUsd);
  if (days === 7) {
    return `This week the front desk cost about ${approx} in model calls.`;
  }
  if (days === 1) {
    return `Today the front desk cost about ${approx} in model calls.`;
  }
  return `Over the last ${days} days, the front desk cost about ${approx} in model calls.`;
}

function parsePositiveIntDays(raw: string): number {
  const trimmed = raw.trim();
  if (!/^\d+$/.test(trimmed)) {
    throw new UsageReportError(
      `Invalid --days value '${raw}'. Expected a positive whole number of days (for example: --days 7).`
    );
  }
  const parsed = Number(trimmed);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new UsageReportError(
      `Invalid --days value '${raw}'. --days must be at least 1.`
    );
  }
  return parsed;
}

export function parseUsageArgs(args: string[]): UsageOptions {
  const parsed: UsageOptions = {};

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;

    if (arg === "--days" || arg === "-d") {
      const next = args[i + 1];
      if (!next || next.startsWith("-")) {
        // Still pass negative numbers like -5 to parsePositiveIntDays for a clear error
        if (next && /^-\d/.test(next)) {
          parsed.days = parsePositiveIntDays(next);
          i++;
          continue;
        }
        throw new UsageReportError(
          "Missing value for --days. Usage: aabook usage [--days N] [--client <folder>]"
        );
      }
      parsed.days = parsePositiveIntDays(next);
      i++;
    } else if (arg.startsWith("--days=")) {
      parsed.days = parsePositiveIntDays(arg.slice("--days=".length));
    } else if (arg === "--client" || arg === "--client-dir") {
      const next = args[i + 1];
      if (!next || next.startsWith("-")) {
        throw new UsageReportError(
          "Missing folder path for --client. Usage: aabook usage [--days N] [--client <folder>]"
        );
      }
      parsed.client = next;
      i++;
    } else if (arg.startsWith("--client=")) {
      const val = arg.slice("--client=".length).trim();
      if (!val) {
        throw new UsageReportError(
          "Missing folder path for --client. Usage: aabook usage [--days N] [--client <folder>]"
        );
      }
      parsed.client = val;
    } else if (arg === "--data-dir") {
      const next = args[i + 1];
      if (!next || next.startsWith("-")) {
        throw new UsageReportError(
          "Missing folder path for --data-dir. Usage: aabook usage [--days N] [--client <folder>]"
        );
      }
      parsed.dataDir = next;
      i++;
    } else if (arg.startsWith("--data-dir=")) {
      const val = arg.slice("--data-dir=".length).trim();
      if (!val) {
        throw new UsageReportError("Missing folder path for --data-dir.");
      }
      parsed.dataDir = val;
    } else {
      throw new UsageReportError(
        `Unknown option '${arg}' for 'aabook usage'. Usage: aabook usage [--days N] [--client <folder>]`
      );
    }
  }

  return parsed;
}

function readJsonObjectSafe(filePath: string): Record<string, unknown> | null {
  if (!existsSync(filePath)) return null;
  try {
    const raw = readFileSync(filePath, "utf-8");
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    return null;
  } catch {
    return null;
  }
}

export function resolveClientDailySpendCap(
  clientConfigDir: string,
  explicitCapUsd?: number
): { dailySpendCapUsd: number; capSource: string } {
  if (typeof explicitCapUsd === "number" && Number.isFinite(explicitCapUsd) && explicitCapUsd > 0) {
    return { dailySpendCapUsd: explicitCapUsd, capSource: "option" };
  }

  const routerJson = readJsonObjectSafe(join(clientConfigDir, "router.json"));
  if (
    routerJson &&
    typeof routerJson.dailySpendCapUsd === "number" &&
    Number.isFinite(routerJson.dailySpendCapUsd) &&
    routerJson.dailySpendCapUsd > 0
  ) {
    return { dailySpendCapUsd: routerJson.dailySpendCapUsd, capSource: "client/router.json" };
  }

  const policiesJson = readJsonObjectSafe(join(clientConfigDir, "policies.json"));
  if (
    policiesJson &&
    typeof policiesJson.dailySpendCapUsd === "number" &&
    Number.isFinite(policiesJson.dailySpendCapUsd) &&
    policiesJson.dailySpendCapUsd > 0
  ) {
    return { dailySpendCapUsd: policiesJson.dailySpendCapUsd, capSource: "client/policies.json" };
  }

  const envRaw = process.env.DAILY_SPEND_CAP_USD;
  if (envRaw && envRaw.trim().length > 0) {
    const envVal = Number(envRaw.trim());
    if (Number.isFinite(envVal) && envVal > 0) {
      return { dailySpendCapUsd: envVal, capSource: "env (DAILY_SPEND_CAP_USD)" };
    }
  }

  return { dailySpendCapUsd: DEFAULT_DAILY_SPEND_CAP_USD, capSource: "default ($5.00/day)" };
}

function resolveUsageTargets(options: UsageOptions): {
  clientConfigDir: string;
  dbPath: string;
  clientName: string;
} {
  const baseDir = resolve(options.baseDir || process.cwd());

  let clientConfigDir: string;
  let dbPath: string;

  if (options.client) {
    const targetPath = resolve(baseDir, options.client);
    if (!existsSync(targetPath)) {
      throw new UsageReportError(`Client folder not found: ${targetPath}`);
    }
    const st = statSync(targetPath);
    if (!st.isDirectory()) {
      throw new UsageReportError(`--client path must be a directory: ${targetPath}`);
    }

    if (existsSync(join(targetPath, "business.json"))) {
      clientConfigDir = targetPath;
    } else if (existsSync(join(targetPath, "client", "business.json"))) {
      clientConfigDir = join(targetPath, "client");
    } else {
      clientConfigDir = targetPath;
    }

    if (options.dbPath) {
      dbPath = resolve(baseDir, options.dbPath);
    } else if (options.dataDir) {
      dbPath = join(resolve(baseDir, options.dataDir), "aabook.sqlite");
    } else {
      const candidates = [
        join(targetPath, "data", "aabook.sqlite"),
        join(targetPath, "aabook.sqlite"),
        join(dirname(targetPath), "data", "aabook.sqlite"),
        join(baseDir, "data", "aabook.sqlite"),
      ];
      dbPath = candidates.find((candidate) => existsSync(candidate)) ?? candidates[0]!;
    }
  } else {
    clientConfigDir = join(baseDir, "client");
    if (options.dbPath) {
      dbPath = resolve(baseDir, options.dbPath);
    } else if (options.dataDir) {
      dbPath = join(resolve(baseDir, options.dataDir), "aabook.sqlite");
    } else {
      dbPath = join(baseDir, "data", "aabook.sqlite");
    }
  }

  const businessJson = readJsonObjectSafe(join(clientConfigDir, "business.json"));
  const rawName = businessJson?.name;
  const clientName =
    typeof rawName === "string" && rawName.trim().length > 0 && !isTodoPlaceholder(rawName)
      ? rawName.trim()
      : basename(clientConfigDir) === "client"
        ? basename(dirname(clientConfigDir)) || "Unconfigured Client"
        : basename(clientConfigDir);

  return { clientConfigDir, dbPath, clientName };
}

function computeUtcWindow(days: number, now: Date): { startDate: string; endDate: string } {
  const endUtcMidnight = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const startUtcMidnight = endUtcMidnight - (days - 1) * 86_400_000;
  return {
    startDate: new Date(startUtcMidnight).toISOString().slice(0, 10),
    endDate: new Date(endUtcMidnight).toISOString().slice(0, 10),
  };
}

/**
 * Strictly read-only query against the SQLite model_usage ledger.
 * Never creates directories, never creates a missing database file, and opens existing
 * SQLite files with { readonly: true } so zero writes can ever occur.
 */
function readModelUsageWindowReadOnly(
  dbPath: string,
  startDate: string,
  endDate: string
): { ledgerExists: boolean; rows: ModelUsageLog[] } {
  if (!existsSync(dbPath)) {
    return { ledgerExists: false, rows: [] };
  }

  const db = new Database(dbPath, { readonly: true });
  try {
    const tableRow = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'model_usage'")
      .get() as { name: string } | null;

    if (!tableRow) {
      return { ledgerExists: true, rows: [] };
    }

    const stmt = db.prepare(`
      SELECT id, provider, model, taskClass, promptTokens, completionTokens, costUsd, timestamp
      FROM model_usage
      WHERE substr(timestamp, 1, 10) >= $startDate
        AND substr(timestamp, 1, 10) <= $endDate
      ORDER BY timestamp ASC, rowid ASC
    `);

    const rows = stmt.all({
      $startDate: startDate,
      $endDate: endDate,
    }) as ModelUsageLog[];

    return { ledgerExists: true, rows };
  } finally {
    db.close();
  }
}

interface MutableBucket {
  callCount: number;
  promptTokens: number;
  completionTokens: number;
  costUsd: number;
}

function emptyBucket(): MutableBucket {
  return { callCount: 0, promptTokens: 0, completionTokens: 0, costUsd: 0 };
}

function addRowToBucket(bucket: MutableBucket, row: ModelUsageLog): void {
  bucket.callCount += 1;
  bucket.promptTokens += Number(row.promptTokens) || 0;
  bucket.completionTokens += Number(row.completionTokens) || 0;
  bucket.costUsd = roundUsd(bucket.costUsd + (Number(row.costUsd) || 0));
}

function bucketToTotals(bucket: MutableBucket): UsageTotals {
  return {
    callCount: bucket.callCount,
    promptTokens: bucket.promptTokens,
    completionTokens: bucket.completionTokens,
    totalTokens: bucket.promptTokens + bucket.completionTokens,
    costUsd: roundUsd(bucket.costUsd),
  };
}

function padRight(str: string, width: number): string {
  return str.length >= width ? str : str + " ".repeat(width - str.length);
}

function padLeft(str: string, width: number): string {
  return str.length >= width ? str : " ".repeat(width - str.length) + str;
}

function buildFormattedReport(report: Omit<UsageReportResult, "formattedReport">): string {
  const lines: string[] = [];
  const cap = report.capSummary.dailySpendCapUsd;

  lines.push("===============================================================");
  lines.push("                  AA BOOK MODEL USAGE REPORT                   ");
  lines.push("===============================================================");
  lines.push(`Client:          ${report.clientName}`);
  lines.push(`Client Folder:   ${report.clientConfigDir}`);
  lines.push(
    `Usage Ledger:    ${report.dbPath} (${report.ledgerExists ? "read-only" : "not created yet — 0 calls"})`
  );
  lines.push(
    `Window:          ${report.window.startDate} to ${report.window.endDate} (${report.window.days} day${report.window.days === 1 ? "" : "s"})`
  );
  lines.push(`Daily Spend Cap: $${cap.toFixed(2)}/day (${report.capSummary.capSource})`);
  lines.push("---------------------------------------------------------------");
  lines.push(`Owner Summary:   "${report.plainSummary}"`);
  lines.push("---------------------------------------------------------------");

  lines.push("Spend vs. Configured Daily Cap:");
  lines.push(
    `  Window Spend:      $${report.totals.costUsd.toFixed(4)} / $${report.capSummary.windowCapBudgetUsd.toFixed(2)} (${report.capSummary.windowSpendPctOfBudget.toFixed(1)}% of ${report.window.days}-day cap budget)`
  );
  lines.push(`  Avg Daily Spend:   $${report.capSummary.averageDailySpendUsd.toFixed(4)}/day`);
  lines.push(
    `  Today (${report.capSummary.todayDate}): $${report.capSummary.todaySpendUsd.toFixed(4)} / $${cap.toFixed(2)} (${report.capSummary.todayCapUtilizationPct.toFixed(1)}% of daily cap)`
  );
  if (report.capSummary.daysExceedingCap.length > 0) {
    const overList = report.capSummary.daysExceedingCap
      .map((d) => `${d.date} ($${d.costUsd.toFixed(4)}, +$${d.overCapUsd.toFixed(4)} over cap)`)
      .join("; ");
    lines.push(`  Days Over Cap:     ${report.capSummary.daysExceedingCap.length} — ${overList}`);
  } else {
    lines.push("  Days Over Cap:     0 (all days within daily spend cap)");
  }

  lines.push("");
  lines.push(
    `Totals (${report.window.days}d): ${report.totals.callCount} calls | ${report.totals.totalTokens.toLocaleString("en-US")} tokens (${report.totals.promptTokens.toLocaleString("en-US")} in / ${report.totals.completionTokens.toLocaleString("en-US")} out) | $${report.totals.costUsd.toFixed(4)}`
  );

  lines.push("");
  lines.push("By Day:");
  if (report.byDay.length === 0) {
    lines.push("  (no model calls recorded in this window)");
  } else {
    lines.push(
      `  ${padRight("Date", 12)} ${padLeft("Calls", 6)} ${padLeft("Tokens", 10)} ${padLeft("Spend", 10)} ${padLeft("% Cap", 8)}  Status`
    );
    for (const day of report.byDay) {
      const status = day.exceededCap
        ? `OVER CAP (+$${day.overCapUsd.toFixed(4)})`
        : day.reachedCap
          ? "AT CAP (aux degraded)"
          : `within cap ($${day.remainingCapUsd.toFixed(4)} left)`;
      lines.push(
        `  ${padRight(day.date, 12)} ${padLeft(String(day.callCount), 6)} ${padLeft(String(day.totalTokens), 10)} ${padLeft(`$${day.costUsd.toFixed(4)}`, 10)} ${padLeft(`${day.capUtilizationPct.toFixed(1)}%`, 8)}  ${status}`
      );
    }
  }

  lines.push("");
  lines.push("By Task Class:");
  lines.push(
    `  ${padRight("Task Class", 14)} ${padLeft("Calls", 6)} ${padLeft("Prompt", 9)} ${padLeft("Compl.", 9)} ${padLeft("Spend", 10)} ${padLeft("Share", 8)}`
  );
  for (const tc of report.byTaskClass) {
    lines.push(
      `  ${padRight(tc.taskClass, 14)} ${padLeft(String(tc.callCount), 6)} ${padLeft(String(tc.promptTokens), 9)} ${padLeft(String(tc.completionTokens), 9)} ${padLeft(`$${tc.costUsd.toFixed(4)}`, 10)} ${padLeft(`${tc.shareOfSpendPct.toFixed(1)}%`, 8)}`
    );
  }

  lines.push("");
  lines.push("By Provider:");
  if (report.byProvider.length === 0) {
    lines.push("  (none)");
  } else {
    lines.push(
      `  ${padRight("Provider", 20)} ${padLeft("Calls", 6)} ${padLeft("Tokens", 10)} ${padLeft("Spend", 10)} ${padLeft("Share", 8)}`
    );
    for (const prov of report.byProvider) {
      lines.push(
        `  ${padRight(prov.provider, 20)} ${padLeft(String(prov.callCount), 6)} ${padLeft(String(prov.totalTokens), 10)} ${padLeft(`$${prov.costUsd.toFixed(4)}`, 10)} ${padLeft(`${prov.shareOfSpendPct.toFixed(1)}%`, 8)}`
      );
    }
  }

  lines.push("");
  lines.push("By Model:");
  if (report.byModel.length === 0) {
    lines.push("  (none)");
  } else {
    lines.push(
      `  ${padRight("Model", 32)} ${padLeft("Calls", 6)} ${padLeft("Tokens", 10)} ${padLeft("Spend", 10)} ${padLeft("Share", 8)}`
    );
    for (const mod of report.byModel) {
      lines.push(
        `  ${padRight(mod.model, 32)} ${padLeft(String(mod.callCount), 6)} ${padLeft(String(mod.totalTokens), 10)} ${padLeft(`$${mod.costUsd.toFixed(4)}`, 10)} ${padLeft(`${mod.shareOfSpendPct.toFixed(1)}%`, 8)}`
      );
    }
  }

  lines.push("===============================================================");
  return lines.join("\n");
}

export function runUsage(options: UsageOptions = {}): UsageReportResult {
  const days = options.days ?? DEFAULT_USAGE_DAYS;
  if (!Number.isSafeInteger(days) || days < 1) {
    throw new UsageReportError(`Invalid days window '${days}'. Expected a positive integer.`);
  }

  const now = options.now ?? new Date();
  const { startDate, endDate } = computeUtcWindow(days, now);
  const { clientConfigDir, dbPath, clientName } = resolveUsageTargets(options);
  const { dailySpendCapUsd, capSource } = resolveClientDailySpendCap(
    clientConfigDir,
    options.dailySpendCapUsd
  );

  const { ledgerExists, rows } = readModelUsageWindowReadOnly(dbPath, startDate, endDate);

  const overallBucket = emptyBucket();
  const dayBuckets = new Map<string, MutableBucket>();
  const taskClassBuckets = new Map<string, MutableBucket>();
  for (const tc of CANONICAL_TASK_CLASSES) {
    taskClassBuckets.set(tc, emptyBucket());
  }
  const providerBuckets = new Map<string, MutableBucket>();
  const modelBuckets = new Map<string, { bucket: MutableBucket; providers: Set<string> }>();

  for (const row of rows) {
    const dayKey = row.timestamp.slice(0, 10);
    addRowToBucket(overallBucket, row);

    let dBucket = dayBuckets.get(dayKey);
    if (!dBucket) {
      dBucket = emptyBucket();
      dayBuckets.set(dayKey, dBucket);
    }
    addRowToBucket(dBucket, row);

    let tcBucket = taskClassBuckets.get(row.taskClass);
    if (!tcBucket) {
      tcBucket = emptyBucket();
      taskClassBuckets.set(row.taskClass, tcBucket);
    }
    addRowToBucket(tcBucket, row);

    let pBucket = providerBuckets.get(row.provider);
    if (!pBucket) {
      pBucket = emptyBucket();
      providerBuckets.set(row.provider, pBucket);
    }
    addRowToBucket(pBucket, row);

    let mEntry = modelBuckets.get(row.model);
    if (!mEntry) {
      mEntry = { bucket: emptyBucket(), providers: new Set<string>() };
      modelBuckets.set(row.model, mEntry);
    }
    addRowToBucket(mEntry.bucket, row);
    mEntry.providers.add(row.provider);
  }

  const totals = bucketToTotals(overallBucket);
  const sharePct = (costUsd: number): number =>
    totals.costUsd > 0 ? roundPct((costUsd / totals.costUsd) * 100) : 0;

  const byDay: DayUsageSummary[] = Array.from(dayBuckets.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, bucket]) => {
      const base = bucketToTotals(bucket);
      const capUtilizationPct = roundPct((base.costUsd / dailySpendCapUsd) * 100);
      const remainingCapUsd = roundUsd(Math.max(0, dailySpendCapUsd - base.costUsd));
      const overCapUsd = roundUsd(Math.max(0, base.costUsd - dailySpendCapUsd));
      return {
        date,
        ...base,
        dailyCapUsd: dailySpendCapUsd,
        capUtilizationPct,
        remainingCapUsd,
        overCapUsd,
        exceededCap: base.costUsd > dailySpendCapUsd,
        reachedCap: base.costUsd >= dailySpendCapUsd,
      };
    });

  const byTaskClass: TaskClassUsageSummary[] = Array.from(taskClassBuckets.entries()).map(
    ([taskClass, bucket]) => {
      const base = bucketToTotals(bucket);
      return {
        taskClass,
        ...base,
        shareOfSpendPct: sharePct(base.costUsd),
      };
    }
  );

  const byProvider: ProviderUsageSummary[] = Array.from(providerBuckets.entries())
    .map(([provider, bucket]) => {
      const base = bucketToTotals(bucket);
      return {
        provider,
        ...base,
        shareOfSpendPct: sharePct(base.costUsd),
      };
    })
    .sort(
      (a, b) =>
        b.costUsd - a.costUsd || b.callCount - a.callCount || a.provider.localeCompare(b.provider)
    );

  const byModel: ModelUsageSummary[] = Array.from(modelBuckets.entries())
    .map(([model, entry]) => {
      const base = bucketToTotals(entry.bucket);
      return {
        model,
        providers: Array.from(entry.providers).sort(),
        ...base,
        shareOfSpendPct: sharePct(base.costUsd),
      };
    })
    .sort(
      (a, b) =>
        b.costUsd - a.costUsd || b.callCount - a.callCount || a.model.localeCompare(b.model)
    );

  const windowCapBudgetUsd = roundUsd(dailySpendCapUsd * days);
  const windowSpendPctOfBudget = roundPct((totals.costUsd / windowCapBudgetUsd) * 100);
  const averageDailySpendUsd = roundUsd(totals.costUsd / days);

  const todayEntry = byDay.find((d) => d.date === endDate);
  const todaySpendUsd = todayEntry ? todayEntry.costUsd : 0;
  const todayCapUtilizationPct = roundPct((todaySpendUsd / dailySpendCapUsd) * 100);

  let peakDay: CapSummary["peakDay"] = null;
  for (const d of byDay) {
    if (!peakDay || d.costUsd > peakDay.costUsd) {
      peakDay = {
        date: d.date,
        costUsd: d.costUsd,
        capUtilizationPct: d.capUtilizationPct,
        exceededCap: d.exceededCap,
      };
    }
  }

  const daysExceedingCap = byDay.filter((d) => d.exceededCap);

  const capSummary: CapSummary = {
    dailySpendCapUsd,
    capSource,
    windowCapBudgetUsd,
    windowSpendPctOfBudget,
    averageDailySpendUsd,
    todayDate: endDate,
    todaySpendUsd,
    todayCapUtilizationPct,
    peakDay,
    daysExceedingCap,
  };

  const plainSummary = formatPlainUsageSummary(days, totals.costUsd);

  const baseResult: Omit<UsageReportResult, "formattedReport"> = {
    clientName,
    clientConfigDir,
    dbPath,
    ledgerExists,
    window: { days, startDate, endDate },
    totals,
    capSummary,
    byDay,
    byTaskClass,
    byProvider,
    byModel,
    plainSummary,
  };

  const formattedReport = buildFormattedReport(baseResult);
  if (!options.silent) {
    console.log(formattedReport);
  }

  return {
    ...baseResult,
    formattedReport,
  };
}
