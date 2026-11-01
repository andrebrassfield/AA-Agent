import type { ClientConfig } from "../types/config.ts";
import type { DataStore } from "../db/store.ts";

export interface ReviewRequestInput {
  bookingId: string;
  customerName: string;
  customerPhone: string;
  delayHours?: number;
  reviewLink?: string;
}

export interface ReviewRequestResult {
  sent: boolean;
  messageText: string;
  scheduledFor: string;
  auditId: string;
}

/**
 * Review requests workflow: after a completed job, one polite ask
 * with the business's review link, configurable delay.
 */
export async function handleReviewRequestWorkflow(
  input: ReviewRequestInput,
  clientConfig: ClientConfig,
  store: DataStore
): Promise<ReviewRequestResult> {
  let review = store.getReview(input.bookingId);

  if (review && review.status === "sent") {
    return {
      sent: false,
      messageText: "Already sent",
      scheduledFor: review.sendAt,
      auditId: "none"
    };
  }

  const delayHours = input.delayHours ?? 2; // Default 2 hours post-job
  const scheduledTime = new Date(Date.now() + delayHours * 3600 * 1000).toISOString();
  const reviewLink = input.reviewLink || `https://g.page/r/${encodeURIComponent(clientConfig.business.name.replace(/\s+/g, ""))}/review`;

  if (!review) {
    store.createReview({
      id: input.bookingId,
      bookingLink: reviewLink,
      sendAt: scheduledTime,
      status: "pending",
      createdAt: new Date().toISOString()
    });
    review = store.getReview(input.bookingId);
  }

  const messageText = `Hi ${input.customerName}, thanks for trusting ${clientConfig.business.name} with your service! If you have a quick moment, we'd truly appreciate your feedback: ${reviewLink}`;

  store.updateReviewStatus(input.bookingId, "sent");

  const auditId = `aud-rev-${Date.now()}`;
  store.logAudit({
    id: auditId,
    action: "REVIEW_REQUEST_SENT",
    entityType: "booking",
    entityId: input.bookingId,
    details: {
      customerPhone: input.customerPhone,
      message: messageText,
      delayHours,
      scheduledFor: scheduledTime,
    },
    timestamp: new Date().toISOString(),
  });

  return {
    sent: true,
    messageText,
    scheduledFor: scheduledTime,
    auditId,
  };
}
