import { afterEach, describe, expect, test, vi } from 'vitest';

import { computerProvider } from '../provider.js';

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('E2B computer provider', () => {
  test('reports setup guidance when the E2B key is missing', () => {
    vi.stubEnv('E2B_API_KEY', '');
    expect(computerProvider.status?.({ plugin_id: 'computer-provider-e2b', settings: {} })).toMatchObject({
      available: true,
      configured: false,
      setup_hint: 'Open Settings → Plugins → E2B Computer.',
    });
    expect(() =>
      computerProvider.create({ plugin_id: 'computer-provider-e2b', settings: {} }),
    ).toThrow('This computer needs an E2B API key before it can start.');
  });
});
