/**
 * Intent classification for chat messages.
 *
 * Two things depend on this:
 *
 *  1. Whether we force a tool call. The agent loop used to force one on every first turn,
 *     which wasted a whole round-trip on "explain this circuit" — the model was compelled
 *     to call read_circuit even though the canvas snapshot was already in front of it.
 *
 *  2. Whether we auto-run the simulator. HyQSim always runs the simulation itself; the AI
 *     never computes results. But for a question like "what output will this give?" it is
 *     pointless to answer without numbers, so we trigger the real simulator first.
 *
 * The keyword lists are exported because AI_GUIDE.md documents them, and docs that drift
 * from the code are worse than no docs.
 */

export type Intent = 'build' | 'explain' | 'analyze';

/** Verbs that mean "change the circuit". */
export const BUILD_KEYWORDS = [
  'build', 'create', 'make', 'construct', 'generate', 'prepare', 'implement',
  'add', 'place', 'insert', 'put', 'append',
  'remove', 'delete', 'drop', 'clear', 'reset', 'erase',
  'modify', 'change', 'replace', 'set', 'update', 'edit', 'swap', 'rename',
  'undo', 'move', 'rewire',
];

/** Phrases that mean "tell me about the circuit structure". */
export const EXPLAIN_KEYWORDS = [
  'explain', 'describe', 'what is', 'what are', 'what does', 'what kind of circuit',
  'why', 'how does', 'how do', 'interpret', 'walk me through', 'summarize',
  'tell me about', 'meaning', 'purpose', 'what circuit',
];

/**
 * Phrases that mean "tell me about the results". These are the ones that auto-run the
 * simulator when results are missing or stale.
 */
export const ANALYZE_KEYWORDS = [
  'what output', 'what result', 'what will', 'what would', 'what happens',
  'analyze', 'analyse', 'analysis', 'evaluate', 'predict', 'outcome', 'output',
  'result', 'measure', 'measurement', 'distribution', 'histogram', 'counts',
  'probability', 'probabilities', 'amplitude', 'expectation',
  'wigner', 'negativity', 'fock', 'photon number', 'squeez',
  'bloch', 'entangle', 'fidelity', 'purity', 'simulate', 'simulation', 'run it',
  '⟨n⟩', '<n>', 'phase space', 'quadrature',
];

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Matches a keyword at a word boundary, allowing any suffix.
 *
 * The suffix is what lets "add" catch "adding" and "squeez" catch "squeezed". The leading
 * boundary is what stops "place" matching "displacement" and "put" matching "output" —
 * both of which a naive substring check mis-classified as build requests, so asking
 * "what kind of output will this give?" could get the canvas rebuilt.
 */
function hasAny(haystack: string, needles: string[]): boolean {
  return needles.some(n => {
    const pattern = /^[a-z]/.test(n) ? `\\b${escapeRegex(n)}` : escapeRegex(n);
    return new RegExp(pattern).test(haystack);
  });
}

/**
 * Classifies a user message.
 *
 * Precedence is deliberate: a message that asks to *change* something is a build even if
 * it also mentions results ("add a squeeze gate and tell me the photon number") — the
 * mutation is the part that must not be skipped. Between the two read-only intents,
 * `analyze` wins, because answering a results question from structure alone is useless
 * while answering a structure question with results attached is merely wasteful.
 */
export function classifyIntent(message: string): Intent {
  const m = message.toLowerCase();
  if (hasAny(m, BUILD_KEYWORDS)) return 'build';
  if (hasAny(m, ANALYZE_KEYWORDS)) return 'analyze';
  if (hasAny(m, EXPLAIN_KEYWORDS)) return 'explain';
  // Unknown phrasing: treat as explain. Guessing 'build' would let a misread question
  // silently wipe the user's canvas, which is the more expensive mistake.
  return 'explain';
}

/** Only `build` forces a structured tool call on the first turn. */
export function shouldForceTools(intent: Intent): boolean {
  return intent === 'build';
}

/**
 * Whether to run the simulator before answering.
 *
 * `hasFreshResult` is simply `simulationResult !== null` — App.tsx nulls the result on
 * every circuit mutation, so a non-null result is by construction current.
 */
export function shouldAutoRunSimulation(
  intent: Intent,
  hasFreshResult: boolean,
  hasCircuit: boolean,
): boolean {
  return intent === 'analyze' && !hasFreshResult && hasCircuit;
}
