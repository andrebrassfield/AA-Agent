import type { ClientConfig } from "./config.ts";
import type { Booking } from "./db.ts";

export interface AgentContext {
  clientConfig: ClientConfig;
  channel: "sms" | "voice";
  senderPhone: string;
  metadata?: Record<string, unknown>;
}

export interface AgentTurnInput {
  userMessage: string;
  context: AgentContext;
  conversationHistory: { role: "user" | "assistant"; content: string }[];
}

export interface AgentTurnOutput {
  reply: string;
  actionTaken?: {
    type: "BOOKING_CREATED" | "CALENDAR_CHECKED" | "ESCALATED" | "INFO_PROVIDED" | "TOOL_CALL";
    details?: Record<string, unknown>;
    booking?: Booking;
  };
}

export interface EngineAdapter {
  name: string;
  processTurn(input: AgentTurnInput): Promise<AgentTurnOutput>;
}
