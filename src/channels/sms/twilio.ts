import * as crypto from "node:crypto";
import { generateId } from "../../db/store.ts";
import { collectEnvSecrets, redactString } from "../../server/redact.ts";
import {
  ChannelValidationError,
  type InboundSmsEvent,
  type OutboundSmsRequest,
  type OutboundSmsResult,
  type SmsProvider,
} from "../../types/channels.ts";
import type { ClientConfig } from "../../types/config.ts";

export const DEFAULT_TWILIO_API_BASE_URL = "https://api.twilio.com";
export const DEFAULT_TWILIO_TIMEOUT_MS = 15_000;

function isRecord(val: unknown): val is Record<string, unknown> {
  return typeof val === "object" && val !== null && !Array.isArray(val);
}

/**
 * Resolves the outbound SMS sending number for a client:
 * 1. Explicit SMS number in client config (`channels.sms.fromNumber` or `business.phoneNumbers.sms`)
 * 2. `TWILIO_PHONE_NUMBER` from environment (`.env`)
 * 3. Fallback to `business.phoneNumbers.main`
 */
export function resolveSmsFromNumber(
  clientConfig: ClientConfig,
  env: NodeJS.ProcessEnv = process.env
): string {
  const configuredSms =
    clientConfig.channels?.sms.fromNumber?.trim() ||
    clientConfig.business.phoneNumbers.sms?.trim();
  if (configuredSms) {
    return configuredSms;
  }
  const providerChoice = clientConfig.channels?.sms.provider ?? "stub";
  if (providerChoice === "twilio") {
    const envPhone = env.TWILIO_PHONE_NUMBER?.trim();
    if (envPhone) {
      return envPhone;
    }
  }
  return clientConfig.business.phoneNumbers.main.trim();
}

/**
 * Computes Twilio's `X-Twilio-Signature` header (Base64 HMAC-SHA1) for a webhook URL and POST form parameters.
 */
export function computeTwilioSignature(
  authToken: string,
  url: string,
  formParams?: Record<string, string> | URLSearchParams
): string {
  const entries: [string, string][] = [];
  if (formParams instanceof URLSearchParams) {
    formParams.forEach((value, key) => {
      entries.push([key, value]);
    });
  } else if (formParams) {
    for (const [key, value] of Object.entries(formParams)) {
      entries.push([key, String(value)]);
    }
  }

  entries.sort((a, b) => {
    if (a[0] < b[0]) return -1;
    if (a[0] > b[0]) return 1;
    if (a[1] < b[1]) return -1;
    if (a[1] > b[1]) return 1;
    return 0;
  });

  let data = url;
  for (const [key, value] of entries) {
    data += key + value;
  }

  return crypto.createHmac("sha1", authToken).update(data, "utf-8").digest("base64");
}

function constantTimeEquals(a: string, b: string): boolean {
  const bufA = Buffer.from(a, "utf-8");
  const bufB = Buffer.from(b, "utf-8");
  if (bufA.length !== bufB.length) {
    return false;
  }
  return crypto.timingSafeEqual(bufA, bufB);
}

export interface VerifyTwilioSignatureInput {
  authToken: string;
  signatureHeader: string | null;
  candidateUrls: string[];
  formParams?: Record<string, string>;
  rawBody?: string;
}

/**
 * Validates an inbound `X-Twilio-Signature` header against one or more candidate request URLs
 * (supporting both direct URLs and reverse-proxy/tunnel URLs) using constant-time comparison.
 */
export function verifyTwilioSignature(input: VerifyTwilioSignatureInput): boolean {
  const token = input.authToken.trim();
  const provided = input.signatureHeader?.trim() ?? "";
  if (!token || !provided) {
    return false;
  }

  for (const candidateUrl of input.candidateUrls) {
    if (!candidateUrl) continue;

    let parsedUrl: URL | null = null;
    try {
      parsedUrl = new URL(candidateUrl);
    } catch {
      parsedUrl = null;
    }

    const bodySha256Param = parsedUrl?.searchParams.get("bodySHA256");
    if (bodySha256Param && input.rawBody !== undefined && !input.formParams) {
      const actualBodyHash = crypto
        .createHash("sha256")
        .update(input.rawBody, "utf-8")
        .digest("hex");
      if (!constantTimeEquals(actualBodyHash.toLowerCase(), bodySha256Param.toLowerCase())) {
        continue;
      }
      const expectedJsonSig = computeTwilioSignature(token, candidateUrl);
      if (constantTimeEquals(provided, expectedJsonSig)) {
        return true;
      }
      continue;
    }

    const expectedFormSig = computeTwilioSignature(token, candidateUrl, input.formParams);
    if (constantTimeEquals(provided, expectedFormSig)) {
      return true;
    }
  }

  return false;
}

