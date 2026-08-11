/**
 * Benchmark sweep utilities — run a benchmark circuit for k = 0..nSteps
 * and record expectation values at each step, for time-series visualisation.
 *
 * NOTE: This module is currently disabled because jcTrotterCircuit and the
 * Rabi-plot feature are commented out. Kept for future re-enablement.
 */

export interface JCSweepPoint {
  step: number;
  t: number;       // = step * g * tau
  nSim: number;    // ⟨n̂⟩ from simulator
  nExact: number;  // sin²(t)  — exact for coupling-only JC, independent of ω
  szSim: number;   // ⟨σ_z⟩ from simulator (QC convention: |1⟩ → ⟨Z⟩ = −1)
  szExact: number; // −cos(2t) — same convention
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function runJCSweep(
  _nSteps: number,
  _g: number,
  _omega: number,
  _tau: number,
  _fockDim: number,
): JCSweepPoint[] {
  // Disabled: jcTrotterCircuit is currently commented out in circuits.ts.
  // Restore the implementation here when the Rabi-plot feature is re-enabled.
  return [];
}
