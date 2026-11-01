import { describe, expect, it } from "bun:test";
import { cpSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadClientConfig } from "../../src/config/loader.ts";
import {
  validateBusinessConfig,
  validateChannelsConfig,
  validatePersonaConfig,
  validatePoliciesConfig,
  validateServicesConfig,
  validateStaffConfig,
} from "../../src/config/validator.ts";
import { FORT_SMITH_HVAC_CONFIG } from "../../src/demo/shop_data.ts";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const TEMPLATES_DIR = join(REPO_ROOT, "templates");
const EXPECTED_CONFIG_FILES = [
  "business.json",
  "channels.json",
  "persona.json",
  "policies.json",
  "services.json",
  "staff.json",
];

function assertNoEnvFilesOrSecretKeys(packDir: string): void {
  const entries = readdirSync(packDir).sort();
  expect(entries).toEqual(EXPECTED_CONFIG_FILES);
  for (const file of entries) {
    expect(/^\.env/i.test(file)).toBe(false);
    const raw = readFileSync(join(packDir, file), "utf-8");
    const parsed = JSON.parse(raw) as unknown;

    const visit = (node: unknown) => {
      if (Array.isArray(node)) {
        node.forEach(visit);
      } else if (typeof node === "object" && node !== null) {
        for (const [key, val] of Object.entries(node)) {
          expect(/secret|api[-_]?key|token|password|private[-_]?key/i.test(key)).toBe(false);
          visit(val);
        }
      }
    };
    visit(parsed);
  }
}

describe("Pilot Client Config Template Pack (templates/)", () => {
  it("templates/fort-smith-hvac loads cleanly with zero TODOs or secrets and matches the Fort Smith demo shop", () => {
    const hvacDir = join(TEMPLATES_DIR, "fort-smith-hvac");
    expect(existsSync(hvacDir)).toBe(true);
    assertNoEnvFilesOrSecretKeys(hvacDir);

    const loaded = loadClientConfig(hvacDir);
    expect(loaded.success).toBe(true);
    expect(loaded.errors).toEqual([]);
    expect(loaded.config?.business).toEqual(FORT_SMITH_HVAC_CONFIG.business);
    expect(loaded.config?.services).toEqual(FORT_SMITH_HVAC_CONFIG.services);
    expect(loaded.config?.staff).toEqual(FORT_SMITH_HVAC_CONFIG.staff);
    expect(loaded.config?.persona).toEqual(FORT_SMITH_HVAC_CONFIG.persona);
    expect(loaded.config?.channels).toEqual(FORT_SMITH_HVAC_CONFIG.channels);
    expect(loaded.config?.policies.cancellation).toEqual(FORT_SMITH_HVAC_CONFIG.policies.cancellation);
    expect(loaded.config?.policies.deposit).toEqual(FORT_SMITH_HVAC_CONFIG.policies.deposit);
    expect(loaded.config?.policies.serviceArea).toEqual(FORT_SMITH_HVAC_CONFIG.policies.serviceArea);
  });

  it("templates/blank marks every client-supplied answer with TODO placeholders and blocks loading until filled", () => {
    const blankDir = join(TEMPLATES_DIR, "blank");
    expect(existsSync(blankDir)).toBe(true);
    assertNoEnvFilesOrSecretKeys(blankDir);

    const loaded = loadClientConfig(blankDir);
    expect(loaded.success).toBe(false);

    // Every file in the blank pack contains explicit TODO placeholders caught by validation
    for (const file of EXPECTED_CONFIG_FILES) {
      const fileError = loaded.errors.find((e) => e.file === file);
      expect(fileError).toBeDefined();
      expect(fileError!.issues.some((msg) => msg.includes("Unresolved TODO placeholder"))).toBe(true);
    }
  });

  it("templates/home-inspection is shaped for the pilot trade with valid shop configs and TODO placeholders on services.json", () => {
    const hiDir = join(TEMPLATES_DIR, "home-inspection");
    expect(existsSync(hiDir)).toBe(true);
    assertNoEnvFilesOrSecretKeys(hiDir);

    const readJson = (file: string) => JSON.parse(readFileSync(join(hiDir, file), "utf-8"));

    const bizRes = validateBusinessConfig(readJson("business.json"));
    const staffRes = validateStaffConfig(readJson("staff.json"));
    const personaRes = validatePersonaConfig(readJson("persona.json"));
    const policiesRes = validatePoliciesConfig(readJson("policies.json"));
    const channelsRes = validateChannelsConfig(readJson("channels.json"));
    const servicesRes = validateServicesConfig(readJson("services.json"));

    expect(bizRes.valid).toBe(true);
    expect(bizRes.data?.trade).toBe("Home Inspection");
    // Fictional NANPA 555-01xx number range only
    expect(bizRes.data?.phoneNumbers.main).toMatch(/^\+1\d{3}55501\d{2}$/);
    expect(staffRes.valid).toBe(true);
    expect(personaRes.valid).toBe(true);
    expect(policiesRes.valid).toBe(true);
    expect(channelsRes.valid).toBe(true);

    // Services must come from the owner, never scraped — template holds TODO placeholders
    expect(servicesRes.valid).toBe(false);
    expect(servicesRes.errors.some((e) => e.message.includes("Unresolved TODO placeholder"))).toBe(true);

    const uneditedLoad = loadClientConfig(hiDir);
    expect(uneditedLoad.success).toBe(false);
    expect(uneditedLoad.errors.map((e) => e.file)).toEqual(["services.json"]);

    // Once owner supplies their actual inspection menu, the pack loads immediately
    const tempClientDir = mkdtempSync(join(tmpdir(), "aabook-pilot-hi-"));
    try {
      cpSync(hiDir, tempClientDir, { recursive: true });
      writeFileSync(
        join(tempClientDir, "services.json"),
        JSON.stringify(
          {
            services: [
              {
                id: "buyer-home-inspection",
                name: "Standard Residential Buyer's Inspection (Up to 2,500 sq ft)",
                description: "Full structural, roof, electrical, plumbing, and HVAC visual inspection with same-day report",
                durationMinutes: 180,
                price: 375,
                bufferMinutes: 45,
                bookingRules: {
                  leadTimeHours: 24,
                  requiresDeposit: false,
                  depositAmount: 0,
                  allowOnlineBooking: true,
                  assignedStaffIds: ["inspector-1"],
                },
              },
            ],
          },
          null,
          2
        ),
        "utf-8"
      );

      const readyLoad = loadClientConfig(tempClientDir);
      expect(readyLoad.success).toBe(true);
      expect(readyLoad.config?.business.trade).toBe("Home Inspection");
      expect(readyLoad.config?.services.services[0]?.price).toBe(375);
    } finally {
      rmSync(tempClientDir, { recursive: true, force: true });
    }
  });
});
