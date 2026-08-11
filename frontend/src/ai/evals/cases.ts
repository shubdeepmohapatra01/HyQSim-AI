/**
 * The prompt suite.
 *
 * Shared by all three runners:
 *   ai:budget  — measures what each prompt costs, with zero API calls
 *   ai:replay  — asserts the tool calls produce the right circuit, with zero API calls
 *   ai:live    — sends the prompts to a real provider and reports what came back
 *
 * `expect` describes the circuit that should exist afterwards. It is deliberately loose
 * about parameter values (a cat state is still a cat state at α=2 or α=2.5) and strict
 * about structure, because structure is what the model gets wrong.
 */

import type { Intent } from '../intent';

export interface ExpectedCircuit {
  qubits: number;
  qumodes: number;
  /** Gate ids that must be present, with how many of each. */
  gates: Record<string, number>;
  /** Optional ordered check on gate ids, ignoring params. */
  sequence?: string[];
}

export interface EvalCase {
  id: string;
  prompt: string;
  intent: Intent;
  /** Circuit the canvas should already hold when the prompt is sent. HQC notation. */
  setup?: string;
  expect?: ExpectedCircuit;
  /** The model should reach for this verified benchmark rather than improvise. */
  expectBenchmark?: string;
  /** Parameters the benchmark should be loaded with, e.g. {alpha: 2}. */
  expectBenchmarkParams?: Record<string, number>;
  /** Every qumode must start in vacuum — guards the alpha-as-Fock-state confusion. */
  expectVacuumQumodes?: boolean;
  /**
   * A concrete circuit in HQC notation that satisfies `expect`. Used by ai:budget to cost
   * the build, and by ai:replay as the tool input to check the decoder against.
   */
  reference?: string;
  /** For explain/analyze cases: the canvas must be unchanged afterwards. */
  expectNoMutation?: boolean;
  /** Substrings the live response ought to contain, checked case-insensitively. */
  expectMentions?: string[];
  notes?: string;
}

/** A cat state as HyQSim builds it: superposed qubit, conditional displacement onto a mode. */
const CAT_SETUP = 'W q0 m0\nG #1 h q0; #2 cdisp q0>m0 2,0';
const GHZ4_SETUP = 'W q0 q1 q2 q3\nG #1 h q0; #2 cnot q0>q1; #3 cnot q1>q2; #4 cnot q2>q3';

