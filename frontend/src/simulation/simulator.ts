// Main quantum circuit simulator

import type { Wire, CircuitElement, Gate, SimulationResult, QubitState, QumodeState, QubitPostSelection } from '../types/circuit';
import { getDefaultParameters } from '../types/circuit';
import type { StateVector, Complex } from './complex';
import { complex, mul, add, scale, abs2, normalize, tensorProduct, matVecMul } from './complex';
import { initQubit, applyGateByName, stateVectorToQubitState, applyCNOT } from './qubit';
import { initQumode, applyQumodeGate, stateVectorToQumodeState, displacementMatrix } from './qumode';

export interface SimulatorState {
  // For independent qubits/qumodes (no entanglement)
  qubitStates: Map<number, StateVector>;
  qumodeStates: Map<number, StateVector>;
  // For entangled states, we'd need a full tensor product state
  // This is a simplified simulator that tracks separable states
  fockDim: number;
}

export function initSimulator(wires: Wire[], fockDim: number): SimulatorState {
  const qubitStates = new Map<number, StateVector>();
  const qumodeStates = new Map<number, StateVector>();

  for (let i = 0; i < wires.length; i++) {
    const wire = wires[i];
    if (wire.type === 'qubit') {
      qubitStates.set(i, initQubit());
    } else {
      qumodeStates.set(i, initQumode(fockDim));
    }
  }

  return { qubitStates, qumodeStates, fockDim };
}

// Sort elements by x position (left to right execution)
function sortElementsByPosition(elements: CircuitElement[]): CircuitElement[] {
  return [...elements].sort((a, b) => a.position.x - b.position.x);
}

export function runSimulation(
  wires: Wire[],
  elements: CircuitElement[],
  gates: Map<string, Gate>,
  fockDim: number,
  postSelections: QubitPostSelection[] = []
): SimulationResult {
  const startTime = performance.now();

  // Initialize state
  const state = initSimulator(wires, fockDim);

  // Sort elements by position (execution order)
  const sortedElements = sortElementsByPosition(elements);

  // Apply each gate
  for (const element of sortedElements) {
    const gate = gates.get(element.gateId);
    if (!gate) continue;

    const params = element.parameterValues ?? getDefaultParameters(gate);
    const wireIndex = element.wireIndex;
    const wire = wires[wireIndex];

    if (gate.category === 'qubit' && wire?.type === 'qubit') {
      // Single qubit gate
      if (!gate.numQubits || gate.numQubits === 1) {
        const currentState = state.qubitStates.get(wireIndex);
        if (currentState) {
          const newState = applyGateByName(currentState, gate.id, params);
          state.qubitStates.set(wireIndex, newState);
        }
      }
      // Two-qubit gate (CNOT)
      else if (gate.numQubits === 2 && element.targetWireIndices?.length) {
        const targetIndex = element.targetWireIndices[0];
        const controlState = state.qubitStates.get(wireIndex);
        const targetState = state.qubitStates.get(targetIndex);

        if (controlState && targetState) {
          // Create 4D tensor product state
          const combinedState = tensorProduct(controlState, targetState);
          // Apply CNOT
          const newCombinedState = applyCNOT(combinedState);
          // Extract individual states (approximation for separable states)
          // This is only accurate if the state remains separable
          const [newControl, newTarget] = extractTwoQubitStates(newCombinedState);
          state.qubitStates.set(wireIndex, newControl);
          state.qubitStates.set(targetIndex, newTarget);
        }
      }
    } else if (gate.category === 'qumode' && wire?.type === 'qumode') {
      // Single qumode gate
      if (!gate.numQumodes || gate.numQumodes === 1) {
        const currentState = state.qumodeStates.get(wireIndex);
        if (currentState) {
          const newState = applyQumodeGate(currentState, gate.id, params, fockDim);
          state.qumodeStates.set(wireIndex, newState);
        }
      }
      // Two-qumode gate (beam splitter) - simplified
      else if (gate.numQumodes === 2 && element.targetWireIndices?.length) {
        const targetIndex = element.targetWireIndices[0];
        const state1 = state.qumodeStates.get(wireIndex);
        const state2 = state.qumodeStates.get(targetIndex);

        if (state1 && state2) {
          const [newState1, newState2] = applyBeamSplitter(
            state1,
            state2,
            params.theta ?? Math.PI / 4,
            params.phi ?? 0,
            fockDim
          );
          state.qumodeStates.set(wireIndex, newState1);
          state.qumodeStates.set(targetIndex, newState2);
        }
      }
    } else if (gate.category === 'hybrid') {
      // Hybrid gate
      const qubitWireIndex = wireIndex;
      const qumodeWireIndex = element.targetWireIndices?.[0];

      if (qumodeWireIndex !== undefined) {
        const qubitState = state.qubitStates.get(qubitWireIndex);
        const qumodeState = state.qumodeStates.get(qumodeWireIndex);

        // Check if this qubit has post-selection
        const qubitPostSelection = postSelections.find(ps => ps.wireIndex === qubitWireIndex);

        if (qubitState && qumodeState) {
          const [newQubitState, newQumodeState] = applyHybridGate(
            qubitState,
            qumodeState,
            gate.id,
            params,
            fockDim,
            qubitPostSelection?.outcome
          );
          state.qubitStates.set(qubitWireIndex, newQubitState);
          state.qumodeStates.set(qumodeWireIndex, newQumodeState);
        }
      }
    }
  }

  // Convert to result format
  const qubitResults = new Map<number, QubitState>();
  const qumodeResults = new Map<number, QumodeState>();

  for (const [idx, sv] of state.qubitStates) {
    qubitResults.set(idx, stateVectorToQubitState(sv));
  }

  for (const [idx, sv] of state.qumodeStates) {
    qumodeResults.set(idx, stateVectorToQumodeState(sv));
  }

  const executionTime = performance.now() - startTime;

  return {
    qubitStates: qubitResults,
    qumodeStates: qumodeResults,
    backend: 'browser',
    executionTime,
  };
}

