import type { ClientConfig } from "../../types/config.ts";

/**
 * Standard CTIA / A2P 10DLC single-word opt-out, opt-in, and informational keywords.
 * Matched case-insensitively when sent as a standalone message (ignoring surrounding whitespace/punctuation)
 * so conversational phrases like "Please cancel my appointment tomorrow" continue to route to booking logic.
 */
export const SMS_OPT_OUT_KEYWORDS = new Set([
  "STOP",
  "STOPALL",
  "UNSUBSCRIBE",
  "CANCEL",
  "END",
  "QUIT",
]);

export const SMS_OPT_IN_KEYWORDS = new Set([
  "START",
  "UNSTOP",
  "SUBSCRIBE",
]);

export const SMS_HELP_KEYWORDS = new Set([
  "HELP",
  "INFO",
]);

export type SmsComplianceCommand =
  | { type: "opt_out"; keyword: string }
  | { type: "opt_in"; keyword: string }
  | { type: "help"; keyword: string }
  | { type: "none" };

export function classifySmsComplianceCommand(
  body: string,
  currentlyOptedOut: boolean = false
): SmsComplianceCommand {
  const cleaned = body
    .trim()
    .replace(/^[.!?,;:\s]+|[.!?,;:\s]+$/g, "")
    .toUpperCase();

  if (!cleaned) {
    return { type: "none" };
  }

  if (SMS_OPT_OUT_KEYWORDS.has(cleaned)) {
    return { type: "opt_out", keyword: cleaned };
  }

  if (SMS_OPT_IN_KEYWORDS.has(cleaned) || (cleaned === "YES" && currentlyOptedOut)) {
    return { type: "opt_in", keyword: cleaned };
  }

  if (SMS_HELP_KEYWORDS.has(cleaned)) {
    return { type: "help", keyword: cleaned };
  }

  return { type: "none" };
}

export function buildSmsHelpReply(clientConfig: ClientConfig): string {
  const shopName = clientConfig.business.name;
  const shopPhone = clientConfig.business.phoneNumbers.main;
  return `${shopName}: Automated front desk text line. For assistance, call ${shopPhone}. Reply STOP to opt out or START to resubscribe. Msg & data rates may apply.`;
}

export function buildSmsOptInReply(clientConfig: ClientConfig): string {
  const shopName = clientConfig.business.name;
  return `${shopName}: You are opted back in to text messages. Reply HELP for info or STOP to opt out. Msg & data rates may apply.`;
}
