#!/usr/bin/env python3
"""
HyQSim MCP server — drive the simulator from Claude Desktop, Claude Code, or any other
MCP client, using your own AI subscription instead of API keys.

    Claude Desktop --stdio--> this process --HTTP--> HyQSim backend --WS--> browser canvas

Setup (Claude Desktop, ~/Library/Application Support/Claude/claude_desktop_config.json):

    {
      "mcpServers": {
        "hyqsim": {
          "command": "python3",
          "args": ["/absolute/path/to/HyQSim-AI/backend/mcp_server.py"]
        }
      }
    }

Or for Claude Code:

    claude mcp add hyqsim -- python3 /absolute/path/to/HyQSim-AI/backend/mcp_server.py

Requires the HyQSim backend to be running (uvicorn main:app --port 8000) and, for live
canvas updates, a HyQSim browser tab open. With exactly one tab open the session is
auto-paired and you never see a code.

Design note: this file is a thin transport shell on purpose. All the real logic lives in
session.py and simulation/hqc.py, so adding a remote streamable-HTTP transport later means
writing another shell rather than reimplementing the tools.

IMPORTANT: no tool here computes physics. `run_simulation` asks HyQSim to simulate and
returns what HyQSim produced. That is the whole point of having a simulator.
"""

from __future__ import annotations

import asyncio
import functools
import os
import sys
from typing import Any

import httpx

try:
    from mcp.server import MCPServer
except ImportError as exc:
    print(
        "The MCP SDK v2 is required. Install it with:\n\n    pip install 'mcp>=2.0.0'\n"
        f"\n(import failed: {exc})",
        file=sys.stderr,
    )
    raise SystemExit(1)

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from simulation import hqc  # noqa: E402

BACKEND_URL = os.getenv("HYQSIM_BACKEND_URL", "http://localhost:8000").rstrip("/")
HTTP_TIMEOUT = 130.0  # must exceed the backend's simulation timeout

# Set by hyqsim_use_session; None means auto-pair.
_pinned_session: str | None = None

mcp = MCPServer(
    name="hyqsim",
    instructions=(
        "HyQSim is a hybrid CV-DV quantum circuit simulator with a live browser canvas. "
        "Build circuits with hyqsim_build_circuit in ONE call rather than adding gates one "
        "at a time. Never compute simulation results yourself — call hyqsim_run_simulation "
        "and report what HyQSim returns."
    ),
)


class ToolError(Exception):
    """Message shown to the model. Written to be actionable, not just descriptive."""


# ─── Backend plumbing ─────────────────────────────────────────────────────────


async def _request(method: str, path: str, **kwargs) -> Any:
    url = f"{BACKEND_URL}{path}"
    try:
        async with httpx.AsyncClient(timeout=HTTP_TIMEOUT) as client:
            response = await client.request(method, url, **kwargs)
    except httpx.ConnectError:
        raise ToolError(
            f"Cannot reach the HyQSim backend at {BACKEND_URL}. Start it with:\n"
            "    cd backend && uvicorn main:app --reload --port 8000"
        )
    except httpx.RequestError as e:
        raise ToolError(f"Error contacting the HyQSim backend: {e}")

    if response.status_code >= 400:
        try:
            detail = response.json().get("detail", response.text)
        except Exception:
            detail = response.text
        raise ToolError(str(detail))

    return response.json()


async def _resolve_session() -> str:
    """Finds the session to drive, auto-pairing when exactly one canvas is open."""
    if _pinned_session:
        return _pinned_session

    data = await _request("GET", "/session")
    sessions = data.get("sessions", [])
    attached = [s for s in sessions if s.get("attached")]

    if len(attached) == 1:
        return attached[0]["code"]
    if len(attached) > 1:
        codes = ", ".join(s["code"] for s in attached)
        raise ToolError(
            f"{len(attached)} HyQSim canvases are open ({codes}). "
            f"Call hyqsim_use_session with the code shown in the tab you want to drive."
        )
    if len(sessions) == 1:
        return sessions[0]["code"]

    raise ToolError(
        "No HyQSim canvas is connected. Open HyQSim in a browser (http://localhost:5173) "
        "and check that the MCP badge in the header reads 'connected'."
    )


async def _circuit_summary(code: str) -> str:
    data = await _request("GET", f"/session/{code}/circuit")
    return data.get("hqc") or "empty (no wires)"


# ─── Result formatting ────────────────────────────────────────────────────────


