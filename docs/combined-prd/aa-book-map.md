# Appendix: Hosted `aa-book` Inventory (Phase 1 Map)

**Subject:** `andrebrassfield/aa-book` — the hosted codebase behind `book.arkansasautomated.com`.  
**Snapshot mapped:** `main` @ `5da6ef5` (2026-10-02, `"fix(e2e): bound every page read so a stalled worker fails instead of vanishing (#66)"`). `252` commits on `main`, `36` remote branches on `origin`, `0` open pull requests, `1` git tag (`live-cutover-2026-08-30`).  
**How it was mapped:** Fresh read-only clone (`git remote set-url --push origin DISABLED-read-only-session`), `git ls-files`, `git grep`, direct source reads of schemas/routes/services/configs, and an isolated local unit-test + typecheck run against a throwaway SQLite file with a stripped environment (`env -i`). Nothing in `andrebrassfield/aa-book` was modified, branched, pushed, or deployed, and no live service, Railway project, Stripe account, Google project, Retell account, or DNS record was touched or queried.  
**Explicitly out of scope (never opened, cloned, or reasoned from):** `ArkansasAutomated/nsi-book`, `ArkansasAutomated/riverlocal-book`.

---

## How to Read the Evidence Labels

Every claim below carries an explicit verification tag. Confirmed facts and inferences never blend.

| Label | Meaning |
| :--- | :--- |
| **[C]** | **Confirmed in code.** Directly verified in source files, Prisma schemas, SQL migrations, build scripts, or CI workflows at `5da6ef5`, or executed locally against throwaway SQLite. File paths are cited. |
| **[I]** | **Inferred.** Derived from repository Markdown docs (`AA.md`, `README.md`, `BRANCH-LOCK.md`, `CONTEXT.md`, `RECEIPT.md`), code comments, env variable naming, or commit/branch names. Code presence does not prove live production state. |
| **[U]** | **Unknown from repo.** Cannot be settled from git history or source code alone; requires owner confirmation or a live-system inspection. |

> **Production caveat:** Presence on `main` does **not** prove what commit or configuration is running on `book.arkansasautomated.com` right now. The repo contains no deployment lockfile pinning a live SHA. All production runtime state is tracked in §10 (`[U-1]` through `[U-12]`).

---

## Summary Counts (At a Glance)

| Metric | Count | Verification |
| :--- | ---: | :--- |
| Tracked files (`git ls-files`) | **486** | [C] `312` `apps/`, `58` `prisma/`, `50` `scripts/`, `25` `docs/`, `5` `tests/`, `5` `infrastructure/`, `3` `packages/`, `2` `.github/`, `26` root |
| Application TypeScript/TSX lines (`apps/web/src/**/*.{ts,tsx}`) | **22,572** | [C] `wc -l` across `301` TS/TSX files in `apps/web/src` |
| UI / page routes (`page.tsx`) | **35** | [C] `18` public/auth pages + `17` authenticated `(dashboard)` pages |
| HTTP API route files (`apps/web/src/app/api/**/route.ts`) | **78** | [C] Exporting **108** HTTP method handlers (`46` `GET`, `42` `POST`, `10` `PATCH`, `7` `DELETE`, `3` `PUT`) |
| Database tables (Prisma `model` blocks) | **42** | [C] `0` Prisma enums; identical 42 models in SQLite and generated PostgreSQL schemas (`35` workspace-scoped) |
| SQL migrations | **53** | [C] `32` SQLite migrations + `21` PostgreSQL migrations (+ `postgres-guards.sql`) |
| External runtime integrations in app code | **9** | [C] Google Calendar/Meet, Stripe Checkout, SMTP, Resend, Mapbox, Retell inbound lookup, LinkedIn, X, Telegram (+ `1` disabled Facebook stub, + `1` offline Anthropic CLI script) |
| Background worker loops | **1 process / 4 loops** | [C] `dist/worker.mjs` draining `IntegrationOutbox` (`5` kinds), `EmailOutbox` (`11` kinds), `SocialPost` queue, and optional `desk-nightshift` (`CHECKOUT_CHASE`) |
| Automated test files | **67** | [C] `62` Vitest files (`374` passing tests) + `1` Node test (`scripts/source-inventory.test.mjs`) + `4` Playwright specs (`11` e2e tests) |

---

## 1. Stack and Runtime

| Layer | Finding | Label & Evidence |
| :--- | :--- | :--- |
| Upstream lineage | Fork of MIT-licensed SnagTime (`nateherkai/snagtime`). Root `package.json` is still `"name": "snagtime"`, workspace package is `@snagtime/web`, and internal Postgres client/role identifiers use `tempocove_*` / `@tempocove/postgresql-client`. | [C] `package.json`, `apps/web/package.json`, `LICENSE`, `packages/tempocove-postgresql-client/`, `prisma/postgresql/postgres-guards.sql` |
| Product positioning | Rebranded as proprietary **AA Book** for Arkansas Automated while retaining upstream MIT copyright in `LICENSE` / `NOTICE`. | [I] `AA.md`, `NOTICE`, `AGENTS.md` |
| Language | TypeScript (`^5.9.3`, strict `tsconfig.base.json`), React `19.2.8` | [C] `package.json`, `apps/web/package.json`, `tsconfig.base.json` |
| Web framework | Next.js `16.3.8` (App Router) serving both React UI and JSON route handlers | [C] `apps/web/package.json`, `apps/web/src/app/` |
| Runtime | Node.js — `>=20.9` enforced locally; `24.15.0` pinned in `Dockerfile` (`node:24.15.0-bookworm-slim`) and GitHub Actions | [C] `Dockerfile` L7/L35, `.github/workflows/ci.yml`, `scripts/demo-check.mjs` |
| Package manager | npm workspaces (`"workspaces": ["apps/*"]`), `package-lock.json`, `.npmrc` sets `ignore-scripts=true` | [C] `package.json`, `.npmrc` |
| ORM & dual-DB setup | Prisma `6.19.3` with **two schemas**: `prisma/schema.prisma` (`provider = "sqlite"`) for local dev/Vitest, and `prisma/postgresql/schema.prisma` (`provider = "postgresql"`, generated via `scripts/generate-postgres-schema.mjs` into `@tempocove/postgresql-client`) for production | [C] `prisma/schema.prisma`, `prisma/postgresql/schema.prisma`, `apps/web/src/server/db.ts` |
| Production DB target | PostgreSQL `18.6` with enforced Row-Level Security (`49` `ENABLE`/`FORCE ROW LEVEL SECURITY` statements) and `5` NOLOGIN group roles (`tempocove_app`, `tempocove_worker`, `tempocove_monitor`, `tempocove_rls_verifier`, `tempocove_migration`) | [C] `Dockerfile` L27, `prisma/postgresql/postgres-guards.sql` L12–16, `prisma/postgresql/migrations/` |
| Web runtime dependencies (12) | `@dnd-kit/core`, `@dnd-kit/utilities`, `@prisma/client`, `google-auth-library`, `googleapis`, `luxon`, `next`, `react`, `react-dom`, `sharp`, `stripe`, `zod` | [C] `apps/web/package.json` |
| Root runtime dependencies (3) | `nodemailer`, `pg`, `qrcode` | [C] `package.json` |
| Worker bundling | `esbuild` bundles `apps/web/src/server/worker.ts` to standalone `dist/worker.mjs` | [C] `package.json` (`worker:build`), `scripts/build-worker.mjs` |

