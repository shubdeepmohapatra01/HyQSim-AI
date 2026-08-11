# Changelog

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
