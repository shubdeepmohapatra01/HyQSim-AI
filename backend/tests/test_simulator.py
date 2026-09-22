"""
Full simulator pipeline tests for HyQSim.

Tests run circuits through `run_bosonic_simulation()` and verify
physical correctness of output states (Bloch vectors, Fock distributions,
mean photon numbers, etc.).

Requires: bosonic-qiskit, qiskit, qutip, numpy.
All tests are skipped if these are not installed.

=== ADDING NEW CIRCUIT TESTS ===

To add a new test circuit, use the provided helpers:

    class TestMyNewCircuit:
        def test_something(self):
            result = run_circuit(
                wires=[qubit(0), qumode(1)],
                gates=[
                    gate("h", wire=0),
                    gate("displace", wire=1, params={"alpha_re": 2.0, "alpha_im": 0.0}),
                    gate("cdisp", wire=0, target=1, params={"alpha_re": 1.0, "alpha_im": 0.0}),
                ],
                fock=8,
            )
            assert result.success
            # Check qubit state
            qb = result.qubitStates[0]
            assert_bloch(qb, x=..., y=..., z=...)
            # Check qumode state
            qm = result.qumodeStates[1]
            assert_mean_photon(qm, expected=..., tol=0.5)
            assert_fock_peak(qm, n=0)

Available helpers:
    qubit(wire_index)         - create a qubit wire
    qumode(wire_index)        - create a qumode wire
    gate(id, wire, ...)       - create a gate element
    run_circuit(wires, gates) - run simulation, returns SimulationResponse
    assert_bloch(state, x, y, z, tol)  - verify Bloch vector components
    assert_fock_peak(state, n)         - verify highest Fock probability is at |n>
    assert_mean_photon(state, expected, tol) - verify mean photon number
    assert_vacuum(state, tol) - verify qumode is in vacuum |0>
    assert_fock_prob(state, n, expected, tol) - verify P(n) for a specific Fock state
"""

import sys
import os
import math

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

import pytest

from simulation.models import (
    QubitPostSelection,
    SimulationRequest, SimulationResponse,
    Wire, WireType, CircuitElement, Position,
    QubitState, QumodeState,
)

# Skip everything if bosonic-qiskit (or its deps like numpy) is not installed
try:
    import numpy as np
    from simulation.bosonic import run_bosonic_simulation, HAS_BOSONIC
    if not HAS_BOSONIC:
        raise ImportError
except ImportError:
    pytestmark = pytest.mark.skip(reason="bosonic-qiskit or dependencies not installed")
    HAS_BOSONIC = False
    def run_bosonic_simulation(*args, **kwargs):
        pass


# ===================================================================
# Circuit builder helpers
# ===================================================================

def qubit(wire_index: int, initial_state: str = "0") -> Wire:
    """Create a qubit wire."""
    return Wire(id=f"q{wire_index}", type=WireType.qubit,
                index=wire_index, initialState=initial_state)


def qumode(wire_index: int, initial_state: int = 0) -> Wire:
    """Create a qumode wire."""
    return Wire(id=f"m{wire_index}", type=WireType.qumode,
                index=wire_index, initialState=initial_state)


_gate_counter = 0

def gate(
    gate_id: str,
    wire: int,
    target: int | None = None,
    params: dict[str, float] | None = None,
    x: float | None = None,
) -> CircuitElement:
    """Create a gate element. x-position auto-increments if not specified."""
    global _gate_counter
    _gate_counter += 1
    return CircuitElement(
        id=f"g{_gate_counter}",
        gateId=gate_id,
        position=Position(x=x if x is not None else _gate_counter * 60.0, y=0),
        wireIndex=wire,
        targetWireIndices=[target] if target is not None else None,
        parameterValues=params,
    )


def run_circuit(
    wires: list[Wire],
    gates: list[CircuitElement],
    fock: int = 8,
    shots: int = 1024,
) -> SimulationResponse:
    """Run a circuit through the full bosonic simulation pipeline."""
    global _gate_counter
    _gate_counter = 0  # reset for next test
    request = SimulationRequest(
        wires=wires,
        elements=gates,
        fockTruncation=fock,
        shots=shots,
    )
    return run_bosonic_simulation(request)


# ===================================================================
# Assertion helpers
# ===================================================================

