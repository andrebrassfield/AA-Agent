import { resolveSmsFromNumber } from "../channels/sms/twilio.ts";
import type { ClientConfig } from "../types/config.ts";
import { normalizePhone, type DataStore } from "../db/store.ts";

export interface MissedCallInput {
  callerPhone: string;
  providerCallId?: string;
  timestamp?: string;
}

export interface MissedCallResult {
  smsSent: boolean;
  duplicate?: boolean;
  optedOut?: boolean;
  messageText: string;
  smsMessageId?: string;
  auditId: string;
}

export interface MissedCallSmsSender {
  sendSms(req: { to: string; from: string; body: string; metadata?: Record<string, unknown> }): Promise<{
    messageId: string;
  }>;
}

/**
 * Missed-call text-back: a missed call triggers an SMS within a minute:
 * greeting from persona config, an offer to book by text, and the booking flow by conversation.
 * Deduplicates on providerCallId in DataStore so duplicate webhook events never send a second SMS.
 * Guardrail: One-to-one operational message, not a campaign, so not gated.
 */
export async function handleMissedCallTextBack(
  input: MissedCallInput,
  clientConfig: ClientConfig,
  store: DataStore,
  smsSender?: MissedCallSmsSender
): Promise<MissedCallResult> {
  const timestamp = input.timestamp || new Date().toISOString();

  if (input.providerCallId) {
    const claimed = store.claimMissedCallTextBack(input.providerCallId, input.callerPhone);
    if (!claimed) {
      const dupAuditId = store.logAudit({
        id: store.generateId("aud-mctb-dup"),
        action: "MISSED_CALL_DUPLICATE_IGNORED",
        entityType: "call",
        entityId: input.providerCallId,
        details: {
          callerPhone: input.callerPhone,
          providerCallId: input.providerCallId,
        },
        timestamp: new Date().toISOString(),
      });
      return {
        smsSent: false,
        duplicate: true,
        messageText: "",
        auditId: dupAuditId,
      };
    }
  }

  const optedOut = store.isSmsOptedOut(input.callerPhone);

  // Log missed call in call_logs
  const callId = store.logCall({
    id: store.generateId("call"),
    callerPhone: input.callerPhone,
    direction: "inbound",
    status: "missed",
    durationSeconds: 0,
    providerCallId: input.providerCallId,
    summary: optedOut
      ? "Inbound call missed - text-back suppressed because caller opted out of SMS"
      : "Inbound call missed - triggered missed-call text-back workflow",
    timestamp,
  });

  if (optedOut) {
    const optOutAuditId = store.logAudit({
      id: store.generateId("aud-mctb-optout"),
      action: "MISSED_CALL_TEXT_BACK_SUPPRESSED",
      entityType: "call",
      entityId: input.providerCallId || callId,
      details: {
        recipientPhone: input.callerPhone,
        normalizedPhone: normalizePhone(input.callerPhone),
        providerCallId: input.providerCallId || null,
        reason: "recipient_opted_out",
      },
      timestamp: new Date().toISOString(),
    });
    return {
      smsSent: false,
      duplicate: false,
      optedOut: true,
      messageText: "",
      auditId: optOutAuditId,
    };
  }

  const smsText = `Hi there! ${clientConfig.persona.greeting} We missed your call, but we're here to help. Would you like to schedule an appointment or ask a question by text?`;

  let smsMessageId: string | undefined;
  if (smsSender) {
    const fromNumber = resolveSmsFromNumber(clientConfig);
    const sent = await smsSender.sendSms({
      to: input.callerPhone,
      from: fromNumber,
      body: smsText,
      metadata: { workflow: "missed_call_text_back", providerCallId: input.providerCallId, callId },
    });
    smsMessageId = sent.messageId;
  }

  // Seed shared conversation history so subsequent inbound texts have the greeting context
  store.appendConversationMessage({
    customerPhone: input.callerPhone,
    channel: "sms",
    role: "assistant",
    content: smsText,
    providerCallId: input.providerCallId,
    timestamp,
  });

  const auditId = store.logAudit({
    id: store.generateId("aud-mctb"),
    action: "MISSED_CALL_TEXT_BACK_SENT",
    entityType: "call",
    entityId: input.providerCallId || callId,
    details: {
      recipientPhone: input.callerPhone,
      providerCallId: input.providerCallId || null,
      smsMessageId: smsMessageId || null,
      message: smsText,
      guardrailBypassReason: "one_to_one_operational_flow",
    },
    timestamp: new Date().toISOString(),
  });

  return {
    smsSent: true,
    duplicate: false,
    messageText: smsText,
    smsMessageId,
    auditId,
  };
}
