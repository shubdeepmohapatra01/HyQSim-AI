"""
HQC — HyQSim Circuit notation, Python implementation.

Mirrors ``frontend/src/ai/hqc.ts``. Used by the MCP server so an external AI client
(Claude Desktop, Claude Code) can build circuits in exactly the notation the in-app
assistant uses.

The gate catalogue is NOT duplicated here — it is loaded from ``shared/gates.json``,
which is generated from the TypeScript source by ``npm run ai:gatespec``. A test on each
side asserts the file is current, so adding a gate to the palette cannot silently leave
the MCP server refusing it.

Notation::

    W q0 q1 m0
    G #1 h q0; #2 cnot q0>q1; #3 displace m0 1,0

- Wires are labelled per type: q0, q1, ... and m0, m1, ...
- |0> is the default initial state and omitted; otherwise ``q0=+`` or ``m0=2``.
- Gates are addressed by 1-based left-to-right index (``#3``), never by element id.
- Parameters are positional in declared order, omitted when all are at their defaults.
- Two-wire gates read ``primary>target``.
"""

from __future__ import annotations

import json
import math
import re
import time
import uuid
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

# ─── Gate catalogue ───────────────────────────────────────────────────────────

_SPEC_PATH = Path(__file__).resolve().parents[2] / "shared" / "gates.json"

if not _SPEC_PATH.exists():
    raise RuntimeError(
        f"Missing shared gate catalogue at {_SPEC_PATH}. "
        "Generate it with: cd frontend && npm run ai:gatespec"
    )

_SPEC = json.loads(_SPEC_PATH.read_text())
GATES: dict[str, dict[str, Any]] = {g["id"]: g for g in _SPEC["gates"]}
GATE_ALIASES: dict[str, str] = _SPEC["aliases"]

QUBIT_INITIAL_STATES = ["0", "1", "+", "-", "i", "-i"]
GATE_SPACING = 80

PYTHON_BACKEND_GATES = {g["id"] for g in _SPEC["gates"] if g["pythonBackend"]}


def canonical_gate_id(raw: str) -> str:
    key = str(raw or "").strip().lower()
    if key in GATES:
        return key
    return GATE_ALIASES.get(key, key)


# ─── Data model (mirrors frontend/src/types/circuit.ts) ───────────────────────


@dataclass
class Wire:
    type: str  # 'qubit' | 'qumode'
    index: int
    id: str = ""
    initialState: Any = None

    def __post_init__(self) -> None:
        if not self.id:
            self.id = f"{self.type}-{uuid.uuid4().hex[:8]}"

    def to_dict(self) -> dict[str, Any]:
        d: dict[str, Any] = {"id": self.id, "type": self.type, "index": self.index}
        if self.initialState is not None:
            d["initialState"] = self.initialState
        return d


@dataclass
class CircuitElement:
    gateId: str
    wireIndex: int
    position: dict[str, float] = field(default_factory=lambda: {"x": 0, "y": 0})
    targetWireIndices: list[int] | None = None
    parameterValues: dict[str, float] = field(default_factory=dict)
    generatorExpression: str | None = None
    id: str = ""

    def __post_init__(self) -> None:
        if not self.id:
            self.id = f"element-{int(time.time() * 1000)}-{uuid.uuid4().hex[:5]}"

    def to_dict(self) -> dict[str, Any]:
        d: dict[str, Any] = {
            "id": self.id,
            "gateId": self.gateId,
            "position": self.position,
            "wireIndex": self.wireIndex,
            "parameterValues": self.parameterValues,
        }
        if self.targetWireIndices:
            d["targetWireIndices"] = self.targetWireIndices
        if self.generatorExpression:
            d["generatorExpression"] = self.generatorExpression
        return d


def wire_from_dict(d: dict[str, Any]) -> Wire:
    return Wire(
        type=d["type"],
        index=d.get("index", 0),
        id=d.get("id", ""),
        initialState=d.get("initialState"),
    )


def element_from_dict(d: dict[str, Any]) -> CircuitElement:
    return CircuitElement(
        gateId=d["gateId"],
        wireIndex=d["wireIndex"],
        position=d.get("position", {"x": 0, "y": 0}),
        targetWireIndices=d.get("targetWireIndices"),
        parameterValues=d.get("parameterValues", {}),
        generatorExpression=d.get("generatorExpression"),
        id=d.get("id", ""),
    )


class HqcError(ValueError):
    """Raised for malformed notation. The message is written to be self-correcting."""


# ─── Wire labels ──────────────────────────────────────────────────────────────


def wire_label(wires: list[Wire], idx: int) -> str:
    if idx < 0 or idx >= len(wires):
        return f"wire{idx}"
    wire = wires[idx]
    type_count = sum(1 for w in wires[:idx] if w.type == wire.type)
    return f"q{type_count}" if wire.type == "qubit" else f"m{type_count}"