export const EVAL_CASES: EvalCase[] = [
  // ── Build ───────────────────────────────────────────────────────────────────
  {
    id: 'cat-state',
    // HyQSim's verified construction (benchmarks/circuits.ts:catStateCircuit):
    // H → CD(α/√2) → H → S† → H → CD(iπ/(8α√2)) → H → S
    reference: 'W m0 q0\nG h q0; cdisp q0>m0 2,0; h q0; sdg q0; h q0; cdisp q0>m0 0,0.0982; h q0; s q0',
    prompt: 'I want to create a Cat state circuit using a qubit and qumode',
    intent: 'build',
    expectBenchmark: 'cat-state',
    expect: { qubits: 1, qumodes: 1, gates: { h: 4, sdg: 1, s: 1, cdisp: 2 } },
    notes:
      'H → CD alone is an ABORTED preparation: the qubit is still entangled with the mode. ' +
      'The model must call load_benchmark rather than improvise. This case previously ' +
      'asserted the wrong (2-gate) circuit and so passed a broken answer.',
  },
  {
    id: 'cat-state-alpha',
    reference: 'W m0 q0\nG h q0; cdisp q0>m0 1.4142,0; h q0; sdg q0; h q0; cdisp q0>m0 0,0.1388; h q0; s q0',
    prompt: 'Build a cat state circuit with alpha = 2 using a qubit and a qumode',
    intent: 'build',
    expectBenchmark: 'cat-state',
    expectBenchmarkParams: { alpha: 2 },
    expect: { qubits: 1, qumodes: 1, gates: { h: 4, sdg: 1, s: 1, cdisp: 2 } },
    expectVacuumQumodes: true,
    notes:
      'Regression: the model read "alpha = 2" as an initial Fock state and wrote m0=2. ' +
      'alpha is a coherent amplitude passed to load_benchmark, never an initial state.',
  },
  {
    id: 'ghz-4',
    reference: 'W q0 q1 q2 q3\nG h q0; cnot q0>q1; cnot q1>q2; cnot q2>q3',
    prompt: 'I want to make a 4-qubit GHZ circuit',
    intent: 'build',
    expect: { qubits: 4, qumodes: 0, gates: { h: 1, cnot: 3 }, sequence: ['h', 'cnot', 'cnot', 'cnot'] },
    notes: 'The round-trip benchmark: 9 tool calls under the old design, 1 under build_circuit.',
  },
  {
    id: 'cv-fourier',
    reference: 'W m0\nG rotate m0 pi/2',
    prompt: 'I want to create the Fourier Transform circuit for CV circuits',
    intent: 'build',
    expect: { qubits: 0, qumodes: 1, gates: { rotate: 1 } },
    notes: 'CV Fourier transform is a phase-space rotation by pi/2.',
  },
  {
    id: 'bell',
    reference: 'W q0 q1\nG h q0; cnot q0>q1',
    prompt: 'Build a Bell state circuit',
    intent: 'build',
    expect: { qubits: 2, qumodes: 0, gates: { h: 1, cnot: 1 }, sequence: ['h', 'cnot'] },
  },
  {
    id: 'squeezed-vacuum',
    reference: 'W m0\nG squeeze m0 0.8,0',
    prompt: 'Create a squeezed vacuum state',
    intent: 'build',
    expect: { qubits: 0, qumodes: 1, gates: { squeeze: 1 } },
  },
  {
    id: 'two-mode-squeezing',
    reference: 'W m0 m1\nG squeeze m0 0.8,0; squeeze m1 0.8,pi; bs m0>m1 pi/4,0',
    prompt: 'Build a two-mode squeezed state using a beam splitter',
    intent: 'build',
    expect: { qubits: 0, qumodes: 2, gates: { squeeze: 2, bs: 1 } },
  },
  {
    id: 'coherent-displacement',
    reference: 'W m0\nG displace m0 1.5,0',
    prompt: 'Make a coherent state with alpha = 1.5 on a single qumode',
    intent: 'build',
    expect: { qubits: 0, qumodes: 1, gates: { displace: 1 } },
  },
  {
    id: 'ghz-3',
    reference: 'W q0 q1 q2\nG h q0; cnot q0>q1; cnot q1>q2; measure q0; measure q1; measure q2',
    prompt: 'Create a 3-qubit GHZ state and add a measurement on every qubit',
    intent: 'build',
    expect: { qubits: 3, qumodes: 0, gates: { h: 1, cnot: 2, measure: 3 } },
  },
  {
    id: 'jc-hybrid',
    reference: 'W q0 m0\nG jc q0>m0 pi/4',
    prompt: 'Build a Jaynes-Cummings interaction between a qubit and a qumode',
    intent: 'build',
    expect: { qubits: 1, qumodes: 1, gates: { jc: 1 } },
    notes: 'jc is browser-backend only; the assistant should say so if Python is selected.',
  },
  {
    id: 'plus-state-init',
    reference: 'W q0=+ m0=2\nG (none)',
    prompt: 'Create a circuit with one qubit initialised in the |+> state and a qumode in Fock state 2',
    intent: 'build',
    expect: { qubits: 1, qumodes: 1, gates: {} },
    notes: 'Exercises the initial-state syntax "q0=+ m0=2".',
  },

  // ── Incremental edits ───────────────────────────────────────────────────────
  {
    id: 'edit-add-gate',
    reference: 'W q0 q1 q2 q3\nG h q0; cnot q0>q1; cnot q1>q2; cnot q2>q3; h q2',
    prompt: 'Add a Hadamard gate on q2',
    intent: 'build',
    setup: GHZ4_SETUP,
    expect: { qubits: 4, qumodes: 0, gates: { h: 2, cnot: 3 } },
    notes: 'Must use add_gate, not rebuild the whole circuit.',
  },
  {
    id: 'edit-remove-gate',
    reference: 'W q0 q1 q2 q3\nG h q0; cnot q0>q1; cnot q1>q2',
    prompt: 'Remove the last gate',
    intent: 'build',
    setup: GHZ4_SETUP,
    expect: { qubits: 4, qumodes: 0, gates: { h: 1, cnot: 2 } },
  },
  {
    id: 'edit-add-wire',
    reference: 'W q0 m0 m1\nG h q0; cdisp q0>m0 2,0',
    prompt: 'Add another qumode to the circuit',
    intent: 'build',
    setup: CAT_SETUP,
    expect: { qubits: 1, qumodes: 2, gates: { h: 1, cdisp: 1 } },
  },

  // ── Explain ─────────────────────────────────────────────────────────────────
  {
    id: 'explain-canvas',
    prompt: 'Explain the circuit on the canvas',
    intent: 'explain',
    setup: CAT_SETUP,
    expectNoMutation: true,
    expectMentions: ['cat'],
    notes: 'The regression that used to wipe the canvas mid-explanation.',
  },
  {
    id: 'explain-ghz',
    prompt: 'What does this circuit do?',
    intent: 'explain',
    setup: GHZ4_SETUP,
    expectNoMutation: true,
    expectMentions: ['ghz'],
  },
  {
    id: 'explain-gate',
    prompt: 'Why is a conditional displacement used here instead of a plain displacement?',
    intent: 'explain',
    setup: CAT_SETUP,
    expectNoMutation: true,
    expectMentions: ['entangl'],
  },

  // ── Analyze (these auto-run HyQSim's simulator) ──────────────────────────────
  {
    id: 'analyze-output',
    prompt: 'What kind of output will this circuit give?',
    intent: 'analyze',
    setup: CAT_SETUP,
    expectNoMutation: true,
    expectMentions: ['fock'],
    notes: 'Must cite numbers from the simulator, never invent them.',
  },
  {
    id: 'analyze-full',
    prompt: 'Analyze the circuit results and the circuit structure',
    intent: 'analyze',
    setup: CAT_SETUP,
    expectNoMutation: true,
  },
  {
    id: 'analyze-wigner',
    prompt: 'Is the Wigner function of this state non-classical?',
    intent: 'analyze',
    setup: CAT_SETUP,
    expectNoMutation: true,
    expectMentions: ['negativ'],
  },
  {
    id: 'analyze-measurement',
    prompt: 'What measurement distribution would I see from this circuit?',
    intent: 'analyze',
    setup: GHZ4_SETUP,
    expectNoMutation: true,
  },
];

export const BUILD_CASES = EVAL_CASES.filter(c => c.intent === 'build');
export const READONLY_CASES = EVAL_CASES.filter(c => c.intent !== 'build');
