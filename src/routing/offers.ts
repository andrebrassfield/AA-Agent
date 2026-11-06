import type { CalendarAdapter, CalendarEvent } from "../calendar/calendar.ts";
import type { ClientConfig, ServiceItem, StaffMember } from "../types/config.ts";
import {
  formatAddress,
  isSyntheticGeocoder,
  localDayMinuteToUtc,
  localDayOf,
  type Geocoder,
  type LatLng,
} from "./geo.ts";
import { checkServiceArea } from "./service-area.ts";
import {
  blockMinutesFor,
  candidateStarts,
  dayWindowsForHorizon,
  evaluateCandidate,
  type RouteStop,
  type SlotOffer,
} from "./ranking.ts";
import { FailingGeocoder, LocalHashGeocoder, NominatimGeocoder } from "./geo.ts";

/** Build the geocoder named by client config. "local" is synthetic; callers must gate on syntheticAllowed. */
export function createGeocoderFromConfig(config: ClientConfig): { geocoder: Geocoder; synthetic: boolean } {
  const r = config.policies.routing;
  const choice = r?.geocoder ?? "nominatim";
  if (choice === "local") {
    return { geocoder: new LocalHashGeocoder(), synthetic: true };
  }
  return { geocoder: new NominatimGeocoder(r?.nominatimBaseUrl), synthetic: false };
}

export interface OfferRouteSlotsInput {
  serviceId: string;
  customerAddress: string;
  /** Local day YYYY-MM-DD to start the search; defaults to today in the business timezone. */
  day?: string;
}

export interface OfferRouteSlotsOptions {
  now?: Date;
  syntheticAllowed?: boolean;
}

export interface RouteOffersResult {
  success: boolean;
  error?: string;
  serviceName?: string;
  screenedOut?: boolean;
  screenReason?: string;
  askFirst?: boolean;
  inServiceArea?: boolean;
  serviceAreaReason?: string;
  /** false => fallback mode: nearest open slots, no drive-time claims. */
  routeAware: boolean;
  offers: SlotOffer[];
  suggestedReply: string;
}

export function screenService(service: ServiceItem): "book" | "ask_first" | "decline" {
  return service.bookingRules?.triage ?? "book";
}

const ADDRESS_RE = /^Address:\s*(.+)$/im;
const TECH_RE = /^Tech:\s*(.+)$/im;

export function parseStopMeta(event: CalendarEvent): { address?: string; tech?: string } {
  const desc = event.description ?? "";
  const a = desc.match(ADDRESS_RE);
  const t = desc.match(TECH_RE);
  return {
    address: a ? a[1].trim() : undefined,
    tech: t ? t[1].trim() : undefined,
  };
}

/** Existing appointments for a local day, with addresses geocoded when possible. */
export async function dayStops(
  calendar: CalendarAdapter,
  day: string,
  tz: string,
  geocoder: Geocoder,
  cache: Map<string, LatLng | null>
): Promise<RouteStop[]> {
  const start = localDayMinuteToUtc(day, 0, tz);
  const next = new Date(start.getTime() + 24 * 3600 * 1000);
  const nextDay = localDayOf(next, tz);
  const end = localDayMinuteToUtc(nextDay, 0, tz);
  const events = await calendar.listEvents(start.toISOString(), end.toISOString());
  const stops: RouteStop[] = [];
  for (const ev of events) {
    const meta = parseStopMeta(ev);
    let latLng: LatLng | null = null;
    if (meta.address) {
      const key = meta.address.trim().toLowerCase();
      if (!cache.has(key)) cache.set(key, await geocoder.geocode(meta.address));
      latLng = cache.get(key) ?? null;
    }
    stops.push({ startTime: ev.startTime, endTime: ev.endTime, latLng, label: meta.address ?? ev.title });
  }
  return stops;
}

function stopsForTech(allStops: RouteStop[], events: CalendarEvent[], tech: StaffMember): RouteStop[] {
  const tagged = events.map((e) => parseStopMeta(e));
  const anyTagged = tagged.some((t) => t.tech);
  if (!anyTagged) return allStops;
  const match = (t?: string) => t && (t.toLowerCase() === tech.id.toLowerCase() || t.toLowerCase() === tech.name.toLowerCase());
  return allStops.filter((_, i) => match(tagged[i].tech));
}

/** Plain-words, exact-time offer: "We can be there at 10:45 AM on Friday, Nov 6." Never a window. */
export function formatPlainWordsOffer(offer: SlotOffer, config: ClientConfig): string {
  const tz = config.business.timezone;
  const d = new Date(offer.startTime);
  const time = new Intl.DateTimeFormat("en-US", { timeZone: tz, hour: "numeric", minute: "2-digit" }).format(d);
  const dayName = new Intl.DateTimeFormat("en-US", { timeZone: tz, weekday: "long", month: "short", day: "numeric" }).format(d);
  return `We can be there at ${time} on ${dayName}.`;
}

const TAKE_A_MESSAGE = "I'll take a message and someone will get back to you.";

