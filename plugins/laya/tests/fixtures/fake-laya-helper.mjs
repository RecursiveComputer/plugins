// Stand-in for laya_helper.py: same JSON-lines protocol, no torch. Run with node.
import readline from 'node:readline';

const mode = process.argv.includes('serve') ? 'serve' : 'unknown';
if (mode !== 'serve') process.exit(2);
const args = process.argv.slice(2);

const rl = readline.createInterface({ input: process.stdin });
const write = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);

rl.on('line', (line) => {
  if (!line.trim()) return;
  const request = JSON.parse(line);
  const { id, operation, payload } = request;
  if (operation === 'status') {
    write({ id, result: { ok: true, version: '0.3.3', device: 'cpu', loaded: [], models: ['english'], args } });
    return;
  }
  if (operation === 'warm') {
    write({ id, result: { model: payload.model === 'auto' ? 'english' : payload.model, loaded: ['english'] } });
    return;
  }
  if (operation === 'slow') {
    setTimeout(() => write({ id, result: { done: true } }), Number(payload.delay_ms ?? 200));
    return;
  }
  if (operation === 'boom') {
    write({ id, error: 'kaboom' });
    return;
  }
  if (operation === 'predict') {
    const answers = {};
    for (const [qid, question] of Object.entries(payload.questions)) {
      if (question.type === 'choice') {
        const keys = Object.keys(question.criteria);
        answers[qid] = {
          type: 'choice',
          choice: keys[0],
          probabilities: Object.fromEntries(keys.map((key, index) => [key, index === 0 ? 0.9 : 0.1 / Math.max(1, keys.length - 1)])),
          confidence: 0.8,
        };
      } else if (question.type === 'noul') {
        answers[qid] = { type: 'noul', noul: 0.42, confidence: 0.58 };
      } else {
        answers[qid] = { type: 'score', score: 1.5, probabilities: { 0: 0.1, 1: 0.3, 2: 0.6 }, confidence: 0.6 };
      }
    }
    write({ id, result: { model: payload.model === 'auto' ? 'english' : payload.model, answers, routing: { model: 'english' }, latency_ms: 3 } });
    return;
  }
  write({ id, error: `unknown operation ${operation}` });
});
rl.on('close', () => process.exit(0));