def _format_result(result: dict[str, Any], wires: list[dict[str, Any]], fock: int) -> str:
    """
    Compact rendering of a simulation result — the Python counterpart of
    frontend/src/ai/circuitToPrompt.ts.

    Wigner data is summarised rather than dumped: the raw grid is 6400 floats, which is
    both unaffordable and unreadable for a model.
    """
    lines = [f"fock={fock} backend={result.get('backend', '?')}"]

    qubit_states = result.get("qubitStates", {}) or {}
    qumode_states = result.get("qumodeStates", {}) or {}

    hqc_wires = [hqc.wire_from_dict(w) for w in wires]

    for i, wire in enumerate(wires):
        label = hqc.wire_label(hqc_wires, i)
        key = str(i)

        if wire["type"] == "qubit":
            s = qubit_states.get(key) or qubit_states.get(i)
            if not s:
                lines.append(f"{label} no result")
                continue
            b = s.get("blochVector", {})
            amps = s.get("amplitude", [])

            def fmt_c(c):
                re_, im_ = round(c.get("re", 0), 4), round(c.get("im", 0), 4)
                return f"{re_}" if abs(im_) < 1e-4 else f"{re_}{'+' if im_ >= 0 else ''}{im_}i"

            psi = f"{fmt_c(amps[0])}|0>+{fmt_c(amps[1])}|1>" if len(amps) == 2 else "?"
            lines.append(
                f"{label} psi={psi} "
                f"B=({round(b.get('x', 0), 2)},{round(b.get('y', 0), 2)},{round(b.get('z', 0), 2)})"
            )
        else:
            s = qumode_states.get(key) or qumode_states.get(i)
            if not s:
                lines.append(f"{label} no result")
                continue
            probs = s.get("fockProbabilities", [])
            fock_str = " ".join(
                f"|{n}>:{p * 100:.1f}%" for n, p in enumerate(probs) if p > 0.001
            )
            lines.append(
                f"{label} <n>={s.get('meanPhotonNumber', 0):.3f} {fock_str or '(vacuum)'}"
            )

            wigner = s.get("wignerData")
            if wigner:
                lines.append(f"{label} W: {_summarise_wigner(wigner, s.get('wignerRange', 6.0))}")

    counts = result.get("bitstringCounts")
    if counts:
        total = sum(counts.values()) or 1
        top = sorted(counts.items(), key=lambda kv: -kv[1])[:8]
        lines.append(
            f"counts({total} shots): " + " ".join(f"{k}={v / total * 100:.1f}%" for k, v in top)
        )

    return "\n".join(lines)


def _summarise_wigner(grid: list[list[float]], rng: float) -> str:
    """Derived scalars only — negativity, extrema, quadrature moments."""
    size = len(grid)
    if size == 0:
        return "(no data)"
    cell = (2 * rng / size) ** 2

    min_v, max_v = float("inf"), float("-inf")
    min_at = max_at = (0.0, 0.0)
    abs_int = total = 0.0
    m_x = m_p = m_xx = m_pp = 0.0

    # Backend grids are W[p_idx][x_idx].
    for ip, row in enumerate(grid):
        p = ((ip + 0.5) / size - 0.5) * 2 * rng
        for ix, v in enumerate(row):
            x = ((ix + 0.5) / size - 0.5) * 2 * rng
            if v < min_v:
                min_v, min_at = v, (x, p)
            if v > max_v:
                max_v, max_at = v, (x, p)
            abs_int += abs(v) * cell
            total += v * cell
            m_x += x * v * cell
            m_p += p * v * cell
            m_xx += x * x * v * cell
            m_pp += p * p * v * cell

    norm = total if abs(total) > 1e-9 else 1.0
    mean_x, mean_p = m_x / norm, m_p / norm
    var_x = max(m_xx / norm - mean_x**2, 0.0)
    var_p = max(m_pp / norm - mean_p**2, 0.0)
    negativity = max(abs_int / abs(norm) - 1, 0.0)

    parts = []
    if negativity > 0.005:
        parts.append(f"neg={negativity:.3f}")
        parts.append(f"min={min_v:.3f}@({min_at[0]:.2f},{min_at[1]:.2f})")
    else:
        parts.append("neg=0 (classical/Gaussian)")
    parts.append(f"peak@({max_at[0]:.2f},{max_at[1]:.2f})")
    parts.append(f"<x>={mean_x:.2f} <p>={mean_p:.2f}")
    parts.append(f"varX={var_x:.2f} varP={var_p:.2f} (vac=1.00)")
    return " ".join(parts)




