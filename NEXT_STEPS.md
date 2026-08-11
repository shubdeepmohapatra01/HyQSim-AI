# Next steps

Open threads as of **2026-08-11**, after the AI overhaul landed on `main` (commit `8374a39`).

Written to be picked up cold. Each item says what the problem is, why it matters, where to
start, and how to tell when it is done.

---

## Orientation

```bash
./run.sh start                    # frontend :5173, backend :8000
```

Free checks, no API key, run these first to confirm nothing has rotted:

```bash
cd frontend && npm run ai:replay    # 94 tests
cd frontend && npm run ai:budget    # token report
cd backend  && python -m pytest tests/ -q   # 52 tests
```

Diagnostics that need a key — reach for these before guessing at a provider failure:

```bash
GOOGLE_API_KEY=... npm run ai:models -- --verify   # which models a key can really use
GROQ_API_KEY=...   npm run ai:probe                # which request features a provider takes
GROQ_API_KEY=...   npm run ai:live                 # the prompt suite → ai-eval-report.md
```

Background reading: `CHANGELOG.md` for what changed and why, `AI_GUIDE.md` for how the
assistant works, `WALKTHROUGH.md` for what the product is meant to feel like.

---

## 1. The assistant confuses qumodes with qubits — highest priority

**Status:** diagnosed from a partial `ai:live` run against `llama-3.3-70b-versatile`, not yet
fixed. The full report was never read.

Observed:

```
cat-state               PASS  1 tool call
cat-state-alpha         FAIL  improvised instead of calling load_benchmark("cat-state")
ghz-4                   PASS  1 tool call
cv-fourier              FAIL  qubits: expected 0, got 3
bell                    PASS  1 tool call
squeezed-vacuum         PASS  but took 8 tool calls
two-mode-squeezing      FAIL  qumodes: expected 2, got 0
coherent-displacement   FAIL  qumodes: expected 1, got 0
```

**The pattern: every failure is a continuous-variable case; every clean pass is pure
discrete.** `coherent-displacement` is one wire and one gate, so this is not output
truncation — the model built qubit wires for a qumode request. `cv-fourier` producing three
qubits means it pattern-matched "Fourier transform circuit" to the textbook QFT and ignored
"for CV circuits".

Two distinct bugs:

- **CV/DV confusion.** The system prompt states lane signatures in the gate catalogue but
  never says plainly that a bosonic/CV/qumode request needs `m` wires. Weak models skim it.
- **`load_benchmark` not firing when a parameter is mentioned.** `cat-state` passed and
  `cat-state-alpha` failed, and the only difference is "with alpha = 2".

**Where to start**

- `frontend/src/ai/tools.ts` — the build rules. Consider an explicit rule: a request naming a
  qumode, cavity, mode, coherent/squeezed/cat state needs `m` wires, not `q`.
- `frontend/src/ai/benchmarks.ts:49` — `BENCHMARK_KEYWORDS` and `benchmarkForPrompt()` already
  exist and are **unused**. Wiring them in would let the app detect "cat state" in the prompt
  and either nudge the model or refuse a hand-built alternative.
- `frontend/src/ai/sanity.ts` — a check for "prompt asked for a qumode/CV state but the
  circuit has no qumodes" would catch all three CV failures at the tool-result stage. The
  checker already receives `userPrompt`.

**Done when:** `npm run ai:live` passes `cv-fourier`, `two-mode-squeezing`,
`coherent-displacement` and `cat-state-alpha` on Groq, and `squeezed-vacuum` takes 1–2 tool
calls rather than 8.

**Do not** fix this by making the prompt longer without measuring — run `npm run ai:budget`
after, since fixed overhead is paid on every request.

---

## 2. `load_benchmark` does not work over MCP

The verified circuits live in TypeScript (`frontend/src/benchmarks/circuits.ts`), so
`backend/mcp_server.py` cannot reach them. An external AI client asked for a cat state will
still improvise the wrong two-gate version — precisely the bug fixed for the in-app path.

**Approach:** route it through the browser, exactly as `hyqsim_run_simulation` already does.
Add a `load_benchmark` message to the WebSocket protocol in `backend/session.py`, have
`frontend/src/mcp/session.ts` call the existing `handleLoadBenchmark` in `App.tsx`, and add a
`hyqsim_load_benchmark` tool. Roughly 40 lines.

**Done when:** with a browser attached, asking an MCP client for a cat state produces the
eight-gate circuit. Add a case to `backend/tests/test_mcp_e2e.py`.

---

## 3. The Gemini 400 was never explained

A build request 400'd on its second turn and an explain request 400'd immediately. The probe
cleared the tool schemas — no-arg tools, `enum`, `additionalProperties` and typed tools all
returned OK — but the prime suspects went untested when the free-tier quota ran out.

Untested rungs, now ordered first in `frontend/src/ai/evals/probe.ts`:

- `tool_choice: 'required'`
- assistant message with `content: null` alongside `tool_calls`
- system message sent with tools

**It may have been a quota error in disguise** — Google returns 400 for some quota states.
Confirm before writing any workaround:

```bash
GOOGLE_API_KEY=... npm run ai:probe -- --model gemini-3.5-flash
```

**Done when:** either a named feature is confirmed rejected and worked around in
`frontend/src/ai/providers.ts`, or the whole thing is confirmed as quota and this item is
deleted.

