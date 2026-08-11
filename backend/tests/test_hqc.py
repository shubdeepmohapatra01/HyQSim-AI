"""
Asserts the Python HQC implementation agrees with the TypeScript one.

Both read ``shared/hqc_cases.json``, generated from the TS source by
``cd frontend && npm run ai:gatespec``. If someone changes one implementation and not the
other, this fails — which is the only thing stopping the MCP server from silently
diverging from the in-app assistant.

Run with:  cd backend && python -m pytest tests/ -v
"""

import json
import math
from pathlib import Path

import pytest

from simulation.hqc import (
    HqcError,
    canonical_gate_id,
    decode_circuit,
    encode_circuit,
    parse_number,
    place_gate,
    resolve_element_ref,
    unsupported_on_python_backend,
)

_CASES_PATH = Path(__file__).resolve().parents[2] / "shared" / "hqc_cases.json"
CASES = json.loads(_CASES_PATH.read_text())


# ─── Golden fixtures shared with TypeScript ───────────────────────────────────


@pytest.mark.parametrize("case", CASES["roundTrip"], ids=lambda c: c["source"][:40])
def test_matches_typescript_encoding(case):
    """Decoding then re-encoding must produce byte-identical output to hqc.ts."""
    wires, elements, errors = decode_circuit(case["source"])
    assert errors == [], f"unexpected errors: {errors}"
    assert encode_circuit(wires, elements) == case["encoded"]


@pytest.mark.parametrize("case", CASES["roundTrip"], ids=lambda c: c["source"][:40])
def test_matches_typescript_structure(case):
    wires, elements, errors = decode_circuit(case["source"])
    assert errors == []

    assert len(wires) == len(case["wires"])
    for actual, expected in zip(wires, case["wires"]):
        assert actual.type == expected["type"]
        assert actual.index == expected["index"]
        assert actual.initialState == expected["initialState"]

    ordered = sorted(elements, key=lambda e: e.position["x"])
    assert len(ordered) == len(case["gates"])
    for actual, expected in zip(ordered, case["gates"]):
        assert actual.gateId == expected["gateId"]
        assert actual.wireIndex == expected["wireIndex"]
        assert actual.targetWireIndices == expected["targetWireIndices"]
        assert set(actual.parameterValues) == set(expected["parameterValues"])
        for name, value in expected["parameterValues"].items():
            assert actual.parameterValues[name] == pytest.approx(value)


@pytest.mark.parametrize("case", CASES["errors"], ids=lambda c: c["source"][:40])
def test_rejects_what_typescript_rejects(case):
    _wires, _elements, errors = decode_circuit(case["source"])
    assert errors, f"expected a rejection for: {case['source']}"
    joined = " ".join(errors).lower()
    assert case["contains"].lower() in joined, f"error text was: {errors}"


def test_reencoding_is_stable():
    """A second decode/encode pass must be a fixed point, not drift."""
    for case in CASES["roundTrip"]:
        wires, elements, _ = decode_circuit(case["source"])
        once = encode_circuit(wires, elements)
        w2, e2, errors = decode_circuit(once)
        assert errors == []
        assert encode_circuit(w2, e2) == once


# ─── Behaviour that has no TypeScript fixture ─────────────────────────────────


def test_parse_number_handles_pi_forms():
    assert parse_number("1.5") == pytest.approx(1.5)
    assert parse_number("-0.25") == pytest.approx(-0.25)
    assert parse_number("pi") == pytest.approx(math.pi)
    assert parse_number("pi/2") == pytest.approx(math.pi / 2)
    assert parse_number("3pi/4") == pytest.approx(3 * math.pi / 4)
    assert parse_number("-pi/4") == pytest.approx(-math.pi / 4)
    assert parse_number("2*pi") == pytest.approx(2 * math.pi)


def test_parse_number_rejects_nonsense():
    assert parse_number("abc") is None
    assert parse_number("") is None
    assert parse_number("pi/0") is None


def test_gate_aliases():
    assert canonical_gate_id("cx") == "cnot"
    assert canonical_gate_id("hadamard") == "h"
    assert canonical_gate_id("beam_splitter") == "bs"
    assert canonical_gate_id("h") == "h"


def test_element_refs_are_positional():
    wires, elements, _ = decode_circuit("W q0\nG h q0; x q0; z q0")
    assert resolve_element_ref("#2", elements) == elements[1].id
    assert resolve_element_ref("2", elements) == elements[1].id
    assert resolve_element_ref("#9", elements) is None


def test_batch_build_gives_distinct_ids():
    _wires, elements, errors = decode_circuit(
        "W q0 q1 q2 q3\nG h q0; cnot q0>q1; cnot q1>q2; cnot q2>q3"
    )
    assert errors == []
    assert len({e.id for e in elements}) == len(elements)


def test_gates_are_ordered_left_to_right():
    _wires, elements, _ = decode_circuit("W q0 q1\nG h q0; cnot q0>q1; x q1")
    xs = [e.position["x"] for e in elements]
    assert xs == sorted(xs)
    assert len(set(xs)) == 3


def test_python_backend_gap_is_reported():
    _wires, elements, _ = decode_circuit("W q0 m0\nG jc q0>m0 pi/4")
    assert unsupported_on_python_backend(elements) == ["jc"]

    _wires, ok, _ = decode_circuit("W q0 m0\nG cdisp q0>m0 2,0")
    assert unsupported_on_python_backend(ok) == []


def test_errors_name_the_valid_options():
    wires, _elements, _ = decode_circuit("W q0 m0\nG (none)")

    with pytest.raises(HqcError) as exc:
        place_gate("flurb", "q0", None, None, wires, [])
    assert "flurb" in str(exc.value) and "cnot" in str(exc.value)

    with pytest.raises(HqcError) as exc:
        place_gate("h", "q9", None, None, wires, [])
    assert "q0, m0" in str(exc.value)

    with pytest.raises(HqcError) as exc:
        place_gate("squeeze", "m0", None, {"nonsense": 1}, wires, [])
    assert "nonsense" in str(exc.value)


def test_every_bad_statement_is_reported():
    _wires, _elements, errors = decode_circuit("W q0\nG flurb q0; h q9; x q0")
    assert len(errors) == 2
