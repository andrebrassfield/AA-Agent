import type { ClientConfig } from "../types/config.ts";
import type { DataStore } from "../db/store.ts";

export interface EstimateTouchPlan {
  day: number;
  message: string;
}

export interface EstimateFollowUpStatus {
  estimateId: string;
  customerName: string;
  customerPhone: string;
  amount: number;
  touchesSent: number[];
  replied: boolean;
  status: "open" | "replied" | "closed";
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

export async function processEstimateFollowUpTouch(
  estimate: EstimateFollowUpStatus,
  targetDay: 2 | 5 | 10,
  clientConfig: ClientConfig,
  store: DataStore,
  customerReplied: boolean = false
): Promise<{ touchSent: boolean; reason?: string; message?: string }> {
  if (estimate.replied || customerReplied) {
    estimate.replied = true;
    estimate.status = "replied";
    store.logAudit({
      id: `aud-est-stop-${Date.now()}`,
      action: "ESTIMATE_TOUCH_STOPPED",
      entityType: "estimate",
      entityId: estimate.estimateId,
      details: { reason: "Customer replied - stopping automated follow-ups", targetDay },
      timestamp: new Date().toISOString(),
    });
    return { touchSent: false, reason: "Customer replied; sequence stopped." };
  }

  if (estimate.touchesSent.includes(targetDay)) {
    return { touchSent: false, reason: `Touch for day ${targetDay} already sent.` };
  }

  const message = getEstimateTouchMessage(targetDay, clientConfig, estimate.customerName, "HVAC system replacement");
  estimate.touchesSent.push(targetDay);

  store.logAudit({
    id: `aud-est-touch-${Date.now()}-${targetDay}`,
    action: `ESTIMATE_TOUCH_DAY_${targetDay}`,
    entityType: "estimate",
    entityId: estimate.estimateId,
    details: {
      recipientPhone: estimate.customerPhone,
      message,
      day: targetDay,
    },
    timestamp: new Date().toISOString(),
  });

  return { touchSent: true, message };
}
