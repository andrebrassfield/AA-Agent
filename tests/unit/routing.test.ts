import { describe, expect, it } from "bun:test";
import { FakeCalendar } from "../../src/calendar/calendar.ts";
import { DataStore } from "../../src/db/store.ts";
import { CoreEngine } from "../../src/engine/core.ts";
import { ProviderRouter } from "../../src/router/router.ts";
import { StubModelProvider } from "../../src/router/stub.ts";
import { RetellVoiceAdapter } from "../../src/channels/voice/retell.ts";
import {
  extractZip,
  haversineMiles,
  LocalHashGeocoder,
  NominatimGeocoder,
  FixedGeocoder,
  FailingGeocoder,
  pointInPolygon,
} from "../../src/routing/geo.ts";
import { checkServiceArea } from "../../src/routing/service-area.ts";
import {
  candidateStarts,
  dayWindowsForHorizon,
  evaluateCandidate,
  insertionDetourMiles,
  type RouteStop,
} from "../../src/routing/ranking.ts";
import {
  computeAddedDriveForBooking,
  formatPlainWordsOffer,
  offerRouteAwareSlots,
  screenService,
} from "../../src/routing/offers.ts";
import { handleBookingWorkflow } from "../../src/workflows/booking.ts";
import { validatePoliciesConfig, validateServicesConfig } from "../../src/config/validator.ts";
import type { ClientConfig } from "../../src/types/config.ts";
import {
  buildSimConfig,
  buildSimGeocoder,
  localDayTime,
  SIM_ADDRESSES,
  SIM_DAY,
  SIM_NOW,
  SIM_TZ,
  seedProofDay,
} from "../../scripts/route-simulator.ts";

const HOME = { lat: 35.3859, lng: -94.3985 };
const NEAR_S2 = { lat: 35.3802, lng: -94.3902 };
const GREENWOOD = { lat: 35.2146, lng: -94.2516 };

describe("geo primitives", () => {
  it("haversine Fort Smith to Greenwood is about 11-16 miles", () => {
    const d = haversineMiles(HOME, GREENWOOD);
    expect(d).toBeGreaterThan(10);
    expect(d).toBeLessThan(16);
  });

  it("extractZip pulls 5-digit zips", () => {
    expect(extractZip("88 Elm St, Fort Smith, AR 72903")).toBe("72903");
    expect(extractZip("no zip here")).toBeNull();
  });

  it("pointInPolygon handles a square", () => {
    const square = [
      { lat: 35.0, lng: -95.0 },
      { lat: 35.0, lng: -94.0 },
      { lat: 36.0, lng: -94.0 },
      { lat: 36.0, lng: -95.0 },
    ];
    expect(pointInPolygon({ lat: 35.5, lng: -94.5 }, square)).toBe(true);
    expect(pointInPolygon({ lat: 34.5, lng: -94.5 }, square)).toBe(false);
  });

  it("LocalHashGeocoder is deterministic and synthetic", async () => {
    const g = new LocalHashGeocoder();
    const a = await g.geocode("100 Shop St, Fort Smith, AR 72901");
    const b = await g.geocode("100 Shop St, Fort Smith, AR 72901");
    expect(a).toEqual(b);
    expect(a!.lat).toBeGreaterThanOrEqual(34.7);
    expect(a!.lat).toBeLessThan(35.9);
    expect(g.name).toBe("local-hash");
  });

  it("NominatimGeocoder parses results and fails closed", async () => {
    const fakeFetch = (fn: () => Promise<Response>): typeof fetch => fn as unknown as typeof fetch;
    const ok = new NominatimGeocoder("https://example.test", fakeFetch(async () => new Response(JSON.stringify([{ lat: "35.38", lon: "-94.39" }]), { status: 200 })));
    expect(await ok.geocode("x")).toEqual({ lat: 35.38, lng: -94.39 });
    const notFound = new NominatimGeocoder("https://example.test", fakeFetch(async () => new Response("[]", { status: 200 })));
    expect(await notFound.geocode("x")).toBeNull();
    const httpErr = new NominatimGeocoder("https://example.test", fakeFetch(async () => new Response("nope", { status: 500 })));
    expect(await httpErr.geocode("x")).toBeNull();
    const throws = new NominatimGeocoder("https://example.test", fakeFetch(async () => {
      throw new Error("network down");
    }));
    expect(await throws.geocode("x")).toBeNull();
  });
});

