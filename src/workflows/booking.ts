import type { ClientConfig } from "../types/config.ts";
import type { DataStore } from "../db/store.ts";
import type { CalendarAdapter } from "../calendar/calendar.ts";
import type { Booking } from "../types/db.ts";

export interface BookingWorkflowInput {
  action: "create" | "reschedule" | "cancel";
  bookingId?: string;
  customerName?: string;
  customerPhone?: string;
  serviceId?: string;
  requestedStartTime?: string;
}

export interface BookingWorkflowResult {
  success: boolean;
  booking?: Booking;
  confirmationSms?: string;
  scheduledReminders?: { time: string; text: string }[];
  error?: string;
}

export function isWithinBusinessHours(start: Date, end: Date, config: ClientConfig): boolean {
  const dayMap = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
  const startDay = dayMap[start.getUTCDay()];
  const hours = (config.business.hours as any)[startDay];

  if (!hours || hours.closed) return false;

  const getMin = (timeStr: string) => {
    const [h, m] = timeStr.split(":").map(Number);
    return h * 60 + m;
  };

  const reqStartMin = start.getUTCHours() * 60 + start.getUTCMinutes();
  let reqEndMin = end.getUTCHours() * 60 + end.getUTCMinutes();
  // Handle cross-day boundary extremely simply for this demo check
  if (reqEndMin < reqStartMin) {
     reqEndMin += 24 * 60;
  }

  const openMin = getMin(hours.open);
  const closeMin = getMin(hours.close);

  return reqStartMin >= openMin && reqEndMin <= closeMin;
}

export async function handleBookingWorkflow(
  input: BookingWorkflowInput,
  clientConfig: ClientConfig,
  calendar: CalendarAdapter,
  store: DataStore
): Promise<BookingWorkflowResult> {
  if (input.action === "cancel") {
    if (!input.bookingId) return { success: false, error: "bookingId required for cancel" };
    const b = store.getBooking(input.bookingId);
    if (!b) return { success: false, error: "Booking not found" };

    store.updateBookingStatus(b.id, "cancelled");
    const evIdMatch = b.notes?.match(/event id: (ev-.*)/);
    if (evIdMatch) {
       await calendar.deleteEvent(evIdMatch[1]);
    }

    return {
      success: true,
      booking: { ...b, status: "cancelled" },
      confirmationSms: `Your appointment with ${clientConfig.business.name} has been cancelled.`
    };
  }

  if (input.action === "reschedule") {
    if (!input.bookingId || !input.requestedStartTime) return { success: false, error: "bookingId and requestedStartTime required" };
    const b = store.getBooking(input.bookingId);
    if (!b) return { success: false, error: "Booking not found" };

    const service = clientConfig.services.services.find((s) => s.id === b.serviceId);
    if (!service) return { success: false, error: "Service not found" };

    const durationMs = (service.durationMinutes + (service.bufferMinutes || 0)) * 60 * 1000;
    const startTime = new Date(input.requestedStartTime);
    const endTime = new Date(startTime.getTime() + durationMs);

    if (!isWithinBusinessHours(startTime, endTime, clientConfig)) {
      return { success: false, error: "Requested time is outside business hours." };
    }

    const startIso = startTime.toISOString();
    const endIso = endTime.toISOString();

    const evIdMatch = b.notes?.match(/event id: (ev-.*)/);
    const evId = evIdMatch ? evIdMatch[1] : null;

    if (evId) {
       await calendar.deleteEvent(evId);
    }

    const available = await calendar.checkAvailability(startIso, endIso);
    if (!available) {
      if (evId) await calendar.createEvent({ id: evId, title: b.serviceName, startTime: b.startTime, endTime: b.endTime });
      return { success: false, error: `Requested slot is not available.` };
    }

    const newEv = await calendar.createEvent({
      id: store.generateId("ev"),
      title: `${service.name} - ${b.customerName}`,
      startTime: startIso,
      endTime: endIso,
      attendees: [b.customerPhone],
    });

    store.updateBookingStatus(b.id, "rescheduled");
    const newBooking: Booking = {
      ...b,
      id: store.generateId("bk"),
      startTime: startIso,
      endTime: endIso,
      status: "confirmed",
      notes: `Calendar event id: ${newEv.id}`
    };
    store.createBooking(newBooking);

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

    return {
      success: true,
      booking: newBooking,
      confirmationSms: `Your ${service.name} is rescheduled for ${startTime.toLocaleString("en-US", { timeZone: clientConfig.business.timezone })}.`,
      scheduledReminders,
    };
  }

  // Create
  if (!input.serviceId || !input.requestedStartTime || !input.customerName || !input.customerPhone) {
    return { success: false, error: "Missing required fields for create" };
  }

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

  if (!isWithinBusinessHours(startTime, endTime, clientConfig)) {
    return { success: false, error: "Requested time is outside business hours." };
  }

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
    id: store.generateId("ev"),
    title: `${service.name} - ${input.customerName}`,
    startTime: startIso,
    endTime: endIso,
    attendees: [input.customerPhone],
    description: `Service: ${service.name} ($${service.price})`,
  });

  const booking: Booking = {
    id: store.generateId("bk"),
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

  store.logAudit({
    id: store.generateId("aud-bk"),
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