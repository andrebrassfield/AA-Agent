import * as readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { join } from "node:path";
import { writeClientConfig } from "../config/loader.ts";
import {
  validateBusinessConfig,
  validateServicesConfig,
  validateStaffConfig,
  validatePersonaConfig,
  validatePoliciesConfig,
  validateChannelsConfig,
  DEFAULT_AI_DISCLOSURE,
  DEFAULT_CHANNELS_CONFIG,
} from "../config/validator.ts";
import type { ClientConfig } from "../types/config.ts";

export interface SetupOptions {
  clientDir?: string;
  nonInteractiveDefaults?: Partial<ClientConfig>;
}

export async function runSetup(options: SetupOptions = {}): Promise<ClientConfig> {
  const clientDir = options.clientDir || join(process.cwd(), "client");
  console.log("===============================================================");
  console.log("          AA BOOK CLIENT CONFIGURATION WIZARD                  ");
  console.log("===============================================================");
  console.log(`Writing configuration to: ${clientDir}\n`);

  if (options.nonInteractiveDefaults) {
    // Used in automated testing or quick defaults
    const cfg: ClientConfig = {
      business: options.nonInteractiveDefaults.business || {
        name: "Standard Service Shop",
        trade: "General Contracting",
        timezone: "America/Chicago",
        hours: { monday: { open: "08:00", close: "17:00" } },
        phoneNumbers: { main: "+15550000000" },
        address: { street: "100 Main St", city: "Fort Smith", state: "AR", zip: "72901" },
      },
      services: options.nonInteractiveDefaults.services || {
        services: [
          { id: "std-service", name: "Standard Service", durationMinutes: 60, price: 99, bufferMinutes: 15 },
        ],
      },
      staff: options.nonInteractiveDefaults.staff || {
        staff: [{ id: "tech-1", name: "Staff Member", role: "Specialist" }],
      },
      persona: options.nonInteractiveDefaults.persona || {
        greeting: "Welcome to our shop!",
        voiceChoice: "alloy",
        aiDisclosureWording: DEFAULT_AI_DISCLOSURE,
        tone: "friendly",
      },
      policies: options.nonInteractiveDefaults.policies || {
        cancellation: { noticePeriodHours: 24, fee: 0, policyText: "24h cancellation" },
        deposit: { required: false, type: "fixed", amount: 0 },
        serviceArea: { primaryZipCodes: ["72901"] },
      },
      channels: options.nonInteractiveDefaults.channels || DEFAULT_CHANNELS_CONFIG,
    };
    writeClientConfig(clientDir, cfg);
    console.log("Wrote configurations successfully via defaults.");
    return cfg;
  }

  const rl = readline.createInterface({ input, output });

  try {
    const ask = async (prompt: string, defaultValue: string = ""): Promise<string> => {
      const display = defaultValue ? `${prompt} [${defaultValue}]: ` : `${prompt}: `;
      const answer = await rl.question(display);
      return answer.trim() || defaultValue;
    };

    console.log("1. Business Profile");
    const name = await ask("Business Name", "Fort Smith Heating & Air");
    const trade = await ask("Trade/Industry", "HVAC");
    const timezone = await ask("Timezone", "America/Chicago");
    const phone = await ask("Main Phone", "+14795550100");
    const street = await ask("Street Address", "701 Rogers Ave");
    const city = await ask("City", "Fort Smith");
    const state = await ask("State", "AR");
    const zip = await ask("Zip Code", "72901");

    const business = {
      name,
      trade,
      timezone,
      hours: {
        monday: { open: "08:00", close: "17:00" },
        tuesday: { open: "08:00", close: "17:00" },
        wednesday: { open: "08:00", close: "17:00" },
        thursday: { open: "08:00", close: "17:00" },
        friday: { open: "08:00", close: "17:00" },
      },
      phoneNumbers: { main: phone },
      address: { street, city, state, zip },
    };

    const bizValidation = validateBusinessConfig(business);
    if (!bizValidation.valid) {
      throw new Error(`Business config invalid: ${bizValidation.errors.map((e) => e.message).join(", ")}`);
    }

    console.log("\n2. Initial Service Offering");
    const serviceName = await ask("Primary Service Name", "AC Tune-Up & Precision Inspection");
    const servicePrice = Number(await ask("Price ($)", "89"));
    const serviceDuration = Number(await ask("Duration (minutes)", "60"));

    const services = {
      services: [
        {
          id: serviceName.toLowerCase().replace(/[^a-z0-9]/g, "-").replace(/-+/g, "-"),
          name: serviceName,
          price: isNaN(servicePrice) ? 89 : servicePrice,
          durationMinutes: isNaN(serviceDuration) ? 60 : serviceDuration,
          bufferMinutes: 15,
        },
      ],
    };

    const srvValidation = validateServicesConfig(services);
    if (!srvValidation.valid) {
      throw new Error(`Services config invalid: ${srvValidation.errors.map((e) => e.message).join(", ")}`);
    }

    console.log("\n3. Staff");
    const staffName = await ask("Lead Tech / Staff Name", "Dre Washington");
    const staffRole = await ask("Role", "Senior Field Technician");
    const staff = {
      staff: [
        {
          id: "tech-1",
          name: staffName,
          role: staffRole,
        },
      ],
    };

    const staffValidation = validateStaffConfig(staff);
    if (!staffValidation.valid) {
      throw new Error(`Staff config invalid: ${staffValidation.errors.map((e) => e.message).join(", ")}`);
    }

    console.log("\n4. Persona & Tone");
    const greeting = await ask("Phone/SMS Greeting", `Thank you for calling ${name}, how can we help?`);
    const toneInput = await ask("Tone (friendly, professional, casual, urgent)", "friendly") as "friendly" | "professional" | "casual" | "urgent";
    const voiceChoice = await ask("Voice Choice (alloy, echo, eleven_rachel)", "alloy");
    const aiDisclosureWording = await ask("AI Disclosure Wording (SPEC requirement: AI never denies being AI)", DEFAULT_AI_DISCLOSURE);

    const persona = {
      greeting,
      tone: (["friendly", "professional", "casual", "urgent"].includes(toneInput) ? toneInput : "friendly") as "friendly" | "professional" | "casual" | "urgent",
      voiceChoice,
      aiDisclosureWording,
    };

    const personaValidation = validatePersonaConfig(persona);
    if (!personaValidation.valid) {
      throw new Error(`Persona config invalid: ${personaValidation.errors.map((e) => e.message).join(", ")}`);
    }

    console.log("\n5. Policies");
    const cancelHours = Number(await ask("Cancellation Notice Hours", "24"));
    const cancelFee = Number(await ask("Cancellation Fee ($)", "25"));
    const zipCoverage = await ask("Primary Zip Codes (comma-separated)", zip);

    const policies = {
      cancellation: {
        noticePeriodHours: isNaN(cancelHours) ? 24 : cancelHours,
        fee: isNaN(cancelFee) ? 25 : cancelFee,
        policyText: `${cancelHours} hours notice required to avoid a fee of $${cancelFee}.`,
      },
      deposit: {
        required: false,
        type: "fixed" as const,
        amount: 0,
      },
      serviceArea: {
        primaryZipCodes: zipCoverage.split(",").map((s) => s.trim()).filter(Boolean),
      },
    };

    const policiesValidation = validatePoliciesConfig(policies);
    if (!policiesValidation.valid) {
      throw new Error(`Policies config invalid: ${policiesValidation.errors.map((e) => e.message).join(", ")}`);
    }

    console.log("\n6. Channels");
    const voiceProvInput = await ask("Voice Provider (retell, elevenlabs)", "retell");
    const smsProvInput = await ask("SMS Provider (stub, twilio)", "stub");
    const channels = {
      voice: {
        provider: (voiceProvInput === "elevenlabs" ? "elevenlabs" : "retell") as "retell" | "elevenlabs",
      },
      sms: {
        provider: (smsProvInput === "twilio" ? "twilio" : "stub") as "stub" | "twilio",
      },
    };
    const channelsValidation = validateChannelsConfig(channels);
    if (!channelsValidation.valid) {
      throw new Error(`Channels config invalid: ${channelsValidation.errors.map((e) => e.message).join(", ")}`);
    }

    const config: ClientConfig = {
      business,
      services,
      staff,
      persona,
      policies,
      channels,
    };

    writeClientConfig(clientDir, config);
    console.log(`\nSuccessfully created client config at: ${clientDir}`);
    console.log(`- business.json`);
    console.log(`- services.json`);
    console.log(`- staff.json`);
    console.log(`- persona.json`);
    console.log(`- policies.json`);
    console.log(`- channels.json`);
    return config;
  } finally {
    rl.close();
  }
}
