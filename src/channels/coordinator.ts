import type { CalendarAdapter } from "../calendar/calendar.ts";
import type { DataStore } from "../db/store.ts";
import type { ProviderRouter } from "../router/router.ts";
import type {
  InboundSmsEvent,
  NormalizedVoiceEvent,
  NormalizedVoiceToolCall,
  NormalizedVoiceToolResult,
  SmsProvider,
} from "../types/channels.ts";
import type { ClientConfig } from "../types/config.ts";
import type { EngineAdapter } from "../types/engine.ts";
import {
  handleBookingWorkflow,
  isWithinBusinessHours,
  type BookingWorkflowResult,
} from "../workflows/booking.ts";
import { stopOpenEstimatesForCustomerReply } from "../workflows/estimate.ts";
import { handleMissedCallTextBack } from "../workflows/missed_call.ts";

export interface RouterProviderSummary {
  summary: string;
  provider: string;
  model: string;
}

interface ActiveVoiceCallSession {
  providerCallId: string;
  callerPhone: string;
  startedAt: string;
  bookingResults: BookingWorkflowResult[];
  toolActionsSummary: string[];
}

export interface ChannelCoordinatorDeps {
  clientConfig: ClientConfig;
  store: DataStore;
  calendar: CalendarAdapter;
  engine: EngineAdapter;
  router: ProviderRouter;
  smsProvider: SmsProvider;
}

export class ChannelCoordinator {
  private readonly clientConfig: ClientConfig;
  private readonly store: DataStore;
  private readonly calendar: CalendarAdapter;
  private readonly engine: EngineAdapter;
  private readonly router: ProviderRouter;
  private readonly smsProvider: SmsProvider;
  private readonly activeCalls = new Map<string, ActiveVoiceCallSession>();

  constructor(deps: ChannelCoordinatorDeps) {
    this.clientConfig = deps.clientConfig;
    this.store = deps.store;
    this.calendar = deps.calendar;
    this.engine = deps.engine;
    this.router = deps.router;
    this.smsProvider = deps.smsProvider;
  }

  private getOrCreateCallSession(providerCallId: string, callerPhone: string = ""): ActiveVoiceCallSession {
    let session = this.activeCalls.get(providerCallId);
    if (!session) {
      session = {
        providerCallId,
        callerPhone,
        startedAt: new Date().toISOString(),
        bookingResults: [],
        toolActionsSummary: [],
      };
      this.activeCalls.set(providerCallId, session);
    } else if (callerPhone && !session.callerPhone) {
      session.callerPhone = callerPhone;
    }
    return session;
  }

  private getBusinessSmsNumber(): string {
    return this.clientConfig.business.phoneNumbers.sms || this.clientConfig.business.phoneNumbers.main;
  }

  private scheduleBookingReminders(bookingId: string, recipientPhone: string, reminders: { time: string; text: string }[] = []): number {
    const existing = this.store.listFollowUps(bookingId).filter((f) => f.status === "pending");
    if (existing.length > 0) {
      return 0;
    }

    let scheduledCount = 0;
    for (const rem of reminders) {
      this.store.scheduleFollowUp({
        type: "booking_reminder",
        entityType: "booking",
        entityId: bookingId,
        recipientPhone,
        message: rem.text,
        scheduledFor: rem.time,
        status: "pending",
      });
      scheduledCount++;
    }
    return scheduledCount;
  }

