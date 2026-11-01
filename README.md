# AA Book (`aabook`)

## What AA Book Is

AA Book is Arkansas Automated's installable front desk booking agent for home services shops and appointment businesses (HVAC, plumbing, electrical, garage doors, exterior cleaning).

Instead of running on a shared multi-tenant web server, AA Book installs onto a small always-on computer at the client's shop (a Mac Mini or Linux mini-PC). It:

1. **Texts back missed calls** with the shop's greeting and offers to book by text.
2. **Books, reschedules, and cancels jobs** against the shop's hours, service catalog, zip codes, and calendar.
3. **Follows up on open estimates** on day 2, day 5, and day 10—and stops immediately if the customer calls or texts back.
4. **Requests Google reviews** after a completed job.
5. **Keeps client data on the machine** inside a local SQLite database (`data/aabook.sqlite`) with a full audit log. Secrets stay strictly in `.env` and never enter client JSON files, templates, or backups.

If a caller or texter ever asks whether they are speaking to an AI, AA Book always answers honestly using the disclosure line in `client/persona.json`.

---

## Quickstart: One-Command Install

AA Book runs on [Bun](https://bun.sh) (`v1.1.0` or newer). If Bun is not installed yet on a fresh machine:

```bash
curl -fsSL https://bun.sh/install | bash
```

Clone the repo and run the one install command:

```bash
git clone git@github.com:andrebrassfield/AA-Agent.git
cd AA-Agent
./bin/aabook.js install
```

What `./bin/aabook.js install` does in one step:
- Checks that Bun is installed and new enough (or prints plain-English fix instructions).
- Installs project dependencies (`bun install --frozen-lockfile`).
- Scaffolds `data/`, starter client config files in `client/`, `.env.example`, and `.env` (with empty secret placeholders).
- Links the `aabook` command onto your `PATH` (for example `~/.bun/bin/aabook`) so you can run `aabook` directly.
- Safe to run twice: if everything is already in place, it changes nothing, preserves your edits, and prints `Already installed — nothing changed.`

---

## Run the Offline Demo

You can verify the whole product right away without API keys, phone numbers, or paid calls:

```bash
aabook demo
```

`aabook demo` boots a fictional shop (**Fort Smith Heating & Air**) on the in-repo `core` engine and local stub providers, walks through all four workflows (missed-call text-back, calendar booking + AI disclosure check, estimate follow-ups with reply stop, and post-job review request), runs a live local webhook pass (`Bun.serve` -> missed Retell call -> SMS text-back -> booked job), and prints the audit log and token spend summary.

---

## Build a Client Config with the Setup Wizard

Every shop is just a `client/` folder of six plain JSON files—no code changes per client. To configure a shop interactively:

```bash
aabook setup
```

Press **Enter** to accept any default in brackets `[...]`, or type the client's details:
1. **Business profile** (`client/business.json`): shop name, trade, timezone, weekday hours, main phone, street address.
2. **Primary service** (`client/services.json`): service name, price, duration, and buffer minutes (you can add more services directly in `client/services.json` afterward).
3. **Staff** (`client/staff.json`): lead technician name and role.
4. **Persona & tone** (`client/persona.json`): phone/SMS greeting, tone (`friendly`, `professional`, `casual`, `urgent`), voice choice, and mandatory AI disclosure wording.
5. **Policies** (`client/policies.json`): cancellation notice hours, fee, deposit rule, and covered zip codes.
6. **Channels** (`client/channels.json`): voice provider (`retell` or `elevenlabs`) and SMS provider (`stub` or `twilio`).

Check your config and local database anytime with:

```bash
aabook status
```

> **Important:** API keys and `WEBHOOK_SECRET` never go inside `client/*.json`. Put secrets in `.env` only (`validator.ts` rejects secret keys across client JSON files). Swapping clients is as simple as swapping the `client/` folder.

### Starting from a Pilot Template Pack (`templates/`)
Instead of typing through the wizard, you can also copy one of the starter folders in [`templates/`](./templates/README.md) into `client/`:
- `templates/blank/` — Complete blank pack with `TODO:` placeholders on every field that needs an answer from the shop owner.
- `templates/fort-smith-hvac/` — Worked fictional example matching the Fort Smith Heating & Air demo shop.
- `templates/home-inspection/` — Fictional pilot-trade pack for a home inspection company with `TODO:` placeholders on `services.json` (inspection tiers and fees must come directly from the owner, never from a website scrape).

---

## How Engines and Providers Swap

### Swapping the Agent Engine (`AABOOK_ENGINE` in `.env`)
Product workflows talk only to the `EngineAdapter` interface, so you can change the reasoning runtime in `.env` without editing shop configs or workflow code:

- `AABOOK_ENGINE=core` *(default)* — Uses AA Book's built-in TypeScript agent loop (`CoreEngine`). Recommended for client installs and used by `aabook demo`.
- `AABOOK_ENGINE=pi` — Runs turns through `@earendil-works/pi-coding-agent` (`PiEngine`) connected to AA Book's local MCP booking tool server (`src/mcp/booking-server.ts`) with a 30-second turn timeout.
- `AABOOK_ENGINE=omp` — Drives an external `omp-agent` binary over JSON-lines stdio (`OmpEngine`) for shops that already run an oh-my-pi compatible harness.

### How Model Cost Routing & Spend Caps Work (`ProviderRouter`)
`ProviderRouter` separates model work into three task classes so live callers get quality responses while background tasks stay cheap:
- `conversation` — Live caller or texter turns.
- `reasoning` — Booking, availability, and rescheduling decisions.
- `aux` — Call summaries, reminders, estimate follow-up copy, and review requests.

Every model completion logs provider, model, task class, token counts, and USD cost to SQLite (`model_usage`). If a shop hits `DAILY_SPEND_CAP_USD` (default `5.00` in `.env`), `ProviderRouter` degrades `aux` tasks to an internal zero-cost fallback first and never cuts off live `conversation` turns. *(See [ROADMAP.md](./ROADMAP.md) for current v1 provider adapter status.)*

### Swapping Voice, SMS, and Calendar Providers
- **Voice & SMS (`client/channels.json`):** Set `"voice": { "provider": "retell" }` (active in v1) or `"elevenlabs"` (validated seam; adapter tracked for v2), and `"sms": { "provider": "stub" }` (v1 in-memory stub; live carrier adapter tracked for v2).
- **Calendar (`.env`):** Leave Google variables blank to use the built-in local calendar, or set `GOOGLE_CALENDAR_ID`, `GOOGLE_CLIENT_EMAIL`, and `GOOGLE_PRIVATE_KEY` in `.env` to create confirmed bookings on Google Calendar.

---

## Everyday Commands

| Command | What it does |
| :--- | :--- |
| `./bin/aabook.js install` | First-time machine check, dependency install, config/data scaffold, and CLI link |
| `aabook setup` | Interactive wizard to create `client/*.json` for a shop |
| `aabook status` | Validate `client/*.json` and print SQLite booking, call, audit, and spend counts |
| `aabook usage [--days N] [--client <folder>]` | Read-only model spend & token report by day, task class, provider, and model against the daily cap |
| `aabook demo` | Run the offline Fort Smith HVAC end-to-end verification pass |
| `aabook serve` | Start the local webhook server (`WEBHOOK_SECRET` required in `.env`) |
| `aabook install --service` | Write a macOS `launchd` plist or Linux `systemd` user unit named for this client |
| `aabook backup` | Save a timestamped `.tar.gz` backup of `client/`, SQLite `data/`, and `audit/` (never `.env`) |
| `aabook restore <file>` | Restore a `.tar.gz` backup (requires `--force` if `data/` is not empty) |
| `bun test && bun run check` | Run the automated test suite and TypeScript typecheck |

---

## More Guides
- **[CLIENT-SETUP.md](./CLIENT-SETUP.md)** — Step-by-step on-site installation checklist with verification steps.
- **[ROADMAP.md](./ROADMAP.md)** — Honest v1 limits and v2 roadmap items.
- **[SPEC.md](./SPEC.md)** — Product architecture rules and guardrails.
