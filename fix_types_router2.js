import fs from 'fs';

let content = fs.readFileSync('src/types/router.ts', 'utf-8');

// Replace ProviderRouteConfig with ProviderChainEntry and an array definition
content = content.replace(
  `export interface ProviderRouteConfig {
  defaultProvider: string;
  defaultModel: string;
  fallbackProvider?: string;
  fallbackModel?: string;
}`,
  `export interface ProviderChainEntry {
  provider: string;
  model: string;
}

export interface ProviderRouteConfig {
  chain: ProviderChainEntry[];
}`
);

fs.writeFileSync('src/types/router.ts', content);