---

## 2. Repo Structure (Counts)

**486 tracked files** across the repository [C]:

| Top-level path | Tracked files | Contents |
| :--- | ---: | :--- |
| `apps/web/` | **312** | Next.js web application (`apps/web/src/app/`: `124` files; `components/`: `52` files; `server/services/`: `72` files; `server/` core/auth/crypto: `40` files; `lib/`: `13` files; `styles/`: `3` files; `public/`, `scripts/`, configs: `8` files) [C] |
| `prisma/` | **58** | `schema.prisma` (SQLite), `seed.ts`, `migration_lock.toml` (×2), `32` SQLite `migration.sql` files, `postgresql/schema.prisma`, `postgresql/postgres-guards.sql`, `21` PostgreSQL `migration.sql` files [C] |
| `scripts/` | **50** | Local setup (`setup-local.mjs`, `demo-check.mjs`), Docker/Railway entrypoints (`container-entrypoint.mjs`, `railway-migrate.sh`, `railway-seed.mjs`, `start-web.mjs`, `build-worker.mjs`), Postgres schema/RLS/authority/backup proof scripts (~22 scripts), `sqlite-to-postgres.mjs`, PowerShell backup/restore (`backup-postgres.ps1`, `restore-postgres.ps1`), secret scan (`ci-secret-scan.mjs`), and `enrich-email.mjs` [C] |
| `docs/` | **25** | `DEPLOYMENT.md`, `INTEGRATION-SETUP.md`, `AI-SETUP.md`, `SNAGTIME-BRAND.md`, `aa-book-contact-360-v1.md`, `route-aware-booking-handoff.md`, `voice-inbound-caller-lookup.md`, `sku-route-pg-tables.DRAFT.sql`, `adr/0001-machine-intake-fail-closed-price-book.md`, `8` dated implementation plans in `docs/plans/`, and `8` architecture diagram files in `docs/arch/` [C] |
| `tests/` | **5** | Playwright browser/axe suites in `tests/e2e/` (`accessibility.spec.ts`, `journey.spec.ts`, `one-use-links.spec.ts`, `public-booking-steps.spec.ts`, `helpers.ts`) [C] |
| `infrastructure/` | **5** | Hardened PostgreSQL container (`Dockerfile`, `pg_hba.conf`, `secure-entrypoint.sh`), `pgloader.load.template`, `dependency-audit-allowlist.json` [C] |
| `packages/` | **3** | `packages/tempocove-postgresql-client` workspace shim [C] |
| `.github/` | **2** | `workflows/ci.yml` (`SnagTime CI`) and `workflows/browser-axe.yml` [C] |
| Root files | **26** | `package.json`, `package-lock.json`, `.npmrc`, `Dockerfile`, `compose.production.yml`, `railway.toml`, `Procfile`, `vitest.config.ts`, `vitest.sqlite-setup.ts`, `playwright.config.ts`, `tsconfig.base.json`, `eslint.config.mjs`, `.env.example`, `.gitignore`, `.dockerignore`, `README.md`, `AA.md`, `AGENTS.md`, `CLAUDE.md`, `CONTEXT.md`, `BRANCH-LOCK.md`, `CONTRIBUTING.md`, `SECURITY.md`, `RECEIPT.md`, `NOTICE`, `LICENSE` [C] |

---

## 3. User-Facing Surfaces and Flows

### 3.1 Public / Unauthenticated Pages (`18` `page.tsx` files + metadata routes) [C]

| Route | Purpose & Behavior | Source Evidence |
| :--- | :--- | :--- |
| `/` | Immediate server redirect to `/dashboard` | [C] `apps/web/src/app/page.tsx` |
| `/book/[slug]` | **Primary public booking flow.** Loads event type + durations + custom questions (`TEXT`, `TEXTAREA`, `SELECT`, `CHECKBOX`), optional guest address for drive-time/service-area filtering (`route-aware-slots`), newsletter opt-in checkbox, creates free or paid booking; redirects browser to Stripe Hosted Checkout (`location.assign`) when paid | [C] `app/book/[slug]/page.tsx`, `components/public-booking-flow.tsx` |
| `/book/[slug]/confirmation` | Booking confirmation / status screen and Stripe Checkout return/cancel target | [C] `app/book/[slug]/confirmation/page.tsx`, `server/services/payments.ts` L114 |
| `/f/[slug]` | **Funnel landing page** rendered from `EventType.landingJson` linking into `/book/[slug]` | [C] `app/f/[slug]/page.tsx`, `components/funnel-landing.tsx` |
| `/uppity-ai/[slug]` | Legacy public URL alias — 307 redirects to `/book/[slug]` | [C] `app/uppity-ai/[slug]/page.tsx` |
| `/uppity-ai/[slug]/confirmation` | Legacy confirmation alias — redirects to `/book/[slug]/confirmation` | [C] `app/uppity-ai/[slug]/confirmation/page.tsx` |
| `/manage/[bookingId]/cancel` | Invitee self-service cancellation page (one-use capability token → `BookingManageSession` cookie) | [C] `app/manage/[bookingId]/cancel/page.tsx`, `server/auth/capabilities.ts` |
| `/manage/[bookingId]/reschedule` | Invitee self-service reschedule slot picker (capability token → `BookingManageSession` cookie) | [C] `app/manage/[bookingId]/reschedule/page.tsx` |
| `/ticket/[bookingId]` | Public event/workshop seat ticket with QR code (`/api/public/ticket/[bookingId]/qr.png`) | [C] `app/ticket/[bookingId]/page.tsx`, `ticket-view.tsx` |
| `/subscribe` | Public AA Letter newsletter subscription form | [C] `app/subscribe/page.tsx`, `components/subscribe-form.tsx` |
| `/unsubscribe` | Public one-click newsletter unsubscribe page | [C] `app/unsubscribe/page.tsx`, `components/unsubscribe-page.tsx` |
| `/signup` | **Open multi-tenant self-registration** creating a new `User`, `Workspace`, `OWNER` `Membership`, `WorkspaceBranding`, and `AvailabilitySchedule`, plus queueing `EMAIL_VERIFY` | [C] `app/signup/page.tsx`, `server/services/accounts.ts` L52–74 |
| `/login` | Organizer email + password sign-in | [C] `app/login/page.tsx`, `components/account-access.tsx` |
| `/verify-email` | Consumes `EMAIL_VERIFY` token from email link | [C] `app/verify-email/page.tsx` |
| `/forgot-password` | Requests `PASSWORD_RESET` email | [C] `app/forgot-password/page.tsx` |
| `/reset-password` | Consumes `PASSWORD_RESET` token and sets new scrypt password | [C] `app/reset-password/page.tsx` |
| `/invite/accept` | Accepts `WorkspaceInvitation` token to join an existing workspace as `ADMIN` or `MEMBER` | [C] `app/invite/accept/page.tsx` |
| `/onboarding` | **Single-card workspace confirmation** ("Everything looks ready"): displays workspace name, timezone, role, and organizer email; clicking "Open dashboard" sets `Workspace.onboardingCompletedAt` and redirects to `/dashboard`. Does *not* collect services, hours, or phone numbers inline. | [C] `app/onboarding/page.tsx`, `components/workspace-onboarding.tsx` |
| `/robots.txt`, `/sitemap.xml`, `/manifest.webmanifest` | Dynamic Next.js metadata routes | [C] `app/robots.ts`, `app/sitemap.ts`, `app/manifest.ts` |