def assert_bloch(state: QubitState, x: float = None, y: float = None,
                 z: float = None, tol: float = 0.15):
    """Assert Bloch vector components are close to expected values."""
    bv = state.blochVector
    if x is not None:
        assert abs(bv["x"] - x) < tol, f'Bloch x: expected {x}, got {bv["x"]}'
    if y is not None:
        assert abs(bv["y"] - y) < tol, f'Bloch y: expected {y}, got {bv["y"]}'
    if z is not None:
        assert abs(bv["z"] - z) < tol, f'Bloch z: expected {z}, got {bv["z"]}'


def assert_fock_peak(state: QumodeState, n: int):
    """Assert the highest Fock probability is at |n>."""
    probs = state.fockProbabilities
    peak = max(range(len(probs)), key=lambda i: probs[i])
    assert peak == n, f"Fock peak at |{peak}>, expected |{n}>. Probs: {probs[:8]}"


def assert_mean_photon(state: QumodeState, expected: float, tol: float = 0.5):
    """Assert mean photon number is close to expected."""
    assert abs(state.meanPhotonNumber - expected) < tol, \
        f"Mean photon: expected {expected}, got {state.meanPhotonNumber}"


def assert_vacuum(state: QumodeState, tol: float = 0.05):
    """Assert qumode is in vacuum state |0>."""
    assert state.fockProbabilities[0] > 1.0 - tol, \
        f"Expected vacuum, P(0)={state.fockProbabilities[0]}"
    assert state.meanPhotonNumber < tol, \
        f"Expected <n>=0, got {state.meanPhotonNumber}"


def assert_fock_prob(state: QumodeState, n: int, expected: float, tol: float = 0.1):
    """Assert probability of Fock state |n> is close to expected."""
    actual = state.fockProbabilities[n]
    assert abs(actual - expected) < tol, \
        f"P(|{n}>): expected {expected}, got {actual}"


# ===================================================================
# 1. PURE DV (qubit-only) CIRCUITS
# ===================================================================

class TestPureDV:
    """Qubit-only circuits. Each test needs at least one qumode (bosonic-qiskit requirement)."""

    def test_identity_qubit_in_zero(self):
        """No gates applied: qubit stays in |0>, qumode in vacuum."""
        r = run_circuit(wires=[qumode(0), qubit(1)], gates=[])
        assert r.success
        assert_bloch(r.qubitStates[1], z=1.0)
        assert_vacuum(r.qumodeStates[0])

    def test_hadamard(self):
        """H|0> = |+> : Bloch vector along +x."""
        r = run_circuit(
            wires=[qumode(0), qubit(1)],
            gates=[gate("h", wire=1)],
        )
        assert r.success
        assert_bloch(r.qubitStates[1], x=1.0, y=0.0, z=0.0)

    def test_pauli_x(self):
        """X|0> = |1> : Bloch vector along -z."""
        r = run_circuit(
            wires=[qumode(0), qubit(1)],
            gates=[gate("x", wire=1)],
        )
        assert r.success
        assert_bloch(r.qubitStates[1], z=-1.0)

    def test_pauli_z(self):
        """Z|0> = |0> (global phase): Bloch vector unchanged at +z."""
        r = run_circuit(
            wires=[qumode(0), qubit(1)],
            gates=[gate("z", wire=1)],
        )
        assert r.success
        assert_bloch(r.qubitStates[1], z=1.0)

    def test_hadamard_twice(self):
        """H H |0> = |0>."""
        r = run_circuit(
            wires=[qumode(0), qubit(1)],
            gates=[gate("h", wire=1, x=10), gate("h", wire=1, x=20)],
        )
        assert r.success
        assert_bloch(r.qubitStates[1], z=1.0)

    def test_x_then_hadamard(self):
        """H X |0> = H|1> = |-> : Bloch vector along -x."""
        r = run_circuit(
            wires=[qumode(0), qubit(1)],
            gates=[gate("x", wire=1, x=10), gate("h", wire=1, x=20)],
        )
        assert r.success
        assert_bloch(r.qubitStates[1], x=-1.0, z=0.0)

    def test_rx_pi(self):
        """Rx(pi)|0> = -i|1> : Bloch vector along -z."""
        r = run_circuit(
            wires=[qumode(0), qubit(1)],
            gates=[gate("rx", wire=1, params={"theta": math.pi})],
        )
        assert r.success
        assert_bloch(r.qubitStates[1], z=-1.0)

    def test_ry_pi_half(self):
        """Ry(pi/2)|0> : Bloch vector along +x."""
        r = run_circuit(
            wires=[qumode(0), qubit(1)],
            gates=[gate("ry", wire=1, params={"theta": math.pi / 2})],
        )
        assert r.success
        assert_bloch(r.qubitStates[1], x=1.0, z=0.0, tol=0.2)


