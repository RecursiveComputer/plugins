import type {
  ClassificationProvider,
  ClassificationProviderPluginModule,
  ClassificationRequest,
  ClassificationResult,
} from '@recursive/core-types/classification-provider';
import type {
  CompactionJudgmentQuestions,
  CompactionJudgmentState,
} from '@recursive/core-types/compaction-transcript';

import { classificationState } from '@recursive/core-types/classification-wire';

import {
  LAYA_PROVIDER_ID,
  buildLayaQuestions,
  createLayaTransport,
  evaluateLayaAsk,
  evaluateLayaChoice,
  layaSettings,
  probeLayaStatus,
  type LayaSettings,
  type LayaTransport,
} from './lib/laya-client.js';

export class LayaProvider implements ClassificationProvider {
  readonly provider_id = LAYA_PROVIDER_ID;
  /**
   * Encoder budgets, not an API cap: 512 tokens of state on the English checkpoint (1024 on the
   * others) and a shared 192–256 token head budget for options, so >20 labels leave each option
   * only a few tokens. The server splits requests against these; oversize state is truncated silently.
   */
  readonly limits = { maxRequestBytes: 8_000, maxLabels: 20 };

  constructor(
    private readonly settings: LayaSettings,
    private readonly transport: LayaTransport = createLayaTransport(settings),
  ) {}

  get model(): string { return this.settings.model; }

  requestBytes(request: ClassificationRequest): number {
    return this.wireBytes(classificationState(request.input), buildLayaQuestions(request, request.labels));
  }

  judgmentBytes(state: CompactionJudgmentState, questions: CompactionJudgmentQuestions): number {
    return this.wireBytes(state, questions);
  }

  private wireBytes(state: unknown, questions: unknown): number {
    return new TextEncoder().encode(JSON.stringify({ model: this.settings.model, state, questions })).byteLength;
  }

  async classify(request: ClassificationRequest): Promise<ClassificationResult | null> {
    return evaluateLayaChoice(this.transport, this.settings, request);
  }

  async classifyBatch(requests: ClassificationRequest[]): Promise<(ClassificationResult | null)[]> {
    // The sidecar serialises forward passes; issuing them together still saves the per-call hop.
    return Promise.all(requests.map((request) => this.classify(request)));
  }

  async judge(state: CompactionJudgmentState, questions: CompactionJudgmentQuestions, timeout_ms?: number) {
    return evaluateLayaAsk(this.transport, this.settings, state, questions, timeout_ms);
  }

  async ask(state: CompactionJudgmentState, questions: CompactionJudgmentQuestions, timeout_ms?: number) {
    return evaluateLayaAsk(this.transport, this.settings, state, questions, timeout_ms);
  }
}

export const classificationProvider: ClassificationProviderPluginModule = {
  async status(context) {
    const settings = layaSettings(context.settings);
    const probe = await probeLayaStatus(createLayaTransport(settings), settings);
    return {
      available: probe.ok,
      configured: probe.ok,
      message: probe.message,
      setup_hint: probe.ok ? null : probe.setup_hint ?? null,
    };
  },
  create(context) {
    return new LayaProvider(layaSettings(context.settings));
  },
};

export default classificationProvider;
