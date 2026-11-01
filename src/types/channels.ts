import type { Booking } from "./db.ts";

export class ChannelValidationError extends Error {
  public readonly statusCode: number;
  constructor(message: string, statusCode: number = 400) {
    super(message);
    this.name = "ChannelValidationError";
    this.statusCode = statusCode;
  }
}

// --- SMS Provider Seam ---

export interface OutboundSmsRequest {
  to: string;
  from: string;
  body: string;
  metadata?: Record<string, unknown>;
}

export interface OutboundSmsResult {
  messageId: string;
  status: "sent" | "queued";
  provider: string;
  timestamp: string;
}

export interface SentSmsRecord extends OutboundSmsRequest {
  messageId: string;
  provider: string;
  timestamp: string;
}

export interface InboundSmsEvent {
  providerMessageId: string;
  from: string;
  to: string;
  body: string;
  timestamp: string;
}

export interface SmsProvider {
  readonly name: string;
  sendSms(request: OutboundSmsRequest): Promise<OutboundSmsResult>;
  parseInboundWebhook(body: unknown): InboundSmsEvent;
}

// --- Voice Provider Seam ---

export type NormalizedVoiceEvent =
  | {
      type: "call_started";
      providerCallId: string;
      callerPhone: string;
      recipientPhone?: string;
      direction: "inbound" | "outbound";
      timestamp: string;
    }
  | {
      type: "call_missed";
      providerCallId: string;
      callerPhone: string;
      recipientPhone?: string;
      direction: "inbound" | "outbound";
      reason: string;
      timestamp: string;
    }
  | {
      type: "call_ended";
      providerCallId: string;
      callerPhone: string;
      recipientPhone?: string;
      direction: "inbound" | "outbound";
      durationSeconds: number;
      transcript?: string;
      disconnectionReason?: string;
      timestamp: string;
    }
  | {
      type: "ignored";
      providerCallId?: string;
      eventName: string;
    };

export type NormalizedVoiceToolCall =
  | {
      tool: "check_availability";
      providerCallId: string;
      callerPhone?: string;
      serviceId?: string;
      requestedStartTime: string;
      endTime?: string;
    }
  | {
      tool: "book_appointment";
      providerCallId: string;
      callerPhone?: string;
      customerName: string;
      customerPhone?: string;
      serviceId: string;
      requestedStartTime: string;
    }
  | {
      tool: "reschedule_appointment";
      providerCallId: string;
      callerPhone?: string;
      bookingId: string;
      requestedStartTime: string;
    }
  | {
      tool: "cancel_appointment";
      providerCallId: string;
      callerPhone?: string;
      bookingId: string;
    }
  | {
      tool: "ask_agent";
      providerCallId: string;
      callerPhone?: string;
      question: string;
    };

export interface NormalizedVoiceToolResult {
  success: boolean;
  tool: NormalizedVoiceToolCall["tool"];
  available?: boolean;
  booking?: Booking;
  message: string;
  error?: string;
}

export interface ProviderHttpPayload {
  status: number;
  body: Record<string, unknown>;
}

export interface VoiceProviderAdapter {
  readonly name: string;
  parseWebhook(body: unknown): NormalizedVoiceEvent;
  parseToolCall(body: unknown, toolHint?: string): NormalizedVoiceToolCall;
  formatToolResult(result: NormalizedVoiceToolResult): ProviderHttpPayload;
  formatWebhookAck(details: Record<string, unknown>): ProviderHttpPayload;
}