describe("service area", () => {
  const config = buildSimConfig();
  const geo = buildSimGeocoder();

  it("admits by zip, by radius, and rejects far addresses", async () => {
    const byZip = await checkServiceArea(SIM_ADDRESSES.stop2, config.business, config.policies, geo);
    expect(byZip.inArea).toBe(true);
    const byRadius = await checkServiceArea(SIM_ADDRESSES.greenwoodCaller, config.business, config.policies, geo);
    expect(byRadius.inArea).toBe(true); // zip not listed, but within 35 mi radius
    expect(byRadius.distanceMiles).toBeLessThan(35);
    const far = await checkServiceArea(SIM_ADDRESSES.farCaller, config.business, config.policies, geo);
    expect(far.inArea).toBe(false);
    expect(far.reason).toContain("beyond 35 mi radius");
  });

  it("rejects when the address cannot be geocoded and zip does not match", async () => {
    const res = await checkServiceArea("999 Nowhere Ln, Nowhere, AR 99999", config.business, config.policies, new FailingGeocoder());
    expect(res.inArea).toBe(false);
    expect(res.reason).toContain("could not be geocoded");
  });
});

describe("ranking math", () => {
  it("insertion detour is ~0 for a collinear near stop and large for a far stop", () => {
    const a = { lat: 35.39, lng: -94.405 };
    const b = { lat: 35.38, lng: -94.39 };
    expect(insertionDetourMiles(a, NEAR_S2, b)).toBeLessThan(0.2);
    expect(insertionDetourMiles(a, GREENWOOD, b)).toBeGreaterThan(20);
    // home anchors both sides: detour = 2 * d(home, new)
    expect(insertionDetourMiles(HOME, GREENWOOD, HOME)).toBeCloseTo(2 * haversineMiles(HOME, GREENWOOD), 5);
  });

  it("evaluateCandidate enforces drive+buffer gap between adjacent stops", () => {
    const stops: RouteStop[] = [
      { startTime: "2026-11-06T15:00:00.000Z", endTime: "2026-11-06T16:00:00.000Z", latLng: { lat: 35.39, lng: -94.405 } },
      { startTime: "2026-11-06T17:30:00.000Z", endTime: "2026-11-06T18:30:00.000Z", latLng: { lat: 35.38, lng: -94.39 } },
    ];
    // candidate 16:15-17:15 (60 min block): gapBefore = 15 min; near stop drive ~2.6 min + 5 buffer -> feasible
    const near = evaluateCandidate(new Date("2026-11-06T16:15:00.000Z"), 60, stops, HOME, NEAR_S2, 25, 5);
    expect(near.feasible).toBe(true);
    expect(near.addedDriveMinutes).toBeLessThanOrEqual(2);
    // greenwood: drive ~36 min each way; gapBefore 15 < 36+5 -> infeasible at the same slot
    const far = evaluateCandidate(new Date("2026-11-06T16:15:00.000Z"), 60, stops, HOME, GREENWOOD, 25, 5);
    expect(far.feasible).toBe(false);
  });

  it("day windows respect closed days and staff schedule intersection", () => {
    const config = buildSimConfig();
    const wins = dayWindowsForHorizon(config, config.staff.staff[0], SIM_DAY, 2, SIM_TZ);
    expect(wins.map((w) => w.day)).toEqual(["2026-11-06", "2026-11-07"]);
    expect(wins[0].openMin).toBe(8 * 60);
    expect(wins[1].closeMin).toBe(13 * 60); // saturday close
    const starts = candidateStarts(wins[0], 60, 15, SIM_TZ);
    expect(starts.length).toBe((17 * 60 - 8 * 60 - 60) / 15 + 1);
  });
});