# ===================================================================
# 2. PURE CV (qumode-only) CIRCUITS
# ===================================================================

class TestPureCV:
    """Qumode-only circuits."""

    def test_vacuum(self):
        """No gates: qumode starts in vacuum |0>."""
        r = run_circuit(wires=[qumode(0)], gates=[])
        assert r.success
        assert_vacuum(r.qumodeStates[0])

    def test_displacement_real(self):
        """D(alpha)|0>: coherent state with <n> ~ |alpha|^2."""
        alpha = 1.0
        r = run_circuit(
            wires=[qumode(0)],
            gates=[gate("displace", wire=0, params={"alpha_re": alpha, "alpha_im": 0.0})],
        )
        assert r.success
        qm = r.qumodeStates[0]
        # Coherent state: <n> = |alpha|^2 = 1.0
        assert_mean_photon(qm, expected=alpha**2, tol=0.5)
        # Should NOT be in vacuum anymore
        assert qm.fockProbabilities[0] < 0.8

    def test_displacement_larger(self):
        """D(2)|0>: <n> ~ 4."""
        r = run_circuit(
            wires=[qumode(0)],
            gates=[gate("displace", wire=0, params={"alpha_re": 2.0, "alpha_im": 0.0})],
        )
        assert r.success
        assert_mean_photon(r.qumodeStates[0], expected=4.0, tol=1.0)

    def test_squeeze(self):
        """S(r)|0>: squeezed vacuum has <n> = sinh^2(r)."""
        r_param = 0.5
        r = run_circuit(
            wires=[qumode(0)],
            gates=[gate("squeeze", wire=0, params={"r": r_param, "phi": 0.0})],
        )
        assert r.success
        expected_n = math.sinh(r_param) ** 2
        assert_mean_photon(r.qumodeStates[0], expected=expected_n, tol=0.3)

    def test_rotation_preserves_vacuum(self):
        """R(theta)|0> = |0>: phase rotation doesn't change vacuum."""
        r = run_circuit(
            wires=[qumode(0)],
            gates=[gate("rotate", wire=0, params={"theta": math.pi / 3})],
        )
        assert r.success
        assert_vacuum(r.qumodeStates[0])

    def test_displace_then_rotate(self):
        """R(theta) D(alpha)|0>: rotation preserves mean photon number."""
        alpha = 1.5
        r = run_circuit(
            wires=[qumode(0)],
            gates=[
                gate("displace", wire=0, x=10, params={"alpha_re": alpha, "alpha_im": 0.0}),
                gate("rotate", wire=0, x=20, params={"theta": math.pi / 4}),
            ],
        )
        assert r.success
        # <n> should still be |alpha|^2
        assert_mean_photon(r.qumodeStates[0], expected=alpha**2, tol=0.5)

    def test_fock_1_initial_state(self):
        """Qumode initialized in |1>: <n> = 1, peak at n=1."""
        r = run_circuit(wires=[qumode(0, initial_state=1)], gates=[])
        assert r.success
        qm = r.qumodeStates[0]
        assert_mean_photon(qm, expected=1.0, tol=0.3)
        assert_fock_peak(qm, n=1)


# ===================================================================
# 3. HYBRID CV-DV CIRCUITS
# ===================================================================

