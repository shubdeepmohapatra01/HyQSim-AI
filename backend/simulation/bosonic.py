"""
Bosonic-qiskit simulation backend.

Uses C2QA/bosonic-qiskit to simulate hybrid CV-DV quantum circuits.
Qumodes are encoded using multiple qubits based on Fock truncation.
The cutoff must be a power of 2 (cutoff = 2^num_qubits_per_qumode).
"""

import numpy as np
import math
import time
from typing import Optional

try:
    from bosonic_qiskit import CVCircuit, QumodeRegister
    from bosonic_qiskit.util import simulate, trace_out_qubits, trace_out_qumodes
    from qiskit import QuantumRegister
    from qiskit.quantum_info import Statevector, partial_trace, DensityMatrix
    import qutip
    HAS_BOSONIC = True
except ImportError:
    HAS_BOSONIC = False
    print("Warning: bosonic-qiskit not installed. Install from: https://github.com/C2QA/bosonic-qiskit")

from .models import (
    SimulationRequest,
    SimulationResponse,
    QubitState,
    QumodeState,
    ComplexNumber,
)


# Gates available in bosonic-qiskit
SUPPORTED_QUMODE_GATES = {'displace', 'squeeze', 'rotate', 'bs', 'kerr'}
SUPPORTED_QUBIT_GATES = {'h', 'x', 'y', 'z', 's', 'sdg', 't', 'rx', 'ry', 'rz', 'cnot'}
SUPPORTED_HYBRID_GATES = {'cdisp', 'cr', 'snap', 'ecd'}


def is_power_of_two(n: int) -> bool:
    """Check if n is a power of 2."""
    return n > 0 and (n & (n - 1)) == 0


def next_power_of_two(n: int) -> int:
    """Return the next power of 2 >= n."""
    if n <= 0:
        return 1
    return 2 ** math.ceil(math.log2(n))


def validate_request(request: SimulationRequest) -> tuple[bool, str]:
    """
    Validate the simulation request.

    Returns:
        Tuple of (is_valid, error_message)
    """
    # Check Fock truncation is power of 2
    if not is_power_of_two(request.fockTruncation):
        suggested = next_power_of_two(request.fockTruncation)
        return False, f"Fock truncation must be a power of 2. Got {request.fockTruncation}, try {suggested}."

    # Check all gates are supported
    for element in request.elements:
        gate_id = element.gateId
        if gate_id not in SUPPORTED_QUMODE_GATES and \
           gate_id not in SUPPORTED_QUBIT_GATES and \
           gate_id not in SUPPORTED_HYBRID_GATES:
            return False, f"Gate '{gate_id}' is not supported by bosonic-qiskit backend."

    return True, ""


def apply_post_selection(
    statevector: Statevector,
    circuit: CVCircuit,
    post_selections: list,
    wire_to_qubit_idx: dict[int, int],
    num_qubits_per_qumode: int
) -> Statevector:
    """
    Apply post-selection on qubit measurement outcomes.

    Projects the statevector onto the subspace where specified qubits
    have the desired measurement outcomes, then normalizes.

    Args:
        statevector: Full system statevector
        circuit: The CVCircuit
        post_selections: List of QubitPostSelection objects
        wire_to_qubit_idx: Mapping from wire index to qubit register index
        num_qubits_per_qumode: Number of qubits encoding each qumode

    Returns:
        Projected and normalized statevector
    """
    sv_array = np.array(statevector.data)
    num_total_qubits = circuit.num_qubits

    # For each post-selection, project onto the desired outcome
    for ps in post_selections:
        wire_idx = ps.wireIndex
        outcome = ps.outcome

        if wire_idx not in wire_to_qubit_idx:
            continue

        qubit_idx = wire_to_qubit_idx[wire_idx]

        # In bosonic-qiskit, the qubit register comes after the qumode qubits
        # The qubit index in the circuit is: num_qumode_qubits + qubit_idx
        num_qumode_qubits = len(circuit.qubits) - len(wire_to_qubit_idx)
        actual_qubit_idx = num_qumode_qubits + qubit_idx

        # Project onto |outcome⟩ for this qubit
        # The statevector has 2^n components, indexed in little-endian order
        # Qubit at position k contributes 2^k to the index
        new_sv = np.zeros_like(sv_array)

        for i in range(len(sv_array)):
            # Check if qubit at actual_qubit_idx has the desired outcome
            qubit_val = (i >> actual_qubit_idx) & 1
            if qubit_val == outcome:
                new_sv[i] = sv_array[i]

        sv_array = new_sv

    # Normalize
    norm = np.linalg.norm(sv_array)
    if norm > 1e-10:
        sv_array = sv_array / norm
    else:
        # Post-selection failed (probability ~0), return original
        return statevector

    return Statevector(sv_array)


