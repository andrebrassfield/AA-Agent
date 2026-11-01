# AA Book Roadmap & Known Limits (`ROADMAP.md`)

This file tracks what is implemented in AA Book today and what remains open for live voice and calendar integrations. Nothing stubbed is presented as live.

---

## Closed in Current Build

- **Live Twilio SMS Carrier Adapter (`src/channels/sms/twilio.ts`, `src/channels/registry.ts`):** `TwilioSmsProvider` implements `SmsProvider` over Bun's built-in `fetch` with zero extra runtime dependencies, reading `TWILIO_ACCOUNT_SID` and `TWILIO_AUTH_TOKEN` strictly from `.env` (and resolving the sending number from client config or `TWILIO_PHONE_NUMBER`) with full secret redaction in logs and errors. `stub` stays the default for `aabook demo` and tests; `twilio` is selected per client in `client/channels.json`.
- **Signed Carrier Inbound SMS Webhook (`src/server/server.ts`, `src/channels/sms/twilio.ts`):** `POST /webhooks/twilio/sms` validates `X-Twilio-Signature` (HMAC-SHA1 in constant time) before accepting any message, rejects missing or invalid signatures with `403` and a `WEBHOOK_SIGNATURE_REJECTED` audit entry, and routes valid messages into the shared `ChannelCoordinator` conversation path.
- **10DLC Opt-Out Compliance (`src/channels/sms/compliance.ts`, `src/db/store.ts`, `src/workflows/missed_call.ts`, `src/channels/coordinator.ts`, `src/workflows/dispatcher.ts`):** Inbound `STOP` (and standard CTIA variants `STOPALL`, `UNSUBSCRIBE`, `CANCEL`, `END`, `QUIT`) marks the normalized phone opted out in SQLite (`sms_opt_outs`) and suppresses outbound sends across missed-call text-back, SMS conversation, voice booking SMS confirmations, and `FollowUpDispatcher`; `START` (`UNSTOP`) reverses opt-out; `HELP` (`INFO`) sends standard informational copy. Every opt-out and opt-in is audit-logged.
- **Live HTTP Model Providers, `FollowUpDispatcher`, & `OmpEngine` Timeout (`src/router/providers.ts`, `src/workflows/dispatcher.ts`, `src/engine/omp.ts`):** OpenAI-compatible, Anthropic, and Gemini HTTP providers over `fetch` with real token spend ledgering; atomic SQLite follow-up tick loop honoring quiet hours; configurable `OmpEngine` turn timeout.

> **Live Carrier Prerequisite:** Sending and receiving real SMS in production still requires the owner's paid Twilio account, purchased phone number, and approved US A2P 10DLC Brand + Campaign registration—follow the step-by-step checklist in [`CLIENT-SETUP.md`](./CLIENT-SETUP.md).

---

## Still Open (Remaining Integrations)

### 1. ElevenLabs Voice Adapter
- **Where:** `src/config/validator.ts`, `src/channels/registry.ts`, `src/channels/voice/retell.ts`
- **Current behavior:** `channels.json` accepts `"voice": { "provider": "retell" | "elevenlabs" }`. `RetellVoiceAdapter` is implemented and tested; selecting `"elevenlabs"` fails fast at startup with a clear unregistered-provider error until `ElevenLabsVoiceAdapter` is added.
- **Next step:** Implement `ElevenLabsVoiceAdapter` mapping ElevenLabs Conversational AI webhook lifecycle events and server-tool calls onto `VoiceProviderAdapter`.

### 2. Two-Way Google Calendar Sync
- **Where:** `src/calendar/calendar.ts`
- **Current behavior:** `GoogleCalendarAdapter` performs service-account JWT exchange and `POST` event creation against Google Calendar v3, while `listBusySlots` reads in-process state and reschedules/cancellations do not yet issue remote Google Calendar `PATCH`/`DELETE` calls.
- **Next step:** Query Google Calendar `freeBusy` / `events.list` in `listBusySlots` so external busy blocks booked outside AA Book prevent conflicts, and persist remote Google Calendar event IDs on `bookings` for two-way reschedule and cancellation updates.

### 3. Operational Polish & Guardrails
- **Retell Webhook HMAC & HTTPS Ingress Helper (`src/server/server.ts`):** Inbound voice webhooks currently authenticate via constant-time `WEBHOOK_SECRET`; native `X-Retell-Signature` verification and automated tunnel setup (Cloudflare Tunnel / Tailscale Funnel) remain open.
- **Bulk Campaign CLI Gate (`SPEC.md`):** AA Book ships 1-to-1 operational messages only; any future bulk review or seasonal campaign command must require explicit human CLI preview and approval before queueing.
- **`PiEngine` MCP Spawn Runtime (`src/engine/pi.ts`):** Switching `PiEngine`'s MCP child process command from `node` to `process.execPath` (`bun`) removes any Node requirement when `AABOOK_ENGINE=pi` is selected.
