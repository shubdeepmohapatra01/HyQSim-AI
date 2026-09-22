"""Unit tests for bosonic qiskit import/export (qiskit_io.py).

These tests verify parsing and code generation. They do NOT require
bosonic-qiskit — all operations are AST-based.
"""

import sys
import os

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from simulation.qiskit_io import parse_bosonic_qiskit, generate_bosonic_qiskit
from simulation.models import Wire, WireType, CircuitElement, Position


def _wire(wire_type: str, index: int) -> Wire:
    return Wire(id=f"w-{index}", type=WireType(wire_type), index=index,
                initialState=0 if wire_type == "qumode" else "0")


def _elem(gate_id, wire, x=30, targets=None, params=None) -> CircuitElement:
    return CircuitElement(id=f"el-{gate_id}-{wire}", gateId=gate_id,
                          position=Position(x=x, y=0), wireIndex=wire,
                          targetWireIndices=targets, parameterValues=params)


class TestImport:
    def test_dv_single_qubit(self):
        code = "import qiskit, c2qa\nqmr=c2qa.QumodeRegister(num_qumodes=1,num_qubits_per_qumode=4)\nqbr=qiskit.QuantumRegister(1)\ncircuit=c2qa.CVCircuit(qmr,qbr)\ncircuit.h(qbr[0])\ncircuit.x(qbr[0])"
        r = parse_bosonic_qiskit(code)
        assert r.success and [e.gateId for e in r.elements] == ["h", "x"]

    def test_cv_displacement_complex(self):
        code = "import c2qa\nqmr=c2qa.QumodeRegister(num_qumodes=1,num_qubits_per_qumode=4)\ncircuit=c2qa.CVCircuit(qmr)\ncircuit.cv_d(complex(1.5,-0.5),qmr[0])"
        r = parse_bosonic_qiskit(code)
        assert r.success
        assert abs(r.elements[0].parameterValues["alpha_re"] - 1.5) < 1e-6
        assert abs(r.elements[0].parameterValues["alpha_im"] - (-0.5)) < 1e-6

    def test_hybrid_cd(self):
        code = "import qiskit,c2qa\nqmr=c2qa.QumodeRegister(num_qumodes=1,num_qubits_per_qumode=4)\nqbr=qiskit.QuantumRegister(1)\ncircuit=c2qa.CVCircuit(qmr,qbr)\ncircuit.cv_c_d(complex(1,0.5),qmr[0],qbr[0])"
        r = parse_bosonic_qiskit(code)
        assert r.success and r.elements[0].gateId == "cdisp"
        qb = next(i for i, w in enumerate(r.wires) if w.type == WireType.qubit)
        assert r.elements[0].wireIndex == qb

    def test_syntax_error(self):
        assert not parse_bosonic_qiskit("def foo(:").success

    def test_no_circuit(self):
        assert not parse_bosonic_qiskit("import c2qa\nqmr=c2qa.QumodeRegister(num_qumodes=1,num_qubits_per_qumode=4)").success


class TestExport:
    def test_dv_gates(self):
        r = generate_bosonic_qiskit([_wire("qumode", 0), _wire("qubit", 1)],
                                     [_elem("h", 1)], 8)
        assert r.success and "circuit.h(qbr[0])" in r.code

    def test_cv_displacement(self):
        r = generate_bosonic_qiskit([_wire("qumode", 0)],
                                     [_elem("displace", 0, params={"alpha_re": 2.0, "alpha_im": 0.0})], 8)
        assert r.success and "cv_d" in r.code

    def test_hybrid_cd(self):
        r = generate_bosonic_qiskit([_wire("qumode", 0), _wire("qubit", 1)],
                                     [_elem("cdisp", 1, targets=[0], params={"alpha_re": 1.0, "alpha_im": 0.5})], 8)
        assert r.success and "cv_c_d" in r.code

    def test_no_wires(self):
        assert not generate_bosonic_qiskit([], [], 8).success


class TestRoundTrip:
    def test_hybrid_circuit(self):
        wires = [_wire("qumode", 0), _wire("qubit", 1)]
        elems = [_elem("h", 1, x=30), _elem("displace", 0, x=90, params={"alpha_re": 1.0, "alpha_im": 0.0}),
                 _elem("cdisp", 1, x=150, targets=[0], params={"alpha_re": 1.0, "alpha_im": 0.5})]
        exp = generate_bosonic_qiskit(wires, elems, 8)
        assert exp.success
        imp = parse_bosonic_qiskit(exp.code)
        assert imp.success and [e.gateId for e in imp.elements] == ["h", "displace", "cdisp"]