---

## 4. Documentation gaps

| Item | What is needed |
|---|---|
| `12-ai-explanation.png` | Not captured. Drop it in `docs/images/`, change `IMAGE-TODO` back to `IMAGE` in `WALKTHROUGH.md` (line 232), run `python3 docs/insert-images.py --apply` |
| `hero.png` | Currently a title-bar crop, but the alt text promises "a cat state circuit and its Wigner function". Either recapture as a full window with the cat state loaded and the Wigner tab open, or point the README at `11-ai-built-cat.png`, which already shows circuit + chat panel together |
| `demo.gif` | Optional but high value. Storyboard: prompt typed → circuit appears → Run → Wigner tab. 12–18 s, under 5 MB, goes below the hero |
| `LICENSE` | **Missing entirely.** For grant-funded academic work this is a real gap — without it nobody can legally build on the repository |

---

## 5. Unverified model ids

Only Google and Groq entries in `frontend/src/ai/providers.ts` have been checked against a
live key. **Anthropic, OpenAI and Mistral entries are unverified** and may 404.

Lesson from this session, worth not relearning: **never guess a replacement model id.** Two
Gemini entries were dead, and the whole 2.5 generation is closed to new keys *while still
appearing in the catalogue*. Listing is not access. Run:

```bash
ANTHROPIC_API_KEY=... npm run ai:models -- --verify
```

---

## 6. Code health

**Lint is not clean** — `npx eslint src` reports 9, none introduced by the overhaul:

```
sweep.ts:18-24              unused vars in the stubbed function
BenchmarkMenu.tsx:93        react-hooks/immutability
GateParameterEditor.tsx:160 react-hooks/set-state-in-effect
ImportExportModal.tsx:73    react-hooks/set-state-in-effect
hybridlaneIO.ts:253         prefer-const
```

The `sweep.ts` ones are from stubbing the disabled JC Trotter module; prefixing params with
`_` does not satisfy this ESLint config.

**`git bisect` does not work across the overhaul.** Commits are grouped thematically, and
only the tip compiles — `main` was already broken when the work started (`sweep.ts`,
`tensor.ts` and `ChatPanel.tsx` all failed to typecheck), so intermediate commits inherit it.
Not worth fixing retroactively; worth avoiding next time by keeping each commit buildable.

**`hyqsim_ai_description.tex`** is uncommitted and unreferenced. Commit it, gitignore it, or
delete it.

---

## 7. Known functional gaps

**The Python backend supports fewer gates than the palette.** `backend/simulation/bosonic.py`
(`SUPPORTED_QUMODE_GATES` line 35, `SUPPORTED_HYBRID_GATES` line 37) rejects `xcdisp`,
`ycdisp`, `jc`, `custom_cv` and `custom_cvdv`. The AI is told via the `!py` marker in the gate
reference and `run_simulation` returns a clear error, but the underlying gap remains. If
these are implemented in bosonic.py, update `PYTHON_BACKEND_GATES` in
`frontend/src/ai/hqc.ts` in the same change — a test enforces the shared catalogue but not
this set.

**JC Trotter and the Rabi plot are disabled.** `frontend/src/benchmarks/sweep.ts` is stubbed
and `jcTrotterCircuit` is commented out in `circuits.ts`, as is `RabiPlot.tsx` in `App.tsx`.
Re-enabling would also restore a fourth benchmark for the assistant.

**Remote MCP transport is not built,** so claude.ai in a browser cannot connect — only
clients that can launch a local process. The logic is already isolated in `session.py` and
`hqc.py` so a streamable-HTTP shell can be added without reimplementing the tools, but it
brings hosting, auth and abuse-surface obligations.

**No local-model provider.** Adding an Ollama or LM Studio entry to `MODEL_OPTIONS` is about
20 lines, since the OpenAI wire format already exists, and would give unlimited free testing
without any quota wall. Deliberately skipped as out of scope.

---

## Constraints worth remembering

- **The assistant must never compute physics.** Every number it reports comes from HyQSim's
  simulator. `run_simulation` triggers the real thing and returns what it produced. Do not
  add a tool or prompt instruction that lets the model calculate a result.
- **Explain and analyze requests cannot modify the canvas.** `MUTATING_TOOLS` are refused for
  those intents in `ChatPanel.handleToolCall`. A new mutating tool must be added to that set.
- **Two HQC implementations must stay in sync.** `frontend/src/ai/hqc.ts` and
  `backend/simulation/hqc.py` are checked against `shared/gates.json` and
  `shared/hqc_cases.json`. After changing the gate palette run
  `cd frontend && npm run ai:gatespec`, or the tests fail.
- **Sanity checks must not produce false positives.** A warning that fires wrongly teaches the
  model to ignore the real ones. Only add a check for a failure actually observed — and note
  that the Fock-state check reads the user's wording, because `m0=2` is correct for "Fock
  state 2" and wrong for "alpha=2".
- **Measure token changes.** `npm run ai:budget` costs nothing and the system prompt is paid
  for on every request. Adding reliability rules cost ~2 points of the saving once already.
- **Groq for iteration.** Weakest tool-caller of the options, but a workable request budget.
  Gemini follows instructions better with a much smaller free tier; MCP has no quota wall at
  all but requires typing in the AI client rather than the browser.