class TestHybrid:
    """Circuits mixing qubit and qumode operations."""

    def test_cd_creates_entanglement(self):
        """H|0> then CD: qubit should be in mixed state (not pure |0> or |1>).
        After CD, qubit is entangled with qumode, so tracing out qumode
        gives a mixed qubit state with |Bloch| < 1."""
        r = run_circuit(
            wires=[qumode(0), qubit(1)],
            gates=[
                gate("h", wire=1, x=10),
                gate("cdisp", wire=1, target=0, x=20,
                     params={"alpha_re": 2.0, "alpha_im": 0.0}),
            ],
        )
        assert r.success
        bv = r.qubitStates[1].blochVector
        bloch_length = math.sqrt(bv["x"]**2 + bv["y"]**2 + bv["z"]**2)
        # Entangled state => mixed => |r| < 1
        assert bloch_length < 0.95, f"Expected mixed state, Bloch length = {bloch_length}"

    def test_cd_on_zero_qubit(self):
        """|0> qubit + CD: qumode displaced by +alpha only (no superposition)."""
        alpha = 1.5
        r = run_circuit(
            wires=[qumode(0), qubit(1)],
            gates=[
                gate("cdisp", wire=1, target=0, x=10,
                     params={"alpha_re": alpha, "alpha_im": 0.0}),
            ],
        )
        assert r.success
        # Qubit should remain in |0>
        assert_bloch(r.qubitStates[1], z=1.0, tol=0.2)
        # Qumode should be a coherent state
        assert_mean_photon(r.qumodeStates[0], expected=alpha**2, tol=1.0)

    def test_cr_on_vacuum(self):
        """Controlled rotation on vacuum does nothing to qumode."""
        r = run_circuit(
            wires=[qumode(0), qubit(1)],
            gates=[
                gate("h", wire=1, x=10),
                gate("cr", wire=1, target=0, x=20,
                     params={"theta": math.pi / 4}),
            ],
        )
        assert r.success
        # Vacuum is eigenstate of rotation, so qumode stays vacuum
        assert_vacuum(r.qumodeStates[0], tol=0.1)

    def test_qubit_unaffected_by_cv_gate(self):
        """Displacement on qumode should not affect qubit state."""
        r = run_circuit(
            wires=[qumode(0), qubit(1)],
            gates=[
                gate("h", wire=1, x=10),
                gate("displace", wire=0, x=20, params={"alpha_re": 2.0, "alpha_im": 0.0}),
            ],
        )
        assert r.success
        # Qubit should still be |+>
        assert_bloch(r.qubitStates[1], x=1.0, z=0.0, tol=0.2)
        # Qumode should be coherent
        assert_mean_photon(r.qumodeStates[0], expected=4.0, tol=1.0)


# ===================================================================
# 4. VALIDATION & EDGE CASES
# ===================================================================

class TestValidation:
    """Test request validation and error paths."""

    def test_fock_truncation_not_power_of_2(self):
        """Non-power-of-2 Fock truncation should fail."""
        r = run_circuit(wires=[qumode(0)], gates=[], fock=6)
        assert not r.success
        assert "power of 2" in r.error.lower()

    def test_no_qumodes_fails(self):
        """Bosonic-qiskit requires at least one qumode."""
        r = run_circuit(wires=[qubit(0)], gates=[])
        assert not r.success

    def test_unsupported_gate(self):
        """Unknown gate ID should fail validation."""
        r = run_circuit(
            wires=[qumode(0)],
            gates=[gate("nonexistent_gate", wire=0)],
        )
        assert not r.success


# ===================================================================
# PLACEHOLDER: Add your own circuit tests below

