import { join } from "node:path";
import { FakeCalendar, GoogleCalendarAdapter, type CalendarAdapter } from "../calendar/calendar.ts";
import { loadClientConfig } from "../config/loader.ts";
import { DataStore } from "../db/store.ts";
import { CoreEngine } from "../engine/core.ts";
import { OmpEngine } from "../engine/omp.ts";
import { PiEngine } from "../engine/pi.ts";
import { buildConfiguredRouter } from "../router/providers.ts";
import type { ProviderRouter } from "../router/router.ts";
import { startWebhookServer, type RunningWebhookServer } from "../server/server.ts";
import type { EngineAdapter } from "../types/engine.ts";
import { resolveClientDailySpendCap } from "./usage.ts";

export interface ServeCliOptions {
  port?: number;
  hostname?: string;
  clientDir?: string;
  dataDir?: string;
  webhookSecret?: string;
  /**
   * Used in tests to receive the running server handle and control lifecycle cleanly
   * without blocking indefinitely on SIGINT/SIGTERM.
   */
  waitForSignal?: boolean;
}

export interface ServeHandle {
  server: RunningWebhookServer;
  store: DataStore;
  shutdown: () => Promise<void>;
}

export function parseServeArgs(args: string[]): { port?: number; hostname?: string; clientDir?: string; dataDir?: string } {
  const parsed: { port?: number; hostname?: string; clientDir?: string; dataDir?: string } = {};
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if ((arg === "--port" || arg === "-p") && args[i + 1]) {
      parsed.port = Number(args[++i]);
    } else if (arg === "--host" && args[i + 1]) {
      parsed.hostname = args[++i];
    } else if (arg === "--client-dir" && args[i + 1]) {
      parsed.clientDir = args[++i];
    } else if (arg === "--data-dir" && args[i + 1]) {
      parsed.dataDir = args[++i];
    }
  }
  return parsed;
}

export async function startServe(options: ServeCliOptions = {}): Promise<ServeHandle> {
  const baseDir = process.cwd();
  const clientDir = options.clientDir || join(baseDir, "client");
  const dataDir = options.dataDir || join(baseDir, "data");
  const dbPath = join(dataDir, "aabook.sqlite");

  const loaded = loadClientConfig(clientDir);
  if (!loaded.success || !loaded.config) {
    const details = loaded.errors.map((e) => `${e.file}: ${e.issues.join("; ")}`).join(" | ");
    throw new Error(`Invalid or missing client configuration in ${clientDir}: ${details}`);
  }

  const webhookSecret = options.webhookSecret ?? process.env.WEBHOOK_SECRET;
  if (!webhookSecret || webhookSecret.trim().length === 0) {
    throw new Error("WEBHOOK_SECRET must be set in environment (.env) before running 'aabook serve'.");
  }

  const store = new DataStore(dbPath);

  const { dailySpendCapUsd } = resolveClientDailySpendCap(clientDir);
  const router: ProviderRouter = buildConfiguredRouter({
    clientConfig: loaded.config,
    dailySpendCapUsd,
    store,
  });

  const engineChoice = (process.env.AABOOK_ENGINE || "core").toLowerCase();
  let engine: EngineAdapter;
  if (engineChoice === "omp") {
    engine = new OmpEngine();
  } else if (engineChoice === "pi") {
    engine = new PiEngine(router);
  } else {
    engine = new CoreEngine(router);
  }

  let calendar: CalendarAdapter;
  if (
    process.env.GOOGLE_CALENDAR_ID &&
    process.env.GOOGLE_CLIENT_EMAIL &&
    process.env.GOOGLE_PRIVATE_KEY
  ) {
    calendar = new GoogleCalendarAdapter(
      process.env.GOOGLE_CALENDAR_ID,
      process.env.GOOGLE_CLIENT_EMAIL,
      process.env.GOOGLE_PRIVATE_KEY
    );
  } else {
    calendar = new FakeCalendar();
  }

  const port = options.port ?? (process.env.PORT ? Number(process.env.PORT) : 3000);
  const hostname = options.hostname ?? process.env.HOST ?? "127.0.0.1";

  let server: RunningWebhookServer;
  try {
    server = startWebhookServer({
      port,
      hostname,
      webhookSecret,
      clientConfig: loaded.config,
      store,
      calendar,
      engine,
      router,
    });
  } catch (err) {
    store.close();
    throw err;
  }

  let stopped = false;
  const shutdown = async () => {
    if (stopped) return;
    stopped = true;
    await server.stop();
    store.close();
  };

  console.log(`AA Book webhook server listening on ${server.url}`);
  console.log(`- Business:       ${loaded.config.business.name}`);
  console.log(`- Voice provider: ${server.voiceAdapter.name}`);
  console.log(`- SMS provider:   ${server.smsProvider.name}`);
  console.log(`- Webhook auth:   WEBHOOK_SECRET ([REDACTED])`);

  if (options.waitForSignal !== false) {
    await new Promise<void>((resolve) => {
      const onSignal = () => {
        console.log("\nShutting down AA Book webhook server...");
        process.off("SIGINT", onSignal);
        process.off("SIGTERM", onSignal);
        shutdown().then(resolve).catch(() => resolve());
      };
      process.on("SIGINT", onSignal);
      process.on("SIGTERM", onSignal);
    });
  }

  return { server, store, shutdown };
}
