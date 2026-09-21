import type {
  ClassificationRequest,
  ClassificationResult,
} from '@recursive/core-types/classification-provider';
import {
  DEFAULT_CLASSIFICATION_TIMEOUT_MS,
  MAX_CLASSIFICATION_TIMEOUT_MS,
} from '@recursive/core-types/classification-provider';
import type {
  CompactionJudgmentAnswers,
  CompactionJudgmentQuestions,
  CompactionJudgmentState,
} from '@recursive/core-types/compaction-transcript';
import { DEFAULT_COMPACTION_TIMEOUT_MS } from '@recursive/core-types/compaction-transcript';

import { getLayaHelperClient, type LayaHelperOptions } from './laya-helper.js';

export const LAYA_PROVIDER_ID = 'laya';

/** Checkpoints shipped in the `convaiinnovations/laya` bundle; `auto` lets the Router pick by script/language. */
export const LAYA_MODEL_OPTIONS = ['auto', 'english', 'multilingual', 'typed-decisions'] as const;
export type LayaModel = (typeof LAYA_MODEL_OPTIONS)[number];

/** Local calls include a one-off checkpoint load, and CPU inference is slower than a hosted API. */
export const DEFAULT_LAYA_TIMEOUT_MS = 5_000;
export const LAYA_WARM_TIMEOUT_MS = 10 * 60_000;

export interface LayaSettings {
  pythonPath: string;
  model: LayaModel | string;
  device: string;
  timeoutMs: number;
  preload: boolean;
  /** When set, talk to a `laya_helper.py serve-http` instance instead of spawning a local one. */
  baseUrl: string;
}

export function layaSettings(input: Record<string, unknown>): LayaSettings {
  const text = (key: string, fallback: string) =>
    typeof input[key] === 'string' && (input[key] as string).trim() ? (input[key] as string).trim() : fallback;
  return {
    pythonPath: text('pythonPath', 'python3'),
    model: text('model', 'auto'),
    device: text('device', 'auto'),
    timeoutMs:
      typeof input.timeoutMs === 'number' && Number.isFinite(input.timeoutMs) && input.timeoutMs > 0
        ? input.timeoutMs
        : DEFAULT_LAYA_TIMEOUT_MS,
    preload: input.preload === true,
    baseUrl: text('baseUrl', ''),
  };
}

type ChoiceAnswer = { type: 'choice'; choice?: string; probabilities?: Record<string, number>; confidence?: number };
type ScoreAnswer = { type: 'score'; score?: number; probabilities?: Record<string, number>; confidence?: number };
type NoulAnswer = { type: 'noul'; noul?: number; confidence?: number };
export type LayaAnswer = ChoiceAnswer | ScoreAnswer | NoulAnswer;

export interface LayaPredictResponse {
  model?: string | null;
  answers?: Record<string, LayaAnswer>;
  routing?: Record<string, unknown>;
  latency_ms?: number;
}

export interface LayaStatus {
  ok: boolean;
  version?: string | null;
  device?: string;
  loaded?: string[];
  models?: string[];
}

export interface LayaPredictBody {
  state: unknown;
  questions: Record<string, unknown>;
  model: string;
}

/** Transport-agnostic view of the sidecar so the provider and tests do not care where Laya runs. */
export interface LayaTransport {
  status(timeoutMs: number): Promise<LayaStatus>;
  warm(model: string, timeoutMs: number): Promise<{ model: string; loaded: string[] }>;
  predict(body: LayaPredictBody, timeoutMs: number): Promise<LayaPredictResponse>;
  describe(): string;
}

function helperOptions(settings: LayaSettings): LayaHelperOptions {
  return {
    pythonPath: settings.pythonPath,
    device: settings.device,
    preload: settings.preload,
    maxLoaded: settings.preload ? LAYA_MODEL_OPTIONS.length - 1 : 1,
  };
}

export function createStdioTransport(settings: LayaSettings): LayaTransport {
  const options = helperOptions(settings);
  return {
    status: (timeoutMs) => getLayaHelperClient(options).request<LayaStatus>('status', {}, timeoutMs),
    warm: (model, timeoutMs) => getLayaHelperClient(options).request('warm', { model }, timeoutMs),
    predict: (body, timeoutMs) =>
      getLayaHelperClient(options).request<LayaPredictResponse>('predict', { ...body }, timeoutMs),
    describe: () => `${settings.pythonPath} laya_helper.py`,
  };
}