describe("offerRouteAwareSlots (spec behaviors)", () => {
  it("proof bar: near caller lands in the tight gap, far caller at day edge/next day", async () => {
    const config = buildSimConfig();
    const geo = buildSimGeocoder();

    const calendarNear = new FakeCalendar();
    await seedProofDay(calendarNear);
    const near = await offerRouteAwareSlots(
      { serviceId: "in-home-visit", customerAddress: SIM_ADDRESSES.nearCaller, day: SIM_DAY },
      config, calendarNear, geo, { now: SIM_NOW, syntheticAllowed: true }
    );
    expect(near.routeAware).toBe(true);
    expect(near.offers.length).toBeGreaterThan(0);
    const nearTop = localDayTime(near.offers[0].startTime);
    expect(nearTop.day).toBe(SIM_DAY);
    expect(nearTop.minutes).toBeGreaterThanOrEqual(10 * 60); // tight gap 10:00-11:30
    expect(nearTop.minutes).toBeLessThan(11 * 60 + 30);
    expect(near.offers[0].addedDriveMinutes).toBeLessThanOrEqual(5);
    expect(near.suggestedReply).toBe(formatPlainWordsOffer(near.offers[0], config));
    expect(near.suggestedReply).toContain("We can be there at");

    const calendarFar = new FakeCalendar();
    await seedProofDay(calendarFar);
    const far = await offerRouteAwareSlots(
      { serviceId: "in-home-visit", customerAddress: SIM_ADDRESSES.greenwoodCaller, day: SIM_DAY },
      config, calendarFar, geo, { now: SIM_NOW, syntheticAllowed: true }
    );
    expect(far.routeAware).toBe(true);
    expect(far.offers.length).toBeGreaterThan(0);
    const farTop = localDayTime(far.offers[0].startTime);
    const atDayEdge = farTop.day === SIM_DAY && farTop.minutes >= 15 * 60;
    const nextDay = farTop.day === "2026-11-07";
    expect(atDayEdge || nextDay).toBe(true);
    expect(far.offers[0].addedDriveMinutes!).toBeGreaterThan(25);
    expect(near.offers[0].addedDriveMinutes!).toBeLessThan(far.offers[0].addedDriveMinutes!);
  });

  it("out of service area: no slots offered, take-a-message reply", async () => {
    const config = buildSimConfig();
    const calendar = new FakeCalendar();
    await seedProofDay(calendar);
    const res = await offerRouteAwareSlots(
      { serviceId: "in-home-visit", customerAddress: SIM_ADDRESSES.farCaller, day: SIM_DAY },
      config, calendar, buildSimGeocoder(), { now: SIM_NOW, syntheticAllowed: true }
    );
    expect(res.inServiceArea).toBe(false);
    expect(res.offers).toEqual([]);
    expect(res.suggestedReply).toContain("outside our service area");
    expect(res.suggestedReply).toContain("take a message");
  });

  it("geocoding failure: fallback to nearest open slots with no drive-time claims", async () => {
    const config = buildSimConfig();
    const calendar = new FakeCalendar();
    await seedProofDay(calendar);
    const res = await offerRouteAwareSlots(
      { serviceId: "in-home-visit", customerAddress: SIM_ADDRESSES.nearCaller, day: SIM_DAY },
      config, calendar, new FailingGeocoder(), { now: SIM_NOW, syntheticAllowed: true }
    );
    expect(res.routeAware).toBe(false);
    expect(res.offers.length).toBeGreaterThan(0);
    for (const o of res.offers) expect(o.addedDriveMinutes).toBeUndefined();
    expect(res.suggestedReply).toContain("Next open time");
  });

  it("synthetic geocoder without syntheticAllowed: no route claims", async () => {
    const config = buildSimConfig();
    const calendar = new FakeCalendar();
    await seedProofDay(calendar);
    const res = await offerRouteAwareSlots(
      { serviceId: "in-home-visit", customerAddress: SIM_ADDRESSES.nearCaller, day: SIM_DAY },
      config, calendar, buildSimGeocoder(), { now: SIM_NOW, syntheticAllowed: false }
    );
    expect(res.routeAware).toBe(false);
    for (const o of res.offers) expect(o.addedDriveMinutes).toBeUndefined();
  });

  it("triage decline: screened out before ranking, no offers even in-area", async () => {
    const config = buildSimConfig();
    config.services.services[0].bookingRules!.triage = "decline";
    const calendar = new FakeCalendar();
    await seedProofDay(calendar);
    const res = await offerRouteAwareSlots(
      { serviceId: "in-home-visit", customerAddress: SIM_ADDRESSES.nearCaller, day: SIM_DAY },
      config, calendar, buildSimGeocoder(), { now: SIM_NOW, syntheticAllowed: true }
    );
    expect(res.screenedOut).toBe(true);
    expect(res.offers).toEqual([]);
  });

  it("triage ask_first: offers flagged askFirst", async () => {
    const config = buildSimConfig();
    config.services.services[0].bookingRules!.triage = "ask_first";
    const calendar = new FakeCalendar();
    await seedProofDay(calendar);
    const res = await offerRouteAwareSlots(
      { serviceId: "in-home-visit", customerAddress: SIM_ADDRESSES.nearCaller, day: SIM_DAY },
      config, calendar, buildSimGeocoder(), { now: SIM_NOW, syntheticAllowed: true }
    );
    expect(res.askFirst).toBe(true);
    expect(res.offers.length).toBeGreaterThan(0);
  });

  it("unknown service errors", async () => {
    const res = await offerRouteAwareSlots(
      { serviceId: "nope", customerAddress: SIM_ADDRESSES.nearCaller, day: SIM_DAY },
      buildSimConfig(), new FakeCalendar(), buildSimGeocoder(), { now: SIM_NOW, syntheticAllowed: true }
    );
    expect(res.success).toBe(false);
    expect(res.error).toContain("not found");
  });
});

