/**
 * Config schemas for AA Book client folders:
 * - business.json
 * - services.json
 * - staff.json
 * - persona.json
 * - policies.json
 * - channels.json (optional; defaults to retell voice + stub sms)
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

export interface ServiceItem {
  id: string;
  name: string;
  description?: string;
  durationMinutes: number;
  price: number;
  bufferMinutes: number;
  bookingRules?: {
    leadTimeHours?: number;
    requiresDeposit?: boolean;
    depositAmount?: number;
    allowOnlineBooking?: boolean;
    assignedStaffIds?: string[];
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
  serviceArea: {
    primaryZipCodes: string[];
    maxDistanceMiles?: number;
    travelFee?: number;
  };
  dailySpendCapUsd?: number;
}

export interface ChannelsConfig {
  voice: {
    provider: VoiceProviderChoice;
  };
  sms: {
    provider: SmsProviderChoice;
  };
}

export interface ClientConfig {
  business: BusinessConfig;
  services: ServicesConfig;
  staff: StaffConfig;
  persona: PersonaConfig;
  policies: PoliciesConfig;
  channels?: ChannelsConfig;
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
