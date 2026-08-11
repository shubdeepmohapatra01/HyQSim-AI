"""
End-to-end test of the MCP bridge.

Spawns a real backend, attaches a fake browser tab to the session WebSocket, and drives
the MCP tools against it — the same path Claude Desktop takes.

The fake browser is what makes this meaningful: it answers `run_simulation` requests the
way the real canvas does, which is how we verify that HyQSim produces the numbers and the
AI only relays them.

Run with:  cd backend && python -m pytest tests/test_mcp_e2e.py -v
Skipped automatically when uvicorn, websockets, or the MCP SDK are absent.
"""

from __future__ import annotations

import asyncio
import json
import os
import socket
import subprocess
import sys
import time
from pathlib import Path

import pytest

BACKEND_DIR = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(BACKEND_DIR))

pytest.importorskip("uvicorn", reason="uvicorn is needed to run the backend under test")
websockets = pytest.importorskip("websockets", reason="websockets is needed for the fake browser")
httpx = pytest.importorskip("httpx")
pytest.importorskip("mcp", reason="the MCP SDK is needed to import mcp_server")


def _free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


@pytest.fixture(scope="module")
def backend():
    """A real uvicorn process — the WebSocket bridge cannot be tested via ASGI transport."""
    port = _free_port()
    proc = subprocess.Popen(
        [sys.executable, "-m", "uvicorn", "main:app", "--port", str(port), "--log-level", "warning"],
        cwd=BACKEND_DIR, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
    )
    base = f"http://127.0.0.1:{port}"

    deadline = time.time() + 30
    while time.time() < deadline:
        if proc.poll() is not None:
            output = proc.stdout.read().decode() if proc.stdout else ""
            pytest.skip(f"backend failed to start:\n{output[-2000:]}")
        try:
            if httpx.get(f"{base}/health", timeout=1).status_code == 200:
                break
        except Exception:
            time.sleep(0.25)
    else:
        proc.terminate()
        pytest.skip("backend did not become healthy in time")

    yield base

    proc.terminate()
    try:
        proc.wait(timeout=10)
    except subprocess.TimeoutExpired:
        proc.kill()


@pytest.fixture(scope="module")
def mcp_server(backend):
    """Imports the MCP server pointed at the test backend."""
    os.environ["HYQSIM_BACKEND_URL"] = backend
    import mcp_server as module
    module.BACKEND_URL = backend
    module._pinned_session = None
    return module


# A result shaped like the real browser's, so _format_result is exercised for real.
FAKE_RESULT = {
    "backend": "browser",
    "executionTime": 12,
    "qubitStates": {
        "0": {
            "amplitude": [{"re": 0.7071, "im": 0}, {"re": 0.7071, "im": 0}],
            "blochVector": {"x": 1, "y": 0, "z": 0},
            "expectations": {"sigmaX": 1, "sigmaY": 0, "sigmaZ": 0},
        }
    },
    "qumodeStates": {
        "1": {
            "fockAmplitudes": [{"re": 0.7, "im": 0}, {"re": 0, "im": 0}, {"re": 0.5, "im": 0}],
            "fockProbabilities": [0.49, 0.0, 0.25, 0.0, 0.13, 0.0, 0.08, 0.05],
            "meanPhotonNumber": 2.0,
        }
    },
    "bitstringCounts": {"0": 512, "1": 512},
}


class FakeBrowser:
    """Stands in for a HyQSim tab: holds the socket open and answers simulation requests."""

    def __init__(self, base: str, code: str):
        self.url = base.replace("http://", "ws://") + f"/session/{code}/ws"
        self._stop = asyncio.Event()
        self._task: asyncio.Task | None = None
        self.simulation_requests = 0

    async def __aenter__(self):
        ready = asyncio.Event()
        self._task = asyncio.create_task(self._run(ready))
        await asyncio.wait_for(ready.wait(), timeout=10)
        await asyncio.sleep(0.2)
        return self

    async def __aexit__(self, *exc):
        self._stop.set()
        if self._task:
            await self._task

    async def _run(self, ready: asyncio.Event):
        async with websockets.connect(self.url) as ws:
            ready.set()
            while not self._stop.is_set():
                try:
                    raw = await asyncio.wait_for(ws.recv(), timeout=0.3)
                except asyncio.TimeoutError:
                    continue
                except Exception:
                    return
                message = json.loads(raw)
                if message.get("type") == "run_simulation":
                    self.simulation_requests += 1
                    await ws.send(json.dumps({
                        "type": "simulation",
                        "requestId": message["requestId"],
                        "result": FAKE_RESULT,
                    }))