  async handleVoiceEvent(event: NormalizedVoiceEvent): Promise<Record<string, unknown>> {
    if (event.type === "ignored") {
      return { status: "ignored", event: event.eventName };
    }

    if (event.type === "call_started") {
      this.getOrCreateCallSession(event.providerCallId, event.callerPhone);

      const stoppedEstimates =
        event.direction === "inbound" && event.callerPhone
          ? stopOpenEstimatesForCustomerReply(event.callerPhone, "voice", this.store)
          : [];

      this.store.logAudit({
        id: this.store.generateId("aud-vstart"),
        action: "VOICE_CALL_STARTED",
        entityType: "call",
        entityId: event.providerCallId,
        details: {
          callerPhone: event.callerPhone,
          direction: event.direction,
          stoppedEstimatesCount: stoppedEstimates.length,
        },
        timestamp: new Date().toISOString(),
      });

      return {
        status: "call_started",
        callId: event.providerCallId,
        stoppedEstimates: stoppedEstimates.map((e) => e.id),
      };
    }

    if (event.type === "call_missed") {
      const mctb = await handleMissedCallTextBack(
        {
          callerPhone: event.callerPhone,
          providerCallId: event.providerCallId,
          timestamp: event.timestamp,
        },
        this.clientConfig,
        this.store,
        this.smsProvider
      );

      return {
        status: mctb.duplicate ? "duplicate_ignored" : "missed_call_text_back_sent",
        callId: event.providerCallId,
        smsSent: mctb.smsSent,
        duplicate: Boolean(mctb.duplicate),
      };
    }

    // event.type === "call_ended"
    const session = this.activeCalls.get(event.providerCallId);
    const callerPhone = event.callerPhone || session?.callerPhone || "unknown";

    if (event.direction === "inbound" && callerPhone !== "unknown") {
      stopOpenEstimatesForCustomerReply(callerPhone, "voice", this.store);
    }

    if (event.transcript && callerPhone !== "unknown") {
      this.store.appendConversationMessage({
        customerPhone: callerPhone,
        channel: "voice",
        role: "user",
        content: `[Voice Call Transcript] ${event.transcript}`,
        providerCallId: event.providerCallId,
        timestamp: event.timestamp,
      });
    }

    // Run call summary through ProviderRouter as an aux task
    const summaryInputParts: string[] = [];
    if (event.transcript) {
      summaryInputParts.push(`Transcript:\n${event.transcript}`);
    }
    if (session && session.toolActionsSummary.length > 0) {
      summaryInputParts.push(`Tool actions executed:\n${session.toolActionsSummary.join("\n")}`);
    }
    if (summaryInputParts.length === 0) {
      summaryInputParts.push(
        `Inbound voice call (${event.durationSeconds}s) with ${callerPhone}. Disconnection reason: ${event.disconnectionReason || "completed"}.`
      );
    }

    const summaryCompletion = await this.router.complete({
      taskClass: "aux",
      messages: [
        {
          role: "system",
          content: `Summarize this phone call for ${this.clientConfig.business.name} in 1-2 sentences, capturing caller request and outcome.`,
        },
        {
          role: "user",
          content: summaryInputParts.join("\n\n"),
        },
      ],
      maxTokens: 150,
    });

    // Schedule any follow-up state the call created (e.g. reminders for bookings still confirmed at call end)
    let followUpsScheduled = 0;
    const scheduledBookingIds: string[] = [];
    if (session) {
      for (const bRes of session.bookingResults) {
        if (!bRes.booking) continue;
        const latest = this.store.getBooking(bRes.booking.id);
        if (latest && latest.status === "confirmed") {
          const added = this.scheduleBookingReminders(
            latest.id,
            latest.customerPhone,
            bRes.scheduledReminders || []
          );
          if (added > 0) {
            followUpsScheduled += added;
            scheduledBookingIds.push(latest.id);
          }
        }
      }
    }

    this.store.logCall({
      callerPhone,
      direction: event.direction,
      status: "completed",
      durationSeconds: event.durationSeconds,
      summary: summaryCompletion.content,
      providerCallId: event.providerCallId,
      timestamp: event.timestamp,
    });

    this.store.logAudit({
      id: this.store.generateId("aud-vend"),
      action: "VOICE_CALL_ENDED",
      entityType: "call",
      entityId: event.providerCallId,
      details: {
        callerPhone,
        durationSeconds: event.durationSeconds,
        summary: summaryCompletion.content,
        auxProvider: summaryCompletion.provider,
        auxModel: summaryCompletion.model,
        followUpsScheduled,
        scheduledBookingIds,
      },
      timestamp: new Date().toISOString(),
    });

    this.activeCalls.delete(event.providerCallId);

    return {
      status: "call_ended",
      callId: event.providerCallId,
      summary: summaryCompletion.content,
      followUpsScheduled,
    };
  }