class TestStateAndMeasurementSeparation:
    """The state and the bitstring counts come from two separate runs.

    (bosonic-qiskit needs at least one qumode, so these circuits carry an idle
    vacuum mode that never takes part.)

    Measuring collapses the state, so the statevector has to be taken from an
    unmeasured run — otherwise every qubit coherence is destroyed and
    <sigma_x> = <sigma_y> = 0 for every circuit.
    """

    def test_hadamard_keeps_its_coherence(self):
        r = run_circuit(wires=[qubit(0), qumode(1)], gates=[gate("h", wire=0, x=10)])
        assert r.success
        assert_bloch(r.qubitStates[0], x=1.0, y=0.0, z=0.0, tol=1e-6)

    def test_s_gate_lands_on_the_y_axis(self):
        r = run_circuit(
            wires=[qubit(0), qumode(1)],
            gates=[gate("h", wire=0, x=10), gate("s", wire=0, x=20)],
        )
        assert r.success
        assert_bloch(r.qubitStates[0], x=0.0, y=1.0, z=0.0, tol=1e-6)

    def test_bell_state_is_mixed_on_each_qubit(self):
        r = run_circuit(
            wires=[qubit(0), qubit(1), qumode(2)],
            gates=[gate("h", wire=0, x=10), gate("cnot", wire=0, target=1, x=20)],
        )
        assert r.success
        for wire in (0, 1):
            bv = r.qubitStates[wire].blochVector
            length = math.sqrt(bv["x"] ** 2 + bv["y"] ** 2 + bv["z"] ** 2)
            assert length < 1e-6, f"wire {wire} should be maximally mixed, got |r| = {length}"

    def test_bitstring_counts_still_come_back(self):
        shots = 2000
        r = run_circuit(
            wires=[qubit(0), qubit(1), qumode(2)],
            gates=[gate("h", wire=0, x=10), gate("cnot", wire=0, target=1, x=20)],
            shots=shots,
        )
        assert r.success
        counts = r.bitstringCounts
        assert counts, "expected bitstring counts from the measured run"
        assert sum(counts.values()) == shots
        # A Bell state only ever yields 00 or 11, roughly half of each
        assert set(counts) <= {"00", "11"}
        assert 0.35 < counts.get("00", 0) / shots < 0.65

    def test_counts_and_state_agree_on_a_biased_qubit(self):
        shots = 4000
        theta = math.pi / 3          # P(1) = sin^2(theta/2) = 0.25
        r = run_circuit(
            wires=[qubit(0), qumode(1)],
            gates=[gate("ry", wire=0, x=10, params={"theta": theta})],
            shots=shots,
        )
        assert r.success
        p1_state = (1 - r.qubitStates[0].blochVector["z"]) / 2
        p1_counts = r.bitstringCounts.get("1", 0) / shots
        assert abs(p1_state - math.sin(theta / 2) ** 2) < 1e-6
        assert abs(p1_counts - p1_state) < 0.05


class TestPostSelectedCounts:
    """Bitstring counts follow the post-selected state, not the raw one."""

    @staticmethod
    def _bell(post_selections=None, shots=1000):
        global _gate_counter
        _gate_counter = 0
        request = SimulationRequest(
            wires=[qubit(0), qubit(1), qumode(2)],
            elements=[
                gate("h", wire=0, x=10),
                gate("cnot", wire=0, target=1, x=20),
            ],
            fockTruncation=4,
            shots=shots,
            postSelections=post_selections or [],
        )
        return run_bosonic_simulation(request)

    def test_without_post_selection_both_outcomes_appear(self):
        r = self._bell()
        assert r.success
        assert set(r.bitstringCounts) == {"00", "11"}

    def test_post_selecting_zero_keeps_only_00(self):
        r = self._bell([QubitPostSelection(wireIndex=0, outcome=0)])
        assert r.success
        assert r.bitstringCounts == {"00": 1000}

    def test_post_selecting_one_keeps_only_11(self):
        r = self._bell([QubitPostSelection(wireIndex=0, outcome=1)])
        assert r.success
        assert r.bitstringCounts == {"11": 1000}

    def test_bit_order_puts_the_first_qubit_wire_leftmost(self):
        r = run_circuit(
            wires=[qubit(0), qubit(1), qumode(2)],
            gates=[gate("x", wire=1, x=10)],
            fock=4,
            shots=100,
        )
        assert r.success
        assert r.bitstringCounts == {"01": 100}

    def test_counts_track_an_uneven_distribution(self):
        shots = 4000
        theta = math.pi / 3          # P(1) = 0.25 on the first qubit
        r = run_circuit(
            wires=[qubit(0), qubit(1), qumode(2)],
            gates=[gate("ry", wire=0, x=10, params={"theta": theta})],
            fock=4,
            shots=shots,
        )
        assert r.success
        p10 = r.bitstringCounts.get("10", 0) / shots
        assert abs(p10 - math.sin(theta / 2) ** 2) < 0.05