**Seeded EventType slugs in code:** `fit-assessment` (local seed) and `front-desk-workshop` (local + Railway seed) [C] (`prisma/seed.ts`, `scripts/railway-seed.mjs`). Marketing site `arkansasautomated.com` links workshop CTAs to `https://book.arkansasautomated.com/book/front-desk-workshop` [I] (`AA.md` L89).

### 3.2 Authenticated Organizer Dashboard (`17` `page.tsx` files in `app/(dashboard)/`) [C]

Navigation shell (`components/app-shell.tsx` L26–39, L84) exposes `14` sidebar destinations plus `/settings`. `MEMBER` role sees `6` items (`Overview`, `Desk`, `Bookings`, `Contacts`, `Pipelines`, `People`); `ADMIN` and `OWNER` see all `15` surfaces:

1. `/dashboard` ("Overview") — booking metrics, weekly forecast strip, revenue trend chart (`components/dashboard-view.tsx`).
2. `/desk` ("Desk") — Contact-360 action queue & one-click next-action execution (`components/desk-view.tsx`, `server/services/contact-360-desk.ts`).
3. `/inbox` ("Inbox") — operator outbox/attention items and (in local demo mode only) local encrypted email viewer (`components/inbox-view.tsx`).
4. `/event-types` — list of bookable event types (`components/event-types-view.tsx`).
5. `/event-types/new` — create event type.
6. `/event-types/[id]` — edit event type: durations, ticket prices, buffers, minimum notice, booking window, location (`GOOGLE_MEET`, `IN_PERSON`, `PHONE`, `CUSTOM`), custom questions, funnel `landingJson`, and linked `ServiceArea`s (`components/event-type-editor.tsx`).
7. `/availability` — weekly availability intervals + date-specific overrides (`components/availability-editor.tsx`).
8. `/bookings` — booking list, detail inspection, organizer cancel/reschedule, CSV export (`components/bookings-view.tsx`).
9. `/contacts` — contact directory + Contact-360 drawer (`components/contacts-view.tsx`, `contact-360-drawer.tsx`).
10. `/route-coverage` — client-only (`ssr: false`) service-area & technician routing config: addresses, `RADIUS`/`POLYGON`/`ZIPLIST` areas, technicians, and workspace `maxDriveMinutes` (`components/route-coverage-view.tsx`).
11. `/pipelines` — drag-and-drop (`@dnd-kit`) CRM kanban board of `Pipeline` / `PipelineStage` / `Lead` cards (`components/pipelines-view.tsx`).
12. `/people` — unified people/lead filtering & bulk actions (`components/people-view.tsx`, `bulk-bar.tsx`).
13. `/call-queue` — outbound sales dial queue with dispositions, notes, and `LEAD_DIAL` follow-up trigger (`components/call-queue-view.tsx`).
14. `/letter` — "AA Letter" newsletter composer, preview/test send, and broadcast to opted-in `Contact` rows (`components/letter-view.tsx`).
15. `/social` — LinkedIn / X OAuth profile connection and scheduled post queue (`components/social-view.tsx`).
16. `/integrations` — Google Calendar OAuth connect/disconnect/scope health, Stripe/email readiness status, manual outbox retry (`components/integrations-view.tsx`).
17. `/settings` — account profile/avatar (`sharp` image ingestion), password change, workspace branding (logo, accent color with WCAG contrast check), team members/invitations, and **Trade Price Book** (`ServicePrice`) management (`components/settings-view.tsx`).

### 3.3 Complete API Route Inventory (`78` `route.ts` files, `108` HTTP handlers) [C]

Every `apps/web/src/app/api/**/route.ts` file and its verified authorization guard:

