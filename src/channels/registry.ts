import type { ClientConfig } from "../types/config.ts";
import type { SmsProvider, VoiceProviderAdapter } from "../types/channels.ts";
import { DEFAULT_CHANNELS_CONFIG } from "../config/validator.ts";
import { RetellVoiceAdapter } from "./voice/retell.ts";
import { StubSmsProvider } from "./sms/stub.ts";
import { TwilioSmsProvider } from "./sms/twilio.ts";

/**
 * Registry mapping client config provider names (`channels.json`) to adapter implementations.
 * `stub` remains the default SMS provider (used by demo and tests); `twilio` is selected per client.
 */
export class ChannelAdapterRegistry {
  private voiceAdapters = new Map<string, VoiceProviderAdapter>();
  private smsProviders = new Map<string, SmsProvider>();

  constructor() {
    this.registerVoiceAdapter(new RetellVoiceAdapter());
    this.registerSmsProvider(new StubSmsProvider());
    this.registerSmsProvider(new TwilioSmsProvider());
  }

  registerVoiceAdapter(adapter: VoiceProviderAdapter): void {
    this.voiceAdapters.set(adapter.name, adapter);
  }

  registerSmsProvider(provider: SmsProvider): void {
    this.smsProviders.set(provider.name, provider);
  }

  resolveVoiceAdapter(clientConfig: ClientConfig): VoiceProviderAdapter {
    const providerName = clientConfig.channels?.voice.provider ?? DEFAULT_CHANNELS_CONFIG.voice.provider;
    const adapter = this.voiceAdapters.get(providerName);
    if (!adapter) {
      throw new Error(
        `Voice provider "${providerName}" configured in client config is not registered. Available: ${Array.from(this.voiceAdapters.keys()).join(", ")}`
      );
    }
    return adapter;
  }

  resolveSmsProvider(clientConfig: ClientConfig): SmsProvider {
    const providerName = clientConfig.channels?.sms.provider ?? DEFAULT_CHANNELS_CONFIG.sms.provider;
    const provider = this.smsProviders.get(providerName);
    if (!provider) {
      throw new Error(
        `SMS provider "${providerName}" configured in client config is not registered. Available: ${Array.from(this.smsProviders.keys()).join(", ")}`
      );
    }
    if (provider instanceof TwilioSmsProvider) {
      const configuredFrom =
        clientConfig.channels?.sms.fromNumber?.trim() ||
        clientConfig.business.phoneNumbers.sms?.trim();
      return provider.withDefaultFromNumber(configuredFrom);
    }
    return provider;
  }
}
