/**
 * Import/export between HyQSim circuits and Jaqal, the Sandia QSCOUT assembly
 * language emitted by hybridlane's ion-trap device
 * (`hybridlane.devices.sandia_qscout.jaqal`).
 *
 * Runs entirely in the browser — no Python backend required.
 *
 * The dialect is the qubit-boson pulse set:
 *
 *     from Calibration_PulseDefinitions.QubitBosonPulses usepulses *
 *
 *     register q[3]
 *
 *     subcircuit {
 *         Rz q[2] 4.0297
 *         xCD q[2] 1 2 0.98841 0.27302
 *         AJC q[1] 1 2 0.0 0.02
 *     }
 *
 * Qubits come from the register; qumodes are *not* in the register — they are
 * addressed by a (manifold, mode) pair, e.g. `1 2` above. Each distinct pair
 * becomes one HyQSim qumode wire, and the pair is kept on the wire
 * (`Wire.jaqalMode`) so that exporting reproduces the original addressing.
 *
 * The importer is deliberately strict: anything it cannot represent exactly is
 * an error rather than a silently dropped line.
 */

import type {
  Wire,
  CircuitElement,
  ImportCircuitResponse,
  ExportCircuitResponse,
  QubitInitialState,
  QumodeInitialState,
} from '../types/circuit';

export const JAQAL_PULSE_MODULE = 'Calibration_PulseDefinitions.QubitBosonPulses';

const GATE_X_SPACING = 60;
const GATE_X_OFFSET = 30;

// ---------------------------------------------------------------------------
// Gate tables
// ---------------------------------------------------------------------------

/** Jaqal gate → single-qubit HyQSim gate. Args are `q[i]` followed by `params`. */
const QUBIT_GATES: Record<string, { gateId: string; params: string[] }> = {
  Rx: { gateId: 'rx', params: ['theta'] },
  Ry: { gateId: 'ry', params: ['theta'] },
  Rz: { gateId: 'rz', params: ['theta'] },
  Px: { gateId: 'x', params: [] },
  Py: { gateId: 'y', params: [] },
  Pz: { gateId: 'z', params: [] },
  Sz: { gateId: 's', params: [] },
  Szd: { gateId: 'sdg', params: [] },
};

/**
 * Jaqal gate → hybrid HyQSim gate. Args are `q[i] manifold mode p1 p2`, and
 * `params` names the two trailing floats in the order Jaqal writes them.
 */
const HYBRID_GATES: Record<string, { gateId: string; params: [string, string] }> = {
  zCD: { gateId: 'cdisp', params: ['alpha_re', 'alpha_im'] },
  xCD: { gateId: 'xcdisp', params: ['alpha_re', 'alpha_im'] },
  yCD: { gateId: 'ycdisp', params: ['alpha_re', 'alpha_im'] },
  // Jaqal writes the phase before the angle; HyQSim calls them phi and theta.
  JC: { gateId: 'jc', params: ['phi', 'theta'] },
  AJC: { gateId: 'ajc', params: ['phi', 'theta'] },
};

/** Jaqal gates we recognise but cannot represent, with the reason shown to the user. */
const UNSUPPORTED_GATES: Record<string, string> = {
  R: 'arbitrary-axis rotation has no single HyQSim gate (use Rx/Ry/Rz)',
  Sx: 'square-root-of-X is not in the HyQSim gate set',
  Sxd: 'square-root-of-X† is not in the HyQSim gate set',
  Sy: 'square-root-of-Y is not in the HyQSim gate set',
  Syd: 'square-root-of-Y† is not in the HyQSim gate set',
  XX: 'Mølmer-Sørensen XX is not in the HyQSim gate set',
  YY: 'Ising YY is not in the HyQSim gate set',
  ZZ: 'Ising ZZ is not in the HyQSim gate set',
  RampUp: 'conditional X-squeezing (RampUp) is not in the HyQSim gate set',
  Beamsplitter: 'the native ion-trap beamsplitter is parameterised by detunings and duration, not by (θ, φ)',
  Rt_SBProbe: 'the sideband probe is a hardware diagnostic, not a circuit gate',
  MS: 'Mølmer-Sørensen MS is not in the HyQSim gate set',
  Sxx: 'Sxx is not in the HyQSim gate set',
};

