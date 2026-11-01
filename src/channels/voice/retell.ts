import { generateId } from "../../db/store.ts";
import {
  ChannelValidationError,
  type NormalizedVoiceEvent,
  type NormalizedVoiceToolCall,
  type NormalizedVoiceToolResult,
  type ProviderHttpPayload,
  type VoiceProviderAdapter,
} from "../../types/channels.ts";

function isRecord(val: unknown): val is Record<string, unknown> {
  return typeof val === "object" && val !== null && !Array.isArray(val);
}

function pickString(obj: Record<string, unknown>, keys: string[]): string | undefined {
  for (const k of keys) {
    const val = obj[k];
    if (typeof val === "string" && val.trim().length > 0) {
      return val.trim();
    }
  }
  return undefined;
}

function formatRetellTranscript(raw: unknown): string | undefined {
  if (typeof raw === "string" && raw.trim().length > 0) {
    return raw.trim();
  }
  if (Array.isArray(raw)) {
    const lines = raw
      .filter(isRecord)
      .map((turn) => {
        const role = typeof turn.role === "string" ? turn.role : "speaker";
        const content = typeof turn.content === "string" ? turn.content : "";
        return content ? `${role}: ${content}` : "";
      })
      .filter(Boolean);
    return lines.length > 0 ? lines.join("\n") : undefined;
  }
  return undefined;
}

const MISSED_DISCONNECTION_REASONS = new Set([
  "dial_no_answer",
  "no_answer",
  "dial_busy",
  "busy",
  "missed",
  "unanswered",
  "voicemail_reached",
  "machine_detected",
]);

const MISSED_CALL_STATUSES = new Set([
  "missed",
  "no_answer",
  "unanswered",
  "busy",
]);

/**
 * Voice provider adapter implementing Retell AI's documented webhook lifecycle payloads
 * (`call_started`, `call_ended`, `call_analyzed`, missed/unanswered call states)
 * and Custom Function tool-call payloads (`{ name, call, args }`).
 */
export class RetellVoiceAdapter implements VoiceProviderAdapter {
  readonly name = "retell";

  parseWebhook(body: unknown): NormalizedVoiceEvent {
    if (!isRecord(body)) {
      throw new ChannelValidationError("Retell webhook body must be a JSON object.");
    }

    const event = pickString(body, ["event"]);
    if (!event) {
      throw new ChannelValidationError("Retell webhook payload missing required 'event' string.");
    }

    const call = isRecord(body.call) ? body.call : null;
    if (!call) {
      throw new ChannelValidationError("Retell webhook payload missing required 'call' object.");
    }

    const providerCallId = pickString(call, ["call_id", "callId"]);
    if (!providerCallId) {
      throw new ChannelValidationError("Retell webhook 'call.call_id' is required.");
    }

    const callerPhone = pickString(call, ["from_number", "fromNumber", "caller_phone"]) || "";
    const recipientPhone = pickString(call, ["to_number", "toNumber"]);
    const direction = call.direction === "outbound" ? "outbound" : "inbound";

    const endTs = typeof call.end_timestamp === "number" ? call.end_timestamp : undefined;
    const startTs = typeof call.start_timestamp === "number" ? call.start_timestamp : undefined;
    const timestamp = endTs
      ? new Date(endTs).toISOString()
      : startTs
        ? new Date(startTs).toISOString()
        : new Date().toISOString();

    if (event === "call_started") {
      if (!callerPhone) {
        throw new ChannelValidationError("Retell 'call_started' event requires 'call.from_number'.");
      }
      return {
        type: "call_started",
        providerCallId,
        callerPhone,
        recipientPhone,
        direction,
        timestamp,
      };
    }

    const disconnectionReason = pickString(call, ["disconnection_reason", "disconnectionReason"]);
    const callStatus = pickString(call, ["call_status", "callStatus"]);
    const callAnalysis = isRecord(call.call_analysis) ? call.call_analysis : undefined;
    const inVoicemail = callAnalysis?.in_voicemail === true;

    const isMissedEvent =
      event === "call_missed" ||
      event === "call_unanswered" ||
      event === "missed_call" ||
      (event === "call_ended" &&
        ((disconnectionReason !== undefined && MISSED_DISCONNECTION_REASONS.has(disconnectionReason)) ||
          (callStatus !== undefined && MISSED_CALL_STATUSES.has(callStatus)) ||
          inVoicemail));

    if (isMissedEvent) {
      if (!callerPhone) {
        throw new ChannelValidationError("Retell missed/unanswered call event requires 'call.from_number'.");
      }
      return {
        type: "call_missed",
        providerCallId,
        callerPhone,
        recipientPhone,
        direction,
        reason: disconnectionReason || callStatus || (inVoicemail ? "voicemail_reached" : "missed"),
        timestamp,
      };
    }

    if (event === "call_ended") {
      const durationMs =
        typeof call.duration_ms === "number"
          ? call.duration_ms
          : startTs !== undefined && endTs !== undefined && endTs >= startTs
            ? endTs - startTs
            : 0;
      return {
        type: "call_ended",
        providerCallId,
        callerPhone,
        recipientPhone,
        direction,
        durationSeconds: Math.max(0, Math.round(durationMs / 1000)),
        transcript: formatRetellTranscript(call.transcript),
        disconnectionReason,
        timestamp,
      };
    }

    return {
      type: "ignored",
      providerCallId,
      eventName: event,
    };
  }

