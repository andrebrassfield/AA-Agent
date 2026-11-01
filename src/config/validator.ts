import type {
  BusinessConfig,
  ServicesConfig,
  StaffConfig,
  PersonaConfig,
  PoliciesConfig,
  ChannelsConfig,
  ClientConfig,
  ValidationResult,
  ValidationIssue,
} from "../types/config.ts";

export const DEFAULT_AI_DISCLOSURE =
  "I am an automated AI assistant helping the front desk at Arkansas Automated.";

export const DEFAULT_CHANNELS_CONFIG: ChannelsConfig = {
  voice: { provider: "retell" },
  sms: { provider: "stub" },
};

function isObject(val: unknown): val is Record<string, unknown> {
  return typeof val === "object" && val !== null && !Array.isArray(val);
}

function isString(val: unknown): val is string {
  return typeof val === "string" && val.trim().length > 0;
}

function isNumber(val: unknown): val is number {
  return typeof val === "number" && !isNaN(val);
}

export function validateBusinessConfig(data: unknown): ValidationResult<BusinessConfig> {
  const errors: ValidationIssue[] = [];
  if (!isObject(data)) {
    return { valid: false, errors: [{ field: "root", message: "business.json must be an object" }] };
  }

  if (!isString(data.name)) {
    errors.push({ field: "name", message: "Business name is required and must be a non-empty string" });
  }
  if (!isString(data.trade)) {
    errors.push({ field: "trade", message: "Business trade (e.g. 'HVAC', 'Plumbing') is required" });
  }
  if (!isString(data.timezone)) {
    errors.push({ field: "timezone", message: "Timezone is required (e.g. 'America/Chicago')" });
  }

  if (!isObject(data.hours)) {
    errors.push({ field: "hours", message: "Business hours must be defined as an object" });
  }

  if (!isObject(data.phoneNumbers) || !isString(data.phoneNumbers.main)) {
    errors.push({ field: "phoneNumbers.main", message: "Main phone number is required" });
  }

  if (!isObject(data.address)) {
    errors.push({ field: "address", message: "Address object is required" });
  } else {
    if (!isString(data.address.street)) errors.push({ field: "address.street", message: "Address street is required" });
    if (!isString(data.address.city)) errors.push({ field: "address.city", message: "Address city is required" });
    if (!isString(data.address.state)) errors.push({ field: "address.state", message: "Address state is required" });
    if (!isString(data.address.zip)) errors.push({ field: "address.zip", message: "Address zip code is required" });
  }

  return {
    valid: errors.length === 0,
    data: errors.length === 0 ? (data as unknown as BusinessConfig) : undefined,
    errors,
  };
}

export function validateServicesConfig(data: unknown): ValidationResult<ServicesConfig> {
  const errors: ValidationIssue[] = [];
  if (!isObject(data) || !Array.isArray(data.services)) {
    return { valid: false, errors: [{ field: "services", message: "services.json must contain a 'services' array" }] };
  }

  if (data.services.length === 0) {
    errors.push({ field: "services", message: "At least one service must be defined" });
  }

  data.services.forEach((service: unknown, index: number) => {
    if (!isObject(service)) {
      errors.push({ field: `services[${index}]`, message: "Service entry must be an object" });
      return;
    }
    if (!isString(service.id)) {
      errors.push({ field: `services[${index}].id`, message: "Service id is required" });
    }
    if (!isString(service.name)) {
      errors.push({ field: `services[${index}].name`, message: "Service name is required" });
    }
    if (!isNumber(service.durationMinutes) || service.durationMinutes <= 0) {
      errors.push({ field: `services[${index}].durationMinutes`, message: "durationMinutes must be a positive number" });
    }
    if (!isNumber(service.price) || service.price < 0) {
      errors.push({ field: `services[${index}].price`, message: "price must be a non-negative number" });
    }
    if (service.bufferMinutes !== undefined && !isNumber(service.bufferMinutes)) {
      errors.push({ field: `services[${index}].bufferMinutes`, message: "bufferMinutes must be a number" });
    }
  });

  return {
    valid: errors.length === 0,
    data: errors.length === 0 ? (data as unknown as ServicesConfig) : undefined,
    errors,
  };
}

export function validateStaffConfig(data: unknown): ValidationResult<StaffConfig> {
  const errors: ValidationIssue[] = [];
  if (!isObject(data) || !Array.isArray(data.staff)) {
    return { valid: false, errors: [{ field: "staff", message: "staff.json must contain a 'staff' array" }] };
  }

  data.staff.forEach((member: unknown, index: number) => {
    if (!isObject(member)) {
      errors.push({ field: `staff[${index}]`, message: "Staff member must be an object" });
      return;
    }
    if (!isString(member.id)) {
      errors.push({ field: `staff[${index}].id`, message: "Staff id is required" });
    }
    if (!isString(member.name)) {
      errors.push({ field: `staff[${index}].name`, message: "Staff name is required" });
    }
    if (!isString(member.role)) {
      errors.push({ field: `staff[${index}].role`, message: "Staff role is required" });
    }
  });

  return {
    valid: errors.length === 0,
    data: errors.length === 0 ? (data as unknown as StaffConfig) : undefined,
    errors,
  };
}

