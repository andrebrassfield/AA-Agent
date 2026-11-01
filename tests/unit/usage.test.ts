import { describe, expect, it } from "bun:test";
import * as crypto from "node:crypto";
import { chmodSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runUsage } from "../../src/cli/usage.ts";
import { DataStore } from "../../src/db/store.ts";
import { main } from "../../src/index.ts";
import { seedUsageFixture } from "../fixtures/usage-fixture.ts";

describe("aabook usage (Read-Only Model Spend Report)", () => {
  it("aggregates totals by day, task class, provider, and model and computes cap math including an over-cap day", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "aabook-usage-math-"));
    try {
      const fixedNow = new Date("2026-11-01T18:00:00.000Z");
      const seeded = seedUsageFixture(tempDir, fixedNow, 1.0);

      const report7d = runUsage({
        client: seeded.clientDir,
        days: 7,
        now: fixedNow,
        silent: true,
      });

      expect(report7d.clientName).toBe("Fort Smith Heating & Air");
      expect(report7d.ledgerExists).toBe(true);
      expect(report7d.window).toEqual({
        days: 7,
        startDate: "2026-10-26",
        endDate: "2026-11-01",
      });

      // Overall 7-day totals (excludes the row from 9 days ago on 2026-10-23)
      expect(report7d.totals).toEqual({
        callCount: 10,
        promptTokens: 12800,
        completionTokens: 4200,
        totalTokens: 17000,
        costUsd: 2.45,
      });

      // Plain-language owner summary
      expect(report7d.plainSummary).toBe(
        "This week the front desk cost about $2.45 in model calls."
      );
      expect(report7d.formattedReport).toContain(report7d.plainSummary);
      expect(report7d.formattedReport).toContain("OVER CAP (+$0.3500)");

      // Cap math against $1.00/day configured in client/policies.json
      expect(report7d.capSummary.dailySpendCapUsd).toBe(1.0);
      expect(report7d.capSummary.capSource).toBe("client/policies.json");
      expect(report7d.capSummary.windowCapBudgetUsd).toBe(7.0);
      expect(report7d.capSummary.windowSpendPctOfBudget).toBe(35);
      expect(report7d.capSummary.averageDailySpendUsd).toBe(0.35);
      expect(report7d.capSummary.todayDate).toBe("2026-11-01");
      expect(report7d.capSummary.todaySpendUsd).toBe(0.68);
      expect(report7d.capSummary.todayCapUtilizationPct).toBe(68);
      expect(report7d.capSummary.daysExceedingCap).toHaveLength(1);
      expect(report7d.capSummary.daysExceedingCap[0]).toMatchObject({
        date: "2026-10-30",
        callCount: 4,
        totalTokens: 8550,
        costUsd: 1.35,
        dailyCapUsd: 1.0,
        capUtilizationPct: 135,
        remainingCapUsd: 0,
        overCapUsd: 0.35,
        exceededCap: true,
        reachedCap: true,
      });

      // Totals by day
      expect(report7d.byDay.map((d) => ({ date: d.date, costUsd: d.costUsd, exceededCap: d.exceededCap }))).toEqual([
        { date: "2026-10-28", costUsd: 0.42, exceededCap: false },
        { date: "2026-10-30", costUsd: 1.35, exceededCap: true },
        { date: "2026-11-01", costUsd: 0.68, exceededCap: false },
      ]);

      // Totals by task class
      expect(report7d.byTaskClass).toEqual([
        {
          taskClass: "conversation",
          callCount: 4,
          promptTokens: 7300,
          completionTokens: 2500,
          totalTokens: 9800,
          costUsd: 1.88,
          shareOfSpendPct: 76.73,
        },
        {
          taskClass: "reasoning",
          callCount: 3,
          promptTokens: 3400,
          completionTokens: 1100,
          totalTokens: 4500,
          costUsd: 0.48,
          shareOfSpendPct: 19.59,
        },
        {
          taskClass: "aux",
          callCount: 3,
          promptTokens: 2100,
          completionTokens: 600,
          totalTokens: 2700,
          costUsd: 0.09,
          shareOfSpendPct: 3.67,
        },
      ]);

      // Totals by provider
      expect(report7d.byProvider.map((p) => ({ provider: p.provider, callCount: p.callCount, costUsd: p.costUsd }))).toEqual([
        { provider: "openrouter", callCount: 6, costUsd: 1.97 },
        { provider: "gemini", callCount: 3, costUsd: 0.48 },
        { provider: "nvidia-nim", callCount: 1, costUsd: 0.0 },
      ]);

      // Totals by model
      expect(report7d.byModel.map((m) => ({ model: m.model, callCount: m.callCount, costUsd: m.costUsd }))).toEqual([
        { model: "anthropic/claude-3.5-sonnet", callCount: 4, costUsd: 1.88 },
        { model: "gemini-2.0-flash", callCount: 3, costUsd: 0.48 },
        { model: "openai/gpt-4o-mini", callCount: 2, costUsd: 0.09 },
        { model: "meta/llama-3.1-8b-instruct", callCount: 1, costUsd: 0.0 },
      ]);

      // Expanding to --days 14 includes the older 9-days-ago entry (+$0.50 -> $2.95)
      const report14d = runUsage({
        client: seeded.rootDir,
        days: 14,
        now: fixedNow,
        silent: true,
      });
      expect(report14d.totals.callCount).toBe(11);
      expect(report14d.totals.costUsd).toBe(2.95);
      expect(report14d.plainSummary).toBe(
        "Over the last 14 days, the front desk cost about $2.95 in model calls."
      );
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("is strictly read-only: never creates a missing database and never mutates a read-only ledger", async () => {
    const emptyBase = mkdtempSync(join(tmpdir(), "aabook-usage-empty-"));
    const seededBase = mkdtempSync(join(tmpdir(), "aabook-usage-ro-"));
    try {
      // 1. Missing ledger: zero files or folders created on disk
      const emptyClientDir = join(emptyBase, "templates-copy");
      const emptyDataDir = join(emptyBase, "data");
      const missingRes = runUsage({
        baseDir: emptyBase,
        silent: true,
      });
      expect(missingRes.ledgerExists).toBe(false);
      expect(missingRes.totals.costUsd).toBe(0);
      expect(missingRes.plainSummary).toBe(
        "This week the front desk cost about $0.00 in model calls."
      );
      expect(existsSync(emptyDataDir)).toBe(false);
      expect(existsSync(emptyClientDir)).toBe(false);

      // 2. Existing ledger locked read-only (0o444): succeeds and leaves byte hash & directory untouched
      const seeded = seedUsageFixture(seededBase);
      const beforeBytes = readFileSync(seeded.dbPath);
      const beforeSha = crypto.createHash("sha256").update(beforeBytes).digest("hex");
      const beforeDataEntries = readdirSync(seeded.dataDir).sort();

      chmodSync(seeded.dbPath, 0o444);

      const exitCode = await main(["usage", "--days", "7", "--client", seeded.clientDir]);
      expect(exitCode).toBe(0);

      const afterBytes = readFileSync(seeded.dbPath);
      const afterSha = crypto.createHash("sha256").update(afterBytes).digest("hex");
      const afterDataEntries = readdirSync(seeded.dataDir).sort();

      expect(afterSha).toBe(beforeSha);
      expect(afterDataEntries).toEqual(beforeDataEntries);

      // 3. Live open WAL DataStore (as during 'aabook serve'): reads without adding rows
      chmodSync(seeded.dbPath, 0o644);
      const liveStore = new DataStore(seeded.dbPath);
      try {
        const countBefore = liveStore.listModelUsage().length;
        const walReport = runUsage({ client: seeded.clientDir, days: 7, silent: true });
        expect(walReport.totals.callCount).toBe(10);
        expect(liveStore.listModelUsage().length).toBe(countBefore);
      } finally {
        liveStore.close();
      }
    } finally {
      try {
        chmodSync(join(seededBase, "data", "aabook.sqlite"), 0o644);
      } catch {
        // Ignore if not created
      }
      rmSync(emptyBase, { recursive: true, force: true });
      rmSync(seededBase, { recursive: true, force: true });
    }
  });

  it("supports --days 1 and --client via CLI main() and rejects invalid flags cleanly", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "aabook-usage-cli-"));
    try {
      const seeded = seedUsageFixture(tempDir);

      const okCode = await main(["usage", "--days", "1", "--client", seeded.clientDir]);
      expect(okCode).toBe(0);

      const zeroDaysCode = await main(["usage", "--days", "0"]);
      expect(zeroDaysCode).toBe(1);

      const negDaysCode = await main(["usage", "--days", "-5"]);
      expect(negDaysCode).toBe(1);

      const badClientCode = await main(["usage", "--client", join(tempDir, "does-not-exist")]);
      expect(badClientCode).toBe(1);

      const unknownFlagCode = await main(["usage", "--bogus"]);
      expect(unknownFlagCode).toBe(1);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