# ─── Tools ────────────────────────────────────────────────────────────────────
#
# Each tool is a plain async function returning a string, registered with @mcp.tool().
# Keeping the logic in ordinary functions means the end-to-end tests exercise the real
# behaviour rather than the SDK's dispatch layer.
#
# `guard` converts a ToolError into the message the model sees. Tools never raise: an
# exception would surface as a protocol error, whereas a sentence naming the valid options
# lets the model correct itself on the next turn.

_NOTATION = (
    "HQC notation. Wires: q0 q1 ... = qubits, m0 m1 ... = qumodes. "
    "Initial states: q0=+ (0,1,+,-,i,-i), m0=2 (Fock 0-5). "
    'Gates: "<id> <wire>[><target>] [params]" joined by ";". '
    "Params are positional in declared order, omitted for defaults. "
    "Radians; pi, pi/2, 3pi/4 accepted. "
    'Example: "h q0; cnot q0>q1; cdisp q0>m0 2,0". '
    "Two-wire order: cnot control>target; bs qumode>qumode; "
    "cdisp/xcdisp/ycdisp/cr/jc ALWAYS qubit>qumode."
)


def guard(fn):
    """
    Turns exceptions into model-readable text so a tool never breaks the session.

    functools.wraps is load-bearing, not cosmetic: the SDK derives each tool's JSON schema
    from the function signature, and a bare *args/**kwargs wrapper makes every tool
    advertise `args` and `kwargs` as its required parameters — leaving the model unable to
    call any of them. wraps copies __annotations__ and sets __wrapped__, which
    inspect.signature follows back to the real signature.
    """
    @functools.wraps(fn)
    async def wrapper(*args, **kwargs):
        try:
            return await fn(*args, **kwargs)
        except ToolError as e:
            return f"Error: {e}"
        except Exception as e:  # noqa: BLE001
            return f"Unexpected error in {fn.__name__}: {type(e).__name__}: {e}"
    return wrapper


@mcp.tool(name="hyqsim_read_circuit")
@guard
async def read_circuit() -> str:
    """Read the circuit currently on the HyQSim canvas, in HQC notation."""
    return await _circuit_summary(await _resolve_session())


@mcp.tool(name="hyqsim_list_gates")
@guard
async def list_gates() -> str:
    """List every available gate with its parameters and lane signature.

    Call this if you are unsure of a gate id. '!py' marks gates that only run on the
    browser backend, not the server-side bosonic-qiskit one.
    """
    return f"{hqc.encode_gate_reference()}\n\n{_NOTATION}"


@mcp.tool(name="hyqsim_build_circuit")
@guard
async def build_circuit(wires: str, gates: str) -> str:
    """Build or replace the entire circuit on the HyQSim canvas in one call.

    Use this for any "build me a X" request rather than adding gates one at a time.

    Args:
        wires: Space-separated wire labels in order, e.g. "q0 q1 q2" or "q0=+ m0=2".
               q0, q1, ... are qubits; m0, m1, ... are qumodes (bosonic modes).
        gates: Semicolon-separated gate statements, e.g. "h q0; cnot q0>q1; cdisp q0>m0 2,0".
               Each is "<gateId> <wire>[><target>] [params]" with positional, comma-separated
               parameters in the gate's declared order; omit them for defaults. Angles are in
               radians and may be written pi, pi/2, 3pi/4. Two-wire order: cnot is
               control>target, bs is qumode>qumode, and cdisp/xcdisp/ycdisp/cr/jc are ALWAYS
               qubit>qumode. Pass "" for a bare set of wires.
    """
    code = await _resolve_session()
    if not (wires or "").strip():
        raise ToolError('build_circuit needs a "wires" spec, e.g. "q0 q1" or "q0 m0".')
    data = await _request("POST", f"/session/{code}/circuit",
                          json={"wires": wires, "gates": gates or ""})
    return f"Built on the canvas:\n{data.get('hqc')}"


@mcp.tool(name="hyqsim_add_gate")
@guard
async def add_gate(gate: str) -> str:
    """Append one gate to the existing circuit. For edits; use hyqsim_build_circuit to create.

    Args:
        gate: One HQC gate statement, e.g. "h q2", "rz q0 pi/4", or "cdisp q0>m0 2,0".
    """
    code = await _resolve_session()
    current = await _request("GET", f"/session/{code}/circuit")
    w = [hqc.wire_from_dict(x) for x in current.get("wires", [])]
    e = [hqc.element_from_dict(x) for x in current.get("elements", [])]

    if not w:
        raise ToolError("The circuit has no wires yet. Call hyqsim_build_circuit first.")

    added, errors = hqc.decode_gates(str(gate or ""), w, e)
    if errors:
        raise ToolError(" ".join(errors))
    if not added:
        raise ToolError('Could not read a gate from that. Expected something like "h q2".')

    return await _push(code, w, e + added)


