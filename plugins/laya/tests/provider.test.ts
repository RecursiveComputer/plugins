import { describe, expect, it, vi } from 'vitest';

import { LayaProvider, classificationProvider } from '../provider.js';
import { layaSettings, type LayaTransport } from '../lib/laya-client.js';

vi.mock('../lib/laya-helper.js', () => ({
  getLayaHelperClient: () => ({
    request: async () => {
      throw new Error("No module named 'laya'");
    },
  }),
}));

const transport: LayaTransport = {
  status: async () => ({ ok: true }),
  warm: async (model) => ({ model, loaded: [model] }),
  predict: async () => ({
    answers: { choice: { type: 'choice', choice: 'x', probabilities: { x: 0.6, y: 0.4 }, confidence: 0.5 } },
  }),
  describe: () => 'fake',
};

describe('LayaProvider', () => {
  it('declares encoder-derived limits and measures the wire envelope', () => {
    const provider = new LayaProvider(layaSettings({}), transport);
    expect(provider.limits).toEqual({ maxRequestBytes: 8_000, maxLabels: 20 });
    const bytes = provider.requestBytes({ labels: ['x', 'y'], input: { a: 'b' } });
    expect(bytes).toBeGreaterThan(50);
    expect(provider.judgmentBytes({ context: '', goal: '', history: [] }, {})).toBeGreaterThan(10);
  });

  it('classifies, batches, and judges through the transport', async () => {
    const provider = new LayaProvider(layaSettings({}), transport);
    const one = await provider.classify({ labels: ['x', 'y'], input: {} });
    expect(one?.choice).toBe('x');
    const batch = await provider.classifyBatch([{ labels: ['x', 'y'], input: {} }, { labels: ['x', 'y'], input: {} }]);
    expect(batch.map((row) => row?.choice)).toEqual(['x', 'x']);
    const judged = await provider.judge({ context: 'c', goal: 'g', history: [] }, { q: { type: 'noul', instructions: 'i' } });
    expect(judged?.provider_id).toBe('laya');
  });

  it('reports the import failure with a pip hint when laya is missing', async () => {
    const status = await classificationProvider.status!({ plugin_id: 'laya', settings: { pythonPath: 'py-missing' } });
    expect(status).toMatchObject({
      available: false,
      configured: false,
      message: expect.stringContaining("No module named 'laya'"),
      setup_hint: expect.stringContaining('py-missing -m pip install laya'),
    });
  });
});