class TestSidebandsAndConditionalDisplacements:
    """Gates added for the Sandia QSCOUT / Jaqal gate set: xCD, yCD, JC, AJC.

    These assert on the qumode side (photon numbers), which is unaffected by
    the qubit-side Bloch extraction issue tracked by the failing TestPureDV
    cases.
    """

    def test_xcd_on_plus_displaces_the_mode(self):
        """xCD conditions on the sigma_x eigenstates, so |+> displaces by +alpha."""
        alpha = 1.0
        r = run_circuit(
            wires=[qumode(0), qubit(1)],
            gates=[
                gate("h", wire=1, x=10),
                gate("xcdisp", wire=1, target=0, x=20,
                     params={"alpha_re": alpha, "alpha_im": 0.0}),
            ],
            fock=8,
        )
        assert r.success
        assert_mean_photon(r.qumodeStates[0], expected=alpha ** 2, tol=0.4)

    def test_ycd_on_zero_displaces_the_mode(self):
        """|0> is an even mix of the sigma_y eigenstates, so the mode still moves."""
        alpha = 1.0
        r = run_circuit(
            wires=[qumode(0), qubit(1)],
            gates=[
                gate("ycdisp", wire=1, target=0, x=10,
                     params={"alpha_re": alpha, "alpha_im": 0.0}),
            ],
            fock=8,
        )
        assert r.success
        assert_mean_photon(r.qumodeStates[0], expected=alpha ** 2, tol=0.4)

    def test_ajc_creates_a_photon_from_vacuum(self):
        """Blue-sideband pi-pulse takes |g,0> to |e,1>."""
        r = run_circuit(
            wires=[qumode(0), qubit(1)],
            gates=[
                gate("ajc", wire=1, target=0, x=10,
                     params={"theta": math.pi / 2, "phi": 0.0}),
            ],
            fock=8,
        )
        assert r.success
        assert_mean_photon(r.qumodeStates[0], expected=1.0, tol=0.2)

    def test_jc_does_nothing_on_ground_vacuum(self):
        """Red sideband has no photon to exchange from |g,0>."""
        r = run_circuit(
            wires=[qumode(0), qubit(1)],
            gates=[
                gate("jc", wire=1, target=0, x=10,
                     params={"theta": math.pi / 2, "phi": 0.0}),
            ],
            fock=8,
        )
        assert r.success
        assert_vacuum(r.qumodeStates[0], tol=0.05)

    def test_ajc_is_undone_by_its_inverse(self):
        """AJC(theta) then AJC(-theta) returns the mode to vacuum.

        (JC cannot undo AJC: from |e,1> the red sideband couples upward to
        |g,2>, it does not take the photon back out.)
        """
        r = run_circuit(
            wires=[qumode(0), qubit(1)],
            gates=[
                gate("ajc", wire=1, target=0, x=10,
                     params={"theta": math.pi / 2, "phi": 0.0}),
                gate("ajc", wire=1, target=0, x=20,
                     params={"theta": -math.pi / 2, "phi": 0.0}),
            ],
            fock=8,
        )
        assert r.success
        assert_vacuum(r.qumodeStates[0], tol=0.1)


# ===================================================================
#
# class TestCatState:
#     """Test circuits that prepare cat states via CD protocol."""
#
#     def test_even_cat(self):
#         r = run_circuit(
#             wires=[qumode(0), qubit(1)],
#             gates=[
#                 gate("h", wire=1, x=10),
#                 gate("cdisp", wire=1, target=0, x=20,
#                      params={"alpha_re": 2.0, "alpha_im": 0.0}),
#                 # Post-select qubit in |+> for even cat...
#             ],
#             fock=16,
#         )
#         assert r.success
#         # Even cat: only even Fock states populated
#         qm = r.qumodeStates[0]
#         # assert qm.fockProbabilities[1] < 0.05  # odd states suppressed
#
#
# class TestBellState:
#     """Test CNOT-based Bell state preparation."""
#
#     def test_bell_phi_plus(self):
#         r = run_circuit(
#             wires=[qumode(0), qubit(1), qubit(2)],
#             gates=[
#                 gate("h", wire=1, x=10),
#                 gate("cnot", wire=1, target=2, x=20),
#             ],
#         )
#         assert r.success
#         # Each qubit should be maximally mixed (Bloch length ~ 0)
#         for qi in [1, 2]:
#             bv = r.qubitStates[qi].blochVector
#             length = math.sqrt(bv["x"]**2 + bv["y"]**2 + bv["z"]**2)
#             assert length < 0.2
