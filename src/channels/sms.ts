import type { ServerConfig } from "../server/server.ts";
import { processEstimateFollowUpTouch } from "../workflows/estimate.ts";

export async function handleSmsWebhook(payload: any, config: ServerConfig): Promise<Response> {
  const fromPhone = payload.from;
  const messageBody = payload.body;

  // 1. Check if this is a reply to an open estimate
  const openEstimates = config.store.listEstimates().filter(e => e.customerPhone === fromPhone && e.status === "open");
  for (const estimate of openEstimates) {
    // Process as replied to stop touches
    await processEstimateFollowUpTouch(estimate.id, 2, config.clientConfig, config.store, true);
  }

  // 2. Route to engine
  const turn = await config.engine.processTurn({
      userMessage: messageBody,
      context: {
          clientConfig: config.clientConfig,
          channel: "sms",
          senderPhone: fromPhone,
      },
      conversationHistory: [], // Ideally this comes from the store
  });

  // 3. Stub sending reply
  config.store.logAudit({
      id: config.store.generateId("aud-sms-reply"),
      action: "SMS_REPLY_SENT",
      entityType: "sms",
      entityId: "outbound",
      details: { to: fromPhone, message: turn.reply },
      timestamp: new Date().toISOString(),
  });

  return new Response(JSON.stringify({ reply: turn.reply }), { status: 200, headers: { "Content-Type": "application/json" } });
}