async def _new_session(base: str) -> str:
    async with httpx.AsyncClient(timeout=10) as client:
        return (await client.post(f"{base}/session")).json()["code"]


def run(coro):
    return asyncio.run(coro)


# ─── Tests ────────────────────────────────────────────────────────────────────


def test_session_code_is_pairable(backend):
    code = run(_new_session(backend))
    assert len(code) == 6
    assert code.isalnum() and code.isupper()
    # Ambiguous glyphs are excluded so a user can read the code aloud.
    assert not set(code) & set("O0I1")


def test_auto_pairs_to_the_only_open_canvas(backend, mcp_server):
    async def scenario():
        code = await _new_session(backend)
        async with FakeBrowser(backend, code):
            return code, await mcp_server._resolve_session()

    code, resolved = run(scenario())
    assert resolved == code


def test_builds_ghz4_in_a_single_call(backend, mcp_server):
    """The headline efficiency claim: one tool call, not nine."""
    async def scenario():
        code = await _new_session(backend)
        async with FakeBrowser(backend, code):
            text = await mcp_server.build_circuit(
                "q0 q1 q2 q3", "h q0; cnot q0>q1; cnot q1>q2; cnot q2>q3"
            )
            async with httpx.AsyncClient(timeout=10) as client:
                stored = (await client.get(f"{backend}/session/{code}/circuit")).json()
            return text, stored

    text, stored = run(scenario())
    assert "W q0 q1 q2 q3" in text
    assert "#1 h q0; #2 cnot q0>q1; #3 cnot q1>q2; #4 cnot q2>q3" in text
    assert len(stored["wires"]) == 4
    assert len(stored["elements"]) == 4
    # Batch placement must not collide ids, or removal breaks.
    assert len({e["id"] for e in stored["elements"]}) == 4


def test_incremental_edits(backend, mcp_server):
    async def scenario():
        code = await _new_session(backend)
        async with FakeBrowser(backend, code):
            await mcp_server.build_circuit("q0 q1", "h q0; cnot q0>q1")
            added = await mcp_server.add_gate("h q1")
            removed = await mcp_server.remove_gate("#3")
            return added, removed

    added, removed = run(scenario())
    assert "#3 h q1" in added
    assert "#3" not in removed
    assert "#1 h q0; #2 cnot q0>q1" in removed


def test_errors_are_self_correcting(backend, mcp_server):
    """Error text must name the valid options, or the model cannot repair its own call."""
    async def scenario():
        code = await _new_session(backend)
        async with FakeBrowser(backend, code):
            await mcp_server.build_circuit("q0 q1 m0", "h q0")
            return {
                "unknown_gate": await mcp_server.add_gate("flurb q0"),
                "missing_wire": await mcp_server.add_gate("h q9"),
                "bad_ref": await mcp_server.remove_gate("#99"),
                "wrong_lane": await mcp_server.add_gate("h m0"),
                "hybrid_order": await mcp_server.add_gate("cdisp m0>q0 1,0"),
                "no_target": await mcp_server.add_gate("cnot q0"),
            }

    r = run(scenario())
    assert "flurb" in r["unknown_gate"] and "cnot" in r["unknown_gate"]
    assert "q0, q1, m0" in r["missing_wire"]
    assert "#1 to #1" in r["bad_ref"]
    assert "qubit" in r["wrong_lane"]
    assert "qubit" in r["hybrid_order"].lower()
    assert "two wires" in r["no_target"]


def test_simulation_is_executed_by_the_browser(backend, mcp_server):
    """The load-bearing guarantee: HyQSim computes the physics, the AI relays it."""
    async def scenario():
        code = await _new_session(backend)
        async with FakeBrowser(backend, code) as browser:
            await mcp_server.build_circuit("q0 m0", "h q0; cdisp q0>m0 2,0")
            text = await mcp_server.run_simulation()
            return text, browser.simulation_requests

    text, requests = run(scenario())
    assert requests == 1, "the browser should have been asked to simulate exactly once"
    assert "source=browser" in text
    assert "B=(1,0,0)" in text
    assert "<n>=2.000" in text
    assert "|0>:49.0%" in text
    assert "counts(1024 shots)" in text