async function fallbackOffers(
  config: ClientConfig,
  service: ServiceItem,
  calendar: CalendarAdapter,
  startDay: string,
  now: Date
): Promise<SlotOffer[]> {
  const tz = config.business.timezone;
  const routing = config.policies.routing;
  const horizon = routing?.horizonDays ?? 7;
  const step = routing?.slotStepMinutes ?? 15;
  const maxOffers = routing?.maxOffers ?? 3;
  const block = blockMinutesFor(service);
  const leadMs = (service.bookingRules?.leadTimeHours ?? 0) * 3600_000;
  const earliest = now.getTime() + leadMs;
  const techId = service.bookingRules?.assignedStaffIds?.[0] ?? config.staff.staff[0]?.id ?? "shop";
  const offers: SlotOffer[] = [];
  for (const win of dayWindowsForHorizon(config, undefined, startDay, horizon, tz)) {
    for (const start of candidateStarts(win, block, step, tz)) {
      if (start.getTime() < earliest) continue;
      const end = new Date(start.getTime() + block * 60_000);
      if (await calendar.checkAvailability(start.toISOString(), end.toISOString())) {
        offers.push({ startTime: start.toISOString(), endTime: end.toISOString(), techId });
        if (offers.length >= maxOffers) return offers.sort((a, b) => a.startTime.localeCompare(b.startTime));
      }
    }
  }
  return offers.sort((a, b) => a.startTime.localeCompare(b.startTime)).slice(0, maxOffers);
}

/**
 * Route-aware slot offers for an in-home booking.
 *
 * Order of operations (screening first, per spec): job-type triage -> service
 * area -> geocode -> per-tech day ranking. Route fit never overrides a decline.
 * If addresses are missing or geocoding fails, falls back to today's behavior:
 * nearest open slots, no route claim. Never invents a drive time.
 */
export async function offerRouteAwareSlots(
  input: OfferRouteSlotsInput,
  config: ClientConfig,
  calendar: CalendarAdapter,
  geocoder: Geocoder,
  opts: OfferRouteSlotsOptions = {}
): Promise<RouteOffersResult> {
  const now = opts.now ?? new Date();
  const tz = config.business.timezone;
  const routing = config.policies.routing;

  const service = config.services.services.find((s) => s.id === input.serviceId);
  if (!service) {
    return { success: false, routeAware: false, offers: [], suggestedReply: "", error: `Service "${input.serviceId}" not found.` };
  }

  // 1. Screening BEFORE any slot ranking.
  const triage = screenService(service);
  if (triage === "decline") {
    return {
      success: true,
      serviceName: service.name,
      screenedOut: true,
      screenReason: `Service "${service.name}" is triaged as decline; no slots offered.`,
      routeAware: false,
      offers: [],
      suggestedReply: `I'm not able to book that here. ${TAKE_A_MESSAGE}`,
    };
  }

  const startDay = input.day ?? localDayOf(now, tz);
  const horizon = routing?.horizonDays ?? 7;
  const step = routing?.slotStepMinutes ?? 15;
  const maxOffers = routing?.maxOffers ?? 3;
  const avgSpeed = routing?.avgSpeedMph ?? 25;
  const buffer = routing?.driveTimeBufferMinutes ?? 10;
  const block = blockMinutesFor(service);
  const leadMs = (service.bookingRules?.leadTimeHours ?? 0) * 3600_000;
  const earliest = now.getTime() + leadMs;

  const routingEnabled = routing?.enabled !== false;
  const inHome = service.inHome !== false;
  const routeCapable =
    routingEnabled &&
    inHome &&
    Boolean(input.customerAddress?.trim()) &&
    (!isSyntheticGeocoder(geocoder) || Boolean(opts.syntheticAllowed));

  if (!routeCapable) {
    const offers = await fallbackOffers(config, service, calendar, startDay, now);
    return {
      success: true,
      serviceName: service.name,
      askFirst: triage === "ask_first" || undefined,
      routeAware: false,
      offers,
      suggestedReply: offers.length
        ? `Next open time. ${formatPlainWordsOffer(offers[0], config)}`
        : `I don't have anything open in the next ${horizon} days. ${TAKE_A_MESSAGE}`,
    };
  }

  // 2. Service area: outside => no slot offered, take a message instead.
  const area = await checkServiceArea(input.customerAddress, config.business, config.policies, geocoder);
  if (!area.inArea) {
    return {
      success: true,
      serviceName: service.name,
      askFirst: triage === "ask_first" || undefined,
      inServiceArea: false,
      serviceAreaReason: area.reason,
      routeAware: true,
      offers: [],
      suggestedReply: `That address is outside our service area (${area.reason}), so I can't offer a time. ${TAKE_A_MESSAGE}`,
    };
  }

  // 3. Geocode caller + home bases. Any failure => fallback, no route claim.
  const cache = new Map<string, LatLng | null>();
  const customerKey = input.customerAddress.trim().toLowerCase();
  cache.set(customerKey, await geocoder.geocode(input.customerAddress));
  const customer = cache.get(customerKey) ?? null;
  if (!customer) {
    const offers = await fallbackOffers(config, service, calendar, startDay, now);
    return {
      success: true,
      serviceName: service.name,
      askFirst: triage === "ask_first" || undefined,
      inServiceArea: true,
      serviceAreaReason: area.reason,
      routeAware: false,
      offers,
      suggestedReply: offers.length
        ? `Next open time. ${formatPlainWordsOffer(offers[0], config)}`
        : `I don't have anything open in the next ${horizon} days. ${TAKE_A_MESSAGE}`,
    };
  }

  // 4. Rank per tech.
  const assigned = service.bookingRules?.assignedStaffIds;
  const techs = config.staff.staff.filter((m) => !assigned || assigned.includes(m.id));
  const techList = techs.length > 0 ? techs : config.staff.staff;

  const allOffers: SlotOffer[] = [];
  for (const tech of techList) {
    const homeAddr = tech.homeBase ? formatAddress(tech.homeBase) : formatAddress(config.business.address);
    const homeKey = homeAddr.trim().toLowerCase();
    if (!cache.has(homeKey)) cache.set(homeKey, await geocoder.geocode(homeAddr));
    const home = cache.get(homeKey) ?? null;
    if (!home) continue; // no home base => cannot rank this tech; others may still work

    for (const win of dayWindowsForHorizon(config, tech, startDay, horizon, tz)) {
      const dayRangeStart = localDayMinuteToUtc(win.day, 0, tz);
      const nextDay = localDayOf(new Date(dayRangeStart.getTime() + 24 * 3600 * 1000), tz);
      const events = await calendar.listEvents(
        dayRangeStart.toISOString(),
        localDayMinuteToUtc(nextDay, 0, tz).toISOString()
      );
      const allStops = await dayStops(calendar, win.day, tz, geocoder, cache);
      const stops = stopsForTech(allStops, events, tech);
      for (const start of candidateStarts(win, block, step, tz)) {
        if (start.getTime() < earliest) continue;
        const end = new Date(start.getTime() + block * 60_000);
        if (!(await calendar.checkAvailability(start.toISOString(), end.toISOString()))) continue;
        const ev = evaluateCandidate(start, block, stops, home, customer, avgSpeed, buffer);
        if (!ev.feasible) continue;
        allOffers.push({
          startTime: start.toISOString(),
          endTime: end.toISOString(),
          techId: tech.id,
          addedDriveMinutes: ev.addedDriveMinutes,
        });
      }
    }
  }

  allOffers.sort((a, b) => (a.addedDriveMinutes ?? 0) - (b.addedDriveMinutes ?? 0) || a.startTime.localeCompare(b.startTime));
  const offers = allOffers.slice(0, maxOffers);

  return {
    success: true,
    serviceName: service.name,
    askFirst: triage === "ask_first" || undefined,
    inServiceArea: true,
    serviceAreaReason: area.reason,
    routeAware: true,
    offers,
    suggestedReply: offers.length
      ? formatPlainWordsOffer(offers[0], config)
      : `I don't have a route-fit time in the next ${horizon} days. ${TAKE_A_MESSAGE}`,
  };
}

