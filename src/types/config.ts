import type { ClientRouterConfig } from "./router.ts";

/**
 * Config schemas for AA Book client folders:
 * - business.json
 * - services.json
 * - staff.json
 * - persona.json
 * - policies.json
 * - channels.json (optional; defaults to retell voice + stub sms)
 * - router.json (optional; defaults to live HTTP provider chains)
 */

export interface BusinessConfig {
  name: string;
  trade: string;
  timezone: string;
  hours: {
    [dayOfWeek: string]: {
      open: string;  // e.g. "08:00"
      close: string; // e.g. "17:00"
      closed?: boolean;
    };
  };
  phoneNumbers: {
    main: string;
    sms?: string;
    emergency?: string;
  };
  address: {
    street: string;
    city: string;
    state: string;
    zip: string;
  };
}

export type ServiceTriage = "book" | "ask_first" | "decline";

export interface ServiceItem {
  id: string;
  name: string;
  description?: string;
  durationMinutes: number;
  price: number;
  bufferMinutes: number;
  /** Route-aware booking applies to in-home services. Defaults to true; set false to opt out. */
  inHome?: boolean;
  bookingRules?: {
    leadTimeHours?: number;
    requiresDeposit?: boolean;
    depositAmount?: number;
    allowOnlineBooking?: boolean;
    assignedStaffIds?: string[];
    /** Screening before any slot ranking. "decline" can never be overridden by route fit. */
    triage?: ServiceTriage;
  };
}

export interface ServicesConfig {
  services: ServiceItem[];
}

export interface StaffMember {
  id: string;
  name: string;
  role: string;
  phone?: string;
  email?: string;
  skills?: string[];
  /** Optional per-tech home base; defaults to business.address (shop). */
  homeBase?: {
    street: string;
    city: string;
    state: string;
    zip: string;
  };
  schedule?: {
    [dayOfWeek: string]: {
      start: string;
      end: string;
      off?: boolean;
    };
  };
}

export interface StaffConfig {
  staff: StaffMember[];
}

export type VoiceProviderChoice = "retell" | "elevenlabs";
export type SmsProviderChoice = "stub" | "twilio";

export interface PersonaConfig {
  greeting: string;
  voiceChoice: string; // e.g. "echo", "alloy", "eleven_rachel"
  aiDisclosureWording: string; // Disclosure requirement: never deny being AI if asked
  tone: "friendly" | "professional" | "casual" | "urgent";
  businessContext?: string;
}

export interface QuietHoursPolicy {
  start: string;     // 24h local time "HH:MM", e.g. "20:00"
  end: string;       // 24h local time "HH:MM", e.g. "08:00"
  timezone?: string; // Optional IANA timezone override; defaults to business.timezone
}

export interface ServiceAreaConfig {
  primaryZipCodes: string[];
  maxDistanceMiles?: number;
  /** Explicit radius around the shop home base; overrides maxDistanceMiles when set. */
  radiusMiles?: number;
  /** Optional polygon (lat/lng vertices). Any matching criterion (zip, polygon, radius) admits. */
  polygon?: { lat: number; lng: number }[];
  travelFee?: number;
}

export interface RoutingConfig {
  /** Route-aware slot ranking on/off. Default true. */
  enabled?: boolean;
  /**
   * Drive-time/geocode source choice carried by client config.
   * "nominatim" (default) = free OSM HTTP, no account/key. "local" = synthetic hash geocoder,
   * only usable when allowSyntheticGeocoder is true (tests/demo/simulator). v1 distance
   * estimate is haversine; no paid routing API is called. Spend caps (dailySpendCapUsd)
   * already govern any future paid provider.
   */
  geocoder?: "local" | "nominatim";
  allowSyntheticGeocoder?: boolean;
  /** Average speed for haversine drive-time estimates. Default 25 mph. */
  avgSpeedMph?: number;
  /** Drive-time buffer preference: extra minutes required between adjacent stops on a route. Default 10. */
  driveTimeBufferMinutes?: number;
  /** Candidate slot step in minutes. Default 15. */
  slotStepMinutes?: number;
  /** How many ranked offers to return. Default 3. */
  maxOffers?: number;
  /** How many days ahead to search. Default 7. */
  horizonDays?: number;
  nominatimBaseUrl?: string;
}

export interface PoliciesConfig {
  cancellation: {
    noticePeriodHours: number;
    fee: number;
    policyText: string;
  };
  deposit: {
    required: boolean;
    type: "fixed" | "percentage";
    amount: number;
  };
  serviceArea: ServiceAreaConfig;
  routing?: RoutingConfig;
  dailySpendCapUsd?: number;
  quietHours?: QuietHoursPolicy;
  followUpTickIntervalMs?: number;
}

export interface ChannelsConfig {
  voice: {
    provider: VoiceProviderChoice;
  };
  sms: {
    provider: SmsProviderChoice;
    fromNumber?: string;
  };
}

export interface ClientConfig {
  business: BusinessConfig;
  services: ServicesConfig;
  staff: StaffConfig;
  persona: PersonaConfig;
  policies: PoliciesConfig;
  channels?: ChannelsConfig;
  router?: ClientRouterConfig;
}

export interface ValidationIssue {
  field: string;
  message: string;
}

export interface ValidationResult<T> {
  valid: boolean;
  data?: T;
  errors: ValidationIssue[];
}
