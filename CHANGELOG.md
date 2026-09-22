# Changelog

## Groq drops the Llama line — 2026-08-19

Groq deprecated `llama-3.3-70b-versatile` and `llama-3.1-8b-instant` on 2026-06-17 and shut
them off for the free and developer tiers on 2026-08-16. Both were in `MODEL_OPTIONS`, and
both were what the docs told a new user to pick — so the free path into the assistant was a
404 whose message ("model not found") reads like a broken key.

### What changed

- **Groq registry replaced** (`ai/providers.ts`) with the ids Groq names as the migration
  targets: `openai/gpt-oss-120b` (the default free choice, and the replacement for 70B
  versatile), `openai/gpt-oss-20b`, and the preview `qwen/qwen3.6-27b` — the only free Groq
  model that still does parallel tool calls.
- **Provider routing handles vendor-prefixed ids.** Groq serves models as `openai/…` and
  `qwen/…`, which collide with the naming of other providers. `providerForModel` now matches
  a Groq prefix list *before* the bare-name rules, so `openai/gpt-oss-120b` routes to Groq
  while `gpt-4o` still routes to OpenAI. Mirrored in `_AI_PROVIDERS` in `backend/main.py`,
  which the server-key proxy uses.
- **Saved selections migrate.** The chosen model lives in `localStorage`, so a returning user
  still carried a dead Llama id — and because it was no longer in `MODEL_OPTIONS`, the base
  URL silently fell back to Anthropic's, sending a Groq model to the wrong host. Retired ids
  are now rewritten on read via `RETIRED_MODELS` / `resolveModelId`.
- **One routing rule instead of four.** `evals/probe.ts`, `evals/live.ts` and `evals/models.ts`
  each carried their own copy of the model→provider prefix logic; all three now call
  `providerForModel`. The copies were exactly the sort of thing that drifts — and had already
  drifted from the frontend on the Together and Google prefixes.
- **Docs** (`README.md`, `AI_GUIDE.md`, `WALKTHROUGH.md`) point at GPT-OSS 120B as the free
  default, and record why the Llama-specific parsing workarounds in `ai/client.ts` and
  `ai/providers.ts` are being kept.

### One bug the swap exposed

`npm run ai:probe --model openai/gpt-oss-120b` found that Groq returns **400 "Tool choice is
required, but model did not call a tool"** when `tool_choice: 'required'` is set and the model
answers in prose instead. gpt-oss reasons before it calls, so this is reachable in ordinary
use. `client.ts` already had the right recovery — downgrade to `tool_choice: 'auto'` and retry
— but `isToolNameValidationError` only matched Llama's two error strings, so on the new
default model this surfaced to the user as a bare 400. The matcher now covers it, with tests
for all three recovery paths plus a negative case (an unrelated error must still surface).

### Verified

Offline: `ai:replay` (137, including new registry, routing and recovery tests), `ai:budget`,
and the backend suite (52).

Live, against the real Groq API on `openai/gpt-oss-120b`:

- `ai:models --verify` — all three new ids callable; the key lists no Llama model at all.
- `ai:probe` — every request feature accepted except the forced tool call noted above.
- `ai:live` — **28/31**. All seven optimize cases that mutate the canvas pass, including
  `optimize-ghz-5`, which correctly rewrote the depth-5 CNOT chain as a balanced doubling
  tree and re-simulated. Remaining failures: `optimize-cv-merge` (real — see `NEXT_STEPS.md`)
  and two `expectMentions` vocabulary misses (`analyze-output` said "photon-number
  distribution" rather than "fock"; `optimize-already-minimal` said "already optimal" rather
  than "minimal"). Both were substantively correct answers.

## Circuit optimization — 2026-08-13

"Optimize this circuit" now reaches the canvas. It did not before, for two reasons that were
easy to miss because the assistant described an optimization convincingly either way.

**It was classified as a read-only request.** `classifyIntent` knew `build`, `explain` and
`analyze`; none of *optimize*, *simplify*, *reduce*, *shorten* or *parallelize* appeared in
any keyword list, so an optimize request fell through to the `explain` default — where the
mutating tools are stripped from the request entirely and refused if the model calls one
anyway. The assistant could only ever talk about the rewrite.

**Depth was not a real quantity.** Every gate decoded from HQC got its own column
(`nextGateX` = `maxX + 80`), so a circuit's depth was always exactly its gate count. A model
that "parallelized the CNOTs" changed nothing measurable or visible.

