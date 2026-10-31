# AA Book CLI (`aabook`)

The installable front desk booking agent for home services and appointment businesses.

## Overview
Built with TypeScript on Bun. AA Book answers calls and texts, books jobs onto the calendar, chases open estimates, and asks for reviews. It runs locally per client machine, configured from files, powered by a swappable agent engine (`core` or `omp`), and routed across model providers by task class.

## Architecture
- **EngineAdapter**: Standalone reasoning interface (`core` agent loop or `omp` external harness).
- **ProviderRouter**: Cost-routed across task classes (`conversation`, `reasoning`, `aux`). Tracks token usage and enforces daily spend caps, degrading `aux` first while preserving conversation quality.
- **Client Configuration**: Folder of 5 validated schema files:
  - `business.json`: Company name, trade, timezone, hours, phones, address.
  - `services.json`: Service catalog, duration, pricing, booking rules.
  - `staff.json`: Team roster and roles.
  - `persona.json`: Greeting, voice choice, tone, and mandatory AI disclosure wording.
  - `policies.json`: Cancellation, deposits, and service area zip codes.
- **Local Data Store (SQLite)**: Built-in `bun:sqlite` engine storing bookings, call logs, audit logs, and token spend locally with zero remote database dependencies.
- **Guardrails**: Bulk campaigns are gated; 1-to-1 operational flows are unblocked. AI never denies being an AI when asked.

## Commands
```bash
# Check prerequisites and scaffold client/ & data/
bun run aabook install

# Interactive wizard to generate client config
bun run aabook setup

# Inspect current configuration and local database status
bun run aabook status

# Run full demo mode (Fort Smith Heating & Air, 4 workflows, fake calendar)
bun run aabook demo
```

## Running Tests
```bash
bun test
```
