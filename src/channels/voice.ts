import type { ServerConfig } from "../server/server.ts";
import { handleMissedCallTextBack } from "../workflows/missed_call.ts";
import { handleBookingWorkflow } from "../workflows/booking.ts";
import { FakeCalendar } from "../calendar/calendar.ts";

export async function handleVoiceWebhook(payload: any, config: ServerConfig): Promise<Response> {
  // Retell-style webhook
  const eventType = payload.event;
  const callerPhone = payload.call?.from || payload.callerPhone;
  const callId = payload.call?.call_id || payload.callId;

  if (eventType === "call_started") {
     // no-op for now
     return new Response(JSON.stringify({ received: true }), { status: 200 });
  }

  if (eventType === "call_ended") {
    // Check if missed
    const status = payload.call?.status || payload.status;
    if (status === "missed" || status === "unanswered") {
      const callLogExists = config.store.listCallLogs().find(l => l.id === callId);
      if (!callLogExists) {
        await handleMissedCallTextBack({ callerPhone, callId }, config.clientConfig, config.store);
      } else {
          // duplicate missed call event, ignore
          config.store.logAudit({
              id: config.store.generateId("aud-mctb-dedupe"),
              action: "MISSED_CALL_TEXT_BACK_DEDUPE",
              entityType: "call",
              entityId: callId,
              details: { callerPhone },
              timestamp: new Date().toISOString(),
          });
      }
    }
    return new Response(JSON.stringify({ received: true }), { status: 200 });
  }

  if (eventType === "tool_call") {
    const toolName = payload.tool?.name;
    if (toolName === "manageBooking") {
       const args = payload.tool?.args;
       const workflowInput = {
         action: args.action,
         bookingId: args.bookingId,
         ...(args.input || {})
       };
       const result = await handleBookingWorkflow(
           workflowInput,
           config.clientConfig,
           new FakeCalendar(),
           config.store
       );
       return new Response(JSON.stringify({ success: result.success, result }), { status: 200, headers: { "Content-Type": "application/json" } });
    }
  }

  return new Response("OK", { status: 200 });
}
