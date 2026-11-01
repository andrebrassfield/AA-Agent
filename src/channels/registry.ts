import type { ClientConfig } from "../types/config.ts";
import type { SmsProvider, VoiceProviderAdapter } from "../types/channels.ts";
import { DEFAULT_CHANNELS_CONFIG } from "../config/validator.ts";
import { RetellVoiceAdapter } from "./voice/retell.ts";
import { StubSmsProvider } from "./sms/stub.ts";

/**
 * Registry mapping client config provider names (`channels.json`) to adapter implementations.
 * Adding ElevenLabs or Twilio later requires only registering an adapter here, without touching product code.
 */
export class ChannelAdapterRegistry {
  private voiceAdapters = new Map<string, VoiceProviderAdapter>();
  private smsProviders = new Map<string, SmsProvider>();

  constructor() {
    this.registerVoiceAdapter(new RetellVoiceAdapter());
    this.registerSmsProvider(new StubSmsProvider());
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
    return provider;
  }
}
