"""
HyQSim Backend - FastAPI server for quantum simulations.

Run with: uvicorn main:app --reload --port 8000
"""

import os
import time
import httpx
from collections import defaultdict
from pathlib import Path

# Load .env if present. python-dotenv handles quoting, `export ` prefixes and multi-line
# values; the hand-rolled parser this replaced silently produced keys with literal quotes
# around them, which fail upstream with an opaque 401.
_env_path = Path(__file__).parent / '.env'
if _env_path.exists():
    try:
        from dotenv import load_dotenv
        load_dotenv(_env_path, override=False)
    except ImportError:
        print("WARNING: python-dotenv not installed; .env will not be loaded. "
              "Run: pip install -r requirements.txt")

from fastapi import FastAPI, HTTPException, Request, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import Response
from contextlib import asynccontextmanager

# ─── AI provider configuration ────────────────────────────────────────────────
# Set these in a .env file or as environment variables.
# Any provider with a key set here will appear as "Server key" in the UI.
_AI_PROVIDERS = {
    'anthropic': {
        'key': os.getenv('ANTHROPIC_API_KEY'),
        'url': 'https://api.anthropic.com/v1/messages',
        'models': ['claude-'],
        'headers': lambda key: {
            'x-api-key': key,
            'anthropic-version': '2023-06-01',
            'content-type': 'application/json',
        },
    },
    'openai': {
        'key': os.getenv('OPENAI_API_KEY'),
        'url': 'https://api.openai.com/v1/chat/completions',
        'models': ['gpt-', 'o1-', 'o3-'],
        'headers': lambda key: {
            'Authorization': f'Bearer {key}',
            'content-type': 'application/json',
        },
    },
    'groq': {
        'key': os.getenv('GROQ_API_KEY'),
        'url': 'https://api.groq.com/openai/v1/chat/completions',
        'models': ['llama-', 'mixtral-', 'gemma-'],
        'headers': lambda key: {
            'Authorization': f'Bearer {key}',
            'content-type': 'application/json',
        },
    },
    'google': {
        'key': os.getenv('GOOGLE_API_KEY'),
        'url': 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions',
        'models': ['gemini-'],
        'headers': lambda key: {
            'Authorization': f'Bearer {key}',
            'content-type': 'application/json',
        },
    },
    'mistral': {
        'key': os.getenv('MISTRAL_API_KEY'),
        'url': 'https://api.mistral.ai/v1/chat/completions',
        'models': ['mistral-', 'codestral-'],
        'headers': lambda key: {
            'Authorization': f'Bearer {key}',
            'content-type': 'application/json',
        },
    },
    # Together was offered in the frontend model list but had no entry here, so its models
    # matched no provider and could never route through a server key.
    'together': {
        'key': os.getenv('TOGETHER_API_KEY'),
        'url': 'https://api.together.xyz/v1/chat/completions',
        'models': ['meta-llama/', 'Qwen/', 'mistralai/'],
        'headers': lambda key: {
            'Authorization': f'Bearer {key}',
            'content-type': 'application/json',
        },
    },
}

def _provider_for_model(model_id: str) -> str | None:
    """Must stay in sync with providerForModel() in frontend/src/ai/providers.ts."""
    for name, cfg in _AI_PROVIDERS.items():
        if any(model_id.startswith(prefix) for prefix in cfg['models']):
            return name
    return None


# ─── Proxy access control ─────────────────────────────────────────────────────
# /ai/chat spends the server's API credits, and the request body (model, max_tokens,
# system, messages) is entirely caller-controlled — so without these it is a free
# general-purpose LLM on the operator's bill. CORS does not help: it constrains browsers,
# not curl.
#
# AI_PROXY_TOKEN is optional so local development keeps working with no setup, but it
# should always be set for a deployment reachable from the internet.
AI_PROXY_TOKEN = os.getenv('AI_PROXY_TOKEN', '').strip()
AI_RATE_LIMIT_PER_MIN = int(os.getenv('AI_RATE_LIMIT_PER_MIN', '20'))

_rate_buckets: dict[str, list[float]] = defaultdict(list)


def _check_rate_limit(client_ip: str) -> bool:
    """Sliding one-minute window per client IP. Returns False when over budget."""
    now = time.monotonic()
    hits = _rate_buckets[client_ip]
    cutoff = now - 60.0
    hits[:] = [t for t in hits if t > cutoff]
    if len(hits) >= AI_RATE_LIMIT_PER_MIN:
        return False
    hits.append(now)

    # Opportunistic cleanup so idle clients don't accumulate forever.
    if len(_rate_buckets) > 1000:
        for ip in [ip for ip, ts in _rate_buckets.items() if not ts]:
            del _rate_buckets[ip]
    return True
