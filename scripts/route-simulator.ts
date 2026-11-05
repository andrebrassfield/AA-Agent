/**
 * Route-aware booking simulator (spec 2026-11-05 proof bar).
 *
 * Runs synthetic-address scenarios against a FakeCalendar. No live client
 * data, no network, no paid APIs. Run directly:
 *
 *   bun run scripts/route-simulator.ts
 *
 * Prints a human-readable transcript plus a JSON ledger on stdout.
 */

import { FakeCalendar, type CalendarEvent } from "../src/calendar/calendar.ts";
import { FixedGeocoder, FailingGeocoder, localDayMinuteToUtc, type LatLng } from "../src/routing/geo.ts";
import { formatPlainWordsOffer, offerRouteAwareSlots, type RouteOffersResult } from "../src/routing/offers.ts";
import type { ClientConfig } from "../src/types/config.ts";

export const SIM_TZ = "America/Chicago";
export const SIM_DAY = "2026-11-06"; // a Friday
export const SIM_NOW = new Date("2026-11-05T20:00:00.000Z");

// Synthetic addresses (invented street names; coords are the real city centroids).
export const SIM_ADDRESSES = {
  home: "100 Shop St, Fort Smith, AR 72901",
  stop1: "12 Oak St, Fort Smith, AR 72901",
  stop2: "88 Elm St, Fort Smith, AR 72903",
  stop3: "5 Pine St, Fort Smith, AR 72916",
  nearCaller: "90 Elm St, Fort Smith, AR 72903", // next door to stop2
  greenwoodCaller: "300 Greenwood Hwy, Greenwood, AR 72927",
  farCaller: "1 Main St, Little Rock, AR 72201", // ~75 mi out
} as const;

export const SIM_COORDS: Record<string, LatLng> = {
  [SIM_ADDRESSES.home.toLowerCase()]: { lat: 35.3859, lng: -94.3985 },
  [SIM_ADDRESSES.stop1.toLowerCase()]: { lat: 35.39, lng: -94.405 },
  [SIM_ADDRESSES.stop2.toLowerCase()]: { lat: 35.38, lng: -94.39 },
  [SIM_ADDRESSES.stop3.toLowerCase()]: { lat: 35.4, lng: -94.38 },
  [SIM_ADDRESSES.nearCaller.toLowerCase()]: { lat: 35.3802, lng: -94.3902 },
  [SIM_ADDRESSES.greenwoodCaller.toLowerCase()]: { lat: 35.2146, lng: -94.2516 },
  [SIM_ADDRESSES.farCaller.toLowerCase()]: { lat: 34.7465, lng: -92.2896 },
};

export function buildSimConfig(): ClientConfig {
  return {
    business: {
      name: "Sim Shop (synthetic)",
      trade: "Home Services",
      timezone: SIM_TZ,
      hours: {
        monday: { open: "08:00", close: "17:00" },
        tuesday: { open: "08:00", close: "17:00" },
        wednesday: { open: "08:00", close: "17:00" },
        thursday: { open: "08:00", close: "17:00" },
        friday: { open: "08:00", close: "17:00" },
        saturday: { open: "09:00", close: "13:00" },
        sunday: { open: "00:00", close: "00:00", closed: true },
      },
      phoneNumbers: { main: "+14755550100" },
      address: { street: "100 Shop St", city: "Fort Smith", state: "AR", zip: "72901" },
    },
    services: {
      services: [
        {
          id: "in-home-visit",
          name: "In-Home Service Visit",
          durationMinutes: 45,
          price: 89,
          bufferMinutes: 15,
          inHome: true,
          bookingRules: { leadTimeHours: 0, assignedStaffIds: ["tech-1"] },
        },
      ],
    },
    staff: {
      staff: [{ id: "tech-1", name: "Sam Tech", role: "Field Tech" }],
    },
    persona: {
      greeting: "Hi, Sim Shop here.",
      voiceChoice: "alloy",
      aiDisclosureWording: "I am an automated AI assistant.",
      tone: "friendly",
    },
    policies: {
      cancellation: { noticePeriodHours: 24, fee: 0, policyText: "24h notice." },
      deposit: { required: false, type: "fixed", amount: 0 },
      serviceArea: {
        primaryZipCodes: ["72901", "72903", "72904", "72908", "72916"],
        maxDistanceMiles: 35,
      },
      routing: {
        enabled: true,
        geocoder: "local",
        allowSyntheticGeocoder: true,
        avgSpeedMph: 25,
        driveTimeBufferMinutes: 5,
        slotStepMinutes: 15,
        maxOffers: 3,
        horizonDays: 2,
      },
      dailySpendCapUsd: 5.0,
    },
  };
}

export function buildSimGeocoder(): FixedGeocoder {
  return new FixedGeocoder(SIM_COORDS);
}

function stopEvent(id: string, address: string, startMin: number, endMin: number): CalendarEvent {
  const start = localDayMinuteToUtc(SIM_DAY, startMin, SIM_TZ).toISOString();
  const end = localDayMinuteToUtc(SIM_DAY, endMin, SIM_TZ).toISOString();
  return {
    id,
    title: `Existing job - ${id}`,
    startTime: start,
    endTime: end,
    description: `Address: ${address}\nTech: tech-1`,
  };
}

