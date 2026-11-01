const SENSITIVE_KEY_PATTERN =
  /secret|token|authorization|api[-_]?key|password|signature|private[-_]?key/i;

export function collectEnvSecrets(extraSecrets: (string | undefined)[] = []): string[] {
  const candidates = [
    process.env.WEBHOOK_SECRET,
    process.env.RETELL_API_KEY,
    process.env.ELEVENLABS_API_KEY,
    process.env.OPENROUTER_API_KEY,
    process.env.NVIDIA_NIM_API_KEY,
    process.env.GEMINI_API_KEY,
    process.env.TWILIO_AUTH_TOKEN,
    process.env.SMS_API_KEY,
    ...extraSecrets,
  ];
  return Array.from(
    new Set(
      candidates
        .filter((v): v is string => typeof v === "string" && v.trim().length >= 4)
        .map((v) => v.trim())
    )
  );
}

export function redactString(input: string, secrets: string[]): string {
  let out = input;
  for (const secret of secrets) {
    if (secret && out.includes(secret)) {
      out = out.split(secret).join("[REDACTED]");
    }
  }
  return out;
}

export function redactSecrets(value: unknown, secrets: string[]): unknown {
  if (typeof value === "string") {
    return redactString(value, secrets);
  }
  if (Array.isArray(value)) {
    return value.map((item) => redactSecrets(item, secrets));
  }
  if (typeof value === "object" && value !== null) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      if (SENSITIVE_KEY_PATTERN.test(k)) {
        out[k] = "[REDACTED]";
      } else {
        out[k] = redactSecrets(v, secrets);
      }
    }
    return out;
  }
  return value;
}