export interface TwilioSmsProviderOptions {
  /**
   * Optional Twilio REST API base URL override (defaults to `process.env.TWILIO_API_BASE_URL` or `https://api.twilio.com`).
   * Used by local fake carrier tests so real Twilio is never contacted in tests.
   */
  apiBaseUrl?: string;
  /**
   * Non-secret default sending number resolved from client config (`channels.json` / `business.json`).
   * Falls back to `TWILIO_PHONE_NUMBER` in `.env` when omitted.
   */
  defaultFromNumber?: string;
  timeoutMs?: number;
  env?: NodeJS.ProcessEnv;
}

/**
 * Live Twilio carrier adapter implementing `SmsProvider` over Bun's built-in `fetch`
 * with zero extra runtime dependencies. Credentials (`TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`)
 * are read strictly from environment variables and redacted in all errors.
 */
export class TwilioSmsProvider implements SmsProvider {
  readonly name = "twilio";
  private readonly explicitBaseUrl?: string;
  private readonly defaultFromNumber?: string;
  private readonly timeoutMs: number;
  private readonly env: NodeJS.ProcessEnv;

  constructor(options: TwilioSmsProviderOptions = {}) {
    this.explicitBaseUrl = options.apiBaseUrl;
    this.defaultFromNumber = options.defaultFromNumber;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TWILIO_TIMEOUT_MS;
    this.env = options.env ?? process.env;
  }

  withDefaultFromNumber(fromNumber?: string): TwilioSmsProvider {
    if (!fromNumber || fromNumber === this.defaultFromNumber) {
      return this;
    }
    return new TwilioSmsProvider({
      apiBaseUrl: this.explicitBaseUrl,
      defaultFromNumber: fromNumber,
      timeoutMs: this.timeoutMs,
      env: this.env,
    });
  }

  private resolveApiBaseUrl(): string {
    const raw =
      this.explicitBaseUrl?.trim() ||
      this.env.TWILIO_API_BASE_URL?.trim() ||
      DEFAULT_TWILIO_API_BASE_URL;
    return raw.replace(/\/+$/, "");
  }

