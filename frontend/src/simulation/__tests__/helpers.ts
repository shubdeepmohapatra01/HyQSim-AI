// Shared helpers for the gate test suite.
import { expect } from 'vitest';
import type { Complex, Matrix, StateVector } from '../complex';
import { ZERO, add, mul, conj, abs2 } from '../complex';
import type { CircuitElement, Gate, QubitInitialState, QumodeInitialState, Wire } from '../../types/circuit';
import { ALL_GATES } from '../../types/circuit';
import { runSimulation } from '../simulator';

export const GATES_MAP: Map<string, Gate> = new Map(ALL_GATES.map(g => [g.id, g]));

export const TOL = 1e-9;

// ---------------------------------------------------------------------------
// Matrix utilities
// ---------------------------------------------------------------------------

export function matMul(A: Matrix, B: Matrix): Matrix {
  const n = A.length, m = B[0].length, k = B.length;
  const out: Matrix = [];
  for (let i = 0; i < n; i++) {
    out[i] = [];
    for (let j = 0; j < m; j++) {
      let s: Complex = ZERO;
      for (let p = 0; p < k; p++) s = add(s, mul(A[i][p], B[p][j]));
      out[i][j] = s;
    }
  }
  return out;
}

export function dagger(A: Matrix): Matrix {
  return A[0].map((_, j) => A.map(row => conj(row[j])));
}

export function kron(A: Matrix, B: Matrix): Matrix {
  const out: Matrix = [];
  for (let i = 0; i < A.length; i++) {
    for (let p = 0; p < B.length; p++) {
      const row: Complex[] = [];
      for (let j = 0; j < A[0].length; j++) {
        for (let q = 0; q < B[0].length; q++) row.push(mul(A[i][j], B[p][q]));
      }
      out.push(row);
    }
  }
  return out;
}

export function maxAbsDiff(A: Matrix, B: Matrix): number {
  let worst = 0;
  for (let i = 0; i < A.length; i++) {
    for (let j = 0; j < A[0].length; j++) {
      worst = Math.max(worst, Math.hypot(A[i][j].re - B[i][j].re, A[i][j].im - B[i][j].im));
    }
  }
  return worst;
}

export function expectMatricesClose(A: Matrix, B: Matrix, tol = 1e-8) {
  expect(A.length).toBe(B.length);
  expect(maxAbsDiff(A, B)).toBeLessThan(tol);
}

/**
 * Check U†U = I. Truncated bosonic operators (displacement, squeezing, JC)
 * are only approximately unitary near the top of the Fock ladder, so callers
 * can restrict the check to the first `subDim` basis states.
 */
export function unitarityError(U: Matrix, subDim = U.length): number {
  const P = matMul(dagger(U), U);
  let worst = 0;
  for (let i = 0; i < subDim; i++) {
    for (let j = 0; j < subDim; j++) {
      const target = i === j ? 1 : 0;
      worst = Math.max(worst, Math.hypot(P[i][j].re - target, P[i][j].im));
    }
  }
  return worst;
}

export function expectUnitary(U: Matrix, subDim = U.length, tol = 1e-8) {
  expect(unitarityError(U, subDim)).toBeLessThan(tol);
}

export function norm2(v: StateVector): number {
  return v.reduce((s, c) => s + abs2(c), 0);
}

// ---------------------------------------------------------------------------
// Circuit-building helpers
// ---------------------------------------------------------------------------

export function qubitWire(index: number, initialState: QubitInitialState = '0'): Wire {
  return { id: `q${index}`, type: 'qubit', index, initialState };
}

export function qumodeWire(index: number, initialState: QumodeInitialState = 0): Wire {
  return { id: `m${index}`, type: 'qumode', index, initialState };
}

let elementCounter = 0;

export function gateEl(
  gateId: string,
  wireIndex: number,
  opts: {
    x?: number;
    targets?: number[];
    params?: Record<string, number>;
    generatorExpression?: string;
  } = {},
): CircuitElement {
  return {
    id: `el-${elementCounter++}`,
    gateId,
    wireIndex,
    position: { x: opts.x ?? elementCounter * 100, y: 0 },
    targetWireIndices: opts.targets,
    parameterValues: opts.params,
    generatorExpression: opts.generatorExpression,
  };
}

export function simulate(
  wires: Wire[],
  elements: CircuitElement[],
  fockDim = 16,
  opts: { shots?: number; measuredWireIndices?: number[] } = {},
) {
  return runSimulation(
    wires,
    elements,
    GATES_MAP,
    fockDim,
    [],
    opts.shots ?? 2048,
    opts.measuredWireIndices ?? [],
  );
}

/** Total probability in the returned Fock distribution (should always be ~1). */
export function fockNorm(probs: number[]): number {
  return probs.reduce((a, b) => a + b, 0);
}
