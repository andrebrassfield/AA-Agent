# AA Book Roadmap & Known Limits (`ROADMAP.md`)

This file tracks what is implemented in AA Book today and what remains open for live carrier, voice, and calendar integrations. Nothing stubbed is presented as live.

---

## Closed in Current Build

- **`OmpEngine` Subprocess Turn Timeout (`src/engine/omp.ts`):** Enforces a configurable per-turn deadline (`timeoutMs` / `AABOOK_OMP_TIMEOUT_MS`, default 30s matching `PiEngine`), kills hung child processes with `SIGKILL`, and rejects with an explicit timeout error.
- **Live HTTP Model Providers (`src/router/providers.ts`, `src/cli/serve.ts`):** `OpenAiCompatibleProvider` (configurable `baseUrl` covering OpenAI, OpenRouter, NVIDIA NIM, and compatible gateways), `AnthropicProvider` (`/v1/messages`), and `GeminiProvider` (`/v1beta/models/...:generateContent`) run over Bun's built-in `fetch` with zero extra runtime dependencies, reading API keys strictly from `.env`, redacting secrets in errors/logs, enforcing daily spend caps, and writing real API token counts to `model_usage`. `StubModelProvider` is used only in `aabook demo` and tests.
- **Background Follow-Up Dispatcher (`src/workflows/dispatcher.ts`, `src/db/store.ts`, `src/cli/serve.ts`):** `aabook serve` runs a configurable tick loop (`--tick-ms` / `FOLLOWUP_TICK_INTERVAL_MS` / `policies.json`, disabled in demo mode) with atomic SQLite `pending -> claimed -> sent` transitions so mid-tick restarts never double-send, skipping replied/stopped estimates and cancelled bookings, and deferring (never dropping) follow-ups during `policies.quietHours` in the client's timezone.

---

## Still Open (Remaining Gaps for Live Carrier & Calendar Operations)

### 1. Outbound SMS Uses `StubSmsProvider` (No Live Carrier Transport Yet)
- **Where:** `src/channels/sms/stub.ts`, `src/channels/registry.ts`, `src/config/validator.ts`
- **Current behavior:** All outbound operational texts (missed-call text-back greetings, booking confirmations, conversational replies, and dispatched follow-ups) route through `SmsProvider`, and `channels.json` validates `"stub"` and `"twilio"`. Only `StubSmsProvider` is registered today, so `aabook serve` captures outbound SMS in memory rather than delivering carrier SMS.
- **Next step:** Implement `TwilioSmsProvider` behind `SmsProvider` reading `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, and `TWILIO_FROM_NUMBER` from `.env`, plus webhook signature verification on `/webhooks/sms` and 10DLC `STOP`/`UNSTOP` opt-out handling.

### 2. ElevenLabs Voice Is a Validated Seam with No Adapter Yet
- **Where:** `src/config/validator.ts`, `src/channels/registry.ts`, `src/channels/voice/retell.ts`
- **Current behavior:** `channels.json` accepts `"voice": { "provider": "retell" | "elevenlabs" }`. `RetellVoiceAdapter` is implemented and tested; selecting `"elevenlabs"` fails fast at startup with a clear unregistered-provider error until `ElevenLabsVoiceAdapter` is implemented.
- **Next step:** Implement `ElevenLabsVoiceAdapter` mapping ElevenLabs Conversational AI webhook events and server-tool calls onto `VoiceProviderAdapter`.

### 3. Live Google Calendar Free/Busy Sync & Remote Updates
- **Where:** `src/calendar/calendar.ts`
- **Current behavior:** `GoogleCalendarAdapter` performs service-account JWT exchange and `POST` event creation against Google Calendar v3, while `listBusySlots` reads in-process state and reschedules/cancellations do not yet issue remote Google Calendar `PATCH`/`DELETE` requests.
- **Next step:** Query Google Calendar `freeBusy` / `events.list` in `listBusySlots` and persist remote Google Calendar event IDs on `bookings` for bidirectional reschedule/cancel sync.

### 4. Provider-Native Webhook HMAC Signatures & Public Ingress Helper
- **Where:** `src/server/server.ts`, `src/channels/voice/retell.ts`
- **Current behavior:** Inbound requests require constant-time `WEBHOOK_SECRET` authentication and write secret-redacted entries to `audit_logs`. Provider-specific HMAC headers (`X-Retell-Signature`) and public HTTPS tunnel setup (Tailscale Funnel / Cloudflare Tunnel) are not yet automated.

### 5. Human-Gated CLI Approval for Bulk Outbound Campaigns
- **Where:** `SPEC.md` (Guardrails)
- **Current behavior:** AA Book ships 1-to-1 operational messages only and omits bulk campaign commands. Any future bulk review or seasonal blast command must require explicit human CLI preview and approval before queueing.

### 6. `PiEngine` MCP Server Runtime Command
- **Where:** `src/engine/pi.ts`
- **Current behavior:** `PiEngine` launches `src/mcp/booking-server.ts` with `node`; switching that spawn command to `process.execPath` (`bun`) will remove the need for Node on Bun-only shop machines.