def wire_label_to_index(wires: list[Wire], label: str) -> int:
    m = re.fullmatch(r"([qm])(\d+)", str(label or "").strip().lower())
    if not m:
        return -1
    wanted = "qubit" if m.group(1) == "q" else "qumode"
    n = int(m.group(2))
    count = 0
    for i, w in enumerate(wires):
        if w.type == wanted:
            if count == n:
                return i
            count += 1
    return -1


def available_wire_labels(wires: list[Wire]) -> str:
    if not wires:
        return "none (add wires first)"
    return ", ".join(wire_label(wires, i) for i in range(len(wires)))


# ─── Numeric literals ─────────────────────────────────────────────────────────

_PI_RE = re.compile(r"^([+-]?)(\d*\.?\d*)\*?(pi|π)(?:/(\d*\.?\d+))?$")


def parse_number(raw: str) -> float | None:
    """Reads ``1.5``, ``-0.3``, ``pi``, ``pi/2``, ``3pi/4``, ``2*pi``.

    Deliberately not ``eval`` — the grammar is small and closed.
    """
    s = re.sub(r"\s+", "", str(raw or "")).lower()
    if s == "":
        return None
    try:
        return float(s)
    except ValueError:
        pass

    m = _PI_RE.match(s)
    if not m:
        return None
    sign = -1.0 if m.group(1) == "-" else 1.0
    coeff = 1.0 if m.group(2) == "" else float(m.group(2))
    div = 1.0 if m.group(4) is None else float(m.group(4))
    if div == 0:
        return None
    return sign * coeff * math.pi / div


def _fmt_number(v: float) -> str:
    if float(v).is_integer():
        return str(int(v))
    return str(round(float(v), 4))


# ─── Parameters ───────────────────────────────────────────────────────────────


def default_parameters(gate: dict[str, Any]) -> dict[str, float]:
    return {p["name"]: p["defaultValue"] for p in gate["parameters"]}


def resolve_parameters(gate: dict[str, Any], raw: Any) -> dict[str, float]:
    defaults = default_parameters(gate)
    declared = gate["parameters"]

    if raw is None or raw == "" or raw == []:
        return defaults

    if isinstance(raw, dict):
        out = dict(defaults)
        for key, val in raw.items():
            if key not in defaults:
                names = ", ".join(p["name"] for p in declared) or "none"
                raise HqcError(f'Gate "{gate["id"]}" has no parameter "{key}". Valid: {names}')
            n = float(val) if isinstance(val, (int, float)) else parse_number(str(val))
            if n is None:
                raise HqcError(f'Parameter "{key}" of "{gate["id"]}" is not a number: "{val}"')
            out[key] = n
        return out

    tokens = (
        [str(t) for t in raw]
        if isinstance(raw, list)
        else [t.strip() for t in str(raw).split(",") if t.strip() != ""]
    )
    if not tokens:
        return defaults

    if all("=" in t for t in tokens):
        named = {}
        for t in tokens:
            k, _, v = t.partition("=")
            named[k.strip()] = v.strip()
        return resolve_parameters(gate, named)

    if len(tokens) > len(declared):
        names = ", ".join(p["name"] for p in declared) or "none"
        raise HqcError(
            f'Gate "{gate["id"]}" takes {len(declared)} parameter(s) ({names}), got {len(tokens)}.'
        )

    out = dict(defaults)
    for i, tok in enumerate(tokens):
        n = parse_number(tok)
        if n is None:
            raise HqcError(
                f'Parameter "{declared[i]["name"]}" of "{gate["id"]}" is not a number: "{tok}"'
            )
        out[declared[i]["name"]] = n
    return out


def _encode_parameters(gate: dict[str, Any], values: dict[str, float] | None) -> str:
    declared = gate["parameters"]
    if not declared or not values:
        return ""
    if all(
        abs(values.get(p["name"], p["defaultValue"]) - p["defaultValue"]) < 1e-9 for p in declared
    ):
        return ""
    return ",".join(_fmt_number(values.get(p["name"], p["defaultValue"])) for p in declared)


# ─── Placing a gate ───────────────────────────────────────────────────────────


def next_gate_x(elements: list[CircuitElement]) -> float:
    if not elements:
        return 0.0
    return max(e.position["x"] for e in elements) + GATE_SPACING


