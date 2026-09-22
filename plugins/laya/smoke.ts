/** Opt-in real-model check: node --import tsx plugins/shared/laya/smoke.ts /path/to/python */
import assert from 'node:assert/strict';
import {
  createLayaTransport,
  layaSettings,
  verifyLayaConnection,
} from './lib/laya-client.js';
import { closeAllLayaHelperClients } from './lib/laya-helper.js';
import { LayaProvider } from './provider.js';

const settings = layaSettings({ pythonPath: process.argv[2], model: 'english', timeoutMs: 30_000 });
const transport = createLayaTransport(settings);
try {
  const verification = await verifyLayaConnection(transport, settings);
  console.log(JSON.stringify({ verification }));
  assert.equal(verification.ok, true, verification.message);
  const provider = new LayaProvider(settings, transport);
  for (const [text, expected] of [
    ['I was charged twice. Please refund the duplicate payment.', 'billing'],
    ['The application crashes whenever I open settings.', 'technical'],
  ]) {
    const result = await provider.classify({
      labels: ['billing', 'technical'],
      input: {
        text,
        instructions: 'Which department should handle this request?',
        criteria: { billing: 'payments, invoices and refunds', technical: 'bugs, crashes and outages' },
      },
    });
    console.log(JSON.stringify({ expected, result }));
    assert.ok(result, 'Laya returned no classification signal.');
    assert.equal(result?.choice, expected);
    assert.ok(result.scores.every(({ score }) => Number.isFinite(score)));
  }
  const judgments = await provider.ask(
    { context: 'The customer explicitly requests a refund for a duplicate charge.', goal: 'Handle the refund.', history: [] },
    {
      refund: { type: 'noul', instructions: 'Does the customer request a refund?' },
      urgency: { type: 'score', instructions: 'How urgent is this request?', criteria: ['not urgent', 'soon', 'critical'] },
    },
    30_000,
  );
  console.log(JSON.stringify({ judgments }));
  assert.ok(Number.isFinite(judgments?.answers.refund?.noul));
  assert.ok(Number.isFinite(judgments?.answers.urgency?.score));
} finally {
  closeAllLayaHelperClients();
}
