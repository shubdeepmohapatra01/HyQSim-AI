/**
 * Serialization of circuit and simulation state for the model.
 *
 * Circuit encoding lives in `hqc.ts`; this module handles simulation results and
 * re-exports the wire helpers so existing importers keep working.
 *
 * Everything here is written for token economy. The previous prose format spent ~180
 * tokens describing a Bell state and repeated a full snapshot on every turn of the
 * conversation, which is what made free-tier providers rate-limit on trivial requests.
 */

import type { Wire, CircuitElement, SimulationResult } from '../types/circuit';
import { encodeCircuit, wireLabel, wireLabelToIndex } from './hqc';
import { wignerFromState, computeWignerFeatures, formatWignerFeatures } from '../simulation/wignerFeatures';

export { wireLabel, wireLabelToIndex };

/** Coarser than the 80×80 display grid — we only need derived scalars, not a picture. */
const FEATURE_GRID = 48;

/** Fock levels below this probability are omitted. */
const FOCK_FLOOR = 0.001;

/** Serializes the current circuit in HQC notation. */
export function circuitToPrompt(wires: Wire[], elements: CircuitElement[]): string {
  return encodeCircuit(wires, elements);
}

function fmtComplex(c: { re: number; im: number }): string {
  const re = Number(c.re.toFixed(4));
  if (Math.abs(c.im) < 1e-4) return String(re);
  const im = Number(c.im.toFixed(4));
  return `${re}${im >= 0 ? '+' : ''}${im}i`;
}

const n2 = (v: number) => (Math.abs(v) < 5e-3 ? '0' : v.toFixed(2));

/**
 * Serializes simulation results.
 *
 * `includeWigner` is on by default but costs a Wigner evaluation per qumode; callers that
 * only need populations can turn it off.
 */
export function simulationResultToPrompt(
  result: SimulationResult,
  wires: Wire[],
  fockTruncation: number,
  includeWigner = true,
): string {
  if (wires.length === 0) return 'no wires — nothing simulated.';

  const lines: string[] = [`fock=${fockTruncation} backend=${result.backend}`];

  for (let i = 0; i < wires.length; i++) {
    const wire = wires[i];
    const label = wireLabel(wires, i);

    if (wire.type === 'qubit') {
      const s = result.qubitStates.get(i);
      if (!s) { lines.push(`${label} no result`); continue; }
      const [a, b] = s.amplitude;
      const bv = s.blochVector;
      lines.push(`${label} psi=${fmtComplex(a)}|0>+${fmtComplex(b)}|1> B=(${n2(bv.x)},${n2(bv.y)},${n2(bv.z)})`);
      continue;
    }

    const s = result.qumodeStates.get(i);
    if (!s) { lines.push(`${label} no result`); continue; }

    const fock = s.fockProbabilities
      .map((p, n) => ({ n, p }))
      .filter(({ p }) => p > FOCK_FLOOR)
      .map(({ n, p }) => `|${n}>:${(p * 100).toFixed(1)}%`)
      .join(' ');
    lines.push(`${label} <n>=${s.meanPhotonNumber.toFixed(3)} ${fock || '(vacuum)'}`);

    if (includeWigner) {
      const w = wignerFromState(s, FEATURE_GRID);
      if (w) {
        lines.push(`${label} W: ${formatWignerFeatures(computeWignerFeatures(w.grid, w.range))}`);
      }
    }
  }

  if (result.bitstringCounts && Object.keys(result.bitstringCounts).length > 0) {
    const total = Object.values(result.bitstringCounts).reduce((a, b) => a + b, 0);
    const top = Object.entries(result.bitstringCounts)
      .sort(([, a], [, b]) => b - a)
      .slice(0, 8)
      .map(([k, v]) => `${k}=${((v / total) * 100).toFixed(1)}%`)
      .join(' ');
    lines.push(`counts(${total} shots): ${top}`);
  }

  return lines.join('\n');
}