def test_get_results_does_not_re_run(backend, mcp_server):
    async def scenario():
        code = await _new_session(backend)
        async with FakeBrowser(backend, code) as browser:
            await mcp_server.build_circuit("q0 m0", "h q0; cdisp q0>m0 2,0")
            await mcp_server.run_simulation()
            cached = await mcp_server.get_results()
            return cached, browser.simulation_requests

    cached, requests = run(scenario())
    assert requests == 1
    assert "<n>=2.000" in cached


def test_editing_the_circuit_invalidates_results(backend, mcp_server):
    """Same rule as App.tsx: any mutation clears the previous result."""
    async def scenario():
        code = await _new_session(backend)
        async with FakeBrowser(backend, code):
            await mcp_server.build_circuit("q0 m0", "h q0; cdisp q0>m0 2,0")
            await mcp_server.run_simulation()
            await mcp_server.add_gate("x q0")
            return await mcp_server.get_results()

    assert "No results yet" in run(scenario())


def test_user_edits_are_visible_to_the_ai(backend, mcp_server):
    """A circuit the user drags together must reach the model unchanged."""
    async def scenario():
        code = await _new_session(backend)
        url = backend.replace("http://", "ws://") + f"/session/{code}/ws"
        async with websockets.connect(url) as ws:
            await ws.recv()  # initial circuit push
            await ws.send(json.dumps({
                "type": "circuit",
                "wires": [
                    {"id": "q-0", "type": "qubit", "index": 0},
                    {"id": "m-0", "type": "qumode", "index": 0},
                ],
                "elements": [{
                    "id": "e1", "gateId": "cdisp", "position": {"x": 0, "y": 0},
                    "wireIndex": 0, "targetWireIndices": [1],
                    "parameterValues": {"alpha_re": 2.0, "alpha_im": 0.0},
                }],
            }))
            await asyncio.sleep(0.4)
            return await mcp_server.read_circuit()

    assert "#1 cdisp q0>m0 2,0" in run(scenario())


def test_clear_empties_the_canvas(backend, mcp_server):
    async def scenario():
        code = await _new_session(backend)
        async with FakeBrowser(backend, code):
            await mcp_server.build_circuit("q0 q1", "h q0; cnot q0>q1")
            return await mcp_server.clear()

    assert "empty" in run(scenario())


def test_gate_catalogue_marks_backend_gaps(mcp_server):
    text = run(mcp_server.list_gates())
    assert "cdisp(alpha_re,alpha_im) [qubit>qumode]" in text
    # jc cannot run on bosonic-qiskit, and the model needs to know before it builds.
    assert "jc(theta) [qubit>qumode] !py" in text
    assert "cnot [qubit>qubit]" in text


def test_detached_session_explains_itself(backend, mcp_server):
    """With no browser and no bosonic-qiskit, say what to do rather than failing opaquely."""
    async def scenario():
        code = await _new_session(backend)
        async with FakeBrowser(backend, code):
            await mcp_server.build_circuit("q0 m0", "h q0; cdisp q0>m0 2,0")
        await asyncio.sleep(0.3)
        return await mcp_server.run_simulation()

    text = run(scenario())
    assert "Error" in text
    assert "browser" in text.lower() or "bosonic-qiskit" in text


def test_tool_schemas_expose_real_parameters(mcp_server):
    """
    Guards a bug that made every tool uncallable: the error-handling decorator wrapped the
    tools in *args/**kwargs, so the SDK derived schemas advertising `args` and `kwargs`
    instead of the actual arguments.
    """
    tools = {t.name: t for t in run(mcp_server.mcp.list_tools())}
    assert len(tools) == 10

    build = tools["hyqsim_build_circuit"].input_schema
    assert set(build["properties"]) == {"wires", "gates"}
    assert set(build["required"]) == {"wires", "gates"}

    assert set(tools["hyqsim_add_gate"].input_schema["properties"]) == {"gate"}
    assert set(tools["hyqsim_remove_gate"].input_schema["properties"]) == {"ref"}
    assert set(tools["hyqsim_use_session"].input_schema["properties"]) == {"code"}

    for name in ("hyqsim_read_circuit", "hyqsim_run_simulation", "hyqsim_clear"):
        assert tools[name].input_schema.get("properties", {}) == {}

    # The instruction that keeps the model from inventing numbers must reach the client.
    assert "never compute" in (tools["hyqsim_run_simulation"].description or "").lower()