| Group | Route Path (`/api/...`) | Methods | Verified Auth Guard (`[C]`) |
| :--- | :--- | :--- | :--- |
| **Public Booking & Tickets (9)** | `public/[slug]` | `GET` | Public (rate-limited) |
| | `public/[slug]/slots` | `GET` | Public (rate-limited) |
| | `public/[slug]/route-aware-status` | `GET` | Public |
| | `public/[slug]/route-aware-slots` | `GET` | Public (rate-limited; geocodes + drive matrix) |
| | `public/[slug]/bookings` | `POST` | Public (rate-limited + idempotency key) |
| | `public/newsletter/subscribe` | `POST` | Public (rate-limited) |
| | `public/newsletter/unsubscribe` | `POST` | Public (HMAC/token-verified) |
| | `public/ticket/[bookingId]` | `GET` | Public (capability/ticket check) |
| | `public/ticket/[bookingId]/qr.png` | `GET` | Public (`image/png` QR) |
| **Invitee / Host Booking Mgmt (7)** | `bookings` | `GET` | `requireWorkspaceAccess` (`MEMBER`+) |
| | `bookings/export` | `GET` | `requireWorkspaceAccess` (`MEMBER`+, CSV) |
| | `bookings/manage-link` | `POST`, `PUT` | Public (booking recovery token request/consume) |
| | `bookings/[id]/manage-session` | `POST`, `PATCH` | Public capability token exchange → cookie |
| | `bookings/[id]` | `GET`, `PATCH`, `DELETE` | Organizer session **or** `requireBookingManageSession` (`read`/`reschedule`/`cancel`) |
| | `bookings/[id]/slots` | `GET` | `requireBookingManageSession` (`reschedule`) |
| | `bookings/[id]/checkout/resume` | `POST` | `requireBookingManageSession` |
| **Auth & Account (9)** | `auth/register` | `POST` | Public + same-origin + IP/email rate limit |
| | `auth/session` | `GET`, `POST`, `DELETE` | Public (`POST` login) / session cookie (`GET`, `DELETE`) |
| | `auth/verify-email/request` | `POST` | Public + same-origin + rate limit |
| | `auth/verify-email/consume` | `POST` | Public + hashed `AccountActionToken` |
| | `auth/password-reset/request` | `POST` | Public + same-origin + rate limit |
| | `auth/password-reset/consume` | `POST` | Public + hashed `AccountActionToken` |
| | `account` | `GET` | `requireWorkspaceAccess` (`MEMBER`+) |
| | `account/profile-image` | `PATCH` | `requireWorkspaceMutationAccess` (`MEMBER`+) |
| | `account/security` | `PATCH` | `requireWorkspaceMutationAccess` (`MEMBER`+) |
| **Workspace & Routing Config (11)** | `workspace` | `PATCH` | `requireWorkspaceMutationAccess` (`ADMIN`+) — includes onboarding completion |
| | `workspace/switch` | `POST` | `requireWorkspaceAccess` (`MEMBER`+) |
| | `workspace/members` | `GET`, `PATCH` | `GET`: `MEMBER`+; `PATCH`: `OWNER` |
| | `workspace/invitations` | `GET`, `POST` | `ADMIN`+ |
| | `workspace/invitations/accept` | `POST` | `requireWorkspaceMutationAccess` (`MEMBER`+) |
| | `workspace/addresses` | `GET`, `POST` | `MEMBER`+ |
| | `workspace/service-areas` | `GET`, `POST` | `MEMBER`+ |
| | `workspace/service-areas/[id]` | `GET`, `PATCH`, `DELETE` | `MEMBER`+ |
| | `workspace/technicians` | `GET`, `POST` | `MEMBER`+ |
| | `workspace/max-drive-minutes` | `GET`, `PATCH` | `GET`: `MEMBER`+; `PATCH`: `ADMIN`+ |
| | `workspace/next-actions` | `GET`, `POST` | `MEMBER`+ (Contact-360 Desk queue & execute) |
| **Scheduling & Branding (4)** | `event-types` | `GET`, `POST` | `GET`: `MEMBER`+; `POST`: `ADMIN`+ |
| | `event-types/[id]` | `GET`, `PATCH`, `DELETE` | `GET`: `MEMBER`+; `PATCH`/`DELETE`: `ADMIN`+ |
| | `availability` | `GET`, `PUT` | `MEMBER`+ |
| | `settings/branding` | `GET`, `PUT` | `GET`: `MEMBER`+; `PUT`: `ADMIN`+ |
| **Trade Price Book (2)** | `service-prices` | `GET`, `POST` | `MEMBER`+ |
| | `service-prices/lookup` | `POST` | `requireWorkspaceAccess` (`MEMBER`+) — fail-closed (`200` / `404 no_price` / `409 ambiguous_price`) |
| **CRM, Contacts & Forecast (15)** | `contacts` | `GET`, `DELETE` | `MEMBER`+ |
| | `contacts/[contactId]` | `GET` | `MEMBER`+ (Contact-360 detail) |
| | `contacts/[contactId]/actions` | `POST` | `MEMBER`+ |
| | `pipelines` | `GET`, `POST` | `MEMBER`+ |
| | `leads` | `GET`, `POST` | `MEMBER`+ |
| | `leads/bulk` | `POST` | `MEMBER`+ |
| | `leads/call-queue` | `GET` | `MEMBER`+ |
| | `leads/export` | `GET` | `MEMBER`+ (CSV) |
| | `leads/[leadId]` | `PATCH`, `DELETE` | `MEMBER`+ |
| | `leads/[leadId]/move` | `POST` | `MEMBER`+ |
| | `leads/[leadId]/disposition` | `POST` | `MEMBER`+ |
| | `leads/[leadId]/notes` | `POST` | `MEMBER`+ |
| | `leads/[leadId]/outreach` | `POST` | `MEMBER`+ (queues `LEAD_DIAL` email) |
| | `forecast/weekly` | `GET` | `MEMBER`+ |
| | `forecast/trend` | `GET` | `MEMBER`+ |
| **Newsletter & Social (8)** | `letter` | `GET`, `POST` | `MEMBER`+ |
| | `letter/test` | `POST` | `MEMBER`+ |
| | `letter/send` | `POST` | `MEMBER`+ |
| | `social/oauth/authorize` | `GET` | `MEMBER`+ |
| | `social/oauth/callback` | `GET` | Public OAuth callback (state-verified) |
| | `social/profiles` | `GET`, `POST` | `MEMBER`+ |
| | `social/posts` | `GET`, `POST` | `MEMBER`+ |
| | `social/queue` | `POST` | `MEMBER`+ |
| **Integrations & Operator (7)** | `integrations/status` | `GET` | `MEMBER`+ |
| | `integrations/outbox` | `POST` | `ADMIN`+ |
| | `integrations/email/inbox` | `GET`, `POST` | `ADMIN`+ (disabled in production) |
| | `integrations/google/authorize` | `POST` | `requireSessionRecord` + same-origin |
| | `integrations/google/callback` | `GET` | Public OAuth callback (PKCE + `OAuthState`) |
| | `integrations/google/status` | `GET`, `DELETE` | `GET`: `MEMBER`+; `DELETE`: `ADMIN`+ |
| | `operator/inbox` | `GET` | `MEMBER`+ |
| **Webhooks, Voice & Health (6)** | `webhooks/stripe` | `POST` | Stripe HMAC (`STRIPE_WEBHOOK_SECRET`) + `WebhookEvent` dedupe |
| | `voice/caller-lookup` | `POST` | Session cookie **or** `VOICE_INBOUND_SECRET` (hardcoded to workspace owning `front-desk-workshop`) |
| | `voice/retell-inbound` | `POST` | Same `requireVoiceCallerAccess` + IP rate limit (`60/min`) |
| | `health/live` | `GET` | Public (`{"status":"ok"}`) |
| | `health/ready` | `GET` | Public (verifies `BUILD_ID`, DB role, worker heartbeat in prod) |
| | `health/operator` | `GET` | `x-tempocove-operator-secret` (`OPERATOR_HEALTH_SECRET`) |

### 3.4 Notification Flows [C]

All outbound notifications in `aa-book` are **email** (via `EmailOutbox`, `11` kinds) plus a **best-effort Telegram alert** to the shop operator on new lead creation (`server/services/leads.ts` L370–375). There is **zero SMS sending or receiving** anywhere in `aa-book` [C].
- Booking confirmation (`BOOKING_CONFIRMED`), reschedule (`BOOKING_RESCHEDULED`), cancellation (`BOOKING_CANCELLED`), and **T-15 minute reminder** (`BOOKING_REMINDER`, copy says `"starting in 15 minutes"`, `notifications.ts` L239) queue transactionally with booking mutations and carry one-use manage links.
- Abandoned paid checkouts receive up to one `CHECKOUT_CHASE` email (`idempotencyKey = email:checkout-chase:<bookingId>`) when `DESK_NIGHTSHIFT=true` (`desk-nightshift.ts`).

---

## 4. Data Model (`42` Tables, `0` Enums) [C]

