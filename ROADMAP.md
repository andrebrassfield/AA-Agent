# AA Book Roadmap & Known v1 Limits (`ROADMAP.md`)

This file collects the known limitations of the v1 build across Sessions 1–3 (Base/Engines, Channels, and Packaging) and tracks what is queued for v2. Every item below reflects the actual state of the repository today—nothing stubbed is presented as live.

---

## Known v1 Limits (Priority v2 Work)

### 1. `OmpEngine` Subprocess Has No Turn Timeout Yet
- **Where:** `src/engine/omp.ts`
- **Current behavior:** `OmpEngine` spawns the configured `omp-agent` binary over stdio, handles missing binaries (`ENOENT`) and unexpected exits cleanly, and enforces the AI disclosure guardrail before spawning. However, unlike `PiEngine` (which enforces a 30-second deadline and kills hung child processes), `OmpEngine` has no timer yet—if the external process hangs without writing a newline or closing stdout, `processTurn` waits indefinitely.
- **v2 plan:** Add a configurable per-turn timeout (default 30s) in `OmpEngine` matching `PiEngine`, killing the child process (`SIGTERM` -> `SIGKILL`) and rejecting with an explicit timeout error so callers/texters can fall back gracefully.

### 2. Outbound SMS Uses `StubSmsProvider` (No Live Carrier Transport Yet)
- **Where:** `src/channels/sms/stub.ts`, `src/channels/registry.ts`, `src/config/validator.ts`
- **Current behavior:** All outbound operational texts (missed-call text-back greetings, booking confirmations, and SMS conversation replies) route cleanly through the `SmsProvider` interface, and `channels.json` already validates `"stub"` and `"twilio"`. Only the in-memory `StubSmsProvider` is registered in v1, so `aabook serve` logs/captures outbound SMS in memory rather than delivering live carrier messages.
- **v2 plan:** Implement `TwilioSmsProvider` (and/or Telnyx) behind `SmsProvider` using credentials from `.env` (`TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_FROM_NUMBER`), plus webhook signature verification on `/webhooks/sms` and 10DLC / STOP-keyword opt-out handling.

### 3. ElevenLabs Voice Is a Validated Seam with No Adapter Yet
- **Where:** `src/config/validator.ts`, `src/channels/registry.ts`, `src/channels/voice/retell.ts`
- **Current behavior:** `channels.json` accepts `"voice": { "provider": "retell" | "elevenlabs" }`, and `ChannelAdapterRegistry` decouples voice providers from booking/workflow logic. `RetellVoiceAdapter` is implemented and tested in v1; selecting `"elevenlabs"` fails fast at server startup with a clear unregistered-provider error because `ElevenLabsVoiceAdapter` has not been written yet.
- **v2 plan:** Implement `ElevenLabsVoiceAdapter` mapping ElevenLabs Conversational AI webhook events and server-tool calls (`check_availability`, `book_appointment`, `reschedule_appointment`, `cancel_appointment`) onto `VoiceProviderAdapter` and register it in `ChannelAdapterRegistry`.

### 4. Scheduled Follow-Ups Are Stored in SQLite with No Background Dispatcher Yet
- **Where:** `src/db/store.ts` (`scheduled_followups`, `estimates`, `reviews`), `src/channels/coordinator.ts`, `src/workflows/`
- **Current behavior:** Booking reminders (24h and 2h), estimate follow-up state (day 2, day 5, day 10), and post-job review requests are persisted in SQLite—and pending follow-ups are automatically cancelled when a booking is rescheduled/cancelled or when an open-estimate customer replies on voice or SMS. However, `aabook serve` does not yet run a background polling loop to dispatch due rows when `scheduledFor` arrives.
- **v2 plan:** Add an idempotent background scheduler inside `aabook serve` (with SQLite row claiming so restarts never double-send) that dispatches due `scheduled_followups`, estimate touches, and review requests through `SmsProvider` while respecting client quiet hours.

---

## Additional v1 Seams & v2 Enhancements

### 5. Live HTTP Model Providers in `aabook serve`
- **Where:** `src/cli/serve.ts`, `src/router/router.ts`, `src/router/stub.ts`
- **Current behavior:** `ProviderRouter` implements ordered fallback chains, per-call `model_usage` token/cost logging, and daily spend cap degradation (`aux` degrades first, preserving `conversation`). `aabook serve` currently wires `StubModelProvider` by default.
- **v2 plan:** Implement live HTTP `ModelProvider` adapters for OpenRouter, NVIDIA NIM, and Gemini Flash reading `OPENROUTER_API_KEY`, `NVIDIA_NIM_API_KEY`, and `GEMINI_API_KEY` from `.env`, plus per-client route chain configuration in `client/models.json`.

### 6. Live Google Calendar Free/Busy Sync & Event Updates
- **Where:** `src/calendar/calendar.ts`
- **Current behavior:** `GoogleCalendarAdapter` performs service-account JWT exchange and `POST` event creation against the Google Calendar v3 API, while `listBusySlots` currently reads in-process state and reschedules/cancellations do not yet issue remote Google Calendar `PATCH`/`DELETE` calls.
- **v2 plan:** Query Google Calendar `freeBusy` / `events.list` in `listBusySlots` and store remote Google Calendar event IDs on `bookings` so reschedules and cancellations sync bidirectionally.

### 7. Provider-Native Webhook HMAC Signatures & Tunnel Guidance
- **Where:** `src/server/server.ts`, `src/channels/voice/retell.ts`
- **Current behavior:** Every inbound request to `aabook serve` requires constant-time `WEBHOOK_SECRET` authentication and writes secret-redacted entries to `audit_logs`. Retell's optional `X-Retell-Signature` HMAC header and public HTTPS ingress (Tailscale Funnel / Cloudflare Tunnel) are not yet automated.
- **v2 plan:** Support optional provider HMAC verification alongside `WEBHOOK_SECRET` and document/script a single Tailscale Funnel or Cloudflare Tunnel setup step in `CLIENT-SETUP.md`.

### 8. Human-Gated CLI Approval for Bulk Outbound Campaigns
- **Where:** `SPEC.md` (Guardrails)
- **Current behavior:** Per `SPEC.md`, 1-to-1 operational messages run automatically while bulk outbound campaigns (review blasts, seasonal tune-up outreach) must require explicit human approval in the CLI. v1 ships only 1-to-1 operational flows and omits bulk blast commands entirely.
- **v2 plan:** Add `aabook campaign preview` and `aabook campaign approve <id>` with recipient preview, spend estimate, opt-out filtering, and an audited human confirmation prompt before any bulk messages can be queued.

### 9. `PiEngine` Live Runtime Invocation Polish
- **Where:** `src/engine/pi.ts`
- **Current behavior:** `PiEngine` spawns `pi` with `--mcp "node <path>/booking-server.ts"`, which works in test harnesses and Node 22.6+ environments with native TypeScript stripping, whereas client machines may only have `bun` installed.
- **v2 plan:** Launch the MCP booking server via `process.execPath` (`bun`) instead of `node` so `PiEngine` has zero dependency on a separate Node installation.