/**
 * Legacy `qscout.v1.std` sideband spellings, still used by older probe
 * circuits. They carry the same information as JC/AJC but in a different order:
 *
 *     Blue q[1] 1 0.0 0.02 1 2      // order, phase, angle, manifold, mode
 *     AJC  q[1] 1 2 0.0 0.02        // manifold, mode, phase, angle
 *
 * The leading `1` is the sideband order; only first-order sidebands map onto
 * the HyQSim gates, so anything else is refused rather than approximated.
 */
const LEGACY_SIDEBANDS: Record<string, { gateId: string; modern: string }> = {
  Blue: { gateId: 'ajc', modern: 'AJC' },
  Red: { gateId: 'jc', modern: 'JC' },
};

// HyQSim gate id → Jaqal gate name for export
const QUBIT_EXPORT: Record<string, { name: string; params: string[] }> = {
  rx: { name: 'Rx', params: ['theta'] },
  ry: { name: 'Ry', params: ['theta'] },
  rz: { name: 'Rz', params: ['theta'] },
  x: { name: 'Px', params: [] },
  y: { name: 'Py', params: [] },
  z: { name: 'Pz', params: [] },
  s: { name: 'Sz', params: [] },
  sdg: { name: 'Szd', params: [] },
};

const HYBRID_EXPORT: Record<string, { name: string; params: [string, string] }> = {
  cdisp: { name: 'zCD', params: ['alpha_re', 'alpha_im'] },
  xcdisp: { name: 'xCD', params: ['alpha_re', 'alpha_im'] },
  ycdisp: { name: 'yCD', params: ['alpha_re', 'alpha_im'] },
  jc: { name: 'JC', params: ['phi', 'theta'] },
  ajc: { name: 'AJC', params: ['phi', 'theta'] },
};

/** HyQSim gates with an exact Jaqal equivalent that takes more than one line. */
const DECOMPOSED_EXPORT: Record<string, { name: string; args: number[] }[]> = {
  // H = Ry(π/2)·Z  (Z first, then Ry)
  h: [{ name: 'Pz', args: [] }, { name: 'Ry', args: [Math.PI / 2] }],
  // T = Rz(π/4) up to a global phase
  t: [{ name: 'Rz', args: [Math.PI / 4] }],
};

/** Qubit initial state → the single native rotation that prepares it from |0⟩. */
const QUBIT_PREP: Record<QubitInitialState, { name: string; args: number[] }[]> = {
  '0': [],
  '1': [{ name: 'Px', args: [] }],
  '+': [{ name: 'Ry', args: [Math.PI / 2] }],
  '-': [{ name: 'Ry', args: [-Math.PI / 2] }],
  'i': [{ name: 'Rx', args: [-Math.PI / 2] }],
  '-i': [{ name: 'Rx', args: [Math.PI / 2] }],
};

let _jaqalUid = 0;
function jaqalUid(prefix: string): string {
  return `${prefix}-jq-${++_jaqalUid}`;
}

function round6(n: number): number {
  return Math.round(n * 1e6) / 1e6;
}

class JaqalError extends Error {}

// ---------------------------------------------------------------------------
// Parser: Jaqal → HyQSim circuit
// ---------------------------------------------------------------------------

/** Strip block and line comments, then split into statements. */
function splitStatements(code: string): { text: string; line: number }[] {
  // Normalise line endings and drop a UTF-8 BOM first. Both matter: a CRLF file
  // leaves a "\r" at the end of every line, and "\r" is a line terminator that
  // `.` does not match, so the `//` comment regex below silently fails to strip
  // anything and whole comment lines arrive as if they were statements.
  const normalised = code.replace(/^﻿/, '').replace(/\r\n?/g, '\n');
  const withoutBlocks = normalised.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '));
  const out: { text: string; line: number }[] = [];

  withoutBlocks.split('\n').forEach((rawLine, i) => {
    const noComment = rawLine.replace(/\/\/.*$/, '');
    // Braces are statements of their own, wherever they appear on the line.
    const spaced = noComment.replace(/([{}])/g, ' $1 ');
    for (const piece of spaced.split(';')) {
      const text = piece.trim();
      if (text) out.push({ text, line: i + 1 });
    }
  });

  // A "{" or "}" glued to a statement becomes its own entry
  const expanded: { text: string; line: number }[] = [];
  for (const stmt of out) {
    for (const tok of stmt.text.split(/\s+(?=[{}])|(?<=[{}])\s+/)) {
      const text = tok.trim();
      if (text) expanded.push({ text, line: stmt.line });
    }
  }
  return expanded;
}

