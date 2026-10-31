# SPEC: AA Book, the installable front desk booking agent
This file is the seed spec for the repo ArkansasAutomated/aa-book-cli. Every build session starts by reading it. If a session's instructions conflict with this file, this file wins unless the session prompt says otherwise explicitly.

## What this is
AA Book is Arkansas Automated's front desk product, sold to home services shops and appointment businesses: it answers calls and texts, books jobs onto the calendar, chases open estimates, and asks for reviews. Until now it lived as a hosted web project. This repo rebuilds it as a command line install: one package Dre installs per client on a small always-on machine, configured per client from files, powered by a swappable agent engine, and routed across swappable model providers.

TypeScript on Bun. CLI command: `aabook`.

## Architecture rules (the protections)
- **Standalone engine, swappable runtimes.** This harness is its own agent, separate from any other agent product. All agent reasoning goes through an `EngineAdapter` interface. v1 ships two adapters: `core` (the in-repo agent loop; the primary engine, and what demo mode runs) and `omp` (drives an external oh-my-pi style minimal harness over stdio, for shops that already run one). Product logic imports the interface only, so a future runtime can be added without touching product code.
- **Model agnostic, cost routed.** A `ProviderRouter` maps task classes to providers: `conversation` (the live caller or texter; quality model), `reasoning` (booking decisions, rescheduling judgment), and `aux` (call summaries, classification, reminder and review copy; cheapest adequate API wins: NVIDIA NIM free models, Gemini Flash, OpenRouter free tier). Chains and pins are config. Every model call logs provider, model, task class, and token counts. Per-client daily spend caps are enforced by the router; hitting the cap degrades aux first, never the conversation.
- **Client config, not client code.** A client is a folder: `business.json` (name, trade, timezone, hours, phone numbers, address), `services.json` (services with duration, price, buffer, booking rules), `staff.json`, `persona.json` (greeting, voice choice, AI disclosure wording, tone), `policies.json` (cancellation, deposit, service area), and secrets in `.env` only. A setup wizard generates the folder. Swapping clients is swapping folders.
- **Data stays local.** Bookings, call logs, and the audit log live in the client's data dir (SQLite or JSONL; pick one in session 1 and stay with it). Nothing leaves the machine except the provider API calls the work needs.
- **Guardrails.** Outbound campaigns (bulk texts, review blasts) are gated behind an explicit human approval in the CLI. One-to-one operational messages the agent sends as part of a live booking flow (confirmations, reminders, the missed-call text-back) are the product working, not campaigns, and are not gated. The AI never denies being an AI if a caller asks directly; the disclosure wording is a persona config field with a default. Secrets: env only, gitignored, redacted in logs.

## The workflows (the product)
- **Missed-call text-back:** a missed call triggers an SMS within a minute: greeting from persona config, an offer to book by text, and the booking flow by conversation.
- **Booking:** check services and rules, read calendar availability (Google Calendar first via its API), create the booking, send confirmation, schedule reminders.
- **Estimate follow-up:** open estimates get touches on day 2, day 5, and day 10 in the business's voice, stopping on any reply.
- **Review requests:** after a completed job, one polite ask with the business's review link, configurable delay.
- **Voice:** inbound calls route through a voice provider (Retell or ElevenLabs) configured per client; the harness exposes the webhook and tool endpoints the provider calls for availability and booking, so the voice layer is a config choice, not code.

## Demo mode
`aabook demo` boots a fake shop (a Fort Smith HVAC company, invented data) with the core engine and stub providers, runs the four workflows end to end against a fake calendar, and prints the transcript and the audit log. Demo mode is how every PR proves itself without a client, a phone number, or a paid API call.

## Repo conventions
- Bun + TypeScript, minimal dependencies (each new dep justified in its PR).
- `bun test` green before a PR is marked ready; demo mode passing is part of done.
- Every PR description: what changed, how it was verified (naming the test, command, or demo output), what remains open.
- The existing hosted AA Book is a different codebase and is not edited, imported, or referenced by this repo.
