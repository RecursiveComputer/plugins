# Laya

Classification provider backed by [Laya](https://github.com/NandhaKishorM/laya), an Apache 2.0
non-autoregressive System 1 model. Same `choice` / `score` / `noul` primitives and wire shape as the
TypeSafe Jev provider, so the platform's route, guard, compaction, and agent-tool questions run unchanged
— just locally, on your own hardware, with no API key.

## How it runs

```
provider.ts ──► lib/laya-client.ts ──► lib/laya-helper.ts ──► python3 laya_helper.py serve
                                   └──► HTTP  ──────────────► python3 laya_helper.py serve-http (remote)
```

- **Local (default).** The provider spawns `laya_helper.py serve` with the configured `pythonPath` and
  talks to it over newline-delimited JSON. One process per (python, device, preload) tuple, kept alive
  across requests; it exits when Recursive closes its stdin.
- **Remote.** Set `baseUrl` to a host running `python3 laya_helper.py serve-http --host 0.0.0.0 --port 8765`
  (for example a GPU box, or when the Recursive server itself runs in a container without Python). Routes:
  `GET /v1/health`, `POST /v1/systemone` with `{state, questions, model?, lang?}`.

## Setup

```bash
python3 -m pip install --upgrade laya      # pulls in torch + transformers
```

Then open the plugin's onboarding, save the Python command, and click **Test Laya**. The first test
downloads the selected checkpoint from Hugging Face (~1.5 GB each) and answers a probe question.

## Settings

| key | default | notes |
| --- | --- | --- |
| `pythonPath` | `python3` | environment where `laya` is importable |
| `model` | `auto` | `auto` routes per request by script/language; `english`, `multilingual`, `typed-decisions` pin a checkpoint |
| `device` | `auto` | CUDA → MPS → CPU |
| `preload` | `false` | keep all three checkpoints resident (~4.6 GB RAM) so `auto` never reloads between languages |
| `timeoutMs` | `5000` | calls made while a checkpoint is still loading fail open; the sidecar is never killed on timeout |
| `baseUrl` | — | remote `serve-http` instance; when set, `pythonPath` is ignored |

## Limits worth knowing

- Options share a 192–256 token head budget, so the provider declares `maxLabels: 20`; the platform splits
  larger label sets. Jev is the better fit for 50+ option questions.
- State is truncated by the encoder (512 tokens English, 1024 multilingual); `maxRequestBytes: 8000`
  keeps the platform from sending what the model cannot read.
- The base checkpoints are strong on classification-style questions and near chance on the synthetic
  typed-decisions workflows unless you pin `typed-decisions`. See Laya's `BENCHMARKS.md`.

## Tests

`npx vitest run plugins/shared/laya` — the stdio client is exercised against
`tests/fixtures/fake-laya-helper.mjs`, a node stand-in that speaks the same protocol, so no torch is needed.