### What changed

- **New `optimize` intent** (`ai/intent.ts`) with its own keyword list, checked *before*
  `build` — an optimize request is usually phrased with a build verb too. It forces a tool
  call, and it auto-runs the simulator first so the model has the state it must preserve.
- **`OPTIMIZE_RULES` prompt block** (`ai/tools.ts`), assembled only for this intent. It names
  the rewrites the model may trust, tells it to rebuild the whole circuit in one
  `build_circuit` call, tells it to change nothing when nothing safe applies, and tells it to
  re-simulate afterwards and compare against the before-state.
- **ASAP scheduling** (`ai/hqc.ts`: `circuitDepth`, `packColumns`, `layoutColumns`). Gates
  whose wires never meet now count as simultaneous, so depth is a genuine second measure
  alongside gate count: `h q0; h q1; h q2` is 3 gates at depth 1. Per-wire ordering is
  untouched, so simulation semantics are identical — gates sharing a step commute by
  construction.

  **Depth and layout are deliberately separate.** `circuitDepth` counts endpoints only: the
  physics. `packColumns` additionally blocks the wires a two-wire gate *spans*, because the
  canvas draws a connector across the gap and a gate in the same column would be drawn
  through it. They disagree for exactly the circuits worth optimizing — a doubling-tree GHZ
  is depth 1+⌈log₂n⌉ but its parallel CNOTs cross, so the drawing needs more columns than
  the circuit needs steps. Qiskit splits this the same way (`depth()` vs its drawer). A first
  cut used span-blocking for both and reported the 8-qubit tree as depth 8 instead of 4,
  which would have made "reduce the depth" unwinnable — the exact request the feature exists
  to serve.
- **The depth rules are structural, not a catalogue of known circuits.** `OPTIMIZE_RULES`
  gives two levers — fewer gates on the critical path, or a shorter critical path for the
  same result (extending from every wire that already carries the state, so a line becomes a
  balanced tree and *k* steps become ~log₂*k*) — and states that reordering is *not* a lever,
  because `packColumns` already schedules independent gates together whatever order they were
  written in. Without that, a model "parallelizes" by shuffling its gate list and claims a win
  it did not produce, which is what the original GHZ report turned out to be.
- **`gates=N depth=M`** is appended to the `[Canvas:]` snapshot. Deliberately *not* added to
  `encodeCircuit`, whose output is mirrored byte-for-byte by `backend/simulation/hqc.py` and
  asserted by `shared/hqc_cases.json`.
- **Optimize turns get a per-wire transposition of the gate list** (`encodeByWire`). Scheduling
  independent gates into the same step means the `G …` line no longer shows a wire's own gates
  consecutively: `#1 h q0; #2 x q1; #3 h q0; #4 x q1` is two cancelling pairs that read as four
  isolated gates. A live session on llama-3.3-70b failed exactly here, reporting "the two H
  gates cancel and the two X gates combine into a single X" — half a cancellation and an
  invented merge. The rules also now say that a parameterless gate can never "merge" (it
  cancels or stays), that a self-inverse pair removes *both* gates, and that a circuit which
  cancels away entirely is a valid result rather than a mistake to avoid.
- **Revert.** `App.tsx` keeps the circuit as it stood before the last wholesale replacement,
  and any chat message that replaced the canvas carries a **↩ Revert** button. There was no
  undo of any kind before this, and an optimize rewrites everything.

### What this deliberately does not do

There is no local gate-cancellation pass and no automatic equivalence check: HyQSim applies
what the model proposes. Robustness comes from intent routing, the prompt, the metrics fed
back to the model, and the fact that a bad rewrite costs one click to undo. A deterministic
optimizer and a simulate-both-and-compare gate are the obvious next step if model-proposed
rewrites turn out not to be good enough.

### Tests

`npm run ai:replay` is at 116 tests (was 94). New coverage: column packing (including that a
GHZ CNOT chain is genuinely irreducible at depth *n*, and that a two-wire gate blocks the
wires it spans), optimize-case replay with `maxGates` / `maxDepth` bounds and a "must not
grow" assertion, optimize-vs-explain classification, and the prompt/tool scoping per intent.
`ai:live` fails an optimize case that leaves the circuit larger or deeper than it found it.

## AI overhaul — 2026-08-11

