import type { ClientConfig } from "../types/config.ts";

export const FORT_SMITH_HVAC_CONFIG: ClientConfig = {
  business: {
    name: "Fort Smith Heating & Air",
    trade: "HVAC",
    timezone: "America/Chicago",
    hours: {
      monday: { open: "08:00", close: "17:00" },
      tuesday: { open: "08:00", close: "17:00" },
      wednesday: { open: "08:00", close: "17:00" },
      thursday: { open: "08:00", close: "17:00" },
      friday: { open: "08:00", close: "17:00" },
      saturday: { open: "09:00", close: "14:00" },
      sunday: { open: "00:00", close: "00:00", closed: true },
    },
    phoneNumbers: {
      main: "+14795550100",
      sms: "+14795550100",
      emergency: "+14795550109",
    },
    address: {
      street: "701 Rogers Ave",
      city: "Fort Smith",
      state: "AR",
      zip: "72901",
    },
  },
  services: {
    services: [
      {
        id: "ac-tuneup",
        name: "AC Tune-Up & Precision Inspection",
        description: "21-point seasonal cooling inspection and refrigerant level check",
        durationMinutes: 60,
        price: 89,
        bufferMinutes: 15,
        bookingRules: {
          leadTimeHours: 4,
          requiresDeposit: false,
          allowOnlineBooking: true,
        },
      },
      {
        id: "furnace-diagnostic",
        name: "Heating & Furnace Diagnostic",
        description: "Diagnostic safety check and component testing",
        durationMinutes: 75,
        price: 99,
        bufferMinutes: 15,
      },
      {
        id: "system-replacement-quote",
        name: "New System Replacement Estimate",
        description: "Free in-home load calculation and system replacement consultation",
        durationMinutes: 90,
        price: 0,
        bufferMinutes: 30,
      },
    ],
  },
  staff: {
    staff: [
      {
        id: "tech-dre",
        name: "Dre Washington",
        role: "Senior HVAC Field Specialist",
        phone: "+14795550101",
      },
      {
        id: "tech-tyler",
        name: "Tyler Vance",
        role: "HVAC Install & Maintenance Tech",
        phone: "+14795550102",
      },
    ],
  },
  persona: {
    greeting: "Thank you for calling Fort Smith Heating & Air, how can we keep you comfortable today?",
    voiceChoice: "alloy",
    aiDisclosureWording: "I am an automated AI assistant helping the front desk at Arkansas Automated.",
    tone: "friendly",
    businessContext: "Family-operated Fort Smith HVAC contractor serving Sebastian and Crawford counties since 2012.",
  },
  policies: {
    cancellation: {
      noticePeriodHours: 24,
      fee: 25,
      policyText: "Cancellations within 24 hours of scheduled appointment may be subject to a $25 trip charge.",
    },
    deposit: {
      required: false,
      type: "fixed",
      amount: 0,
    },
    serviceArea: {
      primaryZipCodes: ["72901", "72903", "72904", "72908", "72916", "72956"],
      maxDistanceMiles: 35,
    },
  },
};