@mcp.tool(name="hyqsim_remove_gate")
@guard
async def remove_gate(ref: str) -> str:
    """Remove one gate by its position number as shown in the circuit listing.

    Args:
        ref: The gate's number, e.g. "#3" or "3". Gates are numbered left to right.
    """
    code = await _resolve_session()
    current = await _request("GET", f"/session/{code}/circuit")
    w = [hqc.wire_from_dict(x) for x in current.get("wires", [])]
    e = [hqc.element_from_dict(x) for x in current.get("elements", [])]

    if not e:
        raise ToolError("There are no gates on the canvas to remove.")
    target = hqc.resolve_element_ref(str(ref or ""), e)
    if target is None:
        raise ToolError(f'No gate "{ref}". The canvas has gates #1 to #{len(e)}.')

    return await _push(code, w, [x for x in e if x.id != target])


@mcp.tool(name="hyqsim_clear")
@guard
async def clear() -> str:
    """Delete all wires and gates from the HyQSim canvas."""
    return await _push(await _resolve_session(), [], [])


@mcp.tool(name="hyqsim_run_simulation")
@guard
async def run_simulation() -> str:
    """Run HyQSim's simulator on the current circuit and return its results.

    Returns qubit amplitudes and Bloch vectors, qumode Fock distributions and mean photon
    numbers, a Wigner summary (negativity, extrema, quadrature variances), and measurement
    statistics.

    You must never compute these numbers yourself. HyQSim runs the physics; call this and
    report what it returns.
    """
    code = await _resolve_session()
    data = await _request("POST", f"/session/{code}/simulate")
    circuit = await _request("GET", f"/session/{code}/circuit")
    summary = _format_result(
        data["result"], circuit.get("wires", []), circuit.get("fockTruncation", 8)
    )
    return f"Simulated by HyQSim (source={data.get('source')}):\n{summary}"


@mcp.tool(name="hyqsim_get_results")
@guard
async def get_results() -> str:
    """Return the most recent simulation results without re-running the simulator."""
    code = await _resolve_session()
    data = await _request("GET", f"/session/{code}/result")
    if not data.get("result"):
        return (
            "No results yet — the circuit has not been simulated since it last changed. "
            "Call hyqsim_run_simulation."
        )
    circuit = await _request("GET", f"/session/{code}/circuit")
    return _format_result(
        data["result"], circuit.get("wires", []), circuit.get("fockTruncation", 8)
    )


@mcp.tool(name="hyqsim_list_sessions")
@guard
async def list_sessions() -> str:
    """List open HyQSim canvases and their pairing codes."""
    sessions = (await _request("GET", "/session")).get("sessions", [])
    if not sessions:
        return "No HyQSim canvases are open. Open http://localhost:5173 in a browser."
    return "\n".join(
        f"{s['code']}  {'connected' if s['attached'] else 'detached'}  "
        f"{s['wires']} wire(s), {s['gates']} gate(s), backend={s['backend']}"
        for s in sessions
    )


@mcp.tool(name="hyqsim_use_session")
@guard
async def use_session(code: str) -> str:
    """Pin which HyQSim canvas to drive.

    Only needed when more than one HyQSim tab is open; with a single tab, pairing is
    automatic.

    Args:
        code: The 6-character code shown in the HyQSim header.
    """
    global _pinned_session
    normalised = str(code or "").strip().upper()
    await _request("GET", f"/session/{normalised}")  # 404s if unknown
    _pinned_session = normalised
    return f"Now driving HyQSim session {normalised}.\n{await _circuit_summary(normalised)}"


async def _push(code: str, wires: list, elements: list) -> str:
    """Writes a circuit back to the session and returns the canonical HQC rendering."""
    data = await _request(
        "POST", f"/session/{code}/circuit",
        json={"wires": [w.to_dict() for w in wires],
              "elements": [e.to_dict() for e in elements]},
    )
    return data.get("hqc") or "empty (no wires)"


if __name__ == "__main__":
    asyncio.run(mcp.run_stdio_async())