Both `prisma/schema.prisma` (SQLite) and `prisma/postgresql/schema.prisma` (PostgreSQL) define the exact same **42 models** and **0 Prisma enums** (string union values are enforced in TypeScript via `apps/web/src/lib/string-union.ts`). `35` models carry `workspaceId` directly or cascade strictly under a parent `Booking`/`EventType`/`AvailabilitySchedule`; `EventType.slug` is **globally unique** across the entire database (`schema.prisma` L117), meaning `/book/[slug]` is a single global slug namespace rather than `/book/[workspace]/[slug]`.

| # | Model | Primary Role & Key Columns | Scope |
| ---: | :--- | :--- | :--- |
| 1 | `User` | Staff login (`email` unique, `passwordHash` scrypt v1, `timeZone`, `emailVerifiedAt`) | Global |
| 2 | `Workspace` | Tenant container (`name`, `timeZone`, `maxDriveMinutes` default `20`, `onboardingCompletedAt`) | Tenant root |
| 3 | `Membership` | `User` ↔ `Workspace` join (`role`: `OWNER`/`ADMIN`/`MEMBER`, `status`) | Workspace |
| 4 | `WorkspaceInvitation` | Pending team invites (`email`, `role`, `tokenHash`, `tokenVersion`, `expiresAt`) | Workspace |
| 5 | `WorkspaceBranding` | Public booking brand (`workspaceName`, `logoUrl`, `accentColor`, `description`, `footerText`) | Workspace (1:1) |
| 6 | `AuthSession` | Cookie session store (`tokenHash`, `userId`, `activeWorkspaceId`, `membershipId`, `expiresAt`, `revokedAt`) | Workspace |
| 7 | `AccountActionToken` | Single-use hashed tokens for `EMAIL_VERIFY` and `PASSWORD_RESET` | Workspace |
| 8 | `OAuthState` | Google OAuth PKCE `codeVerifier`, `nonce`, processing lease, and credential-generation fence | Workspace |
| 9 | `OAuthConnection` | Per-workspace Google Calendar OAuth tokens (encrypted with AES-256-GCM via `TOKEN_ENCRYPTION_KEY`, `server/crypto/tokens.ts`), `calendarId`, disconnect/revoke lease state | Workspace |
| 10 | `EventType` | Bookable service (`slug` globally unique, `durationMinutes`, `locationType`, `bufferBefore/AfterMinutes`, `minimumNoticeMinutes`, `bookingWindowDays`, `priceCents`, `landingJson`) | Workspace |
| 11 | `EventDuration` | Multi-duration / tiered-price options on an `EventType` | via `EventType` |
| 12 | `CustomQuestion` | Intake form fields on an `EventType` (`TEXT`, `TEXTAREA`, `SELECT`, `CHECKBOX`, `optionsJson`) | via `EventType` |
| 13 | `AvailabilitySchedule` | Weekly schedule container per `(workspaceId, userId)` | Workspace |
| 14 | `AvailabilityInterval` | Weekly open intervals (`dayOfWeek`, `startMinute`, `endMinute`) | via Schedule |
| 15 | `AvailabilityOverride` | Date-specific open/blackout overrides (`dateKey`, `isAvailable`, `startMinute`, `endMinute`) | Workspace |
| 16 | `Booking` | Core appointment + payment + sync record: invitee name/email/tz, `startAt`/`endAt`, `status`, snapshots, `stripeCheckoutSessionId`/`stripePaymentIntentId`/`stripeRefundId`/`refundStatus`, `externalCalendarEventId`/etag/lease, `mutationVersion`, `idempotencyKey`, `assignedTechnicianId`, `driveTimeMinutes`, `addressId` | Workspace |
| 17 | `BookingAnswer` | Invitee responses (`valueJson`) to `CustomQuestion`s | via `Booking` |
| 18 | `BookingOccupancy` | **Per-minute slot lock** (`@@unique([workspaceId, hostId, minuteStart])`) preventing concurrent double-bookings | Workspace |
| 19 | `BookingCapability` | Hashed scoped capability tokens (`read`, `cancel`, `reschedule`) per booking | via `Booking` |
| 20 | `BookingManageSession` | Cookie-backed invitee manage session exchanged from capability links | via `Booking` |
| 21 | `BookingRecoveryToken` | Self-service "resend manage link" email tokens | Workspace |
| 22 | `IntegrationOutbox` | Durable leased queue for external side effects (`CALENDAR_CREATE`, `CALENDAR_UPDATE`, `CALENDAR_DELETE`, `STRIPE_EXPIRE`, `STRIPE_REFUND`) | Workspace |
| 23 | `EmailOutbox` | Durable leased email queue (`11` `EmailKind`s, `payloadJson`, `attemptCount`, `status`) | Workspace |
| 24 | `LocalInboxMessage` | Demo-only AES-GCM encrypted local inbox copy (`NODE_ENV !== 'production'` + `DEMO_MODE=true`) | Workspace |
| 25 | `WebhookEvent` | Idempotency log (`provider`, `id`, `payloadHash`) for Stripe webhooks | Global |
| 26 | `RateLimitBucket` | Fixed-window DB rate-limit counters (`keyHash`, `count`, `windowEnd`) | Global |
| 27 | `WorkerHeartbeat` | Worker liveness row (`workerId`, `lastSeenAt`, `status`, `buildId`) checked by `/api/health/ready` | Global |
| 28 | `Contact` | Unified person record (`@@unique([workspaceId, email])`, `phone`, `source`, `stage`, `lastBookingId`, `newsletterOptInAt`/`UnsubscribedAt`) | Workspace |
| 29 | `Pipeline` | CRM deal pipeline (`name`, `isDefault`) | Workspace |
| 30 | `PipelineStage` | Kanban column (`sortKey` float, `isWin`, `isLoss`) | Workspace |
| 31 | `Lead` | CRM deal (`pipelineId`, `stageId`, `contactId`, `valueCents`, `source`, comma-joined `tags` holding `dnc`/`vip`, soft-delete `deletedAt`) | Workspace |
| 32 | `LeadActivity` | Audit/timeline entries on a lead (`note`, `task`, `statusChange`, `source`) | Workspace |
| 33 | `LeadTask` | Follow-up task on a lead (`title`, `dueAt`, `doneAt`) | Workspace |
| 34 | `NewsletterIssue` | AA Letter broadcast drafts and send timestamps (`subject`, `bodyText`, `status`, `sentAt`) | Workspace |
| 35 | `SocialProfile` | Encrypted OAuth credentials (`accessTokenEnc`, `refreshTokenEnc`) per `(workspaceId, platform)` | Workspace |
| 36 | `SocialPost` | Draft/scheduled/published social posts (`platform`, `textPayload`, `scheduledAt`, `failureReason`) | Workspace |
| 37 | `Address` | Geocoded street address (`latitude`, `longitude`, `geocodedBy`) | Workspace |
| 38 | `ServiceArea` | Coverage zone (`RADIUS`, `POLYGON`, or `ZIPLIST`) anchored to `centerAddressId` | Workspace |
| 39 | `EventTypeServiceArea` | Join linking `EventType`s to allowed `ServiceArea`s | via `EventType` |
| 40 | `Technician` | Field tech linked 1:1 to `User` (`homeAddressId`, `maxDailyJobs` default `8`) | Workspace |
| 41 | `RouteCache` | Cached Mapbox drive `minutes` & `meters` keyed by `(originKey, destLat, destLng)` | Workspace |
| 42 | `ServicePrice` | **Fail-closed trade price book** (`trade`, `service`, `serviceDetail`, `workKind`, `fixture`, `locationInHome`, `propertyType`, `timing`, `postalCode`, `cents`, `unit`, `source`) | Workspace |

