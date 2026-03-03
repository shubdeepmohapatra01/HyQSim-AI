// Main quantum circuit simulator
// Uses full tensor product state for proper entanglement handling

import type { Wire, CircuitElement, Gate, SimulationResult, QubitState, QumodeState, QubitPostSelection } from '../types/circuit';
import { getDefaultParameters } from '../types/circuit';
import {
  initTensorState,
  applyQubitGate,
  applyQumodeGate as applyTensorQumodeGate,
  applyHybridGate as applyTensorHybridGate,
  applyBeamSplitter,
  applyCNOTGate,
  applyCustomGate,
  applyPostSelection,
  partialTraceToSubsystem,
  densityMatrixToQubitState,
  densityMatrixToQumodeState,
  sampleQubitBitstrings,
} from './tensor';

/**
 * Given a set of measured wire indices, return their positions in the qubit
 * bitstring (which is ordered by qubit appearance in the wires array).
 * Returns positions sorted ascending so the resulting bitstring is consistent.
 */
export function getQubitBitstringPositions(wires: Wire[], measuredWireIndices: number[]): number[] {
  const qubitWireIndices = wires
    .map((w, i) => ({ wire: w, idx: i }))
    .filter(({ wire }) => wire.type === 'qubit')
    .map(({ idx }) => idx);

  return measuredWireIndices
    .filter(wi => wires[wi]?.type === 'qubit')
    .map(wi => qubitWireIndices.indexOf(wi))
    .filter(pos => pos >= 0)
    .sort((a, b) => a - b);
}

/**
 * Marginalize a bitstring count histogram to a subset of bit positions.
 * E.g. with positions=[0,2], "010"→"00", "011"→"01", etc.
 */
export function marginalizeCountsToPositions(
  counts: Record<string, number>,
  positions: number[],
): Record<string, number> {
  const result: Record<string, number> = {};
  for (const [bitstring, count] of Object.entries(counts)) {
    const margBitstring = positions.map(pos => bitstring[pos]).join('');
    result[margBitstring] = (result[margBitstring] ?? 0) + count;
  }
  return result;
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
  postSelections: QubitPostSelection[] = [],
  shots: number = 1024,
  measuredWireIndices: number[] = [],
): SimulationResult {
  const startTime = performance.now();

  // Separate wire indices by type (used for result extraction)
  const qubitWireIndices: number[] = [];
  const qumodeWireIndices: number[] = [];

  for (let i = 0; i < wires.length; i++) {
    if (wires[i].type === 'qubit') {
      qubitWireIndices.push(i);
    } else {
      qumodeWireIndices.push(i);
    }
  }

  // Initialize tensor product state with custom initial states from wires
  let state = initTensorState(wires, fockDim);

  // Sort elements by position (execution order)
  const sortedElements = sortElementsByPosition(elements);

  // Apply each gate
  for (const element of sortedElements) {
    const gate = gates.get(element.gateId);
    if (!gate) continue;

    const params = element.parameterValues ?? getDefaultParameters(gate);
    const wireIndex = element.wireIndex;
    const wire = wires[wireIndex];

    // Measure gates are markers only — no state transformation
    if (gate.id === 'measure') continue;

    if (gate.category === 'qubit' && wire?.type === 'qubit') {
      // Single qubit gate
      if (!gate.numQubits || gate.numQubits === 1) {
        state = applyQubitGate(state, wireIndex, gate.id, params);
      }
      // Two-qubit gate (CNOT)
      else if (gate.numQubits === 2 && element.targetWireIndices?.length) {
        const targetIndex = element.targetWireIndices[0];
        state = applyCNOTGate(state, wireIndex, targetIndex);
      }
    } else if (gate.category === 'qumode' && wire?.type === 'qumode') {
      // Single qumode gate
      if (!gate.numQumodes || gate.numQumodes === 1) {
        state = applyTensorQumodeGate(state, wireIndex, gate.id, params, fockDim);
      }
      // Two-qumode gate (beam splitter)
      else if (gate.numQumodes === 2 && element.targetWireIndices?.length) {
        const targetIndex = element.targetWireIndices[0];
        state = applyBeamSplitter(
          state,
          wireIndex,
          targetIndex,
          params.theta ?? Math.PI / 4,
          params.phi ?? 0,
          fockDim
        );
      }
    } else if (gate.category === 'hybrid') {
      // Hybrid gate
      const qubitWireIndex = wireIndex;
      const qumodeWireIndex = element.targetWireIndices?.[0];

      if (qumodeWireIndex !== undefined) {
        state = applyTensorHybridGate(
          state,
          qubitWireIndex,
          qumodeWireIndex,
          gate.id,
          params,
          fockDim
        );
      }
    } else if (gate.category === 'custom' && element.generatorExpression) {
      // Custom generator gate
      const theta = params.theta ?? Math.PI / 4;
      const targetWireIndex = element.targetWireIndices?.[0];

      state = applyCustomGate(
        state,
        wireIndex,
        targetWireIndex,
        element.generatorExpression,
        theta,
        fockDim
      );
    }
  }

  // Apply post-selections
  for (const ps of postSelections) {
    if (wires[ps.wireIndex]?.type === 'qubit') {
      state = applyPostSelection(state, ps.wireIndex, ps.outcome as 0 | 1);
    }
  }

  // Convert to result format by computing reduced density matrices
  const qubitResults = new Map<number, QubitState>();
  const qumodeResults = new Map<number, QumodeState>();

  for (const wireIndex of qubitWireIndices) {
    const rho = partialTraceToSubsystem(state, wireIndex);
    const { amplitude, blochVector } = densityMatrixToQubitState(rho);

    qubitResults.set(wireIndex, {
      amplitude,
      blochVector,
      expectations: {
        sigmaX: blochVector.x,
        sigmaY: blochVector.y,
        sigmaZ: blochVector.z,
      },
    });
  }

  for (const wireIndex of qumodeWireIndices) {
    const rho = partialTraceToSubsystem(state, wireIndex);
    const { fockAmplitudes, fockProbabilities, meanPhotonNumber, densityMatrix } = densityMatrixToQumodeState(rho);

    // Convert density matrix to serializable format
    const dmSerializable = densityMatrix.map(row =>
      row.map(c => ({ re: c.re, im: c.im }))
    );

    qumodeResults.set(wireIndex, {
      fockAmplitudes,
      fockProbabilities,
      meanPhotonNumber,
      densityMatrix: dmSerializable,
    });
  }

  // Sample qubit bitstrings — only for explicitly measured qubits
  let bitstringCounts: Record<string, number> | undefined;
  if (measuredWireIndices.length > 0 && qubitWireIndices.length > 0) {
    const allCounts = sampleQubitBitstrings(state, shots);
    const positions = getQubitBitstringPositions(wires, measuredWireIndices);
    if (positions.length > 0) {
      bitstringCounts = marginalizeCountsToPositions(allCounts, positions);
    }
  }

  const executionTime = performance.now() - startTime;

  return {
    qubitStates: qubitResults,
    qumodeStates: qumodeResults,
    backend: 'browser',
    executionTime,
    bitstringCounts,
  };
}