Rebuilt the AI assistant around three problems: it burned tokens fast enough to rate-limit
free tiers on simple requests, it produced physically wrong circuits with confidence, and it
sometimes rewrote a circuit when asked to explain one. Also adds an MCP server so the
simulator can be driven from Claude Desktop or Claude Code without an API key.

### Token efficiency

Measured by `npm run ai:budget` across a 21-prompt suite. No API calls; it constructs the
exact request bodies both the old and new designs send and counts tokens.

| | Before | After |
|---|---|---|
| API round-trips | 120 | **35** |
| Input tokens | 191,736 | **46,493** (−76%) |
| Build a 4-qubit GHZ | 10 trips, 15,911 tok | **2 trips, 3,067 tok** (−81%) |
| Build a cat state | 12 trips, 20,192 tok | **2 trips, 3,121 tok** (−85%) |
| Explain a circuit | 2 trips, 3,048 tok | **1 trip, 506 tok** (−83%) |
| 10-turn conversation | 3,596 tok | **890 tok** (−75%) |

Four changes account for it:

- **`build_circuit` builds a whole circuit in one call.** Previously each gate was its own
  round-trip — clear, then one call per wire, then one per gate — and every round-trip
  resent the entire conversation, so cost grew quadratically with circuit size.
- **HQC notation** (`ai/hqc.ts`) replaced the prose circuit format. A Bell state snapshot
  went from 103 tokens to 22.
- **Only the newest message carries a canvas snapshot.** Older turns previously kept a full
  stale copy of the circuit and its results forever.
- **The system prompt and tool list are scoped to intent.** An explain request cannot build
  anything, so it no longer receives the gate catalogue, the benchmark list, or the mutating
  tool schemas: 1,424 tokens of fixed overhead for a build, **451** for a read-only request.

### Physical correctness

- **`load_benchmark` tool.** The repo's verified circuits (`benchmarks/circuits.ts`) are now
  available to the assistant. Asked for a cat state, a language model reliably produces
  `H → CD` and stops — an aborted preparation that leaves the qubit entangled with the mode.
  The correct construction is eight gates. It now loads that instead of improvising, and the
  benchmark's Fock truncation comes with it (the cat needs 32; at 8 the state is clipped).
- **Sanity checks** (`ai/sanity.ts`) run on every circuit the AI builds and append a `CHECK:`
  note to the tool result, so the model can correct itself before it starts explaining.
  Catches: aborted cat-state preparations, wires with no gates, qumodes initialised to a Fock
  state when a coherent amplitude was meant, and idle qubits in a multi-qubit circuit.
- **Intent classification** (`ai/intent.ts`) decides whether a request may modify the canvas
  and whether the simulator auto-runs. Explain and analyze requests have mutating tools
  refused outright.
- **The AI never computes physics.** `run_simulation` triggers HyQSim's own simulator and
  returns what it produced; the model is instructed never to state a number absent from a
  `[Simulation:]` block.

### MCP server

`backend/mcp_server.py` — drive HyQSim from Claude Desktop or Claude Code using an existing
subscription rather than an API key.

```
Claude Desktop --stdio--> mcp_server.py --HTTP--> FastAPI session store
                                                        |  WebSocket
                                                        v
                                                 browser canvas
```

The backend holds the circuit (`backend/session.py`); the browser subscribes and re-renders
live. Simulation requests are forwarded to the browser, which runs the simulator with the
user's selected backend and posts results back. Sessions auto-pair when one tab is open.

### Wigner encoding

An 80×80 Wigner grid is 6,400 floats — unaffordable to send and unreadable as a number soup.
`simulation/wignerFeatures.ts` reduces it to ~40 tokens of the things a physicist would name:
negativity volume, the most negative point and its location, lobe and fringe counts, fringe
spacing, symmetry class, and quadrature variances against a vacuum of 1.00.

The Wigner computation itself moved out of `QumodeDisplay.tsx` into `simulation/wigner.ts`,
so the AI and the on-screen plot are guaranteed to describe the same numbers.

### Testing

None of this existed before; there were no tests in the repository.

| Command | What it does | Cost |
|---|---|---|
| `npm run ai:replay` | 94 tests: notation, validation, intent routing, sanity checks, benchmark parity | free |
| `npm run ai:budget` | The token table above | free |
| `npm run ai:models` | Which models a key can actually use; `--verify` calls each one | ~1 request/model |
| `npm run ai:probe` | Which request features a provider accepts, when a 400 says nothing useful | ~10 tiny requests |
| `npm run ai:live` | The real prompt suite against a provider; `--compare a,b` for side-by-side | spends tokens |
| `pytest backend/tests/` | 52 tests: HQC parity with TypeScript, MCP end-to-end with a fake browser | free |