# ──────────────────────────────────────────────────────────────────────────────

from simulation.models import (
    SimulationRequest, SimulationResponse,
    ImportRequest, ImportResponse,
    ExportRequest, ExportResponse,
)
from simulation.bosonic import run_bosonic_simulation, HAS_BOSONIC
from simulation.qiskit_io import parse_bosonic_qiskit, generate_bosonic_qiskit
from simulation import hqc
from session import store

# Get allowed origins from environment variable or use defaults
ALLOWED_ORIGINS = os.environ.get("ALLOWED_ORIGINS", "").split(",") if os.environ.get("ALLOWED_ORIGINS") else []
ALLOWED_ORIGINS.extend([
    "http://localhost:5173",  # Vite dev server
    "http://localhost:3000",  # Alternative frontend port
    "http://127.0.0.1:5173",
    "http://127.0.0.1:3000",
    "https://webpublishing.oit.ncsu.edu",  # NC State web publishing
])
# Filter out empty strings
ALLOWED_ORIGINS = [origin for origin in ALLOWED_ORIGINS if origin]


@asynccontextmanager
async def lifespan(app: FastAPI):
    """Startup and shutdown events."""
    # Startup
    print("=" * 50)
    print("HyQSim Backend Starting...")
    print(f"  bosonic-qiskit available: {HAS_BOSONIC}")
    print("=" * 50)
    yield
    # Shutdown
    print("HyQSim Backend Shutting down...")


app = FastAPI(
    title="HyQSim Backend",
    description="Hybrid CV-DV Quantum Simulator API",
    version="0.1.0",
    lifespan=lifespan,
)

# CORS middleware to allow frontend requests
app.add_middleware(
    CORSMiddleware,
    allow_origins=ALLOWED_ORIGINS,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
    # Without this the browser hides Retry-After from JS, so the client's 429 backoff
    # cannot honour what the provider asked for.
    expose_headers=["Retry-After", "X-RateLimit-Remaining-Tokens", "X-RateLimit-Reset-Tokens"],
)


@app.get("/")
async def root():
    """Health check endpoint."""
    return {
        "service": "HyQSim Backend",
        "status": "running",
        "backends": {
            "bosonic-qiskit": HAS_BOSONIC,
        }
    }


@app.get("/health")
async def health():
    """Health check for monitoring."""
    return {"status": "healthy"}


@app.post("/simulate", response_model=SimulationResponse)
async def simulate(request: SimulationRequest):
    """
    Run a quantum circuit simulation.

    Args:
        request: SimulationRequest containing:
            - wires: List of qubit/qumode wires
            - elements: List of gate elements with positions and parameters
            - fockTruncation: Fock space truncation for qumodes

    Returns:
        SimulationResponse with qubit and qumode final states
    """
    if not HAS_BOSONIC:
        raise HTTPException(
            status_code=503,
            detail="bosonic-qiskit not installed. Run: pip install c2qa-qiskit"
        )

    result = run_bosonic_simulation(request)

    if not result.success:
        raise HTTPException(
            status_code=500,
            detail=f"Simulation failed: {result.error}"
        )

    return result


@app.post("/simulate/preview")
async def simulate_preview(request: SimulationRequest):
    """
    Quick preview simulation with reduced precision.
    Uses smaller Fock truncation for faster results.
    """
    # Cap Fock truncation for preview
    preview_request = SimulationRequest(
        wires=request.wires,
        elements=request.elements,
        fockTruncation=min(request.fockTruncation, 8)
    )

    return await simulate(preview_request)


@app.post("/import", response_model=ImportResponse)
async def import_circuit(request: ImportRequest):
    """Parse bosonic qiskit code and return HyQSim circuit data."""
    try:
        return parse_bosonic_qiskit(request.code)
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))


@app.post("/export", response_model=ExportResponse)
async def export_circuit(request: ExportRequest):
    """Generate bosonic qiskit code from HyQSim circuit data."""
    try:
        return generate_bosonic_qiskit(request.wires, request.elements, request.fockTruncation)
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))


@app.get("/ai/providers")
async def get_ai_providers():
    """
    Returns which AI providers have server-side API keys configured.
    Safe to expose — never returns the actual keys.
    """
    return {
        name: bool(cfg['key'])
        for name, cfg in _AI_PROVIDERS.items()
    }


