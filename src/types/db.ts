export type BookingStatus = "confirmed" | "cancelled" | "completed" | "rescheduled";

export interface Booking {
  id: string;
  customerName: string;
  customerPhone: string;
  serviceId: string;
  serviceName: string;
  staffId?: string;
  startTime: string; // ISO string
  endTime: string;   // ISO string
  status: BookingStatus;
  notes?: string;
  createdAt: string;
}

export type CallDirection = "inbound" | "outbound";
export type CallStatus = "missed" | "completed" | "abandoned" | "busy";

export interface CallLog {
  id: string;
  callerPhone: string;
  direction: CallDirection;
  status: CallStatus;
  durationSeconds: number;
  summary?: string;
  providerCallId?: string;
  timestamp: string;
}

export interface AuditLogEntry {
  id: string;
  action: string;
  entityType: string;
  entityId: string;
  details: Record<string, unknown>;
  timestamp: string;
}

export interface ModelUsageLog {
  id: string;
  provider: string;
  model: string;
  taskClass: "conversation" | "reasoning" | "aux";
  promptTokens: number;
  completionTokens: number;
  costUsd: number;
  timestamp: string;
}

export interface EstimateStatus {
  id: string;
  customerName: string;
  customerPhone: string;
  amount: number;
  status: "open" | "replied" | "closed";
  touchesSent: string; // JSON array of touch days e.g. "[2, 5]"
  nextTouchAt?: string; // ISO string
  stopReason?: string;
  createdAt: string;
}

export interface ReviewStatus {
  id: string;
  bookingId?: string;
  bookingLink: string;
  sendAt: string; // ISO string
  status: "pending" | "sent" | "cancelled";
  createdAt: string;
}

export interface ConversationMessage {
  id: string;
  customerPhone: string;
  channel: "sms" | "voice";
  role: "user" | "assistant";
  content: string;
  providerCallId?: string;
  timestamp: string;
}

export type FollowUpType = "booking_reminder" | "estimate_touch" | "review_request";

export interface ScheduledFollowUp {
  id: string;
  type: FollowUpType;
  entityType: string;
  entityId: string;
  recipientPhone: string;
  message: string;
  scheduledFor: string; // ISO string
  status: "pending" | "sent" | "cancelled";
  createdAt: string;
}
