import type {
  SandboxProvider,
  SandboxProviderPluginModule,
} from '@recursive/core-types/sandbox-provider';

import { E2bSandboxProvider } from './lib/e2b-provider.js';

let cached: { key: string; provider: SandboxProvider } | null = null;

function numberSetting(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function apiKey(settings: Record<string, unknown>): string {
  return (
    (typeof settings.e2bApiKey === 'string' ? settings.e2bApiKey.trim() : '') ||
    process.env.E2B_API_KEY?.trim() ||
    ''
  );
}

export const computerProvider: SandboxProviderPluginModule = {
  status({ settings }) {
    const configured = Boolean(apiKey(settings));
    return {
      available: true,
      configured,
      message: configured ? null : 'Add an E2B API key before starting an E2B computer.',
      setup_hint: configured ? null : 'Open Settings → Plugins → E2B Computer.',
    };
  },

  create({ settings }) {
    const keyValue = apiKey(settings);
    if (!keyValue) {
      throw new Error('This computer needs an E2B API key before it can start.');
    }
    const idleMinutes = Math.min(
      1_440,
      Math.max(5, numberSetting(settings.idleTimeoutMinutes, 15)),
    );
    const template =
      typeof settings.e2bTemplate === 'string' && settings.e2bTemplate.trim()
        ? settings.e2bTemplate.trim()
        : 'desktop';
    const cacheKey = `${template}:${idleMinutes}:${keyValue}`;
    if (cached?.key === cacheKey) return cached.provider;
    const provider = new E2bSandboxProvider({
      apiKey: keyValue,
      template,
      idleTimeoutMs: idleMinutes * 60_000,
    });
    cached = { key: cacheKey, provider };
    return provider;
  },
};

export default computerProvider;