export function createHttpTransport(settings: LayaSettings, fetchImpl: typeof fetch = fetch): LayaTransport {
  const base = settings.baseUrl.replace(/\/+$/, '');
  async function call<T>(method: 'GET' | 'POST', route: string, body: unknown, timeoutMs: number): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetchImpl(`${base}${route}`, {
        method,
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: controller.signal,
      });
      if (!response.ok) {
        const detail = await response.text().catch(() => '');
        throw new Error(`Laya server ${response.status}${detail ? `: ${detail.slice(0, 160)}` : ''}`);
      }
      return (await response.json()) as T;
    } finally {
      clearTimeout(timer);
    }
  }
  return {
    status: (timeoutMs) => call<LayaStatus>('GET', '/v1/health', undefined, timeoutMs),
    // The HTTP mode has no warm route; a probe predict loads the checkpoint on the server side.
    warm: async (model, timeoutMs) => {
      const result = await call<LayaPredictResponse>(
        'POST',
        '/v1/systemone',
        { state: { probe: true }, questions: { ok: { type: 'noul', instructions: 'The state is a probe.' } }, model },
        timeoutMs,
      );
      return { model: result.model ?? model, loaded: [] };
    },
    predict: (body, timeoutMs) => call<LayaPredictResponse>('POST', '/v1/systemone', body, timeoutMs),
    describe: () => base,
  };
}

export function createLayaTransport(settings: LayaSettings): LayaTransport {
  return settings.baseUrl ? createHttpTransport(settings) : createStdioTransport(settings);
}

/** Same platform question wording the Jev provider uses, so both providers judge identical prompts. */
const QUESTION_INSTRUCTIONS: Record<string, string> = {
  'route.difficulty': 'How difficult is the upcoming agent turn described by the state? easy = trivial edit or lookup, standard = ordinary implementation work, hard = ambiguous, cross-cutting, or architectural work.',
  'tool.surface.tags': 'Which tool family will the next agent turn most need?',
  'retry.strategy': 'Recent turns show little progress. Which strategy should the agent take next?',
  'chunk.relevance': 'Score each candidate chunk by how directly it answers the query in the state.',
};

function questionInstructions(request: ClassificationRequest): string {
  if (request.question_id && QUESTION_INSTRUCTIONS[request.question_id]) {
    return QUESTION_INSTRUCTIONS[request.question_id]!;
  }
  if (request.question_id) return request.question_id;
  // Ad-hoc questions (live compose routing, workflow decisions) carry their wording in the input.
  const inline = request.input.instructions;
  if (typeof inline === 'string' && inline.trim()) return inline.trim();
  return request.mode === 'scores' ? 'Score each candidate by relevance.' : 'Select the best option.';
}

/**
 * Build the System One question set for a platform classification request. `scores` mode becomes one
 * independent noul per candidate so every chunk is scored on the same scale; otherwise one `choice`
 * whose criteria come from `input.candidates` / `input.criteria` when present.
 */
export function buildLayaQuestions(
  request: ClassificationRequest,
  labels: readonly string[],
): Record<string, unknown> {
  const instructions = questionInstructions(request);
  if (request.mode === 'scores') {
    const chunks = request.input.chunks && typeof request.input.chunks === 'object'
      ? (request.input.chunks as Record<string, unknown>)
      : {};
    return Object.fromEntries(labels.map((label, index) => [`relevance_${index}`, {
      type: 'noul',
      instructions: `The candidate is relevant to the query in state: ${String(chunks[label] ?? label)}`,
    }]));
  }
  const candidates = Array.isArray(request.input.candidates) ? request.input.candidates : [];
  const criteria = request.input.criteria && typeof request.input.criteria === 'object'
    ? (request.input.criteria as Record<string, string>)
    : {};
  return {
    choice: {
      type: 'choice',
      instructions,
      criteria: Object.fromEntries(labels.map((label) => {
        const candidate = candidates.find((row) => row && typeof row === 'object' && row.id === label);
        return [label, candidate ? `${candidate.label}: ${candidate.description ?? ''}` : criteria[label] ?? label];
      })),
    },
  };
}

function mapChoiceAnswer(answer: ChoiceAnswer, labels: readonly string[], latencyMs: number): ClassificationResult {
  const probabilities = answer.probabilities ?? {};
  return {
    choice: typeof answer.choice === 'string' ? answer.choice : null,
    scores: labels.map((label) => ({ label, score: typeof probabilities[label] === 'number' ? probabilities[label]! : 0 })),
    confidence: typeof answer.confidence === 'number' ? answer.confidence : null,
    provider_id: LAYA_PROVIDER_ID,
    latency_ms: latencyMs,
  };
}

function clampTimeout(value: number | undefined, fallback: number): number {
  return Math.min(Math.max(value ?? fallback, 1), MAX_CLASSIFICATION_TIMEOUT_MS);
}

