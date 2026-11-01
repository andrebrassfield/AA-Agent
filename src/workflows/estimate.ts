import type { ClientConfig } from "../types/config.ts";
import type { DataStore } from "../db/store.ts";
import type { EstimateStatus, ScheduledFollowUp } from "../types/db.ts";

export interface EstimateTouchPlan {
  day: number;
  message: string;
}

/**
 * Estimate follow-up workflow: open estimates get touches on day 2, day 5, and day 10
 * in the business's voice, stopping on any reply.
 */
export function getEstimateTouchMessage(
  day: 2 | 5 | 10,
  clientConfig: ClientConfig,
  customerName: string,
  serviceName: string
): string {
  const bizName = clientConfig.business.name;
  switch (day) {
    case 2:
      return `Hi ${customerName}, this is ${bizName}. Just checking in to see if you had any questions regarding the estimate we sent over for your ${serviceName}?`;
    case 5:
      return `Hello ${customerName}, ${bizName} here! We'd love to help get your ${serviceName} on the schedule. Do you need any adjustments or more details on your quote?`;
    case 10:
      return `Hi ${customerName}, final check-in from ${bizName}. Our quote for your ${serviceName} is valid for another week. Let us know if you'd like to proceed or have any questions!`;
    default:
      return `Hi ${customerName}, following up on your estimate with ${bizName}.`;
  }
}

/**
 * Stops pending automated follow-ups for any open estimate belonging to customerPhone,
 * regardless of whether the customer replied via SMS or Voice.
 */
export function stopOpenEstimatesForCustomerReply(
  customerPhone: string,
  channel: "sms" | "voice",
  store: DataStore
): EstimateStatus[] {
  const openEstimates = store.listOpenEstimatesByPhone(customerPhone);
  const stopped: EstimateStatus[] = [];

  for (const estimate of openEstimates) {
    estimate.status = "replied";
    estimate.nextTouchAt = undefined;
    estimate.stopReason = `Customer replied via ${channel} - stopping automated follow-ups`;
    store.updateEstimate(estimate);
    store.cancelFollowUpsForEntity("estimate", estimate.id);

    store.logAudit({
      id: store.generateId("aud-est-stop"),
      action: "ESTIMATE_TOUCH_STOPPED",
      entityType: "estimate",
      entityId: estimate.id,
      details: {
        reason: estimate.stopReason,
        channel,
        customerPhone,
      },
      timestamp: new Date().toISOString(),
    });

    stopped.push(estimate);
  }

  return stopped;
}

export async function processEstimateFollowUpTouch(
  estimateId: string,
  targetDay: 2 | 5 | 10,
  clientConfig: ClientConfig,
  store: DataStore,
  customerReplied: boolean = false
): Promise<{ touchSent: boolean; reason?: string; message?: string }> {
  const estimate = store.getEstimate(estimateId);
  if (!estimate) {
    return { touchSent: false, reason: "Estimate not found." };
  }

  const touchesSent = JSON.parse(estimate.touchesSent) as number[];

  if (estimate.status !== "open" || customerReplied) {
    if (customerReplied && estimate.status === "open") {
      estimate.status = "replied";
      estimate.nextTouchAt = undefined;
      estimate.stopReason = "Customer replied - stopping automated follow-ups";
      store.updateEstimate(estimate);
      store.cancelFollowUpsForEntity("estimate", estimate.id);
    }

    store.logAudit({
      id: store.generateId("aud-est-stop"),
      action: "ESTIMATE_TOUCH_STOPPED",
      entityType: "estimate",
      entityId: estimate.id,
      details: { reason: estimate.stopReason || "Estimate no longer open", targetDay },
      timestamp: new Date().toISOString(),
    });
    return { touchSent: false, reason: "Estimate closed or replied; sequence stopped." };
  }

  if (touchesSent.includes(targetDay)) {
    return { touchSent: false, reason: `Touch for day ${targetDay} already sent.` };
  }

  const message = getEstimateTouchMessage(targetDay, clientConfig, estimate.customerName, "HVAC system replacement");

  touchesSent.push(targetDay);
  estimate.touchesSent = JSON.stringify(touchesSent);
  store.updateEstimate(estimate);

  store.logAudit({
    id: store.generateId(`aud-est-touch-${targetDay}`),
    action: `ESTIMATE_TOUCH_DAY_${targetDay}`,
    entityType: "estimate",
    entityId: estimate.id,
    details: {
      recipientPhone: estimate.customerPhone,
      message,
      day: targetDay,
    },
    timestamp: new Date().toISOString(),
  });

  return { touchSent: true, message };
}

/**
 * Schedules the day 2, day 5, and day 10 estimate follow-up touches in `scheduled_followups`
 * so `FollowUpDispatcher` inside `aabook serve` dispatches them automatically unless the customer replies.
 */
export function scheduleEstimateFollowUps(
  estimateId: string,
  clientConfig: ClientConfig,
  store: DataStore,
  serviceName: string = "HVAC system replacement",
  createdAtDate?: Date
): ScheduledFollowUp[] {
  const estimate = store.getEstimate(estimateId);
  if (!estimate || estimate.status !== "open") {
    return [];
  }

  const baseMs = (createdAtDate ?? new Date(estimate.createdAt)).getTime();
  const touchDays: (2 | 5 | 10)[] = [2, 5, 10];
  const created: ScheduledFollowUp[] = [];

  for (const day of touchDays) {
    const scheduledFor = new Date(baseMs + day * 24 * 60 * 60 * 1000).toISOString();
    const message = getEstimateTouchMessage(day, clientConfig, estimate.customerName, serviceName);
    const id = store.scheduleFollowUp({
      type: "estimate_touch",
      entityType: "estimate",
      entityId: estimate.id,
      recipientPhone: estimate.customerPhone,
      message,
      scheduledFor,
      status: "pending",
    });
    const row = store.getFollowUp(id);
    if (row) {
      created.push(row);
    }
  }

  return created;
}