def run_bosonic_simulation(request: SimulationRequest) -> SimulationResponse:
    """
    Run simulation using bosonic-qiskit.

    Args:
        request: SimulationRequest with wires, elements, and fockTruncation

    Returns:
        SimulationResponse with qubit and qumode states
    """
    start_time = time.time()

    if not HAS_BOSONIC:
        return SimulationResponse(
            success=False,
            qubitStates={},
            qumodeStates={},
            executionTime=0,
            backend="bosonic-qiskit",
            error="bosonic-qiskit not installed. Install from: https://github.com/C2QA/bosonic-qiskit"
        )

    # Validate request
    is_valid, error_msg = validate_request(request)
    if not is_valid:
        return SimulationResponse(
            success=False,
            qubitStates={},
            qumodeStates={},
            executionTime=time.time() - start_time,
            backend="bosonic-qiskit",
            error=error_msg
        )

    try:
        # Count qubits and qumodes, track their wire indices
        qubit_wire_indices = []
        qumode_wire_indices = []

        for i, wire in enumerate(request.wires):
            if wire.type.value == "qubit":
                qubit_wire_indices.append(i)
            else:
                qumode_wire_indices.append(i)

        num_qubits = len(qubit_wire_indices)
        num_qumodes = len(qumode_wire_indices)

        if num_qumodes == 0:
            return SimulationResponse(
                success=False,
                qubitStates={},
                qumodeStates={},
                executionTime=time.time() - start_time,
                backend="bosonic-qiskit",
                error="At least one qumode is required for bosonic-qiskit simulation."
            )

        # Calculate qubits per qumode from Fock truncation
        # cutoff = 2^num_qubits_per_qumode
        num_qubits_per_qumode = int(math.log2(request.fockTruncation))

        # Create qumode register
        qmr = QumodeRegister(
            num_qumodes=num_qumodes,
            num_qubits_per_qumode=num_qubits_per_qumode,
            name="qmr"
        )

        # Create qubit register if needed
        registers = [qmr]
        qbr = None
        if num_qubits > 0:
            qbr = QuantumRegister(num_qubits, name="qbr")
            registers.append(qbr)

        # Create circuit
        circuit = CVCircuit(*registers)

        # Map wire indices to register indices
        wire_to_qumode_idx = {wire_idx: i for i, wire_idx in enumerate(qumode_wire_indices)}
        wire_to_qubit_idx = {wire_idx: i for i, wire_idx in enumerate(qubit_wire_indices)}

        # Sort elements by x position (execution order)
        sorted_elements = sorted(request.elements, key=lambda e: e.position.x)

        # Apply gates
        for element in sorted_elements:
            gate_id = element.gateId
            wire_idx = element.wireIndex
            params = element.parameterValues or {}

            # === QUMODE GATES ===
            if wire_idx in wire_to_qumode_idx:
                qumode_idx = wire_to_qumode_idx[wire_idx]
                qumode = qmr[qumode_idx]  # Get qumode (list of qubits)

                if gate_id == "displace":
                    alpha = complex(params.get("alpha_re", 0), params.get("alpha_im", 0))
                    circuit.cv_d(alpha, qumode)

                elif gate_id == "squeeze":
                    r = params.get("r", 0)
                    phi = params.get("phi", 0)
                    # Squeezing parameter z = r * e^(i*phi)
                    z = r * np.exp(1j * phi)
                    circuit.cv_sq(z, qumode)

                elif gate_id == "rotate":
                    theta = params.get("theta", 0)
                    circuit.cv_r(theta, qumode)

                elif gate_id == "bs" and element.targetWireIndices:
                    # Beam splitter between two qumodes
                    target_wire = element.targetWireIndices[0]
                    if target_wire in wire_to_qumode_idx:
                        target_qumode_idx = wire_to_qumode_idx[target_wire]
                        target_qumode = qmr[target_qumode_idx]
                        theta = params.get("theta", np.pi / 4)
                        # bosonic-qiskit cv_bs takes complex theta
                        circuit.cv_bs(complex(theta), qumode, target_qumode)

            # === QUBIT GATES ===
            elif wire_idx in wire_to_qubit_idx and qbr is not None:
                qubit_idx = wire_to_qubit_idx[wire_idx]
                qubit = qbr[qubit_idx]

                if gate_id == "h":
                    circuit.h(qubit)
                elif gate_id == "x":
                    circuit.x(qubit)
                elif gate_id == "y":
                    circuit.y(qubit)
                elif gate_id == "z":
                    circuit.z(qubit)
                elif gate_id == "s":
                    circuit.s(qubit)
                elif gate_id == "sdg":
                    circuit.sdg(qubit)
                elif gate_id == "t":
                    circuit.t(qubit)
                elif gate_id == "rx":
                    circuit.rx(params.get("theta", np.pi / 2), qubit)
                elif gate_id == "ry":
                    circuit.ry(params.get("theta", np.pi / 2), qubit)
                elif gate_id == "rz":
                    circuit.rz(params.get("theta", np.pi / 2), qubit)
                elif gate_id == "cnot" and element.targetWireIndices:
                    target_wire = element.targetWireIndices[0]
                    if target_wire in wire_to_qubit_idx:
                        target_qubit = qbr[wire_to_qubit_idx[target_wire]]
                        circuit.cx(qubit, target_qubit)

            # === HYBRID GATES ===
            if gate_id in SUPPORTED_HYBRID_GATES and element.targetWireIndices:
                # For hybrid gates, control wire is qubit, target is qumode
                qubit_wire = wire_idx
                qumode_wire = element.targetWireIndices[0]

                if qubit_wire in wire_to_qubit_idx and qumode_wire in wire_to_qumode_idx and qbr is not None:
                    qubit_idx = wire_to_qubit_idx[qubit_wire]
                    qumode_idx = wire_to_qumode_idx[qumode_wire]
                    qubit = qbr[qubit_idx]
                    qumode = qmr[qumode_idx]

                    if gate_id == "cdisp":
                        # Controlled displacement
                        alpha = complex(params.get("alpha_re", 1), params.get("alpha_im", 0))
                        circuit.cv_c_d(alpha, qumode, qubit)

                    elif gate_id == "cr":
                        # Controlled rotation (dispersive interaction)
                        theta = params.get("theta", np.pi / 4)
                        circuit.cv_c_r(theta, qumode, qubit)

                    elif gate_id == "ecd":
                        # Echoed conditional displacement
                        beta = complex(params.get("beta_re", 1), params.get("beta_im", 0))
                        circuit.cv_ecd(abs(beta), qumode, qubit)

                    elif gate_id == "snap":
                        # SNAP gate
                        n = int(params.get("n", 1))
                        theta = params.get("theta", np.pi)
                        circuit.cv_snap(theta, n, qumode, qubit)

        # Simulate
        statevector, result, fockcounts = simulate(circuit, shots=1024, add_save_statevector=True)

        # Extract states
        qubit_states = {}
        qumode_states = {}

        if statevector is not None:
            # Apply post-selection if requested
            if request.postSelections and len(request.postSelections) > 0:
                statevector = apply_post_selection(
                    statevector, circuit, request.postSelections,
                    wire_to_qubit_idx, num_qubits_per_qumode
                )

            # Extract qumode states
            qumode_states = extract_qumode_states_from_statevector(
                statevector, circuit, wire_to_qumode_idx, request.fockTruncation
            )

            # Extract qubit states (after post-selection, these will be definite)
            if num_qubits > 0:
                qubit_states = extract_qubit_states_from_statevector(
                    statevector, circuit, wire_to_qubit_idx
                )

        return SimulationResponse(
            success=True,
            qubitStates=qubit_states,
            qumodeStates=qumode_states,
            executionTime=time.time() - start_time,
            backend="bosonic-qiskit"
        )

    except Exception as e:
        import traceback
        return SimulationResponse(
            success=False,
            qubitStates={},
            qumodeStates={},
            executionTime=time.time() - start_time,
            backend="bosonic-qiskit",
            error=f"{str(e)}\n{traceback.format_exc()}"
        )