export async function evaluateLayaChoice(
  transport: LayaTransport,
  settings: LayaSettings,
  request: ClassificationRequest,
): Promise<ClassificationResult | null> {
  const labels = request.labels;
  if (!labels.length) return null;
  const timeoutMs = clampTimeout(request.timeout_ms ?? settings.timeoutMs, DEFAULT_CLASSIFICATION_TIMEOUT_MS);
  const started = Date.now();
  let payload: LayaPredictResponse;
  try {
    payload = await transport.predict(
      { state: request.input, questions: buildLayaQuestions(request, labels), model: settings.model },
      timeoutMs,
    );
  } catch {
    return null; // fail-open: the classification service treats null as "no signal"
  }
  const answers = payload.answers ?? {};
  const latencyMs = Date.now() - started;
  if (request.mode === 'scores') {
    const scores = labels.map((label, index) => {
      const answer = answers[`relevance_${index}`];
      return { label, score: answer?.type === 'noul' ? answer.noul : undefined };
    });
    if (scores.some((row) => typeof row.score !== 'number' || !Number.isFinite(row.score))) return null;
    const complete = scores as Array<{ label: string; score: number }>;
    const top = [...complete].sort((a, b) => b.score - a.score)[0];
    return {
      choice: top?.label ?? null,
      scores: complete,
      confidence: top?.score ?? null,
      provider_id: LAYA_PROVIDER_ID,
      latency_ms: latencyMs,
      aggregation: 'independent_scores',
    };
  }
  const choice = answers.choice;
  return choice?.type === 'choice' ? mapChoiceAnswer(choice, labels, latencyMs) : null;
}

/** Arbitrary typed questions over a judgment state (guards, compaction); answers pass through untouched. */
export async function evaluateLayaAsk(
  transport: LayaTransport,
  settings: LayaSettings,
  state: CompactionJudgmentState,
  questions: CompactionJudgmentQuestions,
  timeoutMs = DEFAULT_COMPACTION_TIMEOUT_MS,
): Promise<CompactionJudgmentAnswers | null> {
  if (!Object.keys(questions).length) return null;
  const started = Date.now();
  try {
    const payload = await transport.predict({ state, questions, model: settings.model }, clampTimeout(timeoutMs, DEFAULT_COMPACTION_TIMEOUT_MS));
    return {
      answers: (payload.answers ?? {}) as CompactionJudgmentAnswers['answers'],
      latency_ms: Date.now() - started,
      provider_id: LAYA_PROVIDER_ID,
    };
  } catch {
    return null;
  }
}

export interface LayaProbeResult {
  ok: boolean;
  message: string;
  setup_hint?: string;
}

function setupHint(settings: LayaSettings): string {
  if (settings.baseUrl) {
    return `Start \`python3 laya_helper.py serve-http\` on the remote host and check that ${settings.baseUrl} is reachable.`;
  }
  return `Run \`${settings.pythonPath} -m pip install laya\` (PyTorch is pulled in as a dependency), or point the Python command at the environment where laya is installed.`;
}

/** Cheap readiness check: is the sidecar reachable and is `laya` importable? Does not load weights. */
export async function probeLayaStatus(transport: LayaTransport, settings: LayaSettings): Promise<LayaProbeResult> {
  try {
    const status = await transport.status(Math.max(settings.timeoutMs, 15_000));
    if (!status.ok) return { ok: false, message: 'Laya sidecar reported not ready.', setup_hint: setupHint(settings) };
    const loaded = status.loaded?.length ? `loaded: ${status.loaded.join(', ')}` : 'no checkpoint loaded yet';
    return { ok: true, message: `Laya ${status.version ?? ''} on ${status.device ?? 'unknown'} (${loaded}).`.replace('  ', ' ') };
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error), setup_hint: setupHint(settings) };
  }
}

/**
 * Onboarding verification: warm the configured checkpoint (first run downloads it) and run one
 * choice question end to end. Long timeout on purpose — a cold download can take minutes.
 */
export async function verifyLayaConnection(transport: LayaTransport, settings: LayaSettings): Promise<LayaProbeResult> {
  const status = await probeLayaStatus(transport, settings);
  if (!status.ok) return status;
  try {
    await transport.warm(settings.model, LAYA_WARM_TIMEOUT_MS);
  } catch (error) {
    return {
      ok: false,
      message: `Could not load the Laya checkpoint: ${error instanceof Error ? error.message : String(error)}`,
      setup_hint: 'Check network access to huggingface.co and free disk space (each checkpoint is ~1.5 GB).',
    };
  }
  const result = await evaluateLayaChoice(transport, { ...settings, timeoutMs: Math.max(settings.timeoutMs, 30_000) }, {
    labels: ['ok', 'fail'],
    input: { probe: true, expected: 'ok' },
    mode: 'single',
  });
  if (!result?.choice) {
    return { ok: false, message: 'Laya did not return a choice for the probe question.', setup_hint: setupHint(settings) };
  }
  return {
    ok: true,
    message: `Connected (${result.choice}, confidence ${result.confidence ?? 'n/a'}, ${result.latency_ms} ms).`,
  };
}