  parseToolCall(body: unknown, toolHint?: string): NormalizedVoiceToolCall {
    if (!isRecord(body)) {
      throw new ChannelValidationError("Retell custom function body must be a JSON object.");
    }

    const callObj = isRecord(body.call) ? body.call : undefined;
    const argsObj = isRecord(body.args) ? body.args : body;

    const providerCallId =
      (callObj && pickString(callObj, ["call_id", "callId"])) ||
      pickString(body, ["call_id", "callId"]) ||
      generateId("retell-call");

    const callerPhone =
      (callObj && pickString(callObj, ["from_number", "fromNumber"])) ||
      pickString(argsObj, ["customer_phone", "customerPhone", "caller_phone", "callerPhone"]);

    const rawName = (pickString(body, ["name"]) || toolHint || "").trim();
    if (!rawName) {
      throw new ChannelValidationError("Retell tool call requires function 'name' or tool endpoint path.");
    }

    const normalizedName = rawName.toLowerCase().replace(/-/g, "_");

    // Support unified manageBooking shape if configured as a single custom function
    if (normalizedName === "managebooking" || normalizedName === "manage_booking") {
      const action = pickString(argsObj, ["action"]);
      const nestedInput = isRecord(argsObj.input) ? argsObj.input : argsObj;
      if (action === "create") {
        return this.buildBookToolCall(providerCallId, callerPhone, nestedInput);
      }
      if (action === "reschedule") {
        return this.buildRescheduleToolCall(providerCallId, callerPhone, { ...nestedInput, bookingId: argsObj.bookingId ?? nestedInput.bookingId });
      }
      if (action === "cancel") {
        return this.buildCancelToolCall(providerCallId, callerPhone, { bookingId: argsObj.bookingId ?? nestedInput.bookingId });
      }
      throw new ChannelValidationError(`Unsupported manageBooking action: ${String(action)}`);
    }

    if (
      normalizedName === "check_availability" ||
      normalizedName === "availability_check" ||
      normalizedName === "checkavailability" ||
      normalizedName === "availability"
    ) {
      const requestedStartTime = pickString(argsObj, [
        "requested_start_time",
        "requestedStartTime",
        "start_time",
        "startTime",
      ]);
      if (!requestedStartTime) {
        throw new ChannelValidationError("Availability check requires 'requested_start_time' (or 'requestedStartTime').");
      }
      return {
        tool: "check_availability",
        providerCallId,
        callerPhone,
        serviceId: pickString(argsObj, ["service_id", "serviceId"]),
        requestedStartTime,
        endTime: pickString(argsObj, ["end_time", "endTime"]),
      };
    }

    if (
      normalizedName === "book" ||
      normalizedName === "book_appointment" ||
      normalizedName === "create_booking"
    ) {
      return this.buildBookToolCall(providerCallId, callerPhone, argsObj);
    }

    if (
      normalizedName === "reschedule" ||
      normalizedName === "reschedule_appointment" ||
      normalizedName === "reschedule_booking"
    ) {
      return this.buildRescheduleToolCall(providerCallId, callerPhone, argsObj);
    }

    if (
      normalizedName === "cancel" ||
      normalizedName === "cancel_appointment" ||
      normalizedName === "cancel_booking"
    ) {
      return this.buildCancelToolCall(providerCallId, callerPhone, argsObj);
    }

    if (normalizedName === "ask_agent" || normalizedName === "conversation_turn") {
      const question = pickString(argsObj, ["question", "user_message", "userMessage", "message"]);
      if (!question) {
        throw new ChannelValidationError("ask_agent tool call requires 'question'.");
      }
      return {
        tool: "ask_agent",
        providerCallId,
        callerPhone,
        question,
      };
    }

    throw new ChannelValidationError(`Unsupported Retell tool call name: "${rawName}".`);
  }