export function parseJaqal(code: string): ImportCircuitResponse {
  const warnings: string[] = [];

  try {
    return parseJaqalInner(code, warnings);
  } catch (e) {
    return {
      success: false,
      wires: [],
      elements: [],
      error: e instanceof Error ? e.message : String(e),
      warnings,
    };
  }
}

function parseJaqalInner(code: string, warnings: string[]): ImportCircuitResponse {
  const statements = splitStatements(code);
  if (statements.length === 0) throw new JaqalError('The Jaqal program is empty.');

  const constants = new Map<string, number>();
  const registers = new Map<string, number>();   // register name → size
  const elements: CircuitElement[] = [];

  // Qumode wires, keyed by "manifold:mode", in order of first appearance
  const qumodeOrder: { manifold: number; index: number; fockPrep?: number }[] = [];
  const qumodeKeys = new Map<string, number>();

  let sawSubcircuit = false;
  let depth = 0;

  // Column bookkeeping — qubit wires are indexed first, qumodes after them, so
  // columns are tracked by a key that survives the final wire numbering.
  const qubitColumn = new Map<number, number>();
  const qumodeColumn = new Map<number, number>();
  const maxColumn = () =>
    Math.max(0, ...qubitColumn.values(), ...qumodeColumn.values());

  function registerQumode(manifold: number, index: number): number {
    const key = `${manifold}:${index}`;
    const existing = qumodeKeys.get(key);
    if (existing !== undefined) return existing;
    const slot = qumodeOrder.length;
    qumodeOrder.push({ manifold, index });
    qumodeKeys.set(key, slot);
    qumodeColumn.set(slot, maxColumn());
    return slot;
  }

  function fail(line: number, msg: string): never {
    throw new JaqalError(`Line ${line}: ${msg}`);
  }

  function parseNumber(tok: string, line: number, what: string): number {
    if (constants.has(tok)) return constants.get(tok)!;
    const v = Number(tok);
    if (!Number.isFinite(v)) fail(line, `expected a number for ${what}, got "${tok}".`);
    return v;
  }

  function parseInteger(tok: string, line: number, what: string): number {
    const v = parseNumber(tok, line, what);
    if (!Number.isInteger(v)) fail(line, `expected an integer for ${what}, got "${tok}".`);
    return v;
  }

  /** Manifold and mode are hardware addresses — they cannot be negative. */
  function parseAddress(tok: string, line: number, what: string): number {
    const v = parseInteger(tok, line, what);
    if (v < 0) fail(line, `${what} must be zero or positive, got ${v}.`);
    return v;
  }

  /** `q[2]` → qubit wire index 2, validating against the declared register. */
  function parseQubitRef(tok: string, line: number): number {
    const m = tok.match(/^([A-Za-z_]\w*)\[(\d+)\]$/);
    if (!m) fail(line, `expected a qubit reference like q[0], got "${tok}".`);
    const [, name, idxStr] = m;
    const size = registers.get(name);
    if (size === undefined) fail(line, `qubit register "${name}" was never declared.`);
    const idx = parseInt(idxStr, 10);
    if (idx >= size) fail(line, `qubit ${tok} is outside the declared register ${name}[${size}].`);
    return idx;
  }

  for (const { text, line } of statements) {
    if (text === '{') { depth++; continue; }
    if (text === '}') {
      if (depth === 0) fail(line, 'unmatched "}".');
      depth--;
      continue;
    }

    const tokens = text.split(/\s+/);
    const head = tokens[0];

    // ----- header / declarations -----
    if (head === 'from') {
      const usepulses = tokens.indexOf('usepulses');
      if (usepulses < 0) fail(line, 'malformed usepulses statement.');
      const module = tokens[1];
      if (module !== JAQAL_PULSE_MODULE) {
        warnings.push(`Line ${line}: pulse module "${module}" is not ${JAQAL_PULSE_MODULE}; assuming the qubit-boson gate set anyway.`);
      }
      continue;
    }

    if (head === 'import' || head === 'usepulses') {
      warnings.push(`Line ${line}: ignored "${head}" statement.`);
      continue;
    }

    if (head === 'register') {
      const m = tokens[1]?.match(/^([A-Za-z_]\w*)\[(\d+)\]$/);
      if (!m) fail(line, 'malformed register declaration; expected e.g. "register q[3]".');
      // One register only. Wire indices are the register offsets, so a second
      // register would alias onto the first (q[1] and r[1] both landing on
      // wire 1) and silently merge two different qubits.
      if (registers.size > 0 && !registers.has(m[1])) {
        fail(line, `a second qubit register "${m[1]}" is not supported; HyQSim maps one register onto its qubit wires.`);
      }
      if (registers.has(m[1])) fail(line, `register "${m[1]}" is declared twice.`);
      const size = parseInt(m[2], 10);
      if (size === 0) fail(line, `register "${m[1]}" is empty; a circuit needs at least one qubit.`);
      registers.set(m[1], size);
      continue;
    }

    if (head === 'map') fail(line, '"map" aliases are not supported; write register references directly.');
    if (head === 'macro') fail(line, '"macro" definitions are not supported.');
    if (head === 'loop') fail(line, '"loop" blocks are not supported; unroll the loop before importing.');

    if (head === 'let') {
      if (tokens.length < 3) fail(line, 'malformed "let"; expected "let name value".');
      constants.set(tokens[1], parseNumber(tokens[2], line, `let ${tokens[1]}`));
      continue;
    }

    if (head === 'subcircuit') {
      // "subcircuit {" or "subcircuit <n> {". The repeat count is a shot count,
      // not circuit structure — the gate sequence is identical either way — so
      // it is imported and the count is surfaced as a warning rather than
      // rejecting the file outright.
      if (tokens.length > 1 && tokens[1] !== '{') {
        const repeats = constants.has(tokens[1]) ? constants.get(tokens[1])! : Number(tokens[1]);
        if (!Number.isInteger(repeats) || repeats < 0) {
          fail(line, `expected a subcircuit repeat count or "{", got "${tokens[1]}".`);
        }
        warnings.push(
          `Line ${line}: subcircuit repeat count ${repeats} was dropped — set the shot count in the simulator instead.`,
        );
      }
      if (sawSubcircuit && elements.length > 0) {
        warnings.push(`Line ${line}: a second subcircuit block was appended to the same circuit.`);
      }
      sawSubcircuit = true;
      continue;
    }

    if (text.startsWith('<') || text.startsWith('|')) {
      fail(line, 'parallel blocks ("<...>") are not supported.');
    }

    // ----- gates -----
    if (head === 'prepare_all') {
      if (elements.length > 0) {
        fail(line, '"prepare_all" after a gate would reset the circuit, which HyQSim cannot represent.');
      }
      continue;  // all wires already start in |0⟩
    }

    if (head === 'measure_all') {
      const totalQubits = Math.max(0, ...registers.values());
      const col = maxColumn();
      for (let q = 0; q < totalQubits; q++) {
        elements.push({
          id: jaqalUid('el'),
          gateId: 'measure',
          position: { x: col * GATE_X_SPACING + GATE_X_OFFSET, y: 0 },
          wireIndex: q,
        });
        qubitColumn.set(q, col + 1);
      }
      continue;
    }

    if (QUBIT_GATES[head]) {
      const { gateId, params } = QUBIT_GATES[head];
      const args = tokens.slice(1);
      if (args.length !== 1 + params.length) {
        fail(line, `${head} takes ${1 + params.length} argument(s), got ${args.length}.`);
      }
      const wireIdx = parseQubitRef(args[0], line);
      const parameterValues: Record<string, number> = {};
      params.forEach((name, i) => {
        parameterValues[name] = round6(parseNumber(args[i + 1], line, `${head} ${name}`));
      });

      const col = qubitColumn.get(wireIdx) ?? maxColumn();
      qubitColumn.set(wireIdx, col + 1);
      elements.push({
        id: jaqalUid('el'),
        gateId,
        position: { x: col * GATE_X_SPACING + GATE_X_OFFSET, y: 0 },
        wireIndex: wireIdx,
        parameterValues: params.length ? parameterValues : undefined,
      });
      continue;
    }

    if (HYBRID_GATES[head] || LEGACY_SIDEBANDS[head]) {
      const args = tokens.slice(1);

      // Both spellings resolve to the same five values; only the order differs.
      let gateId: string;
      let qubitTok: string, manifoldTok: string, modeTok: string;
      let phiTok: string, thetaTok: string;

      if (LEGACY_SIDEBANDS[head]) {
        const legacy = LEGACY_SIDEBANDS[head];
        if (args.length !== 6) {
          fail(line, `${head} takes 6 arguments (qubit order phase angle manifold mode), got ${args.length}.`);
        }
        const order = parseInteger(args[1], line, `${head} sideband order`);
        if (order !== 1) {
          fail(line, `${head} sideband order ${order} has no HyQSim equivalent — only first-order sidebands map onto ${legacy.modern}.`);
        }
        gateId = legacy.gateId;
        [qubitTok, phiTok, thetaTok, manifoldTok, modeTok] = [args[0], args[2], args[3], args[4], args[5]];
        warnings.push(`Line ${line}: legacy "${head}" was imported as ${legacy.modern}.`);
      } else {
        const { gateId: id, params } = HYBRID_GATES[head];
        if (args.length !== 5) {
          fail(line, `${head} takes 5 arguments (qubit manifold mode ${params[0]} ${params[1]}), got ${args.length}.`);
        }
        gateId = id;
        [qubitTok, manifoldTok, modeTok, phiTok, thetaTok] = args;
      }

      const qubitIdx = parseQubitRef(qubitTok, line);
      const manifold = parseAddress(manifoldTok, line, `${head} manifold`);
      const mode = parseAddress(modeTok, line, `${head} mode`);
      const qumodeSlot = registerQumode(manifold, mode);

      // zCD/xCD/yCD name the pair (alpha_re, alpha_im); JC/AJC name it (phi, theta).
      const [name1, name2] = HYBRID_GATES[head]?.params ?? ['phi', 'theta'];
      const parameterValues: Record<string, number> = {
        [name1]: round6(parseNumber(phiTok, line, `${head} ${name1}`)),
        [name2]: round6(parseNumber(thetaTok, line, `${head} ${name2}`)),
      };

      // A two-wire gate must clear everything placed so far on either wire
      const col = maxColumn();
      qubitColumn.set(qubitIdx, col + 1);
      qumodeColumn.set(qumodeSlot, col + 1);
      elements.push({
        id: jaqalUid('el'),
        gateId,
        position: { x: col * GATE_X_SPACING + GATE_X_OFFSET, y: 0 },
        wireIndex: qubitIdx,
        // Patched to the final qumode wire index once the register size is known
        targetWireIndices: [-1 - qumodeSlot],
        parameterValues,
      });
      continue;
    }

    if (head === 'FockStatePrep') {
      const args = tokens.slice(1);
      if (args.length !== 4) fail(line, `FockStatePrep takes 4 arguments (qubit manifold mode state), got ${args.length}.`);
      parseQubitRef(args[0], line);
      const manifold = parseAddress(args[1], line, 'FockStatePrep manifold');
      const mode = parseAddress(args[2], line, 'FockStatePrep mode');
      const n = parseInteger(args[3], line, 'FockStatePrep state');
      if (n < 0 || n > 5) fail(line, `FockStatePrep |${n}⟩ is outside the range of HyQSim qumode initial states (|0⟩–|5⟩).`);

      const slot = registerQumode(manifold, mode);
      const usedAlready = elements.some(
        el => el.targetWireIndices?.[0] === -1 - slot,
      );
      if (usedAlready) {
        fail(line, `FockStatePrep on mode (${manifold}, ${mode}) comes after a gate on that mode; HyQSim can only prepare Fock states at the start of a circuit.`);
      }
      if (qumodeOrder[slot].fockPrep !== undefined) {
        fail(line, `mode (${manifold}, ${mode}) is prepared twice.`);
      }
      qumodeOrder[slot].fockPrep = n;
      continue;
    }

    if (UNSUPPORTED_GATES[head]) {
      fail(line, `gate "${head}" cannot be imported — ${UNSUPPORTED_GATES[head]}.`);
    }

    if (head.startsWith('I_')) {
      fail(line, `"${head}" is an idle-padding pulse with no HyQSim equivalent; remove the idles before importing.`);
    }
    fail(line, `unrecognised statement "${head}".`);
  }

  if (depth !== 0) throw new JaqalError('Unclosed "{" — the subcircuit block was never closed.');

  const numQubits = Math.max(0, ...registers.values());
  if (numQubits === 0) throw new JaqalError('No qubit register was declared (expected e.g. "register q[3]").');

  // Wires: qubits in register order, then qumodes in order of first appearance
  const wires: Wire[] = [];
  for (let q = 0; q < numQubits; q++) {
    wires.push({ id: jaqalUid('wire'), type: 'qubit', index: q, initialState: '0' });
  }
  qumodeOrder.forEach((qm, slot) => {
    wires.push({
      id: jaqalUid('wire'),
      type: 'qumode',
      index: numQubits + slot,
      initialState: (qm.fockPrep ?? 0) as QumodeInitialState,
      jaqalMode: { manifold: qm.manifold, index: qm.index },
    });
  });

  // Resolve the placeholder qumode targets now that qubit count is known
  for (const el of elements) {
    if (el.targetWireIndices) {
      el.targetWireIndices = el.targetWireIndices.map(t => (t < 0 ? numQubits + (-1 - t) : t));
    }
  }

  if (!sawSubcircuit) {
    warnings.push('No "subcircuit" block was found; gates were read from the top level.');
  }
  if (elements.length === 0) {
    warnings.push('No gate operations found in the program.');
  }

  return { success: true, wires, elements, warnings };
}