---

## 5. Integrations (`9` Active Runtime + `1` Disabled Stub + `1` Offline Script)

| # | Integration | What It Does in `aa-book` | Auth / SDK / Transport | Env Var NAMES (`[C]`) | Status & Evidence |
| ---: | :--- | :--- | :--- | :--- | :--- |
| 1 | **Google Calendar + Google Meet** | Two-way calendar sync (`freebusy` conflict check, event `insert`/`patch`/`delete`, ETag CAS, `conferenceDataVersion: 1` Meet link creation, token revoke on disconnect) | Per-workspace OAuth 2.0 PKCE (`googleapis`, `google-auth-library`) or env refresh token | `CALENDAR_PROVIDER`, `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_REFRESH_TOKEN`, `GOOGLE_CALENDAR_ID`, `GOOGLE_ENV_WORKSPACE_ID` | [C] `server/services/calendar.ts` |
| 2 | **Stripe** | Hosted Checkout session creation for paid bookings (`priceCents > 0`), session expiry, full/partial refunds on cancel, signed webhook settlement | `stripe` SDK `22.5.0`; **single merchant Stripe account** (zero Stripe Connect / `stripeAccount` code) | `PAYMENTS_PROVIDER`, `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY`, `STRIPE_LIVE_PAYMENTS`, `STRIPE_CLAIMABLE_SANDBOX` | [C] `server/services/payments.ts`, `stripe-credentials.ts` |
| 3 | **SMTP (Nodemailer)** | Transactional & newsletter email delivery when `EMAIL_PROVIDER=smtp` | `nodemailer` `10.0.13` | `EMAIL_PROVIDER`, `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASSWORD`, `SMTP_TLS_MODE`, `SMTP_ALLOW_SELF_SIGNED`, `SMTP_TIMEOUT_MS`, `EMAIL_FROM`, `EMAIL_REPLY_TO`, `EMAIL_SENDER_DOMAIN` | [C] `server/services/notifications.ts`, `email-config.ts` |
| 4 | **Resend** | Alternative HTTP transactional & newsletter email transport when `EMAIL_PROVIDER=resend` | `fetch("https://api.resend.com/emails")` | `EMAIL_PROVIDER`, `RESEND_API_KEY`, `EMAIL_FROM`, `EMAIL_REPLY_TO` | [C] `notifications.ts` L333–347 |
| 5 | **Mapbox** | Forward address geocoding (`geocoding/v5`) and driving duration/distance matrix (`directions-matrix/v1`) for route-aware slot filtering; supports dry-run Haversine fallback | `fetch` to `api.mapbox.com` | `MAPBOX_SECRET_TOKEN`, `MAPBOX_DRY_RUN` | [C] `server/services/mapbox.ts`, `routing.ts` |
| 6 | **Retell AI (Inbound Caller Lookup Only)** | `POST /api/voice/retell-inbound` & `caller-lookup` return caller name, returning flag, last booking, VIP/DNC flags (`reject: true` on `dnc` lead tag) as Retell `dynamic_variables`. **Does not book, cancel, or run voice tool calls.** | Shared secret (`x-tempocove-voice-secret`, `Bearer`, or `?voice_secret=`) | `VOICE_INBOUND_SECRET` | [C] `api/voice/*`, `server/services/caller-lookup.ts` |
| 7 | **LinkedIn** | OAuth account link + scheduled text post publishing from worker | `fetch` to `www.linkedin.com` / `api.linkedin.com` | `LINKEDIN_CLIENT_ID`, `LINKEDIN_CLIENT_SECRET`, `LINKEDIN_MEMBER_URN` | [C] `social-oauth.ts`, `social-dispatch.ts` |
| 8 | **X (Twitter)** | OAuth 2.0 PKCE link + scheduled tweet publishing from worker | `fetch` to `api.x.com` | `X_CLIENT_ID`, `X_CLIENT_SECRET` | [C] `social-oauth.ts`, `social-dispatch.ts` |
| 9 | **Telegram Bot API** | Best-effort operator chat notification when a new CRM `Lead` is created | `fetch` to `api.telegram.org` | `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID` | [C] `server/services/leads.ts` L370–375 |
| — | *Facebook (stub)* | Selectable platform enum in `SocialPost`, but publish returns a hardcoded failure (`"facebook:auto-publish is disabled"`) | None | None | [C] `social-dispatch.ts` L55–56 |
| — | *Anthropic Claude (offline script only)* | Standalone `scripts/enrich-email.mjs` calls `https://api.anthropic.com/v1/messages` (Haiku) reading an operator home-dir key file. **Never imported by `apps/web` or worker.** | `fetch` | None (reads `~/.hermes/.claude-api-key` if invoked manually) | [C] `scripts/enrich-email.mjs` L27, L78 |

**Confirmed absent from `aa-book` (`[C]` via repo-wide grep):** Twilio or any SMS carrier, 10DLC STOP/START/HELP handling, missed-call text-back, voice appointment booking/tool webhooks, ElevenLabs, any runtime LLM/agent loop, model routing or token/spend tracking, multi-touch estimate follow-ups, and post-job Google review requests.

---

## 6. Authentication, Authorization & Security Model [C]