def extract_qumode_states_from_statevector(
    statevector: Statevector,
    circuit: CVCircuit,
    wire_to_qumode_idx: dict[int, int],
    fock_truncation: int
) -> dict[int, QumodeState]:
    """Extract qumode states and compute Wigner function from the statevector."""
    states = {}

    for wire_idx, qumode_idx in wire_to_qumode_idx.items():
        try:
            # Trace out everything except this qumode
            qubits_to_trace = []
            for i, qubit in enumerate(circuit.qubits):
                # Check if this qubit belongs to a different qumode
                qumode_qubits = circuit.qumode_qubits_indices_grouped
                current_qumode_qubits = qumode_qubits[qumode_idx] if qumode_idx < len(qumode_qubits) else []
                if i not in current_qumode_qubits:
                    qubits_to_trace.append(i)

            if qubits_to_trace:
                reduced_dm = partial_trace(statevector, qubits_to_trace)
                dm_array = reduced_dm.data
                probs = np.real(np.diag(dm_array))
            else:
                # No qubits to trace out, statevector is for single qumode
                sv_array = np.array(statevector.data)
                dm_array = np.outer(sv_array, np.conj(sv_array))
                probs = np.abs(sv_array) ** 2

            # Ensure we have the right number of Fock states
            fock_probs = np.zeros(fock_truncation)
            fock_probs[:min(len(probs), fock_truncation)] = probs[:fock_truncation]

            # Extract amplitudes with proper phase from density matrix diagonal
            # For mixed states, we use sqrt(prob) but this loses phase info
            # The Wigner function will be computed from the full density matrix
            fock_amps = [ComplexNumber(re=np.sqrt(p), im=0) for p in fock_probs]

            # Mean photon number
            mean_n = sum(n * p for n, p in enumerate(fock_probs))

            # Compute Wigner function using qutip
            wigner_data, wigner_range = compute_wigner_from_density_matrix(
                dm_array, fock_truncation
            )

            states[wire_idx] = QumodeState(
                fockAmplitudes=fock_amps,
                fockProbabilities=fock_probs.tolist(),
                meanPhotonNumber=float(mean_n),
                wignerData=wigner_data,
                wignerRange=wigner_range
            )
        except Exception as e:
            import traceback
            print(f"Error extracting qumode state: {e}\n{traceback.format_exc()}")
            # Fallback to vacuum state
            fock_probs = [1.0] + [0.0] * (fock_truncation - 1)
            fock_amps = [ComplexNumber(re=1.0, im=0.0)] + [ComplexNumber(re=0.0, im=0.0)] * (fock_truncation - 1)
            states[wire_idx] = QumodeState(
                fockAmplitudes=fock_amps,
                fockProbabilities=fock_probs,
                meanPhotonNumber=0.0,
                wignerData=None,
                wignerRange=None
            )

    return states