def place_gate(
    gate_id: str,
    wire_label_str: str,
    target_label: str | None,
    parameters: Any,
    wires: list[Wire],
    elements: list[CircuitElement],
    generator_expression: str | None = None,
) -> CircuitElement:
    """Validates and constructs one element. Raises HqcError with a self-correcting message."""
    canonical = canonical_gate_id(gate_id)
    gate = GATES.get(canonical)
    if gate is None:
        raise HqcError(
            f'Unknown gate id: "{gate_id}". Valid IDs: {", ".join(GATES.keys())}'
        )

    wire_index = wire_label_to_index(wires, wire_label_str)
    if wire_index == -1:
        raise HqcError(
            f'Wire "{wire_label_str}" not found. Current wires: {available_wire_labels(wires)}'
        )
    wire = wires[wire_index]

    needs_two = gate["numQubits"] + gate["numQumodes"] >= 2
    target_indices: list[int] | None = None

    if target_label:
        ti = wire_label_to_index(wires, target_label)
        if ti == -1:
            raise HqcError(
                f'Target wire "{target_label}" not found. Current wires: {available_wire_labels(wires)}'
            )
        if ti == wire_index:
            raise HqcError(
                f'Gate "{canonical}" needs two distinct wires, but both are "{wire_label_str}".'
            )
        target_indices = [ti]
    elif needs_two:
        raise HqcError(
            f'Gate "{canonical}" acts on two wires — supply a target '
            f"(format: {canonical} <primary>><target>)."
        )

    category = gate["category"]
    is_hybrid = category == "hybrid" or (gate["numQubits"] and gate["numQumodes"])

    if is_hybrid:
        if wire.type != "qubit":
            raise HqcError(
                f'Gate "{canonical}" needs the qubit first: "{wire_label_str}" is a qumode. '
                f'Write "{canonical} <qubit>><qumode>".'
            )
        if target_indices and wires[target_indices[0]].type != "qumode":
            raise HqcError(
                f'Gate "{canonical}" needs a qumode as its target, but "{target_label}" is a qubit.'
            )
    elif category == "qubit":
        if wire.type != "qubit":
            raise HqcError(
                f'Gate "{canonical}" requires a qubit wire, but "{wire_label_str}" is a qumode.'
            )
        if target_indices and wires[target_indices[0]].type != "qubit":
            raise HqcError(
                f'Gate "{canonical}" requires both wires to be qubits, but "{target_label}" is a qumode.'
            )
    elif category == "qumode":
        if wire.type != "qumode":
            raise HqcError(
                f'Gate "{canonical}" requires a qumode wire, but "{wire_label_str}" is a qubit.'
            )
        if target_indices and wires[target_indices[0]].type != "qumode":
            raise HqcError(
                f'Gate "{canonical}" requires both wires to be qumodes, but "{target_label}" is a qubit.'
            )

    return CircuitElement(
        gateId=canonical,
        wireIndex=wire_index,
        position={"x": next_gate_x(elements), "y": 0},
        targetWireIndices=target_indices,
        parameterValues=resolve_parameters(gate, parameters),
        generatorExpression=generator_expression,
    )


# ─── Encoding ─────────────────────────────────────────────────────────────────


def ordered_elements(elements: list[CircuitElement]) -> list[CircuitElement]:
    return sorted(elements, key=lambda e: e.position["x"])


def resolve_element_ref(ref: str, elements: list[CircuitElement]) -> str | None:
    ordered = ordered_elements(elements)
    s = str(ref or "").strip()
    m = re.fullmatch(r"#?(\d+)", s)
    if m:
        n = int(m.group(1))
        if 1 <= n <= len(ordered):
            return ordered[n - 1].id
        return None
    return s if any(e.id == s for e in ordered) else None


def encode_wires(wires: list[Wire]) -> str:
    if not wires:
        return "W (none)"
    parts = []
    for i, w in enumerate(wires):
        label = wire_label(wires, i)
        init = w.initialState
        is_default = init is None or init == "0" or init == 0
        parts.append(label if is_default else f"{label}={init}")
    return "W " + " ".join(parts)


def encode_gates(wires: list[Wire], elements: list[CircuitElement]) -> str:
    ordered = ordered_elements(elements)
    if not ordered:
        return "G (none)"
    parts = []
    for i, el in enumerate(ordered):
        gate = GATES.get(el.gateId)
        primary = wire_label(wires, el.wireIndex)
        target = f">{wire_label(wires, el.targetWireIndices[0])}" if el.targetWireIndices else ""
        params = _encode_parameters(gate, el.parameterValues) if gate else ""
        gen = f" {{{el.generatorExpression}}}" if el.generatorExpression else ""
        parts.append(
            f"#{i + 1} {el.gateId} {primary}{target}" + (f" {params}" if params else "") + gen
        )
    return "G " + "; ".join(parts)


def encode_circuit(wires: list[Wire], elements: list[CircuitElement]) -> str:
    if not wires:
        return "empty (no wires)"
    return f"{encode_wires(wires)}\n{encode_gates(wires, elements)}"


