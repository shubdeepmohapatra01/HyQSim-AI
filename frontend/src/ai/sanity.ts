/**
 * Structural sanity checks on a circuit the AI just built.
 *
 * These are not physics validation — the simulator does that. They catch the specific,
 * recurring ways a language model produces something that *looks* like a known circuit but
 * is missing a step, and they fire as a note appended to the tool result so the model can
 * correct itself on the same turn rather than confidently explaining a broken circuit.
 *
 * Each check earns its place by having actually been observed. Do not add speculative ones:
 * a false warning teaches the model to distrust real ones.
 */

import type { Wire, CircuitElement } from '../types/circuit';
import { orderedElements, wireLabel } from './hqc';

export interface SanityWarning {
  /** Shown to the model, phrased as a correction it can act on. */
  message: string;
}

const CD_GATES = new Set(['cdisp', 'xcdisp', 'ycdisp']);

/** Phrases that make a non-vacuum qumode a deliberate request rather than a misreading. */
const FOCK_REQUEST_RE = /\bfock\b|\bnumber state\b|\bphoton number state\b|\|\s*\d+\s*(⟩|>)|\bn\s*=\s*\d/i;

/**
 * @param userPrompt The request that produced this circuit, when available. Without it the
 *   Fock-state check has to be conservative, because "m0=2" is correct for "a qumode in
 *   Fock state 2" and wrong for "alpha=2" — and the circuit alone cannot distinguish them.
 */
export function checkCircuit(
  wires: Wire[],
  elements: CircuitElement[],
  userPrompt?: string,
): SanityWarning[] {
  const warnings: SanityWarning[] = [];
  const ordered = orderedElements(elements);
  const qubits = wires.filter(w => w.type === 'qubit');
  const qumodes = wires.filter(w => w.type === 'qumode');

  const cdCount = ordered.filter(e => CD_GATES.has(e.gateId)).length;
  const hCount = ordered.filter(e => e.gateId === 'h').length;

  // Wires but no gates. Observed with Gemini calling build_circuit with gates:"" — the
  // canvas looked plausible while the circuit did nothing at all. A bare wire set is only
  // legitimate when the point was to set initial states.
  const hasCustomInitialState = wires.some(
    w => w.initialState !== undefined && w.initialState !== '0' && w.initialState !== 0,
  );
  if (wires.length > 0 && ordered.length === 0 && !hasCustomInitialState) {
    warnings.push({
      message:
        'The circuit has wires but NO gates, so it prepares nothing — every wire is left in ' +
        'its initial state. You almost certainly meant to pass a non-empty "gates" string to ' +
        'build_circuit (e.g. "h q0; cnot q0>q1" for a 2-qubit GHZ). Rebuild it with the gates.',
    });
    return warnings; // Later checks assume gates exist; this is the whole problem.
  }

  // Aborted cat-state preparation. H → CD leaves the qubit entangled with the mode; the
  // interferometer has to be closed. HyQSim's verified construction is
  // H → CD → H → S† → H → CD → H → S (benchmarks/circuits.ts:catStateCircuit).
  if (qubits.length === 1 && qumodes.length === 1 && cdCount >= 1 && ordered.length < 8) {
    const lastGate = ordered[ordered.length - 1];
    const endsOpen = lastGate && CD_GATES.has(lastGate.gateId);
    if (endsOpen || hCount < 2) {
      warnings.push({
        message:
          'This looks like an incomplete cat-state preparation: after a conditional ' +
          'displacement the qubit is still entangled with the mode, so this is not yet a ' +
          'cat state. HyQSim has a verified 8-gate construction — call ' +
          'load_benchmark with benchmarkId "cat-state" (parameter: alpha) instead of ' +
          'building it by hand.',
      });
    }
  }

  // A qumode initialised to a non-zero Fock state is usually the model misreading a
  // coherent amplitude ("alpha=2") as an initial state — but it is exactly right when the
  // user asked for a Fock state. Suppress the warning when the prompt says so, because a
  // false warning teaches the model to distrust the real ones.
  const fockWasRequested = userPrompt !== undefined && FOCK_REQUEST_RE.test(userPrompt);
  for (let i = 0; !fockWasRequested && i < wires.length; i++) {
    const w = wires[i];
    if (w.type === 'qumode' && typeof w.initialState === 'number' && w.initialState > 0) {
      warnings.push({
        message:
          `Qumode ${wireLabel(wires, i)} starts in Fock state |${w.initialState}⟩, not vacuum. ` +
          'If the user asked for a coherent amplitude or displacement of that size, that is a ' +
          'gate parameter (e.g. "displace m0 2,0"), not an initial state — rebuild with the ' +
          'mode in vacuum. Only keep this if they explicitly asked for a Fock/number state.',
      });
    }
  }

  // Entangling gates that touch only one wire of a multi-wire register.
  if (qubits.length > 2) {
    const touched = new Set<number>();
    for (const e of ordered) {
      touched.add(e.wireIndex);
      for (const t of e.targetWireIndices ?? []) touched.add(t);
    }
    const idle = wires
      .map((_, i) => i)
      .filter(i => wires[i].type === 'qubit' && !touched.has(i));
    if (idle.length > 0 && ordered.length > 0) {
      warnings.push({
        message:
          `Qubit(s) ${idle.map(i => wireLabel(wires, i)).join(', ')} have no gates and stay in |0⟩. ` +
          'If the circuit was meant to entangle every qubit, it is incomplete.',
      });
    }
  }

  return warnings;
}

/** Appends warnings to a tool result, or returns it unchanged. */
export function withSanityNotes(result: string, warnings: SanityWarning[]): string {
  if (warnings.length === 0) return result;
  return `${result}\n\nCHECK: ${warnings.map(w => w.message).join(' ')}`;
}