  async handleVoiceToolCall(toolCall: NormalizedVoiceToolCall): Promise<NormalizedVoiceToolResult> {
    const session = this.getOrCreateCallSession(toolCall.providerCallId, toolCall.callerPhone || "");
    const callerPhone = toolCall.callerPhone || session.callerPhone;

    if (callerPhone) {
      stopOpenEstimatesForCustomerReply(callerPhone, "voice", this.store);
    }

    if (toolCall.tool === "check_availability") {
      const start = new Date(toolCall.requestedStartTime);
      if (isNaN(start.getTime())) {
        return {
          success: false,
          tool: "check_availability",
          available: false,
          message: "Invalid requested start time.",
          error: "Invalid ISO timestamp",
        };
      }

      let durationMinutes = 60;
      if (toolCall.serviceId) {
        const service = this.clientConfig.services.services.find((s) => s.id === toolCall.serviceId);
        if (!service) {
          return {
            success: false,
            tool: "check_availability",
            available: false,
            message: `Service "${toolCall.serviceId}" not found.`,
            error: `Service "${toolCall.serviceId}" not found.`,
          };
        }
        durationMinutes = service.durationMinutes + (service.bufferMinutes || 0);
      }

      const end = toolCall.endTime
        ? new Date(toolCall.endTime)
        : new Date(start.getTime() + durationMinutes * 60_000);

      if (!isWithinBusinessHours(start, end, this.clientConfig)) {
        session.toolActionsSummary.push(`Checked availability for ${start.toISOString()}: outside business hours.`);
        return {
          success: true,
          tool: "check_availability",
          available: false,
          message: "Requested time is outside business hours.",
        };
      }

      const available = await this.calendar.checkAvailability(start.toISOString(), end.toISOString());
      session.toolActionsSummary.push(
        `Checked availability for ${start.toISOString()}: ${available ? "available" : "unavailable"}.`
      );

      this.store.logAudit({
        id: this.store.generateId("aud-vavail"),
        action: "VOICE_TOOL_AVAILABILITY_CHECKED",
        entityType: "call",
        entityId: toolCall.providerCallId,
        details: {
          serviceId: toolCall.serviceId || null,
          startTime: start.toISOString(),
          endTime: end.toISOString(),
          available,
        },
        timestamp: new Date().toISOString(),
      });

      return {
        success: true,
        tool: "check_availability",
        available,
        message: available ? "The requested time slot is available." : "The requested time slot is unavailable.",
      };
    }

    if (toolCall.tool === "book_appointment") {
      const customerPhone = toolCall.customerPhone || callerPhone;
      if (!customerPhone) {
        return {
          success: false,
          tool: "book_appointment",
          message: "Customer phone number is required to book an appointment.",
          error: "Missing customer phone number",
        };
      }
      if (!session.callerPhone) {
        session.callerPhone = customerPhone;
      }

      const res = await handleBookingWorkflow(
        {
          action: "create",
          customerName: toolCall.customerName,
          customerPhone,
          serviceId: toolCall.serviceId,
          requestedStartTime: toolCall.requestedStartTime,
        },
        this.clientConfig,
        this.calendar,
        this.store
      );

      if (!res.success || !res.booking) {
        session.toolActionsSummary.push(`Booking attempt failed: ${res.error}`);
        return {
          success: false,
          tool: "book_appointment",
          message: res.error || "Unable to create booking.",
          error: res.error,
        };
      }

      session.bookingResults.push(res);
      session.toolActionsSummary.push(`Booked ${res.booking.serviceName} (${res.booking.id}) for ${res.booking.startTime}.`);

      if (res.confirmationSms) {
        await this.smsProvider.sendSms({
          to: customerPhone,
          from: this.getBusinessSmsNumber(),
          body: res.confirmationSms,
          metadata: { bookingId: res.booking.id, providerCallId: toolCall.providerCallId },
        });
      }

      this.store.appendConversationMessage({
        customerPhone,
        channel: "voice",
        role: "assistant",
        content: res.confirmationSms || `Booked ${res.booking.serviceName} (${res.booking.id}).`,
        providerCallId: toolCall.providerCallId,
      });

      return {
        success: true,
        tool: "book_appointment",
        booking: res.booking,
        message: res.confirmationSms || "Appointment confirmed.",
      };
    }

    if (toolCall.tool === "reschedule_appointment") {
      const res = await handleBookingWorkflow(
        {
          action: "reschedule",
          bookingId: toolCall.bookingId,
          requestedStartTime: toolCall.requestedStartTime,
        },
        this.clientConfig,
        this.calendar,
        this.store
      );

      if (!res.success || !res.booking) {
        session.toolActionsSummary.push(`Reschedule attempt for ${toolCall.bookingId} failed: ${res.error}`);
        return {
          success: false,
          tool: "reschedule_appointment",
          message: res.error || "Unable to reschedule booking.",
          error: res.error,
        };
      }

      this.store.cancelFollowUpsForEntity("booking", toolCall.bookingId);
      session.bookingResults.push(res);
      session.toolActionsSummary.push(`Rescheduled ${toolCall.bookingId} -> ${res.booking.id} at ${res.booking.startTime}.`);

      if (res.confirmationSms) {
        await this.smsProvider.sendSms({
          to: res.booking.customerPhone,
          from: this.getBusinessSmsNumber(),
          body: res.confirmationSms,
          metadata: { bookingId: res.booking.id, providerCallId: toolCall.providerCallId },
        });
      }

      this.store.appendConversationMessage({
        customerPhone: res.booking.customerPhone,
        channel: "voice",
        role: "assistant",
        content: res.confirmationSms || `Rescheduled appointment to ${res.booking.startTime}.`,
        providerCallId: toolCall.providerCallId,
      });

      return {
        success: true,
        tool: "reschedule_appointment",
        booking: res.booking,
        message: res.confirmationSms || "Appointment rescheduled.",
      };
    }

    if (toolCall.tool === "cancel_appointment") {
      const res = await handleBookingWorkflow(
        {
          action: "cancel",
          bookingId: toolCall.bookingId,
        },
        this.clientConfig,
        this.calendar,
        this.store
      );

      if (!res.success || !res.booking) {
        session.toolActionsSummary.push(`Cancel attempt for ${toolCall.bookingId} failed: ${res.error}`);
        return {
          success: false,
          tool: "cancel_appointment",
          message: res.error || "Unable to cancel booking.",
          error: res.error,
        };
      }

      this.store.cancelFollowUpsForEntity("booking", toolCall.bookingId);
      session.toolActionsSummary.push(`Cancelled booking ${toolCall.bookingId}.`);

      if (res.confirmationSms) {
        await this.smsProvider.sendSms({
          to: res.booking.customerPhone,
          from: this.getBusinessSmsNumber(),
          body: res.confirmationSms,
          metadata: { bookingId: res.booking.id, providerCallId: toolCall.providerCallId },
        });
      }

      this.store.appendConversationMessage({
        customerPhone: res.booking.customerPhone,
        channel: "voice",
        role: "assistant",
        content: res.confirmationSms || `Cancelled appointment ${res.booking.id}.`,
        providerCallId: toolCall.providerCallId,
      });

      return {
        success: true,
        tool: "cancel_appointment",
        booking: res.booking,
        message: res.confirmationSms || "Appointment cancelled.",
      };
    }

    // toolCall.tool === "ask_agent"
    const historyPhone = callerPhone || "unknown";
    const priorHistory =
      historyPhone !== "unknown"
        ? this.store.getConversationHistory(historyPhone).map((m) => ({ role: m.role, content: m.content }))
        : [];

    if (historyPhone !== "unknown") {
      this.store.appendConversationMessage({
        customerPhone: historyPhone,
        channel: "voice",
        role: "user",
        content: toolCall.question,
        providerCallId: toolCall.providerCallId,
      });
    }

    const turn = await this.engine.processTurn({
      userMessage: toolCall.question,
      context: {
        clientConfig: this.clientConfig,
        channel: "voice",
        senderPhone: historyPhone,
      },
      conversationHistory: priorHistory,
    });

    if (historyPhone !== "unknown") {
      this.store.appendConversationMessage({
        customerPhone: historyPhone,
        channel: "voice",
        role: "assistant",
        content: turn.reply,
        providerCallId: toolCall.providerCallId,
      });
    }

    return {
      success: true,
      tool: "ask_agent",
      message: turn.reply,
    };
  }