/**
 * Added drive minutes for booking at a specific requested time (used when a
 * booking is created with a customer address). Returns null when no honest
 * estimate is possible (geocoding failed, synthetic geocoder not allowed).
 */
export async function computeAddedDriveForBooking(
  service: ServiceItem,
  requestedStartTime: string,
  customerAddress: string,
  config: ClientConfig,
  calendar: CalendarAdapter,
  geocoder: Geocoder,
  opts: OfferRouteSlotsOptions = {}
): Promise<{ staffId: string; driveTimeMinutesAdded: number } | null> {
  const routing = config.policies.routing;
  if (routing?.enabled === false) return null;
  if (isSyntheticGeocoder(geocoder) && !opts.syntheticAllowed) return null;
  const tz = config.business.timezone;
  const avgSpeed = routing?.avgSpeedMph ?? 25;
  const buffer = routing?.driveTimeBufferMinutes ?? 10;
  const block = blockMinutesFor(service);
  const start = new Date(requestedStartTime);
  if (isNaN(start.getTime())) return null;
  const day = localDayOf(start, tz);

  const assigned = service.bookingRules?.assignedStaffIds;
  const techs = config.staff.staff.filter((m) => !assigned || assigned.includes(m.id));
  const tech = (techs[0] ?? config.staff.staff[0]) as StaffMember | undefined;
  if (!tech) return null;

  const cache = new Map<string, LatLng | null>();
  const customer = await geocoder.geocode(customerAddress);
  if (!customer) return null;
  const homeAddr = tech.homeBase ? formatAddress(tech.homeBase) : formatAddress(config.business.address);
  const home = await geocoder.geocode(homeAddr);
  if (!home) return null;

  const stops = await dayStops(calendar, day, tz, geocoder, cache);
  const ev = evaluateCandidate(start, block, stops, home, customer, avgSpeed, buffer);
  return { staffId: tech.id, driveTimeMinutesAdded: ev.addedDriveMinutes };
}

export const NO_GEOCODER = new FailingGeocoder();
