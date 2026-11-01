import * as crypto from "node:crypto";
import type { CalendarAdapter } from "../calendar/calendar.ts";
import { ChannelCoordinator } from "../channels/coordinator.ts";
import { ChannelAdapterRegistry } from "../channels/registry.ts";
import type { DataStore } from "../db/store.ts";
import type { ProviderRouter } from "../router/router.ts";
import {
  ChannelValidationError,
  type SmsProvider,
  type VoiceProviderAdapter,
} from "../types/channels.ts";
import type { ClientConfig } from "../types/config.ts";
import type { EngineAdapter } from "../types/engine.ts";
import { collectEnvSecrets, redactSecrets, redactString } from "./redact.ts";

export interface WebhookServerOptions {
  port?: number;
  hostname?: string;
  webhookSecret?: string;
  clientConfig: ClientConfig;
  store: DataStore;
  calendar: CalendarAdapter;
  engine: EngineAdapter;
  router: ProviderRouter;
  registry?: ChannelAdapterRegistry;
  voiceAdapter?: VoiceProviderAdapter;
  smsProvider?: SmsProvider;
}

export interface RunningWebhookServer {
  port: number;
  url: string;
  voiceAdapter: VoiceProviderAdapter;
  smsProvider: SmsProvider;
  stop: () => Promise<void>;
}

function extractRequestSecret(req: Request): string | null {
  const direct = req.headers.get("x-webhook-secret") ?? req.headers.get("x-aabook-secret");
  if (direct !== null) {
    return direct.trim();
  }
  const auth = req.headers.get("authorization");
  if (auth && auth.toLowerCase().startsWith("bearer ")) {
    return auth.slice(7).trim();
  }
  return null;
}