// Extract two single-qubit states from a 4D combined state (approximation)
function extractTwoQubitStates(combined: StateVector): [StateVector, StateVector] {
  // This is an approximation that works for separable states
  // |ψ⟩ = |00⟩c₀₀ + |01⟩c₀₁ + |10⟩c₁₀ + |11⟩c₁₁

  // Trace out second qubit to get first qubit
  // ρ₁ = Tr₂(|ψ⟩⟨ψ|)
  const p0 = abs2(combined[0]) + abs2(combined[1]); // |⟨0|ψ⟩|²
  const p1 = abs2(combined[2]) + abs2(combined[3]); // |⟨1|ψ⟩|²

  // Approximate first qubit state
  const qubit1: StateVector = normalize([
    complex(Math.sqrt(p0)),
    complex(Math.sqrt(p1)),
  ]);

  // Trace out first qubit to get second qubit
  const q0 = abs2(combined[0]) + abs2(combined[2]);
  const q1 = abs2(combined[1]) + abs2(combined[3]);

  const qubit2: StateVector = normalize([
    complex(Math.sqrt(q0)),
    complex(Math.sqrt(q1)),
  ]);

  return [qubit1, qubit2];
}

// Simplified beam splitter for two qumodes
function applyBeamSplitter(
  state1: StateVector,
  state2: StateVector,
  theta: number,
  phi: number,
  fockDim: number
): [StateVector, StateVector] {
  // BS transformation: a → cos(θ)a + e^{iφ}sin(θ)b
  //                    b → -e^{-iφ}sin(θ)a + cos(θ)b
  // This is complex for general states; we use a simplified approach

  const c = Math.cos(theta);
  const s = Math.sin(theta);

  // For vacuum/low photon states, this approximation works
  // Full implementation would require tensor product space

  // Simplified: just apply a mixing transformation to the amplitudes
  const newState1: StateVector = [];
  const newState2: StateVector = [];

  for (let n = 0; n < fockDim; n++) {
    // Mix the amplitudes
    const a1 = state1[n];
    const a2 = state2[n];

    const expIPhi = complex(Math.cos(phi), Math.sin(phi));
    const expMIPhi = complex(Math.cos(phi), -Math.sin(phi));

    newState1.push(add(scale(a1, c), mul(scale(a2, s), expIPhi)));
    newState2.push(add(mul(scale(a1, -s), expMIPhi), scale(a2, c)));
  }

  return [normalize(newState1), normalize(newState2)];
}