`shared/gates.json` and `shared/hqc_cases.json` are generated from the TypeScript source by
`npm run ai:gatespec`. Both test suites read them, so the Python and TypeScript HQC
implementations cannot drift apart.

### Bugs fixed

Several were found by the new tests rather than by inspection.

| Bug | Impact |
|---|---|
| Eval reference for the cat state asserted a 2-gate circuit | The test suite passed the aborted preparation the model produced — a wrong reference is worse than no test |
| Intent classifier matched substrings | "dis**place**ment" and "out**put**" registered as build verbs, so *"what output will this give?"* could rebuild the canvas |
| `element-${Date.now()}` collided | Batch placement (benchmarks, `build_circuit`) produced duplicate ids, breaking gate removal |
| Shadow-state `pending-` ids | `remove_gate` failed after `add_gate` in the same turn; replaced by positional `#N` refs |
| Provider prefix map duplicated 3× and inconsistent | A model could show a "server key available" star and then fail to route. Together AI could never route at all |
| `Retry-After` dropped by the proxy | Rate-limited clients fell back to blind exponential backoff instead of the delay the provider asked for |
| `/ai/chat` unauthenticated | Anyone reachable could spend the server's API credits on a caller-controlled body. Added optional `AI_PROXY_TOKEN` and a per-IP rate limit |
| Hand-rolled `.env` parser | Mishandled quotes and `export` prefixes, producing keys with literal quotes and opaque 401s. Now uses `python-dotenv` |
| No markdown rendering | `**bold**` and `##` appeared literally in chat |
| `run.sh` failed silently without a venv | The backend died while the frontend started fine, so nothing looked wrong |
| Python backend gate gap | `xcdisp`, `ycdisp`, `jc` and custom gates are browser-only; the AI could build circuits the selected backend would reject. Now flagged in the gate reference and by `run_simulation` |
| MCP tool schemas advertised `args`/`kwargs` | An error-handling decorator erased the type signatures, leaving every MCP tool uncallable |
| Retired Gemini model ids | `gemini-2.0-flash` and `gemini-1.5-pro` both 404'd; the whole 2.5 generation is closed to new keys while still being listed |

### Files

**New**

```
AI_GUIDE.md, WALKTHROUGH.md, CHANGELOG.md, docs/images/
frontend/src/ai/hqc.ts            HQC notation: encode, decode, validate
frontend/src/ai/intent.ts         build / explain / analyze classification
frontend/src/ai/sanity.ts         structural checks on AI-built circuits
frontend/src/ai/benchmarks.ts     exposes verified circuits to the assistant
frontend/src/ai/evals/            prompt suite + 6 test/diagnostic runners
frontend/src/mcp/session.ts       WebSocket bridge for external AI clients
frontend/src/simulation/wigner.ts          Wigner computation, shared with the display
frontend/src/simulation/wignerFeatures.ts  grid → ~40 tokens of physical features
frontend/src/components/ChatMarkdown.tsx   minimal markdown renderer
frontend/src/components/McpSessionBadge.tsx
backend/mcp_server.py             MCP server (stdio)
backend/session.py                live canvas sessions
backend/simulation/hqc.py         Python mirror of ai/hqc.ts
backend/tests/                    pytest suites
shared/                           generated gate catalogue + golden fixtures
```

**Substantially changed**: `ai/tools.ts`, `ai/providers.ts`, `ai/client.ts`,
`ai/circuitToPrompt.ts`, `components/ChatPanel.tsx`, `App.tsx`, `backend/main.py`, `run.sh`.

### Known gaps

- **`load_benchmark` does not work over MCP.** The benchmark circuits are TypeScript, so
  Claude Code will still improvise a cat state. Fixable by routing the request through the
  browser the way `run_simulation` already is.
- **Anthropic, OpenAI and Mistral model ids are unverified** against a live key. Check with
  `npm run ai:models -- --verify` before relying on them.
- **Remote MCP transport is not implemented**, so claude.ai in a browser cannot connect —
  only Claude Desktop and Claude Code, which can launch a local process.
