import { describe, it, expect } from "bun:test";
import {
  validateBusinessConfig,
  validateServicesConfig,
  validateStaffConfig,
  validatePersonaConfig,
  validatePoliciesConfig,
} from "../../src/config/validator.ts";
import { loadClientConfig, writeClientConfig } from "../../src/config/loader.ts";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("Config Schema Validators", () => {
  it("validates valid business.json", () => {
    const validBusiness = {
      name: "Fort Smith Heating & Air",
      trade: "HVAC",
      timezone: "America/Chicago",
      hours: {
        monday: { open: "08:00", close: "17:00" },
      },
      phoneNumbers: {
        main: "+14795550100",
        sms: "+14795550100",
      },
      address: {
        street: "100 Garrison Ave",
        city: "Fort Smith",
        state: "AR",
        zip: "72901",
      },
    };
    const res = validateBusinessConfig(validBusiness);
    expect(res.valid).toBe(true);
    expect(res.errors.length).toBe(0);
    expect(res.data?.name).toBe("Fort Smith Heating & Air");
  });

  it("rejects invalid business.json missing fields", () => {
    const invalidBusiness = {
      name: "",
      timezone: "America/Chicago",
    };
    const res = validateBusinessConfig(invalidBusiness);
    expect(res.valid).toBe(false);
    expect(res.errors.some((e) => e.field === "name")).toBe(true);
    expect(res.errors.some((e) => e.field === "trade")).toBe(true);
    expect(res.errors.some((e) => e.field === "address")).toBe(true);
  });

  it("validates valid services.json and rejects empty services array", () => {
    const valid = {
      services: [
        {
          id: "ac-tuneup",
          name: "AC Tune-Up & Inspection",
          durationMinutes: 60,
          price: 89,
          bufferMinutes: 15,
        },
      ],
    };
    expect(validateServicesConfig(valid).valid).toBe(true);

    const empty = { services: [] };
    const emptyRes = validateServicesConfig(empty);
    expect(emptyRes.valid).toBe(false);
    expect(emptyRes.errors[0].message).toContain("At least one service");
  });

  it("validates valid persona.json and enforces AI disclosure guardrail", () => {
    const valid = {
      greeting: "Hello, thanks for calling Fort Smith Heating & Air!",
      voiceChoice: "echo",
      aiDisclosureWording: "I am an automated AI assistant helping the front desk.",
      tone: "friendly",
    };
    expect(validatePersonaConfig(valid).valid).toBe(true);

    const invalid = {
      greeting: "Hi",
      voiceChoice: "alloy",
      aiDisclosureWording: "", // empty
      tone: "unknown-tone",
    };
    const res = validatePersonaConfig(invalid);
    expect(res.valid).toBe(false);
    expect(res.errors.some((e) => e.field === "aiDisclosureWording")).toBe(true);
    expect(res.errors.some((e) => e.field === "tone")).toBe(true);
  });

  it("validates valid policies.json and rejects invalid deposit types", () => {
    const valid = {
      cancellation: {
        noticePeriodHours: 24,
        fee: 50,
        policyText: "24h cancellation required",
      },
      deposit: {
        required: true,
        type: "fixed",
        amount: 50,
      },
      serviceArea: {
        primaryZipCodes: ["72901", "72903"],
        maxDistanceMiles: 30,
      },
    };
    expect(validatePoliciesConfig(valid).valid).toBe(true);

    const invalid = {
      ...valid,
      deposit: {
        required: true,
        type: "crypto",
        amount: 10,
      },
    };
    const res = validatePoliciesConfig(invalid);
    expect(res.valid).toBe(false);
    expect(res.errors.some((e) => e.field === "deposit.type")).toBe(true);
  });

  it("writes and loads complete client config", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "aabook-test-"));
    const fullConfig = {
      business: {
        name: "Test Shop",
        trade: "HVAC",
        timezone: "America/Chicago",
        hours: { mon: { open: "08:00", close: "17:00" } },
        phoneNumbers: { main: "+15551234567" },
        address: { street: "123 Main", city: "Fort Smith", state: "AR", zip: "72901" },
      },
      services: {
        services: [
          { id: "s1", name: "Service 1", durationMinutes: 30, price: 50, bufferMinutes: 10 },
        ],
      },
      staff: {
        staff: [{ id: "tech1", name: "Dre", role: "Lead Technician" }],
      },
      persona: {
        greeting: "Welcome",
        voiceChoice: "echo",
        aiDisclosureWording: "I am an AI assistant.",
        tone: "professional" as const,
      },
      policies: {
        cancellation: { noticePeriodHours: 24, fee: 25, policyText: "Standard" },
        deposit: { required: false, type: "fixed" as const, amount: 0 },
        serviceArea: { primaryZipCodes: ["72901"] },
      },
    };

    writeClientConfig(tempDir, fullConfig);
    const loaded = loadClientConfig(tempDir);
    expect(loaded.success).toBe(true);
    expect(loaded.config?.business.name).toBe("Test Shop");
    expect(loaded.config?.staff.staff[0].name).toBe("Dre");

    rmSync(tempDir, { recursive: true, force: true });
  });
});