// Apply hybrid gate (qubit-qumode interaction)
function applyHybridGate(
  qubitState: StateVector,
  qumodeState: StateVector,
  gateId: string,
  params: Record<string, number>,
  fockDim: number,
  postSelection?: 0 | 1
): [StateVector, StateVector] {
  switch (gateId) {
    case 'cdisp': {
      // Controlled displacement: |0⟩⟨0|⊗D(α) + |1⟩⟨1|⊗D(-α)
      const alpha: Complex = { re: params.alpha_re ?? 1, im: params.alpha_im ?? 0 };
      const minusAlpha: Complex = { re: -alpha.re, im: -alpha.im };

      // Get displacement matrices
      const Dalpha = displacementMatrix(alpha, fockDim);
      const DminusAlpha = displacementMatrix(minusAlpha, fockDim);

      // Apply conditioned on qubit state
      const displaced0 = matVecMul(Dalpha, qumodeState);  // |α⟩ when qubit is |0⟩
      const displaced1 = matVecMul(DminusAlpha, qumodeState);  // |-α⟩ when qubit is |1⟩

      // With post-selection, we can compute the exact post-selected state
      // For H → CD → H circuit with post-selection:
      //   Post-select |0⟩: even cat = |α⟩ + |-α⟩
      //   Post-select |1⟩: odd cat = |α⟩ - |-α⟩
      const newQumodeState: StateVector = [];

      if (postSelection === 0) {
        // Even cat: |α⟩ + |-α⟩ (positive interference)
        for (let n = 0; n < fockDim; n++) {
          newQumodeState.push(add(displaced0[n], displaced1[n]));
        }
      } else if (postSelection === 1) {
        // Odd cat: |α⟩ - |-α⟩ (negative interference)
        for (let n = 0; n < fockDim; n++) {
          newQumodeState.push(add(displaced0[n], scale(displaced1[n], -1)));
        }
      } else {
        // No post-selection: weighted combination (approximation)
        const p0 = abs2(qubitState[0]);
        const p1 = abs2(qubitState[1]);
        for (let n = 0; n < fockDim; n++) {
          newQumodeState.push(add(
            scale(displaced0[n], Math.sqrt(p0)),
            scale(displaced1[n], Math.sqrt(p1))
          ));
        }
      }

      return [qubitState, normalize(newQumodeState)];
    }

    case 'cr': {
      // Controlled Rotation: |0⟩⟨0|⊗I + |1⟩⟨1|⊗R(θ)
      // Applies phase rotation to qumode only when qubit is in |1⟩
      const theta = params.theta ?? Math.PI / 4;
      const p1 = abs2(qubitState[1]);

      // Apply rotation R(θ) = exp(-iθn) conditioned on qubit state
      const newQumodeState: StateVector = [];
      for (let n = 0; n < fockDim; n++) {
        // Weighted combination: √p0 * |n⟩ + √p1 * e^{-iθn}|n⟩
        const phase = complex(Math.cos(-theta * n * p1), Math.sin(-theta * n * p1));
        newQumodeState.push(mul(qumodeState[n], phase));
      }

      return [qubitState, normalize(newQumodeState)];
    }

    case 'snap': {
      // SNAP: Apply phase to specific Fock state |n⟩
      const targetN = Math.floor(params.n ?? 0);
      const theta = params.theta ?? Math.PI;

      const newQumodeState: StateVector = [...qumodeState];
      if (targetN < fockDim) {
        const phase = complex(Math.cos(theta), Math.sin(theta));
        newQumodeState[targetN] = mul(qumodeState[targetN], phase);
      }

      return [qubitState, normalize(newQumodeState)];
    }

    case 'ecd': {
      // ECD (Echoed Conditional Displacement)
      // Simplified implementation
      const beta: Complex = { re: params.beta_re ?? 1, im: params.beta_im ?? 0 };
      const Dbeta = displacementMatrix(beta, fockDim);

      const newQumodeState = normalize(matVecMul(Dbeta, qumodeState));
      return [qubitState, newQumodeState];
    }

    default:
      return [qubitState, qumodeState];
  }
}