  private buildBookToolCall(
    providerCallId: string,
    callerPhone: string | undefined,
    argsObj: Record<string, unknown>
  ): NormalizedVoiceToolCall {
    const customerName = pickString(argsObj, ["customer_name", "customerName", "name"]);
    const customerPhone = pickString(argsObj, ["customer_phone", "customerPhone", "phone"]) || callerPhone;
    const serviceId = pickString(argsObj, ["service_id", "serviceId"]);
    const requestedStartTime = pickString(argsObj, [
      "requested_start_time",
      "requestedStartTime",
      "start_time",
      "startTime",
    ]);

    if (!customerName || !serviceId || !requestedStartTime) {
      throw new ChannelValidationError(
        "Book tool call requires 'customer_name', 'service_id', and 'requested_start_time'."
      );
    }

    return {
      tool: "book_appointment",
      providerCallId,
      callerPhone,
      customerName,
      customerPhone,
      serviceId,
      requestedStartTime,
    };
  }

  private buildRescheduleToolCall(
    providerCallId: string,
    callerPhone: string | undefined,
    argsObj: Record<string, unknown>
  ): NormalizedVoiceToolCall {
    const bookingId = pickString(argsObj, ["booking_id", "bookingId"]);
    const requestedStartTime = pickString(argsObj, [
      "requested_start_time",
      "requestedStartTime",
      "start_time",
      "startTime",
    ]);

    if (!bookingId || !requestedStartTime) {
      throw new ChannelValidationError(
        "Reschedule tool call requires 'booking_id' and 'requested_start_time'."
      );
    }

    return {
      tool: "reschedule_appointment",
      providerCallId,
      callerPhone,
      bookingId,
      requestedStartTime,
    };
  }

  private buildCancelToolCall(
    providerCallId: string,
    callerPhone: string | undefined,
    argsObj: Record<string, unknown>
  ): NormalizedVoiceToolCall {
    const bookingId = pickString(argsObj, ["booking_id", "bookingId"]);
    if (!bookingId) {
      throw new ChannelValidationError("Cancel tool call requires 'booking_id'.");
    }

    return {
      tool: "cancel_appointment",
      providerCallId,
      callerPhone,
      bookingId,
    };
  }

  formatToolResult(result: NormalizedVoiceToolResult): ProviderHttpPayload {
    return {
      status: 200,
      body: {
        success: result.success,
        tool: result.tool,
        ...(result.available !== undefined ? { available: result.available } : {}),
        ...(result.booking
          ? {
              booking_id: result.booking.id,
              booking: {
                id: result.booking.id,
                service_id: result.booking.serviceId,
                service_name: result.booking.serviceName,
                start_time: result.booking.startTime,
                end_time: result.booking.endTime,
                status: result.booking.status,
              },
            }
          : {}),
        result: result.message,
        message: result.message,
        ...(result.error ? { error: result.error } : {}),
      },
    };
  }

  formatWebhookAck(details: Record<string, unknown>): ProviderHttpPayload {
    return {
      status: 200,
      body: {
        received: true,
        ...details,
      },
    };
  }
}
