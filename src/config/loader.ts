import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type {
  BusinessConfig,
  ServicesConfig,
  StaffConfig,
  PersonaConfig,
  PoliciesConfig,
  ChannelsConfig,
  ClientConfig,
} from "../types/config.ts";
import type { ClientRouterConfig } from "../types/router.ts";
import {
  validateBusinessConfig,
  validateServicesConfig,
  validateStaffConfig,
  validatePersonaConfig,
  validatePoliciesConfig,
  validateChannelsConfig,
  validateRouterConfig,
  DEFAULT_CHANNELS_CONFIG,
} from "./validator.ts";

export interface LoadConfigResult {
  success: boolean;
  config?: ClientConfig;
  errors: { file: string; issues: string[] }[];
}

export function loadClientConfig(clientDir: string): LoadConfigResult {
  const errors: { file: string; issues: string[] }[] = [];

  const readJson = <T>(
    filename: string,
    validator: (data: unknown) => { valid: boolean; data?: T; errors: { message: string }[] }
  ): T | null => {
    const fullPath = join(clientDir, filename);
    if (!existsSync(fullPath)) {
      errors.push({ file: filename, issues: [`File not found at ${fullPath}`] });
      return null;
    }

    try {
      const content = readFileSync(fullPath, "utf-8");
      const parsed = JSON.parse(content);
      const result = validator(parsed);
      if (!result.valid || !result.data) {
        errors.push({
          file: filename,
          issues: result.errors.map((e) => e.message),
        });
        return null;
      }
      return result.data;
    } catch (err: unknown) {
      errors.push({
        file: filename,
        issues: [`Invalid JSON format: ${err instanceof Error ? err.message : String(err)}`],
      });
      return null;
    }
  };

  const business = readJson<BusinessConfig>("business.json", validateBusinessConfig);
  const services = readJson<ServicesConfig>("services.json", validateServicesConfig);
  const staff = readJson<StaffConfig>("staff.json", validateStaffConfig);
  const persona = readJson<PersonaConfig>("persona.json", validatePersonaConfig);
  const policies = readJson<PoliciesConfig>("policies.json", validatePoliciesConfig);

  let channels: ChannelsConfig = DEFAULT_CHANNELS_CONFIG;
  if (existsSync(join(clientDir, "channels.json"))) {
    const loadedChannels = readJson<ChannelsConfig>("channels.json", validateChannelsConfig);
    if (loadedChannels) {
      channels = loadedChannels;
    }
  }

  let router: ClientRouterConfig | undefined;
  if (existsSync(join(clientDir, "router.json"))) {
    const loadedRouter = readJson<ClientRouterConfig>("router.json", validateRouterConfig);
    if (loadedRouter) {
      router = loadedRouter;
    }
  }

  if (errors.length > 0 || !business || !services || !staff || !persona || !policies) {
    return { success: false, errors };
  }

  return {
    success: true,
    config: {
      business,
      services,
      staff,
      persona,
      policies,
      channels,
      ...(router ? { router } : {}),
    },
    errors: [],
  };
}

export function writeClientConfig(clientDir: string, config: ClientConfig): void {
  mkdirSync(clientDir, { recursive: true });
  writeFileSync(join(clientDir, "business.json"), JSON.stringify(config.business, null, 2), "utf-8");
  writeFileSync(join(clientDir, "services.json"), JSON.stringify(config.services, null, 2), "utf-8");
  writeFileSync(join(clientDir, "staff.json"), JSON.stringify(config.staff, null, 2), "utf-8");
  writeFileSync(join(clientDir, "persona.json"), JSON.stringify(config.persona, null, 2), "utf-8");
  writeFileSync(join(clientDir, "policies.json"), JSON.stringify(config.policies, null, 2), "utf-8");
  if (config.channels) {
    writeFileSync(join(clientDir, "channels.json"), JSON.stringify(config.channels, null, 2), "utf-8");
  }
  if (config.router) {
    writeFileSync(join(clientDir, "router.json"), JSON.stringify(config.router, null, 2), "utf-8");
  }
}
