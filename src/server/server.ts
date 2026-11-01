import { serve } from "bun";
import { webhookHandler } from "./webhook.ts";
import type { DataStore } from "../db/store.ts";
import type { EngineAdapter } from "../types/engine.ts";
import type { ClientConfig } from "../types/config.ts";

export interface ServerConfig {
  port: number;
  webhookSecret: string;
  store: DataStore;
  engine: EngineAdapter;
  clientConfig: ClientConfig;
}

export function startServer(config: ServerConfig) {
  const server = serve({
    port: config.port,
    async fetch(req) {
      const url = new URL(req.url);

      if (req.method === "POST" && url.pathname.startsWith("/webhooks/")) {
        return webhookHandler(req, config);
      }

      return new Response("Not Found", { status: 404 });
    },
  });

  return server;
}
