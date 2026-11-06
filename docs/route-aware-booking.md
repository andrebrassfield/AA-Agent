# Route-Aware Booking (design doc, spec 2026-11-05)

Status: implemented on branch `feat/route-aware-booking`, draft PR. Simulator + unit/integration tests green (`bun test` 88/88, `bun x tsc --noEmit` clean, `aabook demo` passes). Nothing merged, deployed, or client-facing.

## Why

Routemize sells route-optimized instant booking to home services: when a customer books, it offers only times that add the least drive time to the day's route. The Nov 4 competitor audit and the Nov 5 Routemize teardown (Sloane) found this is the one real wedge AA Book lacks. Dre's call (2026-11-05 GO): close the gap inside AA Book (the installable `aabook` CLI agent), not by ceding it.

## Scope

- In scope: the AA agent (voice or text) booking an **in-home** appointment in `andrebrassfield/AA-Agent`.
- Out of scope (per spec): no changes to the hosted book.arkansasautomated.com (separate codebase, untouched); no new vendor accounts or paid API keys without Dre's named GO; nothing client-facing ships on this spec alone; Miles/NSI contact remains HELD since Oct 29.

## Inputs (all from the per-client config folder)

- `business.json` → shop home base `address` (per-tech override: `staff.json` member `homeBase`).
- `policies.json` `serviceArea` → `primaryZipCodes` (existing), plus new optional `radiusMiles` (overrides `maxDistanceMiles`) and `polygon` (lat/lng vertices). Any matching criterion admits.
- `policies.json` `routing` (new) → `enabled`, `geocoder` (`"nominatim"` default / `"local"` synthetic), `allowSyntheticGeocoder`, `avgSpeedMph` (default 25), `driveTimeBufferMinutes` (default 10), `slotStepMinutes` (15), `maxOffers` (3), `horizonDays` (7).
- `services.json` → per-job-type `durationMinutes` + `bufferMinutes` (block length), `inHome` (default true), `bookingRules.triage` (`book` | `ask_first` | `decline`, default `book`), `bookingRules.assignedStaffIds` (tech list).
- Calendar → the day's existing appointments; addresses read from event descriptions tagged `Address: ...` and `Tech: ...` (the booking workflow writes both on create when an address is given).

## Behavior pipeline (order matters)

1. **Screening first.** `triage: decline` → no slots, take a message; the booking write itself is also refused (`handleBookingWorkflow` enforces it). `ask_first` → offers returned flagged `askFirst`. Route fit never overrides a decline.
2. **Service area.** Outside → no slot offered; suggested reply takes a message. Un-geocodable address with no zip match → not admitted (we do not guess).
3. **Geocode caller + home base.** Any failure → fallback: nearest open slots, `routeAware: false`, no drive-time claim. Never invent a drive time.
4. **Rank per tech.** Candidate starts step through business hours ∩ staff schedule over the horizon, filtered by calendar availability. Each feasible candidate gets an added-drive-minutes score (below). Offers sorted by added drive ascending, then earlier start; top `maxOffers` returned as exact times. Suggested reply is plain words: "We can be there at 10:45 AM on Friday, Nov 6." Not a window.

## Ranking algorithm (v1)

