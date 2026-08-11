# Using AI with HyQSim

HyQSim's AI assistant works in two directions:

- **Describe a circuit in words** → it appears on the canvas.
  *"I want to create a cat state circuit using a qubit and qumode"*
- **Point at the canvas** → it explains the physics.
  *"What kind of output will this circuit give?"*

There are two ways to connect an AI, and they cost very different things.

| | In-app chat panel | MCP (Claude Desktop / Claude Code) |
|---|---|---|
| **What you need** | An API key (Groq's free tier works) | A Claude subscription you already pay for |
| **Cost per message** | API tokens | Nothing extra |
| **Setup** | Paste a key into the app | One config file, once |
| **Where you type** | Inside HyQSim | In Claude, watching the HyQSim tab |
| **Works offline from Claude** | Yes | No — needs the desktop app open |
| **Best for** | Quick edits while you work | Long sessions, deep analysis, no token anxiety |

Both drive the same simulator and use the same circuit notation. Use whichever suits the moment; they can even be used at the same time.

> **The AI never computes physics.** It builds circuits and explains results, but every number it reports comes from HyQSim's own simulator. If it needs numbers it does not have, it triggers a simulation run and waits. This is enforced in code, not just requested in the prompt.

---

## Option 1 — The in-app chat panel

The chat panel sits below the circuit canvas. Click **AI Assistant** to expand it.

### Getting a key

| Provider | Free tier | Where |
|---|---|---|
| **Groq** | Yes, no card required | [console.groq.com](https://console.groq.com) |
| **Google Gemini** | Yes, generous limits | [aistudio.google.com](https://aistudio.google.com) |
| Anthropic | No | [console.anthropic.com](https://console.anthropic.com) |
| OpenAI | No | [platform.openai.com](https://platform.openai.com) |
| Mistral | No | [console.mistral.ai](https://console.mistral.ai) |

**Groq with Llama 3.3 70B** is the practical default: no credit card, and a request budget
you can actually work with. It is the weakest tool-caller of the options here, which is why
the assistant leans on verified circuits and self-correcting errors rather than trusting the
model's memory.

**Gemini** models are also free and follow instructions better, but the free tier is tight
(one model reported a quota limit of 5 requests) and Google closes older generations to new
keys while still listing them. Verify before relying on one:

```bash
GOOGLE_API_KEY=your_key npm run ai:models -- --verify
```

Confirmed callable on a new key (2026-08-11): `gemini-3.5-flash`, `gemini-3.5-flash-lite`,
`gemini-3.6-flash`, `gemini-flash-latest`. The whole 2.5 generation is closed to new keys.

> **Getting a 404?** The model id has almost certainly been retired — providers drop them
> regularly, and Google in particular moves fast. Do not guess replacements; ask:
>
> ```bash
> GOOGLE_API_KEY=your_key npm run ai:models
> ```
>
> That lists exactly what your key can use and flags any dead entries in HyQSim's registry.
> Then update `MODEL_OPTIONS` in `frontend/src/ai/providers.ts` with a live id.

1. Pick a model from the dropdown.
2. Paste your key. It is stored in your browser's `localStorage` and never sent anywhere but that provider.
3. Type a request.

### Server-side keys (for shared deployments)

If you are hosting HyQSim for a group, put the keys on the server instead so users need none of their own. Copy `backend/.env.example` to `backend/.env` and fill in whichever keys you have. Models with a server key show a ★ in the dropdown, and a green "Server key available" banner appears.

**If your backend is reachable from the internet, set `AI_PROXY_TOKEN`.** The proxy spends your API credits on a request body the caller controls; without a token, anyone who can reach it can run any prompt they like on your bill. Set the same value as `VITE_AI_PROXY_TOKEN` in `frontend/.env`. `AI_RATE_LIMIT_PER_MIN` (default 20) caps requests per IP.

---

## Option 2 — MCP: drive HyQSim from Claude

This connects HyQSim to Claude Desktop or Claude Code, so you can say *"build me a 4-qubit GHZ in HyQSim"* and watch it appear on the canvas. Your Claude subscription pays for the thinking; no API tokens are involved.

### Setup

**1. Install the MCP SDK**

```bash
cd backend
pip install -r requirements.txt      # or just: pip install 'mcp>=2.0.0'
```

**2. Start the backend and the frontend**

```bash
cd backend  && uvicorn main:app --reload --port 8000
cd frontend && npm run dev
```

**3. Register the server with your AI client**

Claude Code:

```bash
claude mcp add hyqsim -- python3 /absolute/path/to/HyQSim-AI/backend/mcp_server.py
```

Claude Desktop — edit `claude_desktop_config.json` and restart the app:

| OS | Path |
|---|---|
| macOS | `~/Library/Application Support/Claude/claude_desktop_config.json` |
| Windows | `%APPDATA%\Claude\claude_desktop_config.json` |

```json
{
  "mcpServers": {
    "hyqsim": {
      "command": "python3",
      "args": ["/absolute/path/to/HyQSim-AI/backend/mcp_server.py"]
    }
  }
}
```

**4. Turn on the bridge in HyQSim**

Open HyQSim in a browser and click **AI Connect** in the header. It turns green and shows a 6-character session code.

**5. Ask for a circuit**

> Build a 4-qubit GHZ state in HyQSim, then run the simulation and tell me what the measurement distribution should look like.

The circuit appears on the canvas as Claude builds it.

### About the session code

You only need it when **more than one** HyQSim tab is open. With a single tab, the MCP server pairs automatically. With several, tell Claude which one:

> Use HyQSim session 7F2K9Q

### How it fits together

```
Claude Desktop ──stdio──▶ mcp_server.py ──HTTP──▶ FastAPI session store
                                                        │  WebSocket
                                                        ▼
                                              your browser canvas
```

The backend holds the circuit; the browser subscribes and re-renders live. When Claude asks for results, the request is forwarded to **your browser**, which runs HyQSim's simulator using whichever backend you selected, and sends back what it produced.

### If a browser is not attached

The MCP tools still work, falling back to the server-side bosonic-qiskit simulator. That backend supports fewer gates than the palette, so `xcdisp`, `ycdisp`, `jc`, and the custom-generator gates need a browser tab. The tools say so explicitly rather than failing quietly.

### MCP tools

| Tool | Purpose |
|---|---|
| `hyqsim_build_circuit` | Build or replace the whole circuit in one call |
| `hyqsim_add_gate` | Append one gate |
| `hyqsim_remove_gate` | Delete one gate by its number |
| `hyqsim_clear` | Empty the canvas |
| `hyqsim_read_circuit` | Read what is on the canvas |
| `hyqsim_run_simulation` | Run HyQSim's simulator and return its results |
| `hyqsim_get_results` | Re-read the last results without re-running |
| `hyqsim_list_gates` | The full gate catalogue |
| `hyqsim_list_sessions` / `hyqsim_use_session` | Pick a canvas when several are open |

---

## Keyword glossary

What you say determines what the assistant does — in particular, whether it is *allowed* to change your circuit and whether it runs the simulator. There are three intents, decided from your wording before anything is sent to the model.

### `build` — changes the circuit

Triggered by: **build, create, make, construct, generate, prepare, implement, add, place, insert, put, append, remove, delete, drop, clear, reset, erase, modify, change, replace, set, update, edit, swap, rename, undo, move, rewire**

- The assistant is required to make a tool call rather than describe one.
- The simulator is **not** run — press **Run Simulation** when you want results.

### `explain` — describes the circuit

Triggered by: **explain, describe, what is, what are, what does, why, how does, how do, interpret, walk me through, summarize, tell me about, meaning, purpose**

- The assistant is **blocked from modifying the canvas.** If the model tries, the tool call is refused and it is told to answer from the snapshot instead.
- The simulator is not run; the answer comes from the circuit's structure.

### `analyze` — describes the results

Triggered by: **what output, what result, what will, what would, what happens, analyze, evaluate, predict, outcome, output, result, measure, measurement, distribution, histogram, counts, probability, amplitude, expectation, wigner, negativity, fock, photon number, squeez…, bloch, entangle…, fidelity, purity, simulate, simulation, run it, phase space, quadrature, ⟨n⟩**

- The assistant is **blocked from modifying the canvas.**
- **The simulator runs automatically** if there are no current results. If you already pressed Run and have not changed the circuit since, the existing results are reused.

### Precedence

1. A message containing any **build** word is a build, even if it also asks about results — *"add a squeeze gate and tell me the photon number"* adds the gate first.
2. Otherwise **analyze** wins over **explain**, because answering a results question without numbers is useless.
3. Unrecognised phrasing is treated as **explain**. Guessing "build" would let a misread question wipe your canvas.

These lists live in `frontend/src/ai/intent.ts` and are covered by tests, so this table and the code stay in step.

---

## Prompt examples

### Verified circuits

HyQSim ships reference circuits that are known-correct. The assistant loads these rather
than reconstructing them, because a language model asked for a "cat state" will confidently
produce `H → CD` and stop — which is an *aborted* preparation: the qubit is still entangled
with the mode, so it is not a cat state at all. The real construction is eight gates.

| Prompt | What it loads |
|---|---|
| `Create a cat state circuit with a qubit and qumode` | `cat-state` — H → CD(α/√2) → H → S† → H → CD(iπ/(8α√2)) → H → S, Fock 32 |
| `Build a cat state with alpha = 2` | Same, with α passed through. **α is a coherent amplitude, not an initial Fock state.** |
| `Transfer the state from the qumode to 3 qubits` | `cv-to-dv` (parameters: `n`, `lambda`) |
| `Transfer from qubits back to the qumode` | `dv-to-cv` |

Loading a benchmark also sets the Fock truncation it needs — the cat state requires 32, and
at the default 8 the distribution is badly truncated.

### Building

| Prompt | Result |
|---|---|
| `Build a Bell state circuit` | 2 qubits, H on q0, CNOT q0→q1 |
| `I want to make a 4-qubit GHZ circuit` | 4 qubits, H then a chain of 3 CNOTs |
| `I want to create the Fourier Transform circuit for CV circuits` | 1 qumode, phase-space rotation by π/2 |
| `Create a squeezed vacuum state` | 1 qumode with a squeeze gate |
| `Build a two-mode squeezed state using a beam splitter` | 2 qumodes, squeezing on each, beam splitter between |
| `Create a circuit with one qubit in \|+⟩ and a qumode in Fock state 2` | Sets initial states rather than adding gates |
| `Build a Jaynes-Cummings interaction between a qubit and a qumode` | q0 + m0 with a JC gate |

### Editing

| Prompt | Result |
|---|---|
| `Add a Hadamard gate on q2` | Appends one gate; leaves the rest alone |
| `Remove the last gate` | Deletes it by position |
| `Add another qumode to the circuit` | Appends a wire |
| `Change the displacement to alpha = 2.5` | Adjusts parameters in place |

### Explaining and analysing

| Prompt | What you get |
|---|---|
| `Explain the circuit on the canvas` | Names the state and explains why the gates produce it |
| `What kind of output will this circuit give?` | Runs the simulator, then interprets the real numbers |
| `Analyze the circuit results and the circuit structure` | Both together |
| `Is the Wigner function of this state non-classical?` | Reads the negativity volume and fringe structure |
| `What measurement distribution would I see?` | Reports the actual bitstring histogram |
| `Why is a conditional displacement used here instead of a plain displacement?` | Physics explanation, no canvas changes |

---

### Writing prompts that work

- **Be specific about wire counts and types.** `"a 2-qubit Bell state"` beats `"a Bell state"`
  on smaller models, and `"on a single qumode"` matters more than it should — weaker models
  will otherwise build qubit wires for a continuous-variable request.
- **State parameters in the prompt**: `"a cat state with alpha = 2"`, `"squeezing r = 0.8"`.
- **Correct it conversationally** rather than starting over: `"the displacement should be
  alpha = 2.0, not 1.0"`, `"use a qumode m0, not qubits"`.
- **Ask for known circuits by name** — "cat state", "CV to DV transfer". The assistant then
  loads HyQSim's verified construction instead of improvising one.
- **Run the simulation before asking for an explanation**, or use an `analyze` phrasing that
  runs it automatically (see the glossary above).

### Model-specific quirks

**Llama 3.3 70B (Groq)** — free and fast, but the weakest tool-caller here:

| Behaviour | What to expect |
|---|---|
| **Tool call format** | Sometimes emits `<function=...>` as plain text; the assistant detects and executes those anyway |
| **Continuous-variable requests** | Its weakest area. May build *qubit* wires for a qumode request. Say `"use a qumode wire m0, not qubits"` if so |
| **Circuit size** | Reliable to roughly 6–8 gates; break very large circuits into steps |
| **Parameters** | Often writes `1.5708` rather than `pi/2` — numerically the same, both accepted |
| **Rate limits** | TPM-metered free tier; the assistant backs off and retries automatically |

**Gemini Flash** — better instruction-following, but a small free-tier request budget and
Google closes older generations to new keys. Verify with `npm run ai:models -- --verify`.

**Claude / GPT-4o** — the most reliable tool-callers; none of the fallback parsing above is
needed for them. Paid keys only.

## HQC — the circuit notation

Both the chat panel and the MCP server describe circuits in a compact notation called HQC. You do not have to learn it, but you can use it directly in a prompt, and you will see it in the assistant's tool calls.

```
W q0 q1 m0
G #1 h q0; #2 cnot q0>q1; #3 displace m0 1.5,0
```

- **`W`** — wires in order. `q0, q1, …` are qubits; `m0, m1, …` are qumodes.
  Non-default initial states are written `q0=+` (from `0 1 + - i -i`) or `m0=2` (Fock 0–5).
- **`G`** — gates left to right, separated by `;`. Each is `<gateId> <wire>[><target>] [params]`.
- **`#1, #2, …`** — a gate's position, used to refer to it (*"remove #3"*).
- **Parameters** are positional in the gate's declared order and omitted when they are at their defaults. Angles are in radians, and `pi`, `pi/2`, `3pi/4`, `2*pi` all work.

Two-wire gates always list the primary wire first:

| Gate | Order |
|---|---|
| `cnot` | control `>` target |
| `bs` | qumode `>` qumode |
| `cdisp`, `xcdisp`, `ycdisp`, `cr`, `jc` | **always** qubit `>` qumode |

Ask the assistant for the full gate list, or run `hyqsim_list_gates` over MCP. Gates marked `!py` run only on the browser backend.

---

## What the assistant sees

Every message carries a compact snapshot of the canvas and the latest results:

```
[Canvas: W q0 m0
G #1 h q0; #2 cdisp q0>m0 2,0]
[Simulation: fock=8 backend=browser
q0 psi=0.7071|0>+0.7071|1> B=(1,0,0)
m0 <n>=2.013 |0>:13.5% |1>:27.1% |2>:27.1% |3>:18.0% |4>:9.0%
m0 W: neg=0.281 min=-0.312@(0.00,1.41) lobes=2 fringes=5/spacing=0.62 sym=x-mirror <x>=0 <p>=0 varX=4.02 varP=1.01 (vac=1.00)]
```

Wigner plots are the interesting case. The raw grid is 80×80 = 6400 numbers — far too many to send, and meaningless to a language model as a wall of digits. Instead HyQSim sends the things a physicist would actually name: negativity volume, where the most negative point sits, how many interference fringes there are and how far apart, the symmetry, and the quadrature variances against a vacuum of 1.00. That is about 40 tokens and supports real reasoning about non-classicality.

---

## Token cost

The assistant was rebuilt around not wasting your quota. Measured with `npm run ai:budget` across the 20-prompt suite:

| | Before | After |
|---|---|---|
| API round-trips | 120 | **35** |
| Input tokens | 191,736 | **46,493** (−76%) |
| Building a 4-qubit GHZ | 10 round-trips, 15,911 tokens | **2 round-trips, 3,067 tokens** (−81%) |
| Building a cat state | 12 round-trips, 20,192 tokens | **2 round-trips, 3,121 tokens** (−85%) |
| Explaining a circuit | 2 round-trips, 3,048 tokens | **1 round-trip, 506 tokens** (−83%) |
| Canvas snapshot (GHZ-4) | 182 tokens | **46 tokens** (−75%) |
| 10-turn conversation | 3,596 tokens | **890 tokens** (−75%) |

Fixed overhead is scoped to the intent, because an explain request cannot build anything:

| Sent every round-trip | Old | build | explain/analyze |
|---|---|---|---|
| System prompt + tool schemas | 1,274 | 1,424 | **451** |

Build requests carry a little more than the old design (the gate catalogue and the verified-
circuit list), and repay it many times over by not making one round-trip per gate. Read-only
requests — the most common kind — carry neither, since the tools they would name are refused
anyway.

Three changes account for most of it:

1. **Whole circuits are built in one call.** Previously each gate was its own API round-trip — clear, then one call per wire, then one per gate — and every round-trip resent the entire conversation, so cost grew quadratically with circuit size.
2. **Only the newest message carries a snapshot.** Older turns keep the text but drop their stale copy of the circuit and results.
3. **Explaining no longer forces a tool call**, and no longer carries the gate catalogue or the mutating tool schemas. The old assistant was compelled to call `read_circuit` on its first turn even when the answer was already in front of it.
4. **Verified circuits are loaded, not rebuilt.** A cat state is one `load_benchmark` call instead of twelve round-trips of gate-by-gate improvisation — and it comes out correct.

### The model matters as much as the token count

Not all models drive this equally well. **Llama 3.3 70B on Groq is the weakest tool-caller
of the options here** — the codebase carries three workarounds that exist solely for it:
recovering tool calls it emits as `<function=...>` plain text, handling it putting JSON
arguments *inside* the function name, and stripping `<|python_tag|>` from replies. None are
needed for Claude, GPT-4o, or Gemini. It is also the most likely to ignore a soft
instruction such as "call `load_benchmark` rather than rebuilding".

**If circuits come out subtly wrong, try a different model before rewriting the prompt.**
The Gemini Flash models follow instructions better than Llama, but their free tier is small
enough that Groq is usually the more practical choice for iteration. A paid Anthropic or
OpenAI key, or the MCP route on an existing Claude subscription, avoids the quota wall
entirely.

To measure it rather than guess:

```bash
GROQ_API_KEY=... GOOGLE_API_KEY=... \
  npm run ai:live -- --compare llama-3.3-70b-versatile,gemini-3.6-flash
```

That writes `ai-eval-comparison.md` with a side-by-side scoreboard — passes, tool errors,
refused mutations, how often each model improvised instead of loading a verified circuit —
followed by the full transcripts for each.

### Still hitting rate limits?

Free tiers meter tokens per minute, not per request. If Groq rate-limits you, the assistant backs off and retries automatically (up to 3 times, capped at 30 s).

- **Switch to Gemini 2.0 Flash** — a much larger free-tier budget.
- **Clear the canvas** between unrelated circuits. This resets the conversation history.
- **Use MCP instead.** No API tokens at all.

---

## Testing the AI features

Three test runners live in `frontend/src/ai/evals/`. Two cost nothing.

### `npm run ai:models` — which models your keys can actually use

Asks each provider for its live model list and checks HyQSim's registry against it. Run this
first whenever a model starts returning 404.

```bash
GOOGLE_API_KEY=... npm run ai:models
GOOGLE_API_KEY=... GROQ_API_KEY=... npm run ai:models        # several at once
npm run ai:models -- --provider google --all                 # include non-chat models
npm run ai:models -- --verify                                # actually call each one
```

**Being listed is not the same as being usable.** Google lists models that are closed to new
keys and 404 on first call. `--verify` sends a one-token request to each registry entry,
paced to stay under free-tier rate limits, and reports which genuinely work.

Keys are read from the environment and never written anywhere.

### `npm run ai:probe` — which request features a provider accepts

OpenAI-compatible endpoints are not uniformly compatible. When a provider returns a 400 that
names nothing useful, this sends a ladder of tiny requests — each adding one feature
(`tool_choice: required`, `enum`, `additionalProperties`, multi-turn tool results, …) — and
reports the first that fails.

```bash
GOOGLE_API_KEY=... npm run ai:probe -- --model gemini-3.6-flash
npm run ai:probe -- --model llama-3.3-70b-versatile --delay 3000
```

Rate-limit responses are reported as *untested*, never as a rejection, and a failing baseline
aborts the run — a diagnostic that guesses is worse than none.

### `npm run ai:budget` — no API calls

Prints the token table above by constructing the exact request bodies both the old and new designs would send. Use it after changing the system prompt or tool schemas to see what it cost you.

### `npm run ai:replay` — no API calls

70 tests over the notation, validation, intent classification, and simulation-trigger policy. Feeds canned tool calls through the same code path the chat panel uses and asserts the resulting circuit.

### `npm run ai:live` — spends tokens

Runs the real prompt suite against a real provider and writes `ai-eval-report.md` with, for each case: the prompt, the tool calls made, the resulting circuit in HQC, the response, and pass/fail against the expected structure.

```bash
GROQ_API_KEY=gsk_...  npm run ai:live
ANTHROPIC_API_KEY=... npm run ai:live -- --model claude-haiku-4-5-20251001
npm run ai:live -- --model llama-3.3-70b-versatile --case ghz-4 --delay 8000

# Two models on the same suite → ai-eval-comparison.md
GROQ_API_KEY=... GOOGLE_API_KEY=... \
  npm run ai:live -- --compare llama-3.3-70b-versatile,gemini-3.6-flash
```

`--delay` (default 3000 ms) paces requests so a free tier's per-minute budget is not tripped.
Missing keys and unknown model ids are rejected before anything is spent.

### Backend tests

```bash
cd backend && python -m pytest tests/ -v
```

52 tests. `test_hqc.py` checks the Python notation parser against golden fixtures generated from the TypeScript one, so the MCP server and the in-app assistant cannot drift apart. `test_mcp_e2e.py` starts a real backend, attaches a fake browser tab, and drives the MCP tools through it.

Regenerate the shared fixtures after changing the gate palette:

```bash
cd frontend && npm run ai:gatespec
```

---

## Troubleshooting

**"Enter an API key above to get started"** — no key entered, and the backend has no server key for the selected model. Pick a ★ model or paste a key.

**AI Connect stays amber** — the backend is not running. Start it: `cd backend && uvicorn main:app --port 8000`.

**Claude says no HyQSim canvas is connected** — open HyQSim in a browser and click **AI Connect** until it turns green.

**Claude cannot see the MCP tools** — restart Claude Desktop after editing the config, and check the path in `args` is absolute. Verify the server runs standalone: `python3 backend/mcp_server.py` (it will wait silently on stdin — that is correct).

**The AI built something the simulator rejects** — you are on the Python backend and the circuit uses a browser-only gate (`xcdisp`, `ycdisp`, `jc`, custom generators). Switch to **Browser** in the right-hand panel.

**The assistant built an obviously wrong circuit** — if it looks like a truncated version of a known circuit, the sanity checker should have appended a `CHECK:` note telling it to use `load_benchmark`. Ask again, and if it still gets it wrong, run `npm run ai:live -- --case cat-state` and share the report.

**The assistant changed my circuit when I asked it to explain** — this should now be impossible; mutating tools are refused outright on explain and analyze requests. If it happens, the wording was classified as a build: check the glossary above and file it as a bug.

**Responses cite numbers that look wrong** — check that the results on screen were produced by the circuit currently on the canvas. Any edit clears the results, and the assistant is told when none exist.