// ---------------------------------------------------------------------------
// Generator: HyQSim circuit → Jaqal
// ---------------------------------------------------------------------------

/**
 * Jaqal numeric literal: plain decimal, no exponent, trimmed to 6 decimals.
 * Jaqal has no exponent syntax, so `String()` is not safe on its own — it
 * switches to "1e+21" for large magnitudes, which no Jaqal parser accepts.
 */
function fmt(value: number): string {
  if (!Number.isFinite(value)) {
    throw new JaqalError(`Cannot write ${value} as a Jaqal number — check the gate parameters.`);
  }
  const rounded = round6(value);
  if (Number.isInteger(rounded)) {
    if (Math.abs(rounded) >= 1e21) {
      throw new JaqalError(`Parameter ${value} is too large to write as a plain Jaqal decimal.`);
    }
    return rounded.toFixed(1);
  }
  // toFixed(6) never uses exponent notation; trim the padding zeros back off.
  return rounded.toFixed(6).replace(/0+$/, '').replace(/\.$/, '.0');
}

export function generateJaqal(wires: Wire[], elements: CircuitElement[]): ExportCircuitResponse {
  try {
    const qubitWires = wires.map((w, i) => ({ w, i })).filter(({ w }) => w.type === 'qubit');
    const qumodeWires = wires.map((w, i) => ({ w, i })).filter(({ w }) => w.type === 'qumode');

    if (qubitWires.length === 0) {
      return {
        success: false,
        code: '',
        error: 'Jaqal programs need at least one qubit — every native gate acts on a qubit.',
      };
    }

    // wire array index → q[n]
    const qubitSlot = new Map<number, number>();
    qubitWires.forEach(({ i }, n) => qubitSlot.set(i, n));

    // wire array index → (manifold, mode), preserved from import when available
    // Addresses carried over from an import are honoured first; wires without
    // one are then given the lowest free mode on manifold 1. Two wires must
    // never share an address — re-importing would merge them into a single
    // qumode and silently change the circuit.
    const modeAddr = new Map<number, { manifold: number; index: number }>();
    const takenAddr = new Set<string>();
    const addrKey = (a: { manifold: number; index: number }) => `${a.manifold}:${a.index}`;

    for (const { w, i } of qumodeWires) {
      if (!w.jaqalMode) continue;
      const key = addrKey(w.jaqalMode);
      if (takenAddr.has(key)) {
        return {
          success: false,
          code: '',
          error:
            `Two qumode wires both claim the Jaqal address (manifold ${w.jaqalMode.manifold}, mode ${w.jaqalMode.index}). ` +
            'Exporting them would merge the modes into one — give them distinct addresses before exporting.',
        };
      }
      takenAddr.add(key);
      modeAddr.set(i, w.jaqalMode);
    }

    let nextFree = 0;
    for (const { i } of qumodeWires) {
      if (modeAddr.has(i)) continue;
      while (takenAddr.has(`1:${nextFree}`)) nextFree++;
      const addr = { manifold: 1, index: nextFree };
      takenAddr.add(addrKey(addr));
      modeAddr.set(i, addr);
    }

    const body: string[] = [];

    // Initial states — Jaqal starts every qubit in |0⟩ and every mode in vacuum
    for (const { w, i } of qubitWires) {
      const prep = QUBIT_PREP[(w.initialState as QubitInitialState) ?? '0'] ?? [];
      for (const step of prep) {
        body.push(`    ${step.name} q[${qubitSlot.get(i)}]${step.args.map(a => ` ${fmt(a)}`).join('')}`);
      }
    }
    for (const { w, i } of qumodeWires) {
      const n = (w.initialState as QumodeInitialState) ?? 0;
      if (n > 0) {
        const addr = modeAddr.get(i)!;
        // FockStatePrep is qubit-assisted; it is driven from the first qubit
        body.push(`    FockStatePrep q[0] ${addr.manifold} ${addr.index} ${n}`);
      }
    }

    const sorted = [...elements].sort((a, b) => a.position.x - b.position.x);
    const unsupported = new Set<string>();
    let anyMeasure = false;

    for (const el of sorted) {
      if (el.gateId === 'measure') { anyMeasure = true; continue; }

      const qSlot = qubitSlot.get(el.wireIndex);

      const qubitGate = QUBIT_EXPORT[el.gateId];
      if (qubitGate) {
        if (qSlot === undefined) { unsupported.add(`${el.gateId} (not on a qubit wire)`); continue; }
        const args = qubitGate.params.map(p => ` ${fmt(el.parameterValues?.[p] ?? 0)}`).join('');
        body.push(`    ${qubitGate.name} q[${qSlot}]${args}`);
        continue;
      }

      const decomposed = DECOMPOSED_EXPORT[el.gateId];
      if (decomposed) {
        if (qSlot === undefined) { unsupported.add(`${el.gateId} (not on a qubit wire)`); continue; }
        for (const step of decomposed) {
          body.push(`    ${step.name} q[${qSlot}]${step.args.map(a => ` ${fmt(a)}`).join('')}`);
        }
        continue;
      }

      const hybridGate = HYBRID_EXPORT[el.gateId];
      if (hybridGate) {
        const targetIdx = el.targetWireIndices?.[0];
        const addr = targetIdx === undefined ? undefined : modeAddr.get(targetIdx);
        if (qSlot === undefined || !addr) { unsupported.add(`${el.gateId} (missing qubit or qumode wire)`); continue; }
        const [p1, p2] = hybridGate.params;
        body.push(
          `    ${hybridGate.name} q[${qSlot}] ${addr.manifold} ${addr.index} ` +
          `${fmt(el.parameterValues?.[p1] ?? 0)} ${fmt(el.parameterValues?.[p2] ?? 0)}`,
        );
        continue;
      }

      unsupported.add(el.gateId);
    }

    if (unsupported.size > 0) {
      return {
        success: false,
        code: '',
        error:
          `These gates have no native Jaqal equivalent on the ion trap: ${[...unsupported].sort().join(', ')}. ` +
          'Remove or decompose them (into Rx/Ry/Rz and the native sideband/conditional-displacement gates) and export again.',
      };
    }

    if (anyMeasure) body.push('    measure_all');

    const out = [
      `from ${JAQAL_PULSE_MODULE} usepulses *`,
      '',
      `register q[${qubitWires.length}]`,
      '',
      'subcircuit {',
      ...body,
      '}',
    ];

    return { success: true, code: out.join('\n') };
  } catch (e) {
    return { success: false, code: '', error: e instanceof Error ? e.message : 'Export failed' };
  }
}