def compute_wigner_from_density_matrix(
    dm_array: np.ndarray,
    fock_truncation: int,
    grid_size: int = 80,
    x_range: float = 5.0
) -> tuple[list[list[float]], float]:
    """
    Compute Wigner function from density matrix using qutip.

    Args:
        dm_array: Density matrix as numpy array
        fock_truncation: Fock space truncation
        grid_size: Size of the Wigner function grid
        x_range: Range of phase space coordinates (-x_range to +x_range)

    Returns:
        Tuple of (wigner_data as 2D list, x_range)
    """
    # Ensure density matrix is the right size
    dm_size = min(dm_array.shape[0], fock_truncation)
    dm_truncated = dm_array[:dm_size, :dm_size]

    # Create qutip density matrix
    rho = qutip.Qobj(dm_truncated, dims=[[dm_size], [dm_size]])

    # Compute Wigner function
    xvec = np.linspace(-x_range, x_range, grid_size)
    W = qutip.wigner(rho, xvec, xvec)

    # Transpose: qutip returns W[x_idx, p_idx], but frontend expects W[p_idx, x_idx]
    # for proper display with x horizontal and p vertical
    W_transposed = W.T

    # Convert to list for JSON serialization
    wigner_data = W_transposed.tolist()

    return wigner_data, x_range