@app.post("/ai/chat")
async def proxy_ai_chat(request: Request):
    """
    Transparent AI chat proxy. The frontend sends the same request body it
    would send directly to the provider; this endpoint adds the server-side
    API key and forwards to the correct provider URL.

    The provider is inferred from the 'model' field in the request body.

    Protected by an optional shared secret (AI_PROXY_TOKEN) and a per-IP rate limit,
    because this endpoint spends the server's API credits on a caller-controlled body.
    """
    if AI_PROXY_TOKEN:
        supplied = request.headers.get('x-hyqsim-proxy-token', '')
        # compare_digest avoids leaking the token length through timing.
        import hmac
        if not hmac.compare_digest(supplied, AI_PROXY_TOKEN):
            raise HTTPException(status_code=401, detail="Missing or invalid proxy token.")

    client_ip = request.client.host if request.client else 'unknown'
    if not _check_rate_limit(client_ip):
        raise HTTPException(
            status_code=429,
            detail=f"Rate limit exceeded ({AI_RATE_LIMIT_PER_MIN} requests/min). Try again shortly.",
            headers={"Retry-After": "60"},
        )

    try:
        body = await request.json()
    except Exception:
        raise HTTPException(status_code=400, detail="Invalid JSON body")

    model_id = body.get("model", "")
    provider_name = _provider_for_model(model_id)
    if not provider_name:
        raise HTTPException(
            status_code=400,
            detail=f"Cannot determine AI provider for model '{model_id}'. "
                   "Supported prefixes: claude-, gpt-, o1-, o3-, llama-, mixtral-, gemma-, "
                   "gemini-, mistral-, codestral-, meta-llama/"
        )

    cfg = _AI_PROVIDERS[provider_name]
    if not cfg['key']:
        raise HTTPException(
            status_code=503,
            detail=f"No server API key configured for '{provider_name}'. "
                   f"Set {provider_name.upper()}_API_KEY in the backend environment."
        )

    headers = cfg['headers'](cfg['key'])
    try:
        async with httpx.AsyncClient(timeout=120.0) as client:
            upstream = await client.post(cfg['url'], headers=headers, json=body)
    except httpx.RequestError as e:
        raise HTTPException(status_code=502, detail=f"Error contacting {provider_name}: {e}")

    # Forward the headers the client's backoff depends on. Dropping Retry-After meant a
    # rate-limited client in server-key mode always fell back to blind exponential waiting
    # instead of the delay the provider actually asked for.
    passthrough = {}
    for header in ('retry-after', 'x-ratelimit-remaining-tokens', 'x-ratelimit-reset-tokens'):
        if header in upstream.headers:
            passthrough[header] = upstream.headers[header]

    return Response(
        content=upstream.content,
        status_code=upstream.status_code,
        media_type="application/json",
        headers=passthrough,
    )


# ─── Live canvas sessions (MCP bridge) ────────────────────────────────────────
#
# These let an external AI client drive the canvas through backend/mcp_server.py. See
# session.py for the architecture. The key property: /session/{code}/simulate never
# computes anything — it asks the browser to run HyQSim's simulator, and only falls back
# to the server-side bosonic-qiskit path when no browser is attached.


@app.post("/session")
async def create_session():
    """Allocates a pairing code. Called by the browser when the canvas mounts."""
    session = store.create()
    return {"code": session.code}


@app.get("/session")
async def list_sessions():
    """Used by the MCP server to auto-pair when exactly one canvas is open."""
    return {"sessions": [s.summary() for s in store.all()]}


@app.get("/session/{code}")
async def get_session(code: str):
    try:
        session = store.require(code)
    except KeyError as e:
        raise HTTPException(status_code=404, detail=str(e))
    return session.summary()


@app.get("/session/{code}/circuit")
async def get_session_circuit(code: str):
    try:
        session = store.require(code)
    except KeyError as e:
        raise HTTPException(status_code=404, detail=str(e))
    return {**session.circuit(), "hqc": hqc_encode(session)}


@app.post("/session/{code}/circuit")
async def set_session_circuit(code: str, request: Request):
    """
    Replaces the session circuit and pushes it to every attached browser tab.

    Accepts either HQC notation (`wires` + `gates` strings) or raw wire/element arrays.
    HQC is what the MCP server sends; the raw form is what the browser sends when the user
    edits the canvas by hand.
    """
    try:
        session = store.require(code)
    except KeyError as e:
        raise HTTPException(status_code=404, detail=str(e))

    body = await request.json()

    if "wires" in body and isinstance(body["wires"], str):
        wires, wire_errors = hqc.decode_wires(body["wires"])
        if wire_errors:
            raise HTTPException(status_code=400, detail=" ".join(wire_errors))
        elements, gate_errors = hqc.decode_gates(body.get("gates", ""), wires)
        if gate_errors:
            raise HTTPException(status_code=400, detail=" ".join(gate_errors))
        session.wires = [w.to_dict() for w in wires]
        session.elements = [e.to_dict() for e in elements]
    else:
        session.wires = body.get("wires", [])
        session.elements = body.get("elements", [])

    if "fockTruncation" in body:
        session.fock_truncation = int(body["fockTruncation"])
    if "backend" in body:
        session.backend = body["backend"]

    # Any circuit change invalidates the previous result — same rule as App.tsx.
    session.result = None
    session.bump()
    await store.push_circuit(session)
    return {**session.circuit(), "hqc": hqc_encode(session)}