function verifySecretConstantTime(provided: string | null, expected: string): boolean {
  if (!provided) return false;
  const a = Buffer.from(provided, "utf-8");
  const b = Buffer.from(expected, "utf-8");
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

function jsonResponse(body: Record<string, unknown>, status: number = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
}

export function startWebhookServer(options: WebhookServerOptions): RunningWebhookServer {
  const expectedSecret = (options.webhookSecret ?? process.env.WEBHOOK_SECRET ?? "").trim();
  if (!expectedSecret) {
    throw new Error(
      "WEBHOOK_SECRET environment variable is required to start the AA Book webhook server."
    );
  }

  const registry = options.registry ?? new ChannelAdapterRegistry();
  const voiceAdapter = options.voiceAdapter ?? registry.resolveVoiceAdapter(options.clientConfig);
  const smsProvider = options.smsProvider ?? registry.resolveSmsProvider(options.clientConfig);

  const coordinator = new ChannelCoordinator({
    clientConfig: options.clientConfig,
    store: options.store,
    calendar: options.calendar,
    engine: options.engine,
    router: options.router,
    smsProvider,
  });

  const server = Bun.serve({
    port: options.port ?? 3000,
    hostname: options.hostname ?? "127.0.0.1",
    async fetch(req: Request): Promise<Response> {
      const url = new URL(req.url);
      const pathname = url.pathname;
      const providedSecret = extractRequestSecret(req);
      const requestSecrets = collectEnvSecrets([expectedSecret, providedSecret ?? undefined]);

      const rawHeaders: Record<string, string> = {};
      req.headers.forEach((value, key) => {
        rawHeaders[key] = value;
      });
      const safeHeaders = redactSecrets(rawHeaders, requestSecrets) as Record<string, unknown>;

      // 1. Shared secret check on every request
      if (!verifySecretConstantTime(providedSecret, expectedSecret)) {
        const reason = providedSecret ? "invalid_secret" : "missing_secret";
        options.store.logAudit({
          id: options.store.generateId("aud-auth"),
          action: "WEBHOOK_AUTH_REJECTED",
          entityType: "webhook",
          entityId: pathname,
          details: {
            method: req.method,
            path: pathname,
            reason,
            headers: safeHeaders,
          },
          timestamp: new Date().toISOString(),
        });
        return jsonResponse(
          {
            error:
              reason === "missing_secret"
                ? "Unauthorized: missing webhook secret"
                : "Unauthorized: invalid webhook secret",
          },
          401
        );
      }

      if (req.method !== "POST") {
        options.store.logAudit({
          id: options.store.generateId("aud-in"),
          action: "WEBHOOK_EVENT_RECEIVED",
          entityType: "webhook",
          entityId: pathname,
          details: {
            method: req.method,
            path: pathname,
            headers: safeHeaders,
            status: 405,
          },
          timestamp: new Date().toISOString(),
        });
        return jsonResponse({ error: "Method not allowed. Use POST." }, 405);
      }

      // 2. Parse JSON body and record every inbound event in the audit log (with secrets redacted)
      let parsedBody: unknown;
      try {
        const rawText = await req.text();
        parsedBody = rawText.trim().length > 0 ? JSON.parse(rawText) : {};
      } catch (err: unknown) {
        const errMsg = redactString(
          err instanceof Error ? err.message : String(err),
          requestSecrets
        );
        options.store.logAudit({
          id: options.store.generateId("aud-badjson"),
          action: "WEBHOOK_BAD_REQUEST",
          entityType: "webhook",
          entityId: pathname,
          details: {
            method: req.method,
            path: pathname,
            headers: safeHeaders,
            error: `Malformed JSON payload: ${errMsg}`,
          },
          timestamp: new Date().toISOString(),
        });
        return jsonResponse({ error: "Invalid JSON request body." }, 400);
      }

      const safeBody = redactSecrets(parsedBody, requestSecrets);
      options.store.logAudit({
        id: options.store.generateId("aud-in"),
        action: "WEBHOOK_EVENT_RECEIVED",
        entityType: "webhook",
        entityId: pathname,
        details: {
          method: req.method,
          path: pathname,
          voiceProvider: voiceAdapter.name,
          smsProvider: smsProvider.name,
          headers: safeHeaders,
          payload: safeBody,
        },
        timestamp: new Date().toISOString(),
      });

      // 3. Route to provider seam & product coordinator
      try {
        if (pathname === "/webhooks/voice") {
          const event = voiceAdapter.parseWebhook(parsedBody);
          const result = await coordinator.handleVoiceEvent(event);
          const formatted = voiceAdapter.formatWebhookAck(result);
          return jsonResponse(formatted.body, formatted.status);
        }

        if (pathname === "/webhooks/voice/tools" || pathname.startsWith("/webhooks/voice/tools/")) {
          const toolHint = pathname.startsWith("/webhooks/voice/tools/")
            ? pathname.slice("/webhooks/voice/tools/".length).replace(/\/+$/, "")
            : undefined;
          const toolCall = voiceAdapter.parseToolCall(parsedBody, toolHint || undefined);
          const toolResult = await coordinator.handleVoiceToolCall(toolCall);
          const formatted = voiceAdapter.formatToolResult(toolResult);
          return jsonResponse(formatted.body, formatted.status);
        }

        if (pathname === "/webhooks/sms") {
          const smsEvent = smsProvider.parseInboundWebhook(parsedBody);
          const smsResult = await coordinator.handleInboundSms(smsEvent);
          return jsonResponse({
            received: true,
            outboundMessageId: smsResult.outboundMessageId,
            reply: smsResult.replyText,
            bookingId: smsResult.bookingCreatedId ?? null,
            stoppedEstimates: smsResult.stoppedEstimateIds,
          });
        }

        return jsonResponse({ error: `Unknown webhook endpoint: ${pathname}` }, 404);
      } catch (err: unknown) {
        if (err instanceof ChannelValidationError) {
          return jsonResponse({ error: redactString(err.message, requestSecrets) }, err.statusCode);
        }
        const safeErr = redactString(
          err instanceof Error ? err.message : String(err),
          requestSecrets
        );
        options.store.logAudit({
          id: options.store.generateId("aud-err"),
          action: "WEBHOOK_HANDLER_ERROR",
          entityType: "webhook",
          entityId: pathname,
          details: {
            path: pathname,
            error: safeErr,
          },
          timestamp: new Date().toISOString(),
        });
        return jsonResponse({ error: `Internal webhook processing error: ${safeErr}` }, 500);
      }
    },
  });

  const boundPort = server.port ?? options.port ?? 3000;
  const boundHost = options.hostname ?? "127.0.0.1";

  return {
    port: boundPort,
    url: `http://${boundHost}:${boundPort}`,
    voiceAdapter,
    smsProvider,
    stop: async () => {
      server.stop(true);
    },
  };
}
