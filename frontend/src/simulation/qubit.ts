// Qubit simulation using state vectors

import type { StateVector, Matrix } from './complex';
import {
  complex, ONE, ZERO, I,
  mul, conj, abs2, exp, fromPolar,
  matVecMul, normalize,
} from './complex';
import type { QubitState } from '../types/circuit';

// Standard qubit gates as 2x2 matrices
const SQRT2_INV = 1 / Math.sqrt(2);

export const GATES: Record<string, Matrix> = {
  // Identity
  I: [
    [ONE, ZERO],
    [ZERO, ONE],
  ],
  // Pauli gates
  X: [
    [ZERO, ONE],
    [ONE, ZERO],
  ],
  Y: [
    [ZERO, { re: 0, im: -1 }],
    [I, ZERO],
  ],
  Z: [
    [ONE, ZERO],
    [ZERO, { re: -1, im: 0 }],
  ],
  // Hadamard
  H: [
    [complex(SQRT2_INV), complex(SQRT2_INV)],
    [complex(SQRT2_INV), complex(-SQRT2_INV)],
  ],
  // Phase gates
  S: [
    [ONE, ZERO],
    [ZERO, I],
  ],
  Sdg: [
    [ONE, ZERO],
    [ZERO, { re: 0, im: -1 }],  // S† = -i on |1⟩
  ],
  T: [
    [ONE, ZERO],
    [ZERO, fromPolar(1, Math.PI / 4)],
  ],
};

// Rotation gates (parameterized)
export function Rx(theta: number): Matrix {
  const c = Math.cos(theta / 2);
  const s = Math.sin(theta / 2);
  return [
    [complex(c), complex(0, -s)],
    [complex(0, -s), complex(c)],
  ];
}

export function Ry(theta: number): Matrix {
  const c = Math.cos(theta / 2);
  const s = Math.sin(theta / 2);
  return [
    [complex(c), complex(-s)],
    [complex(s), complex(c)],
  ];
}

export function Rz(theta: number): Matrix {
  return [
    [exp(complex(0, -theta / 2)), ZERO],
    [ZERO, exp(complex(0, theta / 2))],
  ];
}

// Initialize qubit in |0⟩ state
export function initQubit(): StateVector {
  return [ONE, ZERO];
}

// Apply a gate to a qubit state
export function applyGate(state: StateVector, gate: Matrix): StateVector {
  return normalize(matVecMul(gate, state));
}

// Apply a gate by name
export function applyGateByName(
  state: StateVector,
  gateName: string,
  params?: Record<string, number>
): StateVector {
  let gate: Matrix;

  switch (gateName) {
    case 'h':
      gate = GATES.H;
      break;
    case 'x':
      gate = GATES.X;
      break;
    case 'y':
      gate = GATES.Y;
      break;
    case 'z':
      gate = GATES.Z;
      break;
    case 's':
      gate = GATES.S;
      break;
    case 'sdg':
      gate = GATES.Sdg;
      break;
    case 't':
      gate = GATES.T;
      break;
    case 'rx':
      gate = Rx(params?.theta ?? Math.PI / 2);
      break;
    case 'ry':
      gate = Ry(params?.theta ?? Math.PI / 2);
      break;
    case 'rz':
      gate = Rz(params?.theta ?? Math.PI / 2);
      break;
    default:
      return state; // Unknown gate, return unchanged
  }

  return applyGate(state, gate);
}

// Calculate Bloch sphere coordinates from state vector
export function getBlochVector(state: StateVector): { x: number; y: number; z: number } {
  const [alpha, beta] = state;

  // |ψ⟩ = α|0⟩ + β|1⟩
  // Bloch sphere: x = 2*Re(α β̄), y = -2*Im(α β̄) = ⟨σy⟩, z = |α|² - |β|²
  const alphaBetaConj = mul(alpha, conj(beta));

  return {
    x: 2 * alphaBetaConj.re,
    y: -2 * alphaBetaConj.im,
    z: abs2(alpha) - abs2(beta),
  };
}

// Calculate expectation values ⟨σx⟩, ⟨σy⟩, ⟨σz⟩
export function getExpectations(state: StateVector): { sigmaX: number; sigmaY: number; sigmaZ: number } {
  // For a pure state, expectation values equal Bloch vector components
  const bloch = getBlochVector(state);
  return {
    sigmaX: bloch.x,
    sigmaY: bloch.y,
    sigmaZ: bloch.z,
  };
}

// Convert state vector to full QubitState
export function stateVectorToQubitState(state: StateVector): QubitState {
  const blochVector = getBlochVector(state);
  const expectations = getExpectations(state);

  return {
    amplitude: [state[0], state[1]],
    blochVector,
    expectations,
  };
}

// Two-qubit CNOT gate (control on first qubit)
// Acts on 4D state vector [|00⟩, |01⟩, |10⟩, |11⟩]
export const CNOT: Matrix = [
  [ONE, ZERO, ZERO, ZERO],
  [ZERO, ONE, ZERO, ZERO],
  [ZERO, ZERO, ZERO, ONE],
  [ZERO, ZERO, ONE, ZERO],
];

// Apply CNOT to two-qubit state
export function applyCNOT(state: StateVector): StateVector {
  return normalize(matVecMul(CNOT, state));
}
