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
  /**
   * Upper bounds, for optimize cases. An optimization is judged by whether it got cheap
   * enough, not by whether it produced one particular circuit — several rewrites of a GHZ
   * chain are equally valid.
   */
  maxGates?: number;
  maxDepth?: number;
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

  // ── Optimize (allowed to mutate; judged on cost, not on one exact circuit) ───
  {
    id: 'optimize-cancel-inverses',
    prompt: 'Optimize this circuit',
    intent: 'optimize',
    setup: 'W q0 q1\nG #1 h q0; #2 h q0; #3 cnot q0>q1; #4 x q1; #5 x q1',
    reference: 'W q0 q1\nG cnot q0>q1',
    expect: { qubits: 2, qumodes: 0, gates: { cnot: 1 }, maxGates: 1, maxDepth: 1 },
    notes: 'Adjacent self-inverse pairs on either side of the CNOT. Five gates down to one.',
  },
  {
    id: 'optimize-merge-rotations',
    prompt: 'Can you simplify this circuit?',
    intent: 'optimize',
    setup: 'W q0\nG #1 h q0; #2 rz q0 pi/4; #3 rz q0 pi/4',
    reference: 'W q0\nG h q0; rz q0 pi/2',
    expect: { qubits: 1, qumodes: 0, gates: { h: 1, rz: 1 }, maxGates: 2, maxDepth: 2 },
    notes: 'Same-axis rotations on one wire add. The merged angle must be pi/2, not pi/4.',
  },
  {
    id: 'optimize-ghz-5',
    prompt: 'Can you optimize the circuit and reduce its depth?',
    intent: 'optimize',
    setup: 'W q0 q1 q2 q3 q4\nG #1 h q0; #2 cnot q0>q1; #3 cnot q1>q2; #4 cnot q2>q3; #5 cnot q3>q4',
    // Doubling tree: each step, every wire already holding the state copies to a fresh one.
    reference: 'W q0 q1 q2 q3 q4\nG h q0; cnot q0>q1; cnot q0>q2; cnot q1>q3; cnot q0>q4',
    expect: { qubits: 5, qumodes: 0, gates: { h: 1, cnot: 4 }, maxGates: 5, maxDepth: 4 },
    notes:
      'The case that prompted this feature. The gate count is fixed at n — every qubit has ' +
      'to be entangled — but the depth is not: a CNOT chain is depth n because each CNOT ' +
      'waits on the wire the last one wrote, while a doubling tree is 1+ceil(log2 n). ' +
      'Fanning every CNOT out from q0 does NOT count: they share the control, so they ' +
      'serialize exactly like the chain.',
  },
  {
    id: 'optimize-ghz-8',
    prompt: 'Make this circuit shallower',
    intent: 'optimize',
    setup:
      'W q0 q1 q2 q3 q4 q5 q6 q7\nG #1 h q0; #2 cnot q0>q1; #3 cnot q1>q2; #4 cnot q2>q3; ' +
      '#5 cnot q3>q4; #6 cnot q4>q5; #7 cnot q5>q6; #8 cnot q6>q7',
    reference:
      'W q0 q1 q2 q3 q4 q5 q6 q7\nG h q0; cnot q0>q1; cnot q0>q2; cnot q1>q3; ' +
      'cnot q0>q4; cnot q1>q5; cnot q2>q6; cnot q3>q7',
    expect: { qubits: 8, qumodes: 0, gates: { h: 1, cnot: 7 }, maxGates: 8, maxDepth: 4 },
    notes: 'Where the tree pays: depth 8 down to 4, with the same eight gates.',
  },
  {
    id: 'optimize-cancels-entirely',
    prompt: 'Can you optimize this circuit',
    intent: 'optimize',
    setup: 'W q0 q1\nG #1 h q0; #2 x q1; #3 h q0; #4 x q1',
    reference: 'W q0 q1\nG (none)',
    expect: { qubits: 2, qumodes: 0, gates: {}, maxGates: 0, maxDepth: 0 },
    notes:
      'From a real session on llama-3.3-70b, which answered "the two H gates cancel and the ' +
      'two X gates combine into a single X". Two traps: the pairs are NOT adjacent in the ' +
      'execution-order list (#1/#3 and #2/#4) because independent gates share a step, and a ' +
      'gate with no parameters cannot "merge" — x,x is the identity, leaving nothing. The ' +
      'right answer empties the circuit, which models are reluctant to produce.',
  },
  {
    id: 'optimize-cv-merge',
    prompt: 'Simplify this circuit',
    intent: 'optimize',
    setup: 'W m0 m1\nG #1 rotate m0 pi/4; #2 rotate m0 pi/4; #3 displace m1 0,0; #4 squeeze m1 0.5',
    reference: 'W m0 m1\nG rotate m0 pi/2; squeeze m1 0.5',
    expect: { qubits: 0, qumodes: 2, gates: { rotate: 1, squeeze: 1 }, maxGates: 2, maxDepth: 1 },
    notes:
      'The same three rules on qumodes: repeated rotations add, a zero displacement is the ' +
      'identity, and the two surviving gates are on different modes so they share a step.',
  },
  {
    id: 'optimize-rebalance-hybrid',
    prompt: 'Reduce the depth of this circuit',
    intent: 'optimize',
    setup: 'W q0 q1 q2 q3\nG #1 h q0; #2 cnot q0>q1; #3 h q2; #4 cnot q2>q3',
    expectNoMutation: true,
    expectMentions: ['depth'],
    notes:
      'Two independent blocks written one after the other. HyQSim already schedules them ' +
      'together (depth 2, not 4), so there is nothing left to win — the model must recognise ' +
      'that reordering is not its job rather than churning the circuit.',
  },
  {
    id: 'optimize-already-minimal',
    prompt: 'Optimize this to use fewer gates',
    intent: 'optimize',
    setup: 'W q0 q1\nG #1 h q0; #2 cnot q0>q1',
    expectNoMutation: true,
    expectMentions: ['minimal'],
    notes: 'Nothing safe to remove. The model must say so rather than invent a rewrite.',
  },
  {
    id: 'optimize-phrasing-shallower',
    prompt: 'Make this shallower',
    intent: 'optimize',
    setup: GHZ4_SETUP,
    notes: 'Classification only — this phrasing has no build verb and used to land in explain.',
  },
  {
    id: 'optimize-phrasing-fewer-gates',
    prompt: 'Can you do this with fewer gates?',
    intent: 'optimize',
    setup: GHZ4_SETUP,
    notes: 'Classification only.',
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
export const OPTIMIZE_CASES = EVAL_CASES.filter(c => c.intent === 'optimize');
/** Cases where a mutating tool call must be refused — the two read-only intents. */
export const READONLY_CASES = EVAL_CASES.filter(c => c.intent === 'explain' || c.intent === 'analyze');