- **Organizer auth (`server/auth/password.ts`, `session.ts`):** Passwords hashed with Node `crypto.scrypt` (`scrypt:v1:<salt>:<derived>`). Sessions use an HTTP-only `SameSite=Lax` cookie (`secure` in production) whose SHA-256 hash is stored in `AuthSession` alongside `activeWorkspaceId` and `membershipId`. Mutating browser endpoints call `assertSameOrigin(request)`.
- **RBAC (`session.ts` L50, L111):** Three workspace roles ranked `MEMBER (1) < ADMIN (2) < OWNER (3)`. Last-owner deletion/demotion is blocked in SQLite/PG triggers and service transactions (`accounts.ts` L150).
- **Database tenant isolation (`server/db-context.ts`, `prisma/postgresql/`):** Production PostgreSQL enforces Row-Level Security across workspace tables (`49` `ENABLE`/`FORCE ROW LEVEL SECURITY` statements) verified by dedicated CI scripts (`ci:postgres-rls`, `ci:postgres-app-context`, `ci:postgres-service-dml`).
- **Token encryption at rest (`server/crypto/tokens.ts`):** OAuth tokens and local inbox payloads are encrypted with `aes-256-gcm` (`aesgcm:v1:...`) using 32-byte `TOKEN_ENCRYPTION_KEY` (enforced `>=16` distinct bytes).
- **Invitee capability links (`server/auth/capabilities.ts`):** Customers never create accounts. Confirmation/reminder emails embed HMAC-derived capability tokens (`BOOKING_CAPABILITY_SECRET` / rotatable `BOOKING_CAPABILITY_KEYRING`), exchanged once for an HTTP-only per-booking cookie (`BookingManageSession`) scoped to `read`, `cancel`, or `reschedule`.
- **Machine-to-machine endpoints:** Stripe uses `Stripe-Signature` (`STRIPE_WEBHOOK_SECRET`); Retell lookup uses `VOICE_INBOUND_SECRET` (hardcoded to the workspace owning `front-desk-workshop`, `caller-lookup.ts` L116); operator health uses `OPERATOR_HEALTH_SECRET`. Notice `POST /api/service-prices/lookup` currently requires an interactive workspace cookie (`requireWorkspaceAccess`) rather than a machine bearer secret [C] (`api/service-prices/lookup/route.ts` L20).

---

## 7. Scheduled and Background Work [C]

There are **no cron containers, platform cron schedules, or GitHub Actions scheduled workflows** [C]. All asynchronous work runs inside a single polling loop (`apps/web/src/server/worker.ts`, compiled to `dist/worker.mjs`) ticking every `OUTBOX_POLL_INTERVAL_MS`:

1. **`drainDueOutbox` (`server/services/outbox.ts`):** Processes leased `IntegrationOutbox` rows across `5` kinds (`CALENDAR_CREATE`, `CALENDAR_UPDATE`, `CALENDAR_DELETE`, `STRIPE_EXPIRE`, `STRIPE_REFUND`) with exponential backoff, tombstone superseding on rapid create→cancel, and `DEAD` terminal marking.
2. **`processEmailOutbox` (`server/services/notifications.ts`):** Sends leased `EmailOutbox` rows across `11` kinds (`EMAIL_VERIFY`, `PASSWORD_RESET`, `WORKSPACE_INVITATION`, `BOOKING_RECOVERY`, `BOOKING_CONFIRMED`, `BOOKING_RESCHEDULED`, `BOOKING_CANCELLED`, `BOOKING_REMINDER`, `NEWSLETTER_ISSUE`, `LEAD_DIAL`, `CHECKOUT_CHASE`).
3. **`drainSocialPosts` (`server/services/social-dispatch.ts`):** Publishes due `SocialPost` rows (`scheduledAt <= now`) to LinkedIn and X.
4. **`runBookingNightshift` (`server/services/desk-nightshift.ts`):** Gated by `DESK_NIGHTSHIFT === "true"`; runs at most once every `15` minutes and queues up to `10` `CHECKOUT_CHASE` emails for unpaid paid-event bookings.
5. **`WorkerHeartbeat`:** Upserts `STARTING` / `RUNNING` / `IDLE` / `DEGRADED` plus `buildId`; `/api/health/ready` fails `503` in production if the worker heartbeat goes stale [C]. (An inline fallback `OUTBOX_WORKER_MODE` / `OUTBOX_INLINE_DRAIN` also exists for single-process non-strict environments [C].)

---

## 8. Deployment Shape & Environment Variable Names

- **Build & container topology (`[C]`):** `railway.toml` selects `builder = "DOCKERFILE"` pointing to multi-stage `Dockerfile` (`deps` → `builder` → `production-deps` → `migration` on `postgres:18.6-bookworm` → `runtime` on `node:24.15.0-bookworm-slim`). `ENTRYPOINT` is `node scripts/container-entrypoint.mjs`; default `CMD` is `node apps/web/server.js`.
- **Startup contract (`[C]` `scripts/container-entrypoint.mjs`):** Reads optional `/run/secrets/*` `*_FILE` mounts, optionally runs `scripts/railway-migrate.sh` (`RUN_MIGRATE=true`) and `scripts/railway-seed.mjs` (`RUN_SEED=true` + `AA_BOOK_SEED=true`), asserts `BUILD_ID` matches compiled `/app/apps/web/.next/BUILD_ID`, and execs either web (`apps/web/server.js`) or worker (`dist/worker.mjs`).
- **Railway accommodations (`[C]`):** While `scripts/production-config.mjs` specifies strict `sslmode=verify-full` and separate PostgreSQL roles (`compose.production.yml` reference topology), `server/db.ts` L33 permits `sslmode=require` when `RAILWAY_ENVIRONMENT` is set, and `server/worker.ts` L19 skips the DB role assertion when `RAILWAY_SKIP_DB_ROLES=true`.
- **Hosted target (`[I]` `AA.md`, `BRANCH-LOCK.md`):** Docs name Railway project `loyal-passion`, public URL `https://book.arkansasautomated.com`. Note that `ArkansasAutomated/aa-book` on GitHub redirects (`301`) to `andrebrassfield/aa-book` [C].

