import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  buildLayaQuestions,
  createHttpTransport,
  createStdioTransport,
  evaluateLayaAsk,
  evaluateLayaChoice,
  layaSettings,
  probeLayaStatus,
  verifyLayaConnection,
  type LayaPredictResponse,
  type LayaTransport,
} from '../lib/laya-client.js';
import { closeAllLayaHelperClients } from '../lib/laya-helper.js';

const FAKE_HELPER = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'fake-laya-helper.mjs');
const settings = layaSettings({});

// Route the bundled Python helper to the node fixture; only the stdio suite spawns anything.
vi.mock('../lib/laya-helper.js', async (importActual) => {
  const actual = await importActual<typeof import('../lib/laya-helper.js')>();
  return {
    ...actual,
    getLayaHelperClient: (options: Parameters<typeof actual.getLayaHelperClient>[0]) =>
      actual.getLayaHelperClient({ ...options, helperPath: FAKE_HELPER }),
  };
});

function fakeTransport(answers: LayaPredictResponse['answers'], captured: Array<Record<string, unknown>> = []): LayaTransport {
  return {
    status: async () => ({ ok: true, version: '0.3.3', device: 'cpu', loaded: ['english'] }),
    warm: async (model) => ({ model, loaded: [model] }),
    predict: async (body) => {
      captured.push(body as unknown as Record<string, unknown>);
      return { model: 'english', answers, latency_ms: 2 };
    },
    describe: () => 'fake',
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  closeAllLayaHelperClients();
});

describe('layaSettings', () => {
  it('applies defaults and trims strings', () => {
    expect(layaSettings({ pythonPath: '  ', timeoutMs: -1 })).toMatchObject({
      pythonPath: 'python3',
      model: 'auto',
      device: 'auto',
      timeoutMs: 5000,
      preload: false,
      baseUrl: '',
    });
    expect(layaSettings({ baseUrl: 'http://gpu:8765/ ', preload: true }).baseUrl).toBe('http://gpu:8765/');
  });
});

describe('buildLayaQuestions', () => {
  it('builds one choice with candidate descriptions as criteria', () => {
    const questions = buildLayaQuestions(
      {
        question_id: 'route.difficulty',
        labels: ['easy', 'hard'],
        input: { candidates: [{ id: 'easy', label: 'Easy', description: 'trivial' }] },
      },
      ['easy', 'hard'],
    );
    expect(questions.choice).toMatchObject({
      type: 'choice',
      instructions: 'How difficult is the upcoming agent turn described by the state?',
      criteria: {
        easy: { label: 'Easy', description: 'trivial' },
        hard: { covers: expect.any(String), excludes: expect.any(String) },
      },
    });
  });

  it('poses ad-hoc questions with the wording the caller supplied in the input', () => {
    const questions = buildLayaQuestions(
      { labels: ['easy', 'hard'], input: { instructions: 'How much reasoning does this task require?', criteria: { easy: 'small' } } },
      ['easy', 'hard'],
    );
    expect(questions.choice).toMatchObject({ instructions: 'How much reasoning does this task require?', criteria: { easy: 'small', hard: 'hard' } });
  });

  it('expands scores mode into one noul per chunk so every candidate shares a scale', () => {
    const questions = buildLayaQuestions(
      { mode: 'scores', labels: ['7', '9'], input: { query: 'q', chunks: { '7': 'seven', '9': 'nine' } } },
      ['7', '9'],
    );
    expect(questions.relevance_0).toMatchObject({ type: 'noul', instructions: { candidate: 'chunks.7', query: 'query' } });
    expect(questions.relevance_1).toMatchObject({ type: 'noul', instructions: { candidate: 'chunks.9' } });
    expect(JSON.stringify(questions)).not.toContain('seven');
  });
});