describe("booking workflow route annotation", () => {
  it("create with address stores address + drive estimate and tags the calendar event", async () => {
    const config = buildSimConfig();
    const calendar = new FakeCalendar();
    await seedProofDay(calendar);
    const store = new DataStore(":memory:");
    const startLocal = localDayTime(new Date().toISOString()); // unused; compute below
    void startLocal;
    const requested = "2026-11-06T14:00:00.000Z"; // 08:00 local; passes the existing UTC-hours gate, free on the seeded day
    const res = await handleBookingWorkflow(
      {
        action: "create",
        customerName: "Near Caller",
        customerPhone: "+14755550001",
        serviceId: "in-home-visit",
        requestedStartTime: requested,
        customerAddress: SIM_ADDRESSES.nearCaller,
      },
      config, calendar, store,
      { geocoder: buildSimGeocoder(), syntheticAllowed: true }
    );
    expect(res.success).toBe(true);
    expect(res.booking!.customerAddress).toBe(SIM_ADDRESSES.nearCaller);
    expect(res.booking!.staffId).toBe("tech-1");
    expect(res.booking!.driveTimeMinutesAdded).toBeGreaterThanOrEqual(1);
    expect(res.booking!.driveTimeMinutesAdded).toBeLessThanOrEqual(10);
    const events = await calendar.listEvents("2026-11-06T00:00:00.000Z", "2026-11-08T00:00:00.000Z");
    const ev = events.find((e) => e.title.includes("Near Caller"))!;
    expect(ev.description).toContain(`Address: ${SIM_ADDRESSES.nearCaller}`);
    expect(ev.description).toContain("Tech: tech-1");
    const row = store.getBooking(res.booking!.id)!;
    expect(row.customerAddress).toBe(SIM_ADDRESSES.nearCaller);
    expect(row.driveTimeMinutesAdded).toBe(res.booking!.driveTimeMinutesAdded);
    store.close();
  });

  it("create with un-geocodable address succeeds but stores no drive claim", async () => {
    const config = buildSimConfig();
    const calendar = new FakeCalendar();
    const store = new DataStore(":memory:");
    const res = await handleBookingWorkflow(
      {
        action: "create",
        customerName: "Mystery",
        customerPhone: "+14755550002",
        serviceId: "in-home-visit",
        requestedStartTime: "2026-11-06T14:00:00.000Z", // 08:00 local, open
        customerAddress: "999 Nowhere Ln, Nowhere, AR 99999",
      },
      config, calendar, store,
      { geocoder: new FailingGeocoder() }
    );
    expect(res.success).toBe(true);
    expect(res.booking!.customerAddress).toBe("999 Nowhere Ln, Nowhere, AR 99999");
    expect(res.booking!.driveTimeMinutesAdded).toBeNull();
    store.close();
  });

  it("triage decline blocks the booking write itself", async () => {
    const config = buildSimConfig();
    config.services.services[0].bookingRules!.triage = "decline";
    const store = new DataStore(":memory:");
    const res = await handleBookingWorkflow(
      {
        action: "create",
        customerName: "Declined",
        customerPhone: "+14755550003",
        serviceId: "in-home-visit",
        requestedStartTime: "2026-11-06T14:00:00.000Z",
        customerAddress: SIM_ADDRESSES.nearCaller,
      },
      config, new FakeCalendar(), store,
      { geocoder: buildSimGeocoder(), syntheticAllowed: true }
    );
    expect(res.success).toBe(false);
    expect(res.error).toContain("decline");
    store.close();
  });

  it("computeAddedDriveForBooking returns null for synthetic geocoder without allowance", async () => {
    const config = buildSimConfig();
    const calendar = new FakeCalendar();
    await seedProofDay(calendar);
    const res = await computeAddedDriveForBooking(
      config.services.services[0],
      "2026-11-06T16:15:00.000Z",
      SIM_ADDRESSES.nearCaller,
      config, calendar, buildSimGeocoder(),
      { syntheticAllowed: false }
    );
    expect(res).toBeNull();
  });
});