@app.post("/session/{code}/simulate")
async def simulate_session(code: str):
    """
    Runs HyQSim's simulator on the session circuit.

    Prefers the attached browser, so the run uses the backend the user actually selected
    and the results they see on screen are the results the AI is told about.
    """
    try:
        session = store.require(code)
    except KeyError as e:
        raise HTTPException(status_code=404, detail=str(e))

    if not session.wires:
        raise HTTPException(status_code=400, detail="Nothing to simulate — the circuit is empty.")

    if session.attached:
        try:
            result = await store.request_simulation(session)
        except TimeoutError as e:
            raise HTTPException(status_code=504, detail=str(e))
        session.result = result
        session.touch()
        return {"source": "browser", "result": result}

    # No browser attached: fall back to the server-side simulator. Still HyQSim, never the AI.
    if not HAS_BOSONIC:
        raise HTTPException(
            status_code=503,
            detail="No browser canvas is attached and bosonic-qiskit is not installed, "
                   "so there is no simulator available. Open HyQSim in a browser.",
        )

    elements = [e for e in session.elements if e.get("gateId") != "measure"]
    unsupported = hqc.unsupported_on_python_backend(
        [hqc.element_from_dict(e) for e in elements]
    )
    if unsupported:
        raise HTTPException(
            status_code=400,
            detail=f"No browser is attached, and the server-side bosonic-qiskit backend "
                   f"cannot run: {', '.join(unsupported)}. Open HyQSim in a browser to use "
                   f"the full gate set.",
        )

    try:
        sim_request = SimulationRequest(
            wires=session.wires,
            elements=elements,
            fockTruncation=session.fock_truncation,
        )
        response = run_bosonic_simulation(sim_request)
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Simulation failed: {e}")

    result = response.model_dump()
    session.result = result
    return {"source": "bosonic-qiskit", "result": result}


@app.get("/session/{code}/result")
async def get_session_result(code: str):
    try:
        session = store.require(code)
    except KeyError as e:
        raise HTTPException(status_code=404, detail=str(e))
    return {"result": session.result, "revision": session.revision}


@app.websocket("/session/{code}/ws")
async def session_socket(websocket: WebSocket, code: str):
    """
    A browser tab's live link to its session.

    Inbound messages:
      circuit          — the user edited the canvas; store it and re-broadcast
      simulation       — a result the browser produced, answering a run_simulation request
      settings         — fock truncation / backend selection changed
      ping             — keepalive

    Outbound messages:
      circuit          — the circuit changed (usually because the AI changed it)
      run_simulation   — please run the simulator and post the result back
    """
    session = store.get(code)
    if session is None:
        await websocket.close(code=4404, reason="Unknown session")
        return

    await websocket.accept()
    session.sockets.add(websocket)

    try:
        await websocket.send_json({"type": "circuit", **session.circuit()})

        while True:
            message = await websocket.receive_json()
            kind = message.get("type")

            if kind == "circuit":
                session.wires = message.get("wires", [])
                session.elements = message.get("elements", [])
                if "fockTruncation" in message:
                    session.fock_truncation = int(message["fockTruncation"])
                if "backend" in message:
                    session.backend = message["backend"]
                session.result = None
                session.bump()
                # Echo to any other tabs on the same session, but not back to this one.
                for other in list(session.sockets):
                    if other is not websocket:
                        try:
                            await other.send_json({"type": "circuit", **session.circuit()})
                        except Exception:
                            session.sockets.discard(other)

            elif kind == "simulation":
                result = message.get("result")
                session.result = result
                session.touch()
                request_id = message.get("requestId")
                if request_id:
                    store.resolve_simulation(session, request_id, result)

            elif kind == "settings":
                if "fockTruncation" in message:
                    session.fock_truncation = int(message["fockTruncation"])
                if "backend" in message:
                    session.backend = message["backend"]
                session.touch()

            elif kind == "ping":
                await websocket.send_json({"type": "pong"})

    except WebSocketDisconnect:
        pass
    except Exception as e:
        print(f"Session {code} socket error: {e}")
    finally:
        session.sockets.discard(websocket)


def hqc_encode(session) -> str:
    """Session circuit in HQC notation — what the MCP server shows the model."""
    wires = [hqc.wire_from_dict(w) for w in session.wires]
    elements = [hqc.element_from_dict(e) for e in session.elements]
    return hqc.encode_circuit(wires, elements)


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8000, reload=True)