def encode_gate_reference() -> str:
    """Compact catalogue for an MCP tool description."""
    lines = []
    for g in GATES.values():
        params = ",".join(p["name"] for p in g["parameters"])
        nq, nm = g["numQubits"], g["numQumodes"]
        if nq and nm:
            sig = " [qubit>qumode]"
        elif nq >= 2:
            sig = " [qubit>qubit]"
        elif nm >= 2:
            sig = " [qumode>qumode]"
        elif nm == 1:
            sig = " [qumode]"
        else:
            sig = " [qubit]"
        py = "" if g["pythonBackend"] else " !py"
        lines.append(f"{g['id']}" + (f"({params})" if params else "") + sig + py)
    return "\n".join(lines)


def unsupported_on_python_backend(elements: list[CircuitElement]) -> list[str]:
    return sorted({e.gateId for e in elements if e.gateId not in PYTHON_BACKEND_GATES})


# ─── Decoding ─────────────────────────────────────────────────────────────────


def decode_wires(spec: str) -> tuple[list[Wire], list[str]]:
    errors: list[str] = []
    wires: list[Wire] = []
    text = re.sub(r"^W\s+", "", str(spec or ""), flags=re.IGNORECASE)
    tokens = [t for t in re.split(r"[\s,;]+", text) if t and t != "(none)"]

    qubit_count = 0
    qumode_count = 0

    for token in tokens:
        label, _, init_raw = token.partition("=")
        label = label.lower()
        m = re.fullmatch(r"([qm])(\d+)", label)
        if not m:
            errors.append(
                f'Bad wire label "{token}". Use q0, q1, ... for qubits and m0, m1, ... for qumodes.'
            )
            continue
        wtype = "qubit" if m.group(1) == "q" else "qumode"

        initial_state: Any = None
        if init_raw:
            cleaned = re.sub(r"[|⟩>]", "", init_raw)
            if wtype == "qubit":
                if cleaned not in QUBIT_INITIAL_STATES:
                    errors.append(
                        f'Bad qubit initial state "{init_raw}" on {label}. '
                        f'Valid: {", ".join(QUBIT_INITIAL_STATES)}'
                    )
                else:
                    initial_state = cleaned
            else:
                try:
                    n = int(cleaned)
                    if not 0 <= n <= 5:
                        raise ValueError
                    initial_state = n
                except ValueError:
                    errors.append(
                        f'Bad qumode initial Fock state "{init_raw}" on {label}. Valid: 0-5'
                    )

        if wtype == "qubit":
            index = qubit_count
            qubit_count += 1
        else:
            index = qumode_count
            qumode_count += 1

        wires.append(Wire(type=wtype, index=index, initialState=initial_state))

    return wires, errors


def decode_gates(
    spec: str,
    wires: list[Wire],
    starting_elements: list[CircuitElement] | None = None,
) -> tuple[list[CircuitElement], list[str]]:
    errors: list[str] = []
    elements = list(starting_elements or [])
    added: list[CircuitElement] = []

    text = re.sub(r"^G\s+", "", str(spec or ""), flags=re.IGNORECASE)
    statements = [s.strip() for s in re.split(r"[;\n]+", text) if s.strip() not in ("", "(none)")]

    for raw in statements:
        stmt = re.sub(r"^#\d+\s*", "", raw).strip()
        if not stmt:
            continue

        generator_expression = None
        gen_match = re.search(r"\{([^}]*)\}\s*$", stmt)
        body = stmt[: gen_match.start()].strip() if gen_match else stmt
        if gen_match:
            generator_expression = gen_match.group(1).strip()

        parts = body.split()
        if len(parts) < 2:
            errors.append(f'Cannot parse "{raw}". Expected: <gateId> <wire>[><target>] [params]')
            continue

        gate_id, wire_spec = parts[0], parts[1]
        param_spec = " ".join(parts[2:]).strip()

        arrow = [s.strip() for s in re.split(r"[>→]", wire_spec) if s.strip()]
        primary = arrow[0] if arrow else ""
        target = arrow[1] if len(arrow) > 1 else None

        try:
            element = place_gate(
                gate_id, primary, target, param_spec or None, wires, elements,
                generator_expression,
            )
        except HqcError as e:
            errors.append(f'"{raw}": {e}')
            continue

        elements.append(element)
        added.append(element)

    return added, errors


def decode_circuit(src: str) -> tuple[list[Wire], list[CircuitElement], list[str]]:
    text = str(src or "")
    wire_match = re.search(r"^\s*W\s+(.*)$", text, re.IGNORECASE | re.MULTILINE)
    gate_match = re.search(r"^\s*G\s+([\s\S]*)$", text, re.IGNORECASE | re.MULTILINE)

    wires, wire_errors = decode_wires(wire_match.group(1) if wire_match else "")
    elements, gate_errors = decode_gates(gate_match.group(1) if gate_match else "", wires)
    return wires, elements, wire_errors + gate_errors