describe('evaluateLayaChoice', () => {
  it('maps a choice answer into a classification result', async () => {
    const captured: Array<Record<string, unknown>> = [];
    const transport = fakeTransport(
      { choice: { type: 'choice', choice: 'hard', probabilities: { easy: 0.2, hard: 0.8 }, confidence: 0.7 } },
      captured,
    );
    const result = await evaluateLayaChoice(transport, settings, { labels: ['easy', 'hard'], input: { task: 'x' } });
    expect(result).toMatchObject({
      choice: 'hard',
      confidence: 0.7,
      provider_id: 'laya',
      scores: [{ label: 'easy', score: 0.2 }, { label: 'hard', score: 0.8 }],
    });
    expect(captured[0]).toMatchObject({ model: 'auto', state: { task: 'x' } });
  });

  it('collects independent noul scores in scores mode', async () => {
    const transport = fakeTransport({
      relevance_0: { type: 'noul', noul: 0.2 },
      relevance_1: { type: 'noul', noul: 0.9 },
    });
    const result = await evaluateLayaChoice(transport, settings, {
      mode: 'scores',
      labels: ['a', 'b'],
      input: { query: 'q', chunks: { a: 'A', b: 'B' } },
    });
    expect(result).toMatchObject({ choice: 'b', scores: [{ label: 'a', score: 0.2 }, { label: 'b', score: 0.9 }], aggregation: 'independent_scores' });
  });

  it('fails open on transport errors, missing answers, and empty labels', async () => {
    const failing: LayaTransport = { ...fakeTransport({}), predict: async () => { throw new Error('down'); } };
    await expect(evaluateLayaChoice(failing, settings, { labels: ['a'], input: {} })).resolves.toBeNull();
    await expect(evaluateLayaChoice(fakeTransport({}), settings, { labels: ['a'], input: {} })).resolves.toBeNull();
    await expect(evaluateLayaChoice(fakeTransport({}), settings, { labels: [], input: {} })).resolves.toBeNull();
  });
});

describe('evaluateLayaAsk', () => {
  it('passes typed answers through with provider identity', async () => {
    const transport = fakeTransport({ keep: { type: 'noul', noul: 0.77 } });
    const result = await evaluateLayaAsk(
      transport,
      settings,
      { context: 'c', goal: 'g', history: [] },
      { keep: { type: 'noul', instructions: 'Keep it?' } },
    );
    expect(result).toMatchObject({ provider_id: 'laya', answers: { keep: { noul: 0.77 } } });
    await expect(evaluateLayaAsk(transport, settings, { context: 'c', goal: 'g', history: [] }, {})).resolves.toBeNull();
  });
});

describe('http transport', () => {
  it('posts System One bodies to /v1/systemone and reads /v1/health', async () => {
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith('/v1/health')) return { ok: true, json: async () => ({ ok: true, version: '0.3.3' }) } as Response;
      expect(url).toBe('http://gpu:8765/v1/systemone');
      const body = JSON.parse(String(init?.body));
      expect(body.questions.choice.type).toBe('choice');
      return {
        ok: true,
        json: async () => ({ answers: { choice: { type: 'choice', choice: 'a', probabilities: { a: 1 }, confidence: 1 } } }),
      } as Response;
    });
    const http = createHttpTransport(layaSettings({ baseUrl: 'http://gpu:8765/' }), fetchMock as unknown as typeof fetch);
    await expect(http.status(1000)).resolves.toMatchObject({ ok: true });
    const result = await evaluateLayaChoice(http, settings, { labels: ['a', 'b'], input: {} });
    expect(result?.choice).toBe('a');
  });

  it('turns non-2xx responses into a rejection', async () => {
    const fetchMock = vi.fn(async () => ({ ok: false, status: 503, text: async () => 'loading' }) as unknown as Response);
    const http = createHttpTransport(layaSettings({ baseUrl: 'http://gpu:8765' }), fetchMock as unknown as typeof fetch);
    await expect(http.status(1000)).rejects.toThrow('Laya server 503: loading');
  });
});

describe('stdio transport end to end (fake sidecar)', () => {
  const local = layaSettings({ pythonPath: process.execPath });

  it('probes status and verifies with a probe choice', async () => {
    const status = await probeLayaStatus(createStdioTransport(local), local);
    expect(status).toMatchObject({ ok: true, message: expect.stringContaining('0.3.3') });
    const verify = await verifyLayaConnection(createStdioTransport(local), local);
    expect(verify).toMatchObject({ ok: true, message: expect.stringContaining('ok') });
  });
});