export function validatePersonaConfig(data: unknown): ValidationResult<PersonaConfig> {
  const errors: ValidationIssue[] = [];
  if (!isObject(data)) {
    return { valid: false, errors: [{ field: "root", message: "persona.json must be an object" }] };
  }

  if (!isString(data.greeting)) {
    errors.push({ field: "greeting", message: "Persona greeting is required" });
  }
  if (!isString(data.voiceChoice)) {
    errors.push({ field: "voiceChoice", message: "voiceChoice is required" });
  }
  if (!isString(data.aiDisclosureWording)) {
    errors.push({
      field: "aiDisclosureWording",
      message: "aiDisclosureWording is required (guardrail: AI must never deny being AI)",
    });
  }
  const validTones = ["friendly", "professional", "casual", "urgent"];
  if (!isString(data.tone) || !validTones.includes(data.tone)) {
    errors.push({
      field: "tone",
      message: `Tone must be one of: ${validTones.join(", ")}`,
    });
  }

  return {
    valid: errors.length === 0,
    data: errors.length === 0 ? (data as unknown as PersonaConfig) : undefined,
    errors,
  };
}

export function validatePoliciesConfig(data: unknown): ValidationResult<PoliciesConfig> {
  const errors: ValidationIssue[] = [];
  if (!isObject(data)) {
    return { valid: false, errors: [{ field: "root", message: "policies.json must be an object" }] };
  }

  if (!isObject(data.cancellation)) {
    errors.push({ field: "cancellation", message: "Cancellation policy object is required" });
  } else {
    if (!isNumber(data.cancellation.noticePeriodHours)) {
      errors.push({ field: "cancellation.noticePeriodHours", message: "noticePeriodHours is required" });
    }
    if (!isNumber(data.cancellation.fee)) {
      errors.push({ field: "cancellation.fee", message: "cancellation fee is required" });
    }
  }

  if (!isObject(data.deposit)) {
    errors.push({ field: "deposit", message: "Deposit policy object is required" });
  } else {
    if (typeof data.deposit.required !== "boolean") {
      errors.push({ field: "deposit.required", message: "deposit.required must be a boolean" });
    }
    if (data.deposit.type !== "fixed" && data.deposit.type !== "percentage") {
      errors.push({ field: "deposit.type", message: "deposit.type must be 'fixed' or 'percentage'" });
    }
    if (!isNumber(data.deposit.amount)) {
      errors.push({ field: "deposit.amount", message: "deposit.amount must be a number" });
    }
  }

  if (!isObject(data.serviceArea)) {
    errors.push({ field: "serviceArea", message: "serviceArea object is required" });
  } else {
    if (!Array.isArray(data.serviceArea.primaryZipCodes) || data.serviceArea.primaryZipCodes.length === 0) {
      errors.push({ field: "serviceArea.primaryZipCodes", message: "primaryZipCodes must be a non-empty array of strings" });
    }
  }

  return {
    valid: errors.length === 0,
    data: errors.length === 0 ? (data as unknown as PoliciesConfig) : undefined,
    errors,
  };
}

export function validateChannelsConfig(data: unknown): ValidationResult<ChannelsConfig> {
  const errors: ValidationIssue[] = [];
  if (!isObject(data)) {
    return { valid: false, errors: [{ field: "root", message: "channels.json must be an object" }] };
  }

  const validVoiceProviders = ["retell", "elevenlabs"];
  if (!isObject(data.voice) || !isString(data.voice.provider) || !validVoiceProviders.includes(data.voice.provider)) {
    errors.push({
      field: "voice.provider",
      message: `voice.provider must be one of: ${validVoiceProviders.join(", ")}`,
    });
  }

  const validSmsProviders = ["stub", "twilio"];
  if (!isObject(data.sms) || !isString(data.sms.provider) || !validSmsProviders.includes(data.sms.provider)) {
    errors.push({
      field: "sms.provider",
      message: `sms.provider must be one of: ${validSmsProviders.join(", ")}`,
    });
  }

  // Guardrail: secrets belong in .env only, never in client config JSON
  const checkNoSecrets = (obj: Record<string, unknown>, prefix: string) => {
    for (const key of Object.keys(obj)) {
      if (/secret|api[-_]?key|token|password/i.test(key)) {
        errors.push({
          field: `${prefix}.${key}`,
          message: `Secrets (${key}) are not permitted in client JSON config; use .env only`,
        });
      }
    }
  };
  checkNoSecrets(data, "channels");
  if (isObject(data.voice)) checkNoSecrets(data.voice, "channels.voice");
  if (isObject(data.sms)) checkNoSecrets(data.sms, "channels.sms");

  return {
    valid: errors.length === 0,
    data: errors.length === 0 ? (data as unknown as ChannelsConfig) : undefined,
    errors,
  };
}
