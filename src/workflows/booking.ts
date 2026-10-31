import type { ClientConfig } from "../types/config.ts";
import type { DataStore } from "../db/store.ts";
import type { CalendarAdapter } from "../calendar/calendar.ts";
import type { Booking } from "../types/db.ts";

export interface BookingWorkflowInput {
  customerName: string;
  customerPhone: string;
  serviceId: string;
  requestedStartTime: string;
}

export interface BookingWorkflowResult {
  success: boolean;
  booking?: Booking;
  confirmationSms?: string;
  scheduledReminders?: { time: string; text: string }[];
  error?: string;
}

/**
 * Booking workflow: check services and rules, read calendar availability
 * (Google Calendar first via its API / CalendarAdapter), create the booking,
 * send confirmation, schedule reminders.
 */
export async function handleBookingWorkflow(
  input: BookingWorkflowInput,
  clientConfig: ClientConfig,
  calendar: CalendarAdapter,
  store: DataStore
): Promise<BookingWorkflowResult> {
  const service = clientConfig.services.services.find((s) => s.id === input.serviceId);
  if (!service) {
    return {
      success: false,
      error: `Service "${input.serviceId}" not found in business catalog.`,
    };
  }

  const durationMs = (service.durationMinutes + (service.bufferMinutes || 0)) * 60 * 1000;
  const startTime = new Date(input.requestedStartTime);
  const endTime = new Date(startTime.getTime() + durationMs);

  const startIso = startTime.toISOString();
  const endIso = endTime.toISOString();

  // Check calendar availability
  const available = await calendar.checkAvailability(startIso, endIso);
  if (!available) {
    return {
      success: false,
      error: `Requested slot (${startIso} - ${endIso}) is not available on calendar.`,
    };
  }

  // Create calendar event
  const calendarEvent = await calendar.createEvent({
    id: `ev-${Date.now()}`,
    title: `${service.name} - ${input.customerName}`,
    startTime: startIso,
    endTime: endIso,
    attendees: [input.customerPhone],
    description: `Service: ${service.name} ($${service.price})`,
  });

  const booking: Booking = {
    id: `bk-${Date.now()}`,
    customerName: input.customerName,
    customerPhone: input.customerPhone,
    serviceId: service.id,
    serviceName: service.name,
    startTime: startIso,
    endTime: endIso,
    status: "confirmed",
    notes: `Calendar event id: ${calendarEvent.id}`,
    createdAt: new Date().toISOString(),
  };

  store.createBooking(booking);

  const confirmationSms = `You're all booked! ${service.name} with ${clientConfig.business.name} is confirmed for ${startTime.toLocaleString("en-US", { timeZone: clientConfig.business.timezone })}. Reply RESCHEDULE if you need to make changes.`;

  // Schedule reminders: 24 hours prior, 2 hours prior
  const reminder24h = new Date(startTime.getTime() - 24 * 60 * 60 * 1000).toISOString();
  const reminder2h = new Date(startTime.getTime() - 2 * 60 * 60 * 1000).toISOString();

  const scheduledReminders = [
    {
      time: reminder24h,
      text: `Reminder: Your ${service.name} with ${clientConfig.business.name} is tomorrow at ${startTime.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", timeZone: clientConfig.business.timezone })}.`,
    },
    {
      time: reminder2h,
      text: `We will see you in about 2 hours for your ${service.name}! Our technician is on the way soon.`,
    },
  ];

  // Audit log (operational booking confirmation)
  store.logAudit({
    id: `aud-bk-${Date.now()}`,
    action: "BOOKING_CONFIRMED",
    entityType: "booking",
    entityId: booking.id,
    details: {
      customerPhone: input.customerPhone,
      service: service.name,
      calendarEventId: calendarEvent.id,
      scheduledRemindersCount: scheduledReminders.length,
      guardrailBypassReason: "one_to_one_operational_flow",
    },
    timestamp: new Date().toISOString(),
  });

  return {
    success: true,
    booking,
    confirmationSms,
    scheduledReminders,
  };
}
