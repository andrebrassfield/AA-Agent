import { join } from "node:path";
import { loadClientConfig } from "../config/loader.ts";
import { DataStore } from "../db/store.ts";
import { ProviderRouter } from "../router/router.ts";
import { CoreEngine } from "../engine/core.ts";
import { StubModelProvider } from "../router/stub.ts";
import { startServer } from "../server/server.ts";

export interface ServeOptions {
  clientDir?: string;
  dataDir?: string;
  port?: number;
}

export function runServe(options: ServeOptions = {}) {
  const baseDir = process.cwd();
  const clientDir = options.clientDir || join(baseDir, "client");
  const dataDir = options.dataDir || join(baseDir, "data");
  const dbPath = join(dataDir, "aabook.sqlite");
  const port = options.port || 3000;

  const webhookSecret = process.env.AABOOK_WEBHOOK_SECRET;
  if (!webhookSecret) {
      console.error("FATAL: AABOOK_WEBHOOK_SECRET environment variable is missing.");
      process.exit(1);
  }

  const loadResult = loadClientConfig(clientDir);
  if (!loadResult.success) {
      console.error("Failed to load client config:", loadResult.errors);
      process.exit(1);
  }

  const store = new DataStore(dbPath);

  const router = new ProviderRouter(
      {
          dailySpendCapUsd: 1.0,
          routes: {
              conversation: { chain: [{ provider: "stub-nim", model: "meta/llama-3-70b-instruct" }] },
              reasoning: { chain: [{ provider: "stub-gemini", model: "google/gemini-1.5-flash" }] },
              aux: { chain: [{ provider: "stub-openrouter", model: "meta/llama-3-8b-instruct:free" }] },
          },
      },
      store
  );

  router.registerProvider(new StubModelProvider("stub-nim"));
  router.registerProvider(new StubModelProvider("stub-gemini"));
  router.registerProvider(new StubModelProvider("stub-openrouter"));

  const engine = new CoreEngine(router);

  const server = startServer({
      port,
      webhookSecret,
      store,
      engine,
      clientConfig: loadResult.config!,
  });

  console.log(`Webhook server started on port ${port}`);

  // Handle clean shutdown
  process.on("SIGINT", () => {
      console.log("\nShutting down...");
      server.stop(true);
      store.close();
      process.exit(0);
  });
}