describe("screening + engine + retell wiring", () => {
  it("screenService defaults to book", () => {
    expect(screenService({ id: "x", name: "x", durationMinutes: 30, price: 0, bufferMinutes: 0 })).toBe("book");
  });

  it("core engine accepts offerRouteSlots tool calls", async () => {
    const router = new ProviderRouter(
      { dailySpendCapUsd: 1, routes: { conversation: { chain: [{ provider: "stub", model: "m" }] }, reasoning: { chain: [{ provider: "stub", model: "m" }] }, aux: { chain: [{ provider: "stub", model: "m" }] } } },
      new DataStore(":memory:")
    );
    router.registerProvider(
      new StubModelProvider("stub", () => `Here are times.\n<tool_call>{"name": "offerRouteSlots", "args": {"serviceId": "in-home-visit", "customerAddress": "90 Elm St, Fort Smith, AR 72903"}}</tool_call>`)
    );
    const engine = new CoreEngine(router);
    const turn = await engine.processTurn({
      userMessage: "I need a visit at 90 Elm St, Fort Smith, AR 72903",
      context: { clientConfig: buildSimConfig(), channel: "sms", senderPhone: "+14755550001" },
      conversationHistory: [],
    });
    expect(turn.actionTaken?.type).toBe("TOOL_CALL");
    expect((turn.actionTaken?.details as any).name).toBe("offerRouteSlots");
  });

  it("retell adapter parses offer_route_slots and book_appointment with address", () => {
    const adapter = new RetellVoiceAdapter();
    const parsed = adapter.parseToolCall({
      name: "offer_route_slots",
      call: { call_id: "c1", from_number: "+14755550001" },
      args: { service_id: "in-home-visit", customer_address: SIM_ADDRESSES.nearCaller, day: SIM_DAY },
    });
    expect(parsed.tool).toBe("offer_route_slots");
    if (parsed.tool === "offer_route_slots") {
      expect(parsed.customerAddress).toBe(SIM_ADDRESSES.nearCaller);
      expect(parsed.serviceId).toBe("in-home-visit");
      expect(parsed.day).toBe(SIM_DAY);
    }
    const booked = adapter.parseToolCall({
      name: "book_appointment",
      args: { customer_name: "N", service_id: "in-home-visit", requested_start_time: "2026-11-06T16:15:00.000Z", customer_address: SIM_ADDRESSES.nearCaller },
    });
    expect(booked.tool).toBe("book_appointment");
    if (booked.tool === "book_appointment") expect(booked.customerAddress).toBe(SIM_ADDRESSES.nearCaller);
    const formatted = adapter.formatToolResult({
      success: true,
      tool: "offer_route_slots",
      message: "We can be there at 10:15 AM on Friday, Nov 6.",
      offers: [{ startTime: "2026-11-06T16:15:00.000Z", endTime: "2026-11-06T17:15:00.000Z", techId: "tech-1", addedDriveMinutes: 1 }],
      inServiceArea: true,
      routeAware: true,
      suggestedReply: "We can be there at 10:15 AM on Friday, Nov 6.",
    });
    expect(formatted.body.offers).toHaveLength(1);
    expect(formatted.body.route_aware).toBe(true);
    expect(formatted.body.suggested_reply).toContain("10:15 AM");
  });
});