def extract_qubit_states_from_statevector(
    statevector: Statevector,
    circuit: CVCircuit,
    wire_to_qubit_idx: dict[int, int]
) -> dict[int, QubitState]:
    """Extract individual qubit states from the full statevector."""
    states = {}

    for wire_idx, qubit_idx in wire_to_qubit_idx.items():
        try:
            # Trace out all qumodes to get qubit density matrix
            reduced_dm = trace_out_qumodes(circuit, statevector)

            # If multiple qubits, trace out other qubits too
            num_qubits = reduced_dm.dim
            if num_qubits > 2:
                # Trace out other qubits
                qubits_to_trace = [i for i in range(int(np.log2(num_qubits))) if i != qubit_idx]
                if qubits_to_trace:
                    reduced_dm = partial_trace(reduced_dm, qubits_to_trace)

            # Get the 2x2 density matrix
            dm = reduced_dm.data

            # Calculate Bloch vector from density matrix
            # ρ = (I + r·σ)/2, so r_i = Tr(ρ σ_i)
            sigma_x = np.array([[0, 1], [1, 0]])
            sigma_y = np.array([[0, -1j], [1j, 0]])
            sigma_z = np.array([[1, 0], [0, -1]])

            bloch_x = float(np.real(np.trace(dm @ sigma_x)))
            bloch_y = float(np.real(np.trace(dm @ sigma_y)))
            bloch_z = float(np.real(np.trace(dm @ sigma_z)))

            # Approximate amplitudes from diagonal
            p0 = float(np.real(dm[0, 0]))
            p1 = float(np.real(dm[1, 1]))

            states[wire_idx] = QubitState(
                amplitude=(
                    ComplexNumber(re=np.sqrt(p0), im=0.0),
                    ComplexNumber(re=np.sqrt(p1), im=0.0)
                ),
                blochVector={"x": bloch_x, "y": bloch_y, "z": bloch_z},
                expectations={"sigmaX": bloch_x, "sigmaY": bloch_y, "sigmaZ": bloch_z}
            )
        except Exception:
            # Fallback to |0⟩ state
            states[wire_idx] = QubitState(
                amplitude=(
                    ComplexNumber(re=1.0, im=0.0),
                    ComplexNumber(re=0.0, im=0.0)
                ),
                blochVector={"x": 0.0, "y": 0.0, "z": 1.0},
                expectations={"sigmaX": 0.0, "sigmaY": 0.0, "sigmaZ": 1.0}
            )

    return states
