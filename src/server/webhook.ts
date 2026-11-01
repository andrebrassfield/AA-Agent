import type { ServerConfig } from "./server.ts";
import { handleVoiceWebhook } from "../channels/voice.ts";
import { handleSmsWebhook } from "../channels/sms.ts";

export async function webhookHandler(req: Request, config: ServerConfig): Promise<Response> {
  const authHeader = req.headers.get("Authorization");
  if (!authHeader || authHeader !== `Bearer ${config.webhookSecret}`) {
    config.store.logAudit({
      id: config.store.generateId("aud-wh-err"),
      action: "WEBHOOK_AUTH_FAILED",
      entityType: "webhook",
      entityId: "unknown",
      details: { url: req.url },
      timestamp: new Date().toISOString(),
    });
    return new Response("Unauthorized", { status: 401 });
  }

  const url = new URL(req.url);
  const provider = url.pathname.split("/")[2]; // /webhooks/provider

  try {
    const payload = await req.json();

    config.store.logAudit({
      id: config.store.generateId("aud-wh"),
      action: "WEBHOOK_RECEIVED",
      entityType: "webhook",
      entityId: "inbound",
      details: { provider, payload },
      timestamp: new Date().toISOString(),
    });

    if (provider === "voice") {
      return await handleVoiceWebhook(payload, config);
    } else if (provider === "sms") {
      return await handleSmsWebhook(payload, config);
    }

    return new Response("Unknown provider", { status: 400 });
  } catch (error: any) {
    console.error("Webhook processing error:", error);
    return new Response("Bad Request", { status: 400 });
  }
}
