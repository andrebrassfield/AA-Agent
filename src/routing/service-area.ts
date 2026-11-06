import type { BusinessConfig, PoliciesConfig } from "../types/config.ts";
import {
  extractZip,
  formatAddress,
  type Geocoder,
  haversineMiles,
  pointInPolygon,
  round1,
} from "./geo.ts";

export interface ServiceAreaResult {
  inArea: boolean;
  reason: string;
  distanceMiles?: number;
}

/**
 * Service-area admission. Any configured criterion that matches admits the
 * address: zip in primaryZipCodes, inside polygon, or within radius of the
 * shop home base (radiusMiles overrides maxDistanceMiles). If the address
 * cannot be geocoded and no zip matched, it is NOT admitted: we do not guess.
 */
export async function checkServiceArea(
  customerAddress: string,
  business: BusinessConfig,
  policies: PoliciesConfig,
  geocoder: Geocoder
): Promise<ServiceAreaResult> {
  const area = policies.serviceArea;

  const zip = extractZip(customerAddress);
  if (zip && area.primaryZipCodes.includes(zip)) {
    return { inArea: true, reason: `zip ${zip} in primaryZipCodes` };
  }

  const radiusMiles = area.radiusMiles ?? area.maxDistanceMiles;
  const polygon = area.polygon;
  if (!radiusMiles && (!polygon || polygon.length < 3)) {
    return {
      inArea: false,
      reason: `zip ${zip ?? "unknown"} not in primaryZipCodes and no radius/polygon configured`,
    };
  }

  const customer = await geocoder.geocode(customerAddress);
  if (!customer) {
    return { inArea: false, reason: "address could not be geocoded; service area unconfirmed" };
  }

  if (polygon && polygon.length >= 3 && pointInPolygon(customer, polygon)) {
    return { inArea: true, reason: "inside service-area polygon" };
  }

  if (radiusMiles) {
    const home = await geocoder.geocode(formatAddress(business.address));
    if (!home) {
      return { inArea: false, reason: "shop home base could not be geocoded" };
    }
    const d = haversineMiles(home, customer);
    if (d <= radiusMiles) {
      return { inArea: true, reason: `within ${radiusMiles} mi radius of shop`, distanceMiles: round1(d) };
    }
    return {
      inArea: false,
      reason: `${round1(d)} mi from shop, beyond ${radiusMiles} mi radius`,
      distanceMiles: round1(d),
    };
  }

  return { inArea: false, reason: "outside configured service area" };
}
