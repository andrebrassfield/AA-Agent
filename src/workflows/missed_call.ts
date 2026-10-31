import type { ClientConfig } from "../types/config.ts";
import type { DataStore } from "../db/store.ts";

export interface MissedCallInput {
  callerPhone: string;
  timestamp?: string;
}

export interface MissedCallResult {
  smsSent: boolean;
  messageText: string;
  auditId: string;
}

/**
 * Missed-call text-back: a missed call triggers an SMS within a minute:
 * greeting from persona config, an offer to book by text, and the booking flow by conversation.
 * Guardrail: One-to-one operational message, not a campaign, so not gated.
 */
export async function handleMissedCallTextBack(
  input: MissedCallInput,
  clientConfig: ClientConfig,
  store: DataStore
): Promise<MissedCallResult> {
  const timestamp = input.timestamp || new Date().toISOString();

  // Log missed call in call_logs
  const callId = `call-${Date.now()}`;
  store.logCall({
    id: callId,
    callerPhone: input.callerPhone,
    direction: "inbound",
    status: "missed",
    durationSeconds: 0,
    summary: "Inbound call missed - triggered missed-call text-back workflow",
    timestamp,
  });

  const smsText = `Hi there! ${clientConfig.persona.greeting} We missed your call, but we're here to help. Would you like to schedule an appointment or ask a question by text?`;

  const auditId = `aud-mctb-${Date.now()}`;
  store.logAudit({
    id: auditId,
    action: "MISSED_CALL_TEXT_BACK_SENT",
    entityType: "call",
    entityId: callId,
    details: {
      recipientPhone: input.callerPhone,
      message: smsText,
      guardrailBypassReason: "one_to_one_operational_flow",
    },
    timestamp: new Date().toISOString(),
  });

  return {
    smsSent: true,
    messageText: smsText,
    auditId,
  };
}