/** Proof-bar day: 3 stops in Fort Smith. */
export async function seedProofDay(calendar: FakeCalendar): Promise<void> {
  await calendar.createEvent(stopEvent("ev-s1", SIM_ADDRESSES.stop1, 9 * 60, 10 * 60));
  await calendar.createEvent(stopEvent("ev-s2", SIM_ADDRESSES.stop2, 11 * 60 + 30, 12 * 60 + 30));
  await calendar.createEvent(stopEvent("ev-s3", SIM_ADDRESSES.stop3, 14 * 60, 15 * 60));
}

/** Packed day: gaps too small for a route-feasible insertion. */
export async function seedPackedDay(calendar: FakeCalendar): Promise<void> {
  await calendar.createEvent(stopEvent("ev-p1", SIM_ADDRESSES.stop1, 8 * 60, 9 * 60));
  await calendar.createEvent(stopEvent("ev-p2", SIM_ADDRESSES.stop2, 10 * 60, 11 * 60 + 30));
  await calendar.createEvent(stopEvent("ev-p3", SIM_ADDRESSES.stop3, 12 * 60 + 30, 14 * 60));
  await calendar.createEvent(stopEvent("ev-p4", SIM_ADDRESSES.stop1, 15 * 60, 17 * 60));
}

export function localDayTime(iso: string): { day: string; minutes: number } {
  const d = new Date(iso);
  const day = new Intl.DateTimeFormat("en-US", { timeZone: SIM_TZ, year: "numeric", month: "2-digit", day: "2-digit" })
    .formatToParts(d)
    .reduce((acc, p) => ({ ...acc, [p.type]: p.value }), {} as Record<string, string>);
  const hm = new Intl.DateTimeFormat("en-US", { timeZone: SIM_TZ, hour: "2-digit", minute: "2-digit", hour12: false })
    .formatToParts(d)
    .reduce((acc, p) => ({ ...acc, [p.type]: p.value }), {} as Record<string, string>);
  return {
    day: `${day.year}-${day.month}-${day.day}`,
    minutes: Number(hm.hour) * 60 + Number(hm.minute),
  };
}

export interface ScenarioReport {
  name: string;
  result: RouteOffersResult;
  topOfferLocal?: { day: string; minutes: number };
}

export async function runRouteSimulator(): Promise<{ scenarios: ScenarioReport[]; ledger: string }> {
  const config = buildSimConfig();
  const geocoder = buildSimGeocoder();
  const scenarios: ScenarioReport[] = [];

  const run = async (name: string, address: string, seed: (c: FakeCalendar) => Promise<void>, geo: FixedGeocoder | FailingGeocoder = geocoder) => {
    const calendar = new FakeCalendar();
    await seed(calendar);
    const result = await offerRouteAwareSlots(
      { serviceId: "in-home-visit", customerAddress: address, day: SIM_DAY },
      config,
      calendar,
      geo,
      { now: SIM_NOW, syntheticAllowed: true }
    );
    scenarios.push({
      name,
      result,
      topOfferLocal: result.offers[0] ? localDayTime(result.offers[0].startTime) : undefined,
    });
  };

  await run("proof: near caller (next door to stop 2)", SIM_ADDRESSES.nearCaller, seedProofDay);
  await run("proof: far caller (Greenwood, ~12 mi out)", SIM_ADDRESSES.greenwoodCaller, seedProofDay);
  await run("out of area (Little Rock, ~75 mi)", SIM_ADDRESSES.farCaller, seedProofDay);
  await run("packed day: far caller pushed to next open day", SIM_ADDRESSES.greenwoodCaller, seedPackedDay);
  await run("geocoder failure: fallback, no drive claims", SIM_ADDRESSES.nearCaller, seedProofDay, new FailingGeocoder());

  return { scenarios, ledger: JSON.stringify({ simDay: SIM_DAY, tz: SIM_TZ, now: SIM_NOW.toISOString(), scenarios }, null, 2) };
}

if ((import.meta as unknown as { main: boolean }).main) {
  const { scenarios, ledger } = await runRouteSimulator();
  const config = buildSimConfig();
  console.log("===============================================================");
  console.log("  AA BOOK ROUTE-AWARE BOOKING SIMULATOR (synthetic addresses)");
  console.log(`  day=${SIM_DAY} tz=${SIM_TZ} now=${SIM_NOW.toISOString()}`);
  console.log("===============================================================");
  for (const s of scenarios) {
    console.log("");
    console.log(`--- ${s.name}`);
    console.log(`    routeAware=${s.result.routeAware} inServiceArea=${s.result.inServiceArea ?? "n/a"} screenedOut=${s.result.screenedOut ?? false} offers=${s.result.offers.length}`);
    for (const o of s.result.offers) {
      const lt = localDayTime(o.startTime);
      console.log(`    offer ${o.startTime} (local ${lt.day} ${String(Math.floor(lt.minutes / 60)).padStart(2, "0")}:${String(lt.minutes % 60).padStart(2, "0")}) tech=${o.techId} addedDriveMinutes=${o.addedDriveMinutes ?? "n/a"}`);
    }
    console.log(`    suggestedReply: "${s.result.suggestedReply}"`);
    if (s.result.offers[0]) console.log(`    plain words: "${formatPlainWordsOffer(s.result.offers[0], config)}"`);
  }
  console.log("");
  console.log("LEDGER_JSON:");
  console.log(ledger);
}
