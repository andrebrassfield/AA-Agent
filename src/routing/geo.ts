/**
 * Geo primitives for route-aware booking (v1).
 *
 * v1 drive-time source: haversine miles on geocoded addresses at a configured
 * average speed. No paid routing API is called in v1. Geocoders are injected;
 * "local-hash" is synthetic and may only be used when the client config sets
 * routing.allowSyntheticGeocoder (tests, demo, simulator). Production default
 * is Nominatim (free OSM HTTP, no account, no key). Never invent a drive time:
 * if geocoding fails, callers fall back to plain slot offers with no route claim.
 */

export interface LatLng {
  lat: number;
  lng: number;
}

export interface AddressLike {
  street: string;
  city: string;
  state: string;
  zip: string;
}

export interface Geocoder {
  readonly name: string;
  geocode(address: string): Promise<LatLng | null>;
}

export function formatAddress(a: AddressLike): string {
  return `${a.street}, ${a.city}, ${a.state} ${a.zip}`;
}

const toRad = (deg: number) => (deg * Math.PI) / 180;
const EARTH_RADIUS_MILES = 3958.7613;

export function haversineMiles(a: LatLng, b: LatLng): number {
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_MILES * Math.asin(Math.sqrt(h));
}

export function driveMinutes(miles: number, avgSpeedMph: number): number {
  if (avgSpeedMph <= 0) return 0;
  return (miles / avgSpeedMph) * 60;
}

export function extractZip(address: string): string | null {
  const m = address.match(/\b(\d{5})(?:-\d{4})?\b/);
  return m ? m[1] : null;
}

/** Ray-casting point-in-polygon. Polygon is a list of lat/lng vertices. */
export function pointInPolygon(p: LatLng, polygon: LatLng[]): boolean {
  if (polygon.length < 3) return false;
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const xi = polygon[i].lng;
    const yi = polygon[i].lat;
    const xj = polygon[j].lng;
    const yj = polygon[j].lat;
    const intersects =
      yi > p.lat !== yj > p.lat &&
      p.lng < ((xj - xi) * (p.lat - yi)) / (yj - yi) + xi;
    if (intersects) inside = !inside;
  }
  return inside;
}

/**
 * Deterministic hash geocoder. SYNTHETIC coordinates inside an Arkansas bbox.
 * Only for tests/demo/simulator, and only when allowSyntheticGeocoder is set.
 */
export class LocalHashGeocoder implements Geocoder {
  readonly name = "local-hash";
  async geocode(address: string): Promise<LatLng | null> {
    const q = address.trim();
    if (!q) return null;
    let h = 2166136261;
    for (let i = 0; i < q.length; i++) {
      h ^= q.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    const lat = 34.7 + ((h >>> 8) % 1200) / 1000; // 34.7 - 35.9, Arkansas bbox
    const lng = -94.6 + ((h & 0xffff) % 1200) / 1000; // -94.6 - -93.4
    return { lat, lng };
  }
}

/**
 * Free OpenStreetMap Nominatim geocoder. No account, no API key. Low-volume
 * use only per OSM usage policy; sends a descriptive User-Agent.
 */
export class NominatimGeocoder implements Geocoder {
  readonly name = "nominatim";
  constructor(
    private baseUrl: string = "https://nominatim.openstreetmap.org",
    private fetchImpl: typeof fetch = globalThis.fetch
  ) {}

  async geocode(address: string): Promise<LatLng | null> {
    const q = address.trim();
    if (!q) return null;
    try {
      const url = `${this.baseUrl}/search?format=json&limit=1&q=${encodeURIComponent(q)}`;
      const res = await this.fetchImpl(url, {
        headers: {
          "User-Agent": "aabook-cli/0.1 (front-desk booking agent, low volume)",
          Accept: "application/json",
        },
      });
      if (!res.ok) return null;
      const data = (await res.json()) as Array<{ lat?: string; lon?: string }>;
      if (!Array.isArray(data) || data.length === 0) return null;
      const lat = Number(data[0]?.lat);
      const lng = Number(data[0]?.lon);
      if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
      return { lat, lng };
    } catch {
      return null;
    }
  }
}

/** Fixed address -> coordinates table. For tests and the simulator. Synthetic addresses only. */
export class FixedGeocoder implements Geocoder {
  readonly name = "fixed";
  constructor(private table: Record<string, LatLng>) {}
  async geocode(address: string): Promise<LatLng | null> {
    return this.table[address.trim().toLowerCase()] ?? null;
  }
}

/** A geocoder that always fails. Used to exercise the fallback path. */
export class FailingGeocoder implements Geocoder {
  readonly name = "failing";
  async geocode(): Promise<LatLng | null> {
    return null;
  }
}

export function isSyntheticGeocoder(geocoder: Geocoder): boolean {
  return geocoder.name === "local-hash" || geocoder.name === "fixed";
}

// --- Timezone helpers (local day/minutes in a business timezone -> UTC) ---

const WEEKDAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];

export function tzOffsetMinutes(tz: string, date: Date): number {
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  const parts = Object.fromEntries(dtf.formatToParts(date).map((p) => [p.type, p.value]));
  const asUtc = Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day),
    Number(parts.hour) % 24,
    Number(parts.minute),
    Number(parts.second)
  );
  return (asUtc - date.getTime()) / 60000;
}

/** Local day "YYYY-MM-DD" + minutes-after-midnight in tz -> Date (UTC instant). */
export function localDayMinuteToUtc(day: string, minutesLocal: number, tz: string): Date {
  const [y, m, d] = day.split("-").map(Number);
  const approx = new Date(Date.UTC(y, m - 1, d, 12, 0, 0));
  const offset = tzOffsetMinutes(tz, approx);
  return new Date(Date.UTC(y, m - 1, d, 0, 0, 0) - offset * 60000 + minutesLocal * 60000);
}

export function localDayOf(date: Date, tz: string): string {
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  const parts = Object.fromEntries(dtf.formatToParts(date).map((p) => [p.type, p.value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
}

const WEEKDAY_SHORT = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

export function localWeekdayOf(day: string, tz: string): string {
  const [y, m, d] = day.split("-").map(Number);
  const date = new Date(Date.UTC(y, m - 1, d, 12, 0, 0));
  const short = new Intl.DateTimeFormat("en-US", { timeZone: tz, weekday: "short" })
    .formatToParts(date)
    .find((p) => p.type === "weekday")!.value;
  return WEEKDAYS[WEEKDAY_SHORT.indexOf(short)] ?? "monday";
}

export function parseHHMM(s: string): number {
  const [h, m] = s.split(":").map(Number);
  return h * 60 + m;
}

export function round1(n: number): number {
  return Math.round(n * 10) / 10;
}