  async handleInboundSms(event: InboundSmsEvent): Promise<{
    replyText: string;
    outboundMessageId: string;
    bookingCreatedId?: string;
    stoppedEstimateIds: string[];
  }> {
    // 1. Customer reply on an open estimate stops pending follow-ups through DataStore
    const stoppedEstimates = stopOpenEstimatesForCustomerReply(event.from, "sms", this.store);

    // 2. Load shared conversation history across both voice and SMS
    const priorHistory = this.store
      .getConversationHistory(event.from)
      .map((m) => ({ role: m.role, content: m.content }));

    this.store.appendConversationMessage({
      customerPhone: event.from,
      channel: "sms",
      role: "user",
      content: event.body,
      timestamp: event.timestamp,
    });

    // 3. Route turn into the configured EngineAdapter
    const turn = await this.engine.processTurn({
      userMessage: event.body,
      context: {
        clientConfig: this.clientConfig,
        channel: "sms",
        senderPhone: event.from,
      },
      conversationHistory: priorHistory,
    });

    let replyText = turn.reply;
    let bookingCreatedId: string | undefined;

    if (turn.actionTaken?.type === "TOOL_CALL" && turn.actionTaken.details?.name === "manageBooking") {
      const rawArgs = turn.actionTaken.details.args as {
        action: "create" | "reschedule" | "cancel";
        bookingId?: string;
        input?: {
          customerName?: string;
          customerPhone?: string;
          serviceId?: string;
          requestedStartTime?: string;
        };
      };

      const bookingResult = await handleBookingWorkflow(
        {
          action: rawArgs.action,
          bookingId: rawArgs.bookingId,
          customerName: rawArgs.input?.customerName,
          customerPhone: rawArgs.input?.customerPhone || event.from,
          serviceId: rawArgs.input?.serviceId,
          requestedStartTime: rawArgs.input?.requestedStartTime,
        },
        this.clientConfig,
        this.calendar,
        this.store
      );

      if (bookingResult.success && bookingResult.booking) {
        bookingCreatedId = bookingResult.booking.id;
        if (rawArgs.action === "cancel" || rawArgs.action === "reschedule") {
          if (rawArgs.bookingId) {
            this.store.cancelFollowUpsForEntity("booking", rawArgs.bookingId);
          }
        }
        if (bookingResult.booking.status === "confirmed") {
          this.scheduleBookingReminders(
            bookingResult.booking.id,
            bookingResult.booking.customerPhone,
            bookingResult.scheduledReminders || []
          );
        }
        replyText = bookingResult.confirmationSms || turn.reply || "Your appointment has been updated.";
      } else {
        replyText = `Sorry, we couldn't complete that booking: ${bookingResult.error || "Unavailable slot."}`;
      }
    }

    const sent = await this.smsProvider.sendSms({
      to: event.from,
      from: this.getBusinessSmsNumber(),
      body: replyText,
      metadata: {
        inboundMessageId: event.providerMessageId,
        bookingId: bookingCreatedId,
      },
    });

    this.store.appendConversationMessage({
      customerPhone: event.from,
      channel: "sms",
      role: "assistant",
      content: replyText,
    });

    this.store.logAudit({
      id: this.store.generateId("aud-sms"),
      action: "SMS_TURN_COMPLETED",
      entityType: "sms",
      entityId: event.providerMessageId,
      details: {
        customerPhone: event.from,
        outboundMessageId: sent.messageId,
        bookingCreatedId: bookingCreatedId || null,
        stoppedEstimateIds: stoppedEstimates.map((e) => e.id),
      },
      timestamp: new Date().toISOString(),
    });

    return {
      replyText,
      outboundMessageId: sent.messageId,
      bookingCreatedId,
      stoppedEstimateIds: stoppedEstimates.map((e) => e.id),
    };
  }
}