  async sendSms(request: OutboundSmsRequest): Promise<OutboundSmsResult> {
    const accountSid = (this.env.TWILIO_ACCOUNT_SID ?? "").trim();
    const authToken = (this.env.TWILIO_AUTH_TOKEN ?? "").trim();

    if (!accountSid) {
      throw new Error(
        "Twilio SMS provider requires TWILIO_ACCOUNT_SID in environment (.env)."
      );
    }
    if (!authToken) {
      throw new Error(
        "Twilio SMS provider requires TWILIO_AUTH_TOKEN in environment (.env)."
      );
    }

    const from =
      request.from?.trim() ||
      this.defaultFromNumber?.trim() ||
      (this.env.TWILIO_PHONE_NUMBER ?? "").trim();

    if (!from) {
      throw new Error(
        "Twilio SMS provider requires a sending phone number in client config or TWILIO_PHONE_NUMBER in environment (.env)."
      );
    }

    const to = request.to?.trim() ?? "";
    if (!to) {
      throw new Error("Twilio SMS send requires a non-empty 'to' phone number.");
    }
    const bodyText = request.body ?? "";
    if (bodyText.trim().length === 0) {
      throw new Error("Twilio SMS send requires a non-empty 'body' message.");
    }

    const basicCredentials = Buffer.from(`${accountSid}:${authToken}`, "utf-8").toString("base64");
    const secrets = collectEnvSecrets([accountSid, authToken, basicCredentials]);

    const endpoint = `${this.resolveApiBaseUrl()}/2010-04-01/Accounts/${encodeURIComponent(
      accountSid
    )}/Messages.json`;

    const formBody = new URLSearchParams({
      To: to,
      From: from,
      Body: bodyText,
    });

    let res: Response;
    try {
      res = await fetch(endpoint, {
        method: "POST",
        headers: {
          Authorization: `Basic ${basicCredentials}`,
          "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8",
          Accept: "application/json",
        },
        body: formBody.toString(),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (err: unknown) {
      const rawMsg = err instanceof Error ? err.message : String(err);
      throw new Error(`Twilio SMS network error: ${redactString(rawMsg, secrets)}`);
    }

    const rawResponseText = await res.text();
    if (!res.ok) {
      let detail = rawResponseText.slice(0, 500);
      try {
        const errJson = JSON.parse(rawResponseText) as Record<string, unknown>;
        const codePart = errJson.code !== undefined ? ` (code ${String(errJson.code)})` : "";
        const msgPart =
          typeof errJson.message === "string" ? errJson.message : rawResponseText.slice(0, 500);
        detail = `${msgPart}${codePart}`;
      } catch {
        // Keep sliced text when upstream error body is non-JSON
      }
      throw new Error(`Twilio SMS HTTP ${res.status}: ${redactString(detail, secrets)}`);
    }

    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(rawResponseText) as Record<string, unknown>;
    } catch (err: unknown) {
      const rawMsg = err instanceof Error ? err.message : String(err);
      throw new Error(`Twilio SMS invalid JSON response: ${redactString(rawMsg, secrets)}`);
    }

    const sid =
      typeof parsed.sid === "string" && parsed.sid.trim().length > 0
        ? parsed.sid.trim()
        : generateId("twilio-sms");

    const rawStatus = typeof parsed.status === "string" ? parsed.status.toLowerCase() : "queued";
    const status: OutboundSmsResult["status"] =
      rawStatus === "sent" || rawStatus === "delivered" ? "sent" : "queued";

    const rawDate = typeof parsed.date_created === "string" ? Date.parse(parsed.date_created) : NaN;
    const timestamp = !Number.isNaN(rawDate)
      ? new Date(rawDate).toISOString()
      : new Date().toISOString();

    return {
      messageId: sid,
      status,
      provider: this.name,
      timestamp,
    };
  }

  parseInboundWebhook(body: unknown): InboundSmsEvent {
    let record: Record<string, unknown>;

    if (body instanceof URLSearchParams) {
      record = {};
      body.forEach((value, key) => {
        record[key] = value;
      });
    } else if (typeof body === "string") {
      record = {};
      const params = new URLSearchParams(body);
      params.forEach((value, key) => {
        record[key] = value;
      });
    } else if (isRecord(body)) {
      record = body;
    } else {
      throw new ChannelValidationError(
        "Inbound Twilio SMS webhook body must be form-encoded parameters or a JSON object."
      );
    }

    const fromRaw = record.From ?? record.from ?? record.sender;
    const toRaw = record.To ?? record.to ?? record.recipient ?? "";
    const textRaw = record.Body ?? record.body ?? record.text ?? record.message;
    const idRaw =
      record.MessageSid ??
      record.SmsMessageSid ??
      record.SmsSid ??
      record.messageId ??
      record.id;
    const tsRaw = record.timestamp;

    if (typeof fromRaw !== "string" || fromRaw.trim().length === 0) {
      throw new ChannelValidationError(
        "Inbound Twilio SMS payload requires a non-empty 'From' phone number."
      );
    }
    if (typeof textRaw !== "string" || textRaw.trim().length === 0) {
      throw new ChannelValidationError(
        "Inbound Twilio SMS payload requires a non-empty 'Body' text."
      );
    }

    return {
      providerMessageId:
        typeof idRaw === "string" && idRaw.trim().length > 0
          ? idRaw.trim()
          : generateId("twilio-in"),
      from: fromRaw.trim(),
      to: typeof toRaw === "string" ? toRaw.trim() : "",
      body: textRaw.trim(),
      timestamp:
        typeof tsRaw === "string" && tsRaw.trim().length > 0
          ? tsRaw
          : new Date().toISOString(),
    };
  }
}