describe("validator extensions", () => {
  const basePolicies = {
    cancellation: { noticePeriodHours: 24, fee: 0, policyText: "x" },
    deposit: { required: false, type: "fixed", amount: 0 },
    serviceArea: { primaryZipCodes: ["72901"] },
  };

  it("accepts routing block and radius/polygon, rejects bad values", () => {
    const ok = validatePoliciesConfig({ ...basePolicies, routing: { enabled: true, geocoder: "nominatim", avgSpeedMph: 25, driveTimeBufferMinutes: 10, slotStepMinutes: 15, maxOffers: 3, horizonDays: 7 }, serviceArea: { primaryZipCodes: ["72901"], radiusMiles: 40, polygon: [{ lat: 35, lng: -95 }, { lat: 35, lng: -94 }, { lat: 36, lng: -94 }] } });
    expect(ok.valid).toBe(true);
    const badGeo = validatePoliciesConfig({ ...basePolicies, routing: { geocoder: "google" } });
    expect(badGeo.valid).toBe(false);
    const badPoly = validatePoliciesConfig({ ...basePolicies, serviceArea: { primaryZipCodes: ["72901"], polygon: [{ lat: 35, lng: -95 }] } });
    expect(badPoly.valid).toBe(false);
    const badRadius = validatePoliciesConfig({ ...basePolicies, serviceArea: { primaryZipCodes: ["72901"], radiusMiles: -3 } });
    expect(badRadius.valid).toBe(false);
  });

  it("validates triage and inHome on services", () => {
    const ok = validateServicesConfig({ services: [{ id: "s", name: "s", durationMinutes: 30, price: 0, bufferMinutes: 5, inHome: true, bookingRules: { triage: "ask_first" } }] });
    expect(ok.valid).toBe(true);
    const bad = validateServicesConfig({ services: [{ id: "s", name: "s", durationMinutes: 30, price: 0, bufferMinutes: 5, bookingRules: { triage: "maybe" } }] });
    expect(bad.valid).toBe(false);
    expect(bad.errors[0].field).toContain("triage");
  });
});
