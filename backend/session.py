"""
Live canvas sessions — the bridge between the MCP server and a browser tab.

The problem this solves: the circuit canvas lives in a browser, but the MCP server is a
separate process launched by Claude Desktop. They are joined here. The backend holds the
authoritative circuit for a session; the browser subscribes over a WebSocket and
re-renders on every change; the MCP server mutates it over plain HTTP.

    Claude Desktop --stdio--> mcp_server.py --HTTP--> SessionStore
                                                          |  WebSocket
                                                          v
                                                   browser canvas

Simulation deliberately does NOT happen here. When the MCP server asks for results, the
request is forwarded to the browser, which runs HyQSim's own simulator using whichever
backend the user selected, and posts the results back. The AI never computes physics.
(If no browser is attached, main.py falls back to the bosonic-qiskit path — still
HyQSim's simulator, just the server-side one.)

State is in-memory and per-process: sessions vanish on restart, which is correct for a
local dev tool and keeps us from inventing a persistence story nobody asked for.
"""

from __future__ import annotations

import asyncio
import secrets
import time
from dataclasses import dataclass, field
from typing import Any

# Unambiguous alphabet: no O/0, I/1, so a user reading a code aloud gets it right.
_CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"
CODE_LENGTH = 6

SESSION_TTL_SECONDS = 12 * 60 * 60
SIMULATION_TIMEOUT_SECONDS = 120.0


def _new_code() -> str:
    return "".join(secrets.choice(_CODE_ALPHABET) for _ in range(CODE_LENGTH))


@dataclass
class Session:
    code: str
    created_at: float = field(default_factory=time.time)
    last_seen: float = field(default_factory=time.time)

    # Circuit state, stored in the same shape the frontend uses.
    wires: list[dict[str, Any]] = field(default_factory=list)
    elements: list[dict[str, Any]] = field(default_factory=list)
    fock_truncation: int = 8
    backend: str = "browser"

    # Latest simulation result, exactly as the browser produced it.
    result: dict[str, Any] | None = None

    revision: int = 0

    # Sockets belonging to browser tabs showing this session.
    sockets: set[Any] = field(default_factory=set)

    # In-flight simulation requests, keyed by request id, awaited by the MCP server.
    pending_sims: dict[str, asyncio.Future] = field(default_factory=dict)

    @property
    def attached(self) -> bool:
        return len(self.sockets) > 0

    def touch(self) -> None:
        self.last_seen = time.time()

    def bump(self) -> int:
        self.revision += 1
        self.touch()
        return self.revision

    def circuit(self) -> dict[str, Any]:
        return {
            "wires": self.wires,
            "elements": self.elements,
            "fockTruncation": self.fock_truncation,
            "backend": self.backend,
            "revision": self.revision,
        }

    def summary(self) -> dict[str, Any]:
        return {
            "code": self.code,
            "attached": self.attached,
            "clients": len(self.sockets),
            "revision": self.revision,
            "wires": len(self.wires),
            "gates": len(self.elements),
            "hasResult": self.result is not None,
            "backend": self.backend,
            "fockTruncation": self.fock_truncation,
            "createdAt": self.created_at,
            "lastSeen": self.last_seen,
        }


class SessionStore:
    def __init__(self) -> None:
        self._sessions: dict[str, Session] = {}

    # ─── Lifecycle ────────────────────────────────────────────────────────────

    def create(self) -> Session:
        self._evict_stale()
        for _ in range(10):
            code = _new_code()
            if code not in self._sessions:
                session = Session(code=code)
                self._sessions[code] = session
                return session
        raise RuntimeError("Could not allocate a unique session code")

    def get(self, code: str) -> Session | None:
        session = self._sessions.get(str(code or "").strip().upper())
        if session:
            session.touch()
        return session

    def require(self, code: str) -> Session:
        session = self.get(code)
        if session is None:
            known = ", ".join(self._sessions.keys()) or "none"
            raise KeyError(f'No session "{code}". Active sessions: {known}')
        return session

    def delete(self, code: str) -> None:
        self._sessions.pop(str(code or "").strip().upper(), None)

    def all(self) -> list[Session]:
        self._evict_stale()
        return list(self._sessions.values())

    def attached_sessions(self) -> list[Session]:
        return [s for s in self.all() if s.attached]

    def resolve(self, code: str | None) -> Session:
        """
        Resolves a session, auto-pairing when unambiguous.

        In local use there is exactly one HyQSim tab open, so making the user read a
        pairing code aloud to their AI client would be pointless ceremony. The code is
        only needed once a second tab exists.
        """
        if code:
            return self.require(code)

        attached = self.attached_sessions()
        if len(attached) == 1:
            return attached[0]
        if not attached:
            existing = self.all()
            if len(existing) == 1:
                return existing[0]
            raise KeyError(
                "No HyQSim canvas is connected. Open HyQSim in a browser "
                "(http://localhost:5173) and make sure the MCP badge shows 'connected'."
            )
        codes = ", ".join(s.code for s in attached)
        raise KeyError(
            f"{len(attached)} HyQSim canvases are connected ({codes}). "
            "Say which one to use, e.g. 'use HyQSim session " + attached[0].code + "'."
        )

    def _evict_stale(self) -> None:
        cutoff = time.time() - SESSION_TTL_SECONDS
        for code in [c for c, s in self._sessions.items() if s.last_seen < cutoff and not s.attached]:
            del self._sessions[code]

    # ─── Broadcast ────────────────────────────────────────────────────────────

    async def broadcast(self, session: Session, message: dict[str, Any]) -> None:
        """Pushes a message to every browser tab on this session, dropping dead sockets."""
        dead = []
        for socket in list(session.sockets):
            try:
                await socket.send_json(message)
            except Exception:
                dead.append(socket)
        for socket in dead:
            session.sockets.discard(socket)

    async def push_circuit(self, session: Session) -> None:
        await self.broadcast(session, {"type": "circuit", **session.circuit()})

    # ─── Simulation round-trip ────────────────────────────────────────────────

    async def request_simulation(self, session: Session) -> dict[str, Any]:
        """
        Asks the attached browser to run HyQSim's simulator and waits for the result.

        Raises TimeoutError if the browser never answers, and RuntimeError if no browser
        is attached — the caller then decides whether to fall back to the server-side
        bosonic-qiskit path.
        """
        if not session.attached:
            raise RuntimeError("No browser attached to this session.")

        request_id = secrets.token_hex(8)
        future: asyncio.Future = asyncio.get_running_loop().create_future()
        session.pending_sims[request_id] = future

        await self.broadcast(session, {"type": "run_simulation", "requestId": request_id})

        try:
            return await asyncio.wait_for(future, timeout=SIMULATION_TIMEOUT_SECONDS)
        except asyncio.TimeoutError as exc:
            raise TimeoutError(
                f"The browser did not return a simulation within {SIMULATION_TIMEOUT_SECONDS:.0f}s. "
                "It may still be computing a large Fock truncation."
            ) from exc
        finally:
            session.pending_sims.pop(request_id, None)

    def resolve_simulation(self, session: Session, request_id: str, payload: dict[str, Any]) -> None:
        future = session.pending_sims.get(request_id)
        if future is not None and not future.done():
            future.set_result(payload)


store = SessionStore()
