import { generateId } from "../../db/store.ts";
import {
  ChannelValidationError,
  type InboundSmsEvent,
  type OutboundSmsRequest,
  type OutboundSmsResult,
  type SentSmsRecord,
  type SmsProvider,
} from "../../types/channels.ts";

function isRecord(val: unknown): val is Record<string, unknown> {
  return typeof val === "object" && val !== null && !Array.isArray(val);
}

/**
 * In-memory SMS provider stub.
 * All outbound operational SMS (missed-call greetings, booking confirmations, conversational replies)
 * route through SmsProvider so tests and demo mode never transmit real network messages.
 */
export class StubSmsProvider implements SmsProvider {
  readonly name = "stub";
  public readonly sentMessages: SentSmsRecord[] = [];

  async sendSms(request: OutboundSmsRequest): Promise<OutboundSmsResult> {
    const messageId = generateId("sms");
    const timestamp = new Date().toISOString();

    this.sentMessages.push({
      ...request,
      messageId,
      provider: this.name,
      timestamp,
    });

    return {
      messageId,
      status: "sent",
      provider: this.name,
      timestamp,
    };
  }

  parseInboundWebhook(body: unknown): InboundSmsEvent {
    if (!isRecord(body)) {
      throw new ChannelValidationError("Inbound SMS webhook body must be a JSON object.");
    }

    const fromRaw = body.from ?? body.From ?? body.sender;
    const toRaw = body.to ?? body.To ?? body.recipient ?? "";
    const textRaw = body.body ?? body.Body ?? body.text ?? body.message;
    const idRaw = body.messageId ?? body.MessageSid ?? body.id;
    const tsRaw = body.timestamp;

    if (typeof fromRaw !== "string" || fromRaw.trim().length === 0) {
      throw new ChannelValidationError("Inbound SMS payload requires a non-empty 'from' phone number.");
    }
    if (typeof textRaw !== "string" || textRaw.trim().length === 0) {
      throw new ChannelValidationError("Inbound SMS payload requires a non-empty 'body' text.");
    }

    return {
      providerMessageId: typeof idRaw === "string" && idRaw.trim().length > 0 ? idRaw.trim() : generateId("in-sms"),
      from: fromRaw.trim(),
      to: typeof toRaw === "string" ? toRaw.trim() : "",
      body: textRaw.trim(),
      timestamp: typeof tsRaw === "string" && tsRaw.trim().length > 0 ? tsRaw : new Date().toISOString(),
    };
  }
}
