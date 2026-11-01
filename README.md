# AA Book CLI (`aabook`)

The installable front desk booking agent for home services and appointment businesses.

## Overview
Built with TypeScript on Bun. AA Book answers calls and texts, books jobs onto the calendar, chases open estimates, and asks for reviews. It runs locally per client machine, configured from files, powered by a swappable agent engine (`core`, `pi`, or `omp`), and routed across model providers by task class.

## Architecture
- **EngineAdapter**: Standalone reasoning interface (`core` in-repo agent loop, `pi`, or `omp` external harness).
- **ProviderRouter**: Cost-routed across task classes (`conversation`, `reasoning`, `aux`). Tracks token usage and enforces daily spend caps, degrading `aux` first while preserving conversation quality.
- **Channels & Local Webhook Server**:
  - Built-in `Bun.serve` HTTP server (`aabook serve`) authenticating every inbound request with `WEBHOOK_SECRET` from `.env`, redacting secrets, and logging every inbound event to the SQLite audit log.
  - **VoiceProviderAdapter**: Provider seam implemented for Retell AI (`call_started`, `call_ended`, unanswered/missed calls, and custom function tools for availability, booking, rescheduling, and cancellation), selected via client `channels.json` so additional providers (e.g. ElevenLabs) can be registered without modifying product code.
  - **SmsProvider**: Outbound/inbound SMS interface with `StubSmsProvider` default so tests and demo mode never send real messages. Inbound texts share conversation history with voice and automatically stop pending open-estimate touches on reply across either channel.
- **Client Configuration**: Validated JSON files in `client/`:
  - `business.json`: Company name, trade, timezone, hours, phones, address.
  - `services.json`: Service catalog, duration, pricing, booking rules.
  - `staff.json`: Team roster and roles.
  - `persona.json`: Greeting, voice choice, tone, and mandatory AI disclosure wording.
  - `policies.json`: Cancellation, deposits, and service area zip codes.
  - `channels.json`: Per-client voice and SMS provider selection (secrets remain strictly in `.env`).
- **Local Data Store (SQLite)**: Built-in `bun:sqlite` engine storing bookings, call logs, missed-call dedupe records, shared conversation history, scheduled follow-ups, audit logs, and token spend locally with collision-free prefixed IDs.
- **Guardrails**: Bulk campaigns are gated; 1-to-1 operational flows are unblocked. AI never denies being an AI when asked.

## Commands
```bash
# Check prerequisites and scaffold client/ & data/
bun run src/index.ts install

# Interactive wizard to generate client config
bun run src/index.ts setup

# Inspect current configuration and local database status
bun run src/index.ts status

# Start local webhook server (requires WEBHOOK_SECRET in .env)
WEBHOOK_SECRET=your-secret bun run src/index.ts serve --port 3000

# Run full demo mode (Fort Smith Heating & Air, 4 workflows + channels pass on stubs)
bun run src/index.ts demo
```

## Running Tests & Typecheck
```bash
bun test
bun run check
```