**Complete Application & Ops Environment Variable NAMES (`[C]`, secret values never read or printed):**
- *Core & Security:* `NODE_ENV`, `NEXT_PUBLIC_APP_URL`, `BUILD_ID`, `AUTH_SECRET`, `NEXTAUTH_SECRET`, `TOKEN_ENCRYPTION_KEY`, `EMAIL_TOKEN_SECRET`, `TENANT_CONTEXT_SECRET`, `BOOKING_CAPABILITY_SECRET`, `BOOKING_CAPABILITY_KEYRING`, `BOOKING_CAPABILITY_KEY_ID`, `RATE_LIMIT_PROVIDER`, `RATE_LIMIT_HASH_SECRET`, `RATE_LIMIT_MAX_BUCKETS`, `TRUST_PROXY`, `PROXY_SHARED_SECRET`, `OPERATOR_HEALTH_SECRET`, `DEMO_MODE`, `DEMO_HOST_EMAIL`, `DEMO_HOST_PASSWORD`.
- *Database & Roles:* `DATABASE_PROVIDER`, `DATABASE_URL`, `DATABASE_ROLE`, `WORKER_DATABASE_URL`, `MONITOR_DATABASE_URL`, `TEMPOCOVE_APP_DB_PASSWORD`, `TEMPOCOVE_WORKER_DB_PASSWORD`, `TEMPOCOVE_MONITOR_DB_PASSWORD`, `TEMPOCOVE_MIGRATION_DB_PASSWORD`, `POSTGRES_INSECURE_LOCAL_TEST`.
- *Worker & Automation:* `OUTBOX_WORKER_ENABLED`, `OUTBOX_WORKER_MODE`, `OUTBOX_POLL_INTERVAL_MS`, `OUTBOX_INLINE_DRAIN`, `WORKER_ID`, `WORKER_SHUTDOWN_TIMEOUT_MS`, `DESK_NIGHTSHIFT`, `LEAD_AUTOMATION_EMAILS`, `LEAD_OUTREACH_CTA_URL`.
- *Deploy & Seed:* `RUN_MIGRATE`, `RUN_SEED`, `AA_BOOK_SEED`, `AA_BOOK_OWNER_EMAIL`, `AA_BOOK_OWNER_PASSWORD`, `AA_BOOK_URL`, `RAILWAY_ENVIRONMENT`, `RAILWAY_SKIP_DB_ROLES`.
- *Integrations:* `CALENDAR_PROVIDER`, `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_REFRESH_TOKEN`, `GOOGLE_CALENDAR_ID`, `GOOGLE_ENV_WORKSPACE_ID`, `PAYMENTS_PROVIDER`, `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY`, `STRIPE_LIVE_PAYMENTS`, `STRIPE_CLAIMABLE_SANDBOX`, `EMAIL_PROVIDER`, `EMAIL_FROM`, `EMAIL_REPLY_TO`, `EMAIL_SENDER_DOMAIN`, `RESEND_API_KEY`, `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASSWORD`, `SMTP_TLS_MODE`, `SMTP_ALLOW_SELF_SIGNED`, `SMTP_TIMEOUT_MS`, `MAPBOX_SECRET_TOKEN`, `MAPBOX_DRY_RUN`, `VOICE_INBOUND_SECRET`, `LINKEDIN_CLIENT_ID`, `LINKEDIN_CLIENT_SECRET`, `LINKEDIN_MEMBER_URN`, `X_CLIENT_ID`, `X_CLIENT_SECRET`, `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`.

---

## 9. Test State [C]

| Suite | Count & Scope | Result / Gate Status |
| :--- | :--- | :--- |
| **Vitest unit + SQLite integration** (`vitest.config.ts`) | **62** test files (`apps/web/src/**/*.test.ts`), **374** tests (serial execution against isolated temp SQLite DB) | **[C] Executed locally in this session:** `62 passed (62)`, `374 passed (374)` in `27.85s` (`env -i` clean environment). |
| **Source inventory test** (`scripts/source-inventory.test.mjs`) | **1** Node built-in test file | **[C] Executed locally in this session:** passed (`0` failures). |
| **TypeScript typecheck** (`npm run typecheck`) | `tsc --project apps/web/tsconfig.json --noEmit` | **[C] Executed locally in this session:** exit `0` (`0` errors). |
| **Playwright + axe-core e2e** (`tests/e2e/*.spec.ts`) | **4** spec files (`journey`, `public-booking-steps`, `one-use-links`, `accessibility`), **11** tests | **[C]** Configured in `.github/workflows/browser-axe.yml` (`4` shards, `workflow_dispatch` only — not run on PRs due to runner timeouts per `RECEIPT.md` `[I]`). Not executed in this session to avoid spinning long headless servers. |
| **PostgreSQL RLS / authority / load proofs** (`scripts/postgres-*.{mjs,mts}`) | **~14** CI proof scripts inside `.github/workflows/ci.yml` (`verify` job against `postgres:18` service container) | **[C]** Wired into `ci.yml` `verify` job on PR/push; `native-production-load` is self-hosted `workflow_dispatch` only. Branch protection is process-enforced (`BRANCH-LOCK.md`), not GitHub API-enforced (`[I]`). |

---

## 10. Unknowns Requiring Owner or Live-System Inspection (`[U]`)

| ID | Unknown | Why the Repo Cannot Settle It |
| :--- | :--- | :--- |
| **U-1** | Exact commit SHA currently running on `book.arkansasautomated.com`, and whether Railway's GitHub auto-deploy webhook survived the repo path move from `ArkansasAutomated/aa-book` to `andrebrassfield/aa-book` | Railway deployment state lives outside git. |
| **U-2** | Production row counts and tenancy footprint: whether *only* Arkansas Automated's own workspace (`front-desk-workshop` / `fit-assessment`) has real rows, or whether any external customer signed up via open `/signup` | Requires read query against Railway PostgreSQL (`Workspace`, `Booking`, `Contact`, `Lead`, `ServicePrice`). |
| **U-3** | Whether a separate Railway worker service (`node dist/worker.mjs`) is running and healthy, or whether outbox draining runs inline, plus any `DEAD` rows in `IntegrationOutbox` / `EmailOutbox` | Requires Railway dashboard or `GET /api/health/operator`. |
| **U-4** | Whether production runs with `RAILWAY_SKIP_DB_ROLES=true` + `sslmode=require` or provisioned `tempocove_*` Postgres roles + `verify-full` TLS | Lives in Railway environment variables. |
| **U-5** | Whether automated encrypted PostgreSQL backups are scheduled and tested against live Railway data | `scripts/backup-postgres.ps1` is manual PowerShell; no scheduler exists in the repo. |
| **U-6** | Whether any live Retell phone number currently points its `inbound_webhook_url` at `book.arkansasautomated.com/api/voice/retell-inbound` | Configured in Retell dashboard (`docs/voice-inbound-caller-lookup.md` notes it needed explicit GO). |
| **U-7** | Live Stripe volume: whether `STRIPE_LIVE_PAYMENTS=true` is currently active in Railway, which event slugs collect real payments, and whether any open/refundable workshop tickets exist | Lives in Railway env + Stripe dashboard. |
| **U-8** | Google Cloud OAuth publishing status: whether the `Arkansas Automated Book` OAuth client is still in "Testing" mode (7-day refresh token expiry) or verified/published in production | `AA.md` noted "testing OAuth" on 2026-08-30; current Google Console status is external. |
| **U-9** | Active email provider in production (`EMAIL_PROVIDER=resend` vs `smtp`) and SPF/DKIM domain status | Lives in Railway env + DNS/provider console. |
| **U-10** | Live web traffic distribution across `/book/[slug]`, `/f/[slug]`, `/uppity-ai/[slug]`, `/ticket/[bookingId]`, and `/subscribe` (including any external links or QR codes in the wild) | Requires Railway HTTP logs or marketing-site inspection. |
| **U-11** | Whether `AA Letter` (`/letter`), Social Engine (`/social`), CRM Pipelines (`/pipelines`, `/desk`), or Route Coverage (`/route-coverage` + Mapbox) are actively used by the owner day-to-day or were experimental slices | Requires owner confirmation / prod DB counts. |
| **U-12** | Disposition of the `35` non-`main` remote branches on `andrebrassfield/aa-book` (e.g., `dre/DRE-204-price-book`, `dre/DRE-166-click-to-call`, `feat/contact-360-vnext`, `feat/qualify-*`) — whether any hold unmerged work still wanted | Only the owner can classify which branches matter vs archive. |