- A tech's day = home base anchoring both ends + existing stops in time order.
- Inserting the new stop between prev and next adds `detour = d(prev,new) + d(new,next) − d(prev,next)` miles (haversine). Added drive minutes = detour / avgSpeedMph × 60, rounded up.
- Feasibility: the schedule gaps between adjacent real stops must absorb the drive plus `driveTimeBufferMinutes` (gap ≥ drive + buffer on both sides). Home anchors have no gap constraint (day start/end flex within hours). Stops whose addresses fail to geocode still block time via calendar availability but are excluded from geometry.
- Multi-tech: rank per tech (events tagged `Tech:` filter that tech's stops when present) and merge offers globally.

## Drive-time source: v1 and the upgrade path

- v1: haversine on geocoded addresses, $0, no key. Geocoder default is Nominatim (free OSM HTTP, no account; low-volume, descriptive User-Agent). `local` is a deterministic synthetic hash geocoder usable only with `allowSyntheticGeocoder: true` (tests/demo/simulator); without that flag the code falls back and makes no route claim.
- Upgrade path (design note, not built): a real routing API (Google Routes Distance Matrix or Mapbox Matrix). Published list-price magnitudes (re-verify on the vendor pricing page before enabling; no keys without Dre's named GO, and per-client `dailySpendCapUsd` already caps spend): Mapbox Matrix ≈ $2.00 per 1,000 requests with a 100k requests/month free tier; Google Distance Matrix ≈ $5 per 1,000 requests (25×25 elements each). One ranking pass over a day with S stops and C candidate slots costs roughly (S+1)×C distance elements — a typical day (5 stops, 20 slots) ≈ 120 elements, on the order of $0.001–$0.60 depending on billing unit. Worth it when drive-time accuracy prevents lost bookings or travel-fee disputes, not before. Client config carries the choice (`routing.geocoder` + future provider field); v1 ships none of it.

## Booking write

`book_appointment` / `manageBooking create` accept `customerAddress`. The address is stored verbatim on the booking; `driveTimeMinutesAdded` and `staffId` are set only when an honest estimate was computable; the calendar event description gets `Address:` / `Tech:` tags so future ranking sees the stop. Audit log carries route details (`VOICE_TOOL_ROUTE_SLOTS_OFFERED`, `SMS_ROUTE_SLOTS_OFFERED`, and route fields on `BOOKING_CONFIRMED`).

## Proof bar (spec) → evidence

Simulator: `bun run scripts/route-simulator.ts` (synthetic addresses only, FakeCalendar, FixedGeocoder). Day 2026-11-06 with 3 stops in Fort Smith:

- Near caller next door to stop 2 → top offer 10:15 local (the tight 10:00–11:30 gap), added drive 1 min. "We can be there at 10:15 AM on Friday, Nov 6."
- Greenwood caller (~12–14 mi) → top offer day's edge 15:45 local, added drive 67 min (next day 09:00 at 70 min is second). Packed-day variant → pushed to next open day (Sat 09:00).
- Little Rock caller (~127 mi) → outside 35 mi radius: no offers, take-a-message reply.
- Geocoder failure → fallback nearest-open offers, no drive claims.

Tests: `tests/unit/routing.test.ts` (geo, service area, ranking math, gap feasibility, all spec behaviors, booking annotation, engine/retell wiring, validator) and `tests/integration/route_simulator.test.ts` (proof bar end to end). `bun test` 88/88 pass.

## Miles/NSI pilot reviewer case

Solo operator, wide area (45 mi radius, travelFee $35), inspections 180 min + 45 buffer = 225 min blocks. With blocks that long, inter-stop gaps almost never fit a new inspection with drive+buffer, so ranking does the right thing for his day: it refuses to squeeze a stop between inspections and offers the day's edge or the next open day instead of a tight gap that would run him late. The wide radius admits Greenwood-area callers by distance; the ranking (not the area check) is what keeps his route sane. His `services.json` still needs owner-confirmed values (template holds TODOs) before any pilot.

## Open items / risks

- Reschedule does not re-rank by route (uses standard availability) — future work.
- `isWithinBusinessHours` interprets hours as UTC (pre-existing quirk, unchanged); slot generation uses local tz properly, so an edge case exists where an offered slot is rejected by the create path. Flagged, not fixed here.
- Nominatim is network-dependent and rate-limited; failures fall back safely but offers degrade to nearest-open. A caching layer would cut calls.
- Haversine ignores roads (~15–30% optimistic in rural AR); avgSpeedMph is the tuning knob until a routing API is approved.
- Synthetic geocoders are hard-gated behind `allowSyntheticGeocoder` so tests can never leak fake drive times into a real client run.
