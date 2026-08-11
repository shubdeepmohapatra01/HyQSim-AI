/**
 * HQC — HyQSim Circuit notation.
 *
 * A compact text encoding of a circuit, designed to be cheap in tokens and easy for an
 * LLM to both read and write. It replaces the prose format that used to be sent to the
 * model, which cost ~5x more tokens for the same information.
 *
 *   W q0 q1 m0
 *   G #1 h q0; #2 cnot q0>q1; #3 displace m0 1,0
 *
 * Conventions:
 *  - Wires are labelled positionally per type: q0, q1, ... and m0, m1, ...
 *  - |0⟩ is the default initial state and is omitted. Anything else is `q0=+` / `m0=2`.
 *  - Gates are addressed by 1-based left-to-right index (`#3`), never by element id.
 *    Positional refs are always resolvable, which element ids are not while the chat
 *    panel is holding optimistic shadow state mid-turn.
 *  - Parameters are positional in the gate's declared order, and omitted entirely when
 *    every value equals its default.
 *  - Multi-wire gates read `primary>target`.
 */

import type { Gate, Wire, CircuitElement, QubitInitialState, QumodeInitialState } from '../types/circuit';
import { ALL_GATES, getDefaultParameters } from '../types/circuit';

const GATES_BY_ID = new Map(ALL_GATES.map(g => [g.id, g]));

/**
 * Names models reach for that aren't our canonical ids. Accepting these costs nothing and
 * saves a whole self-correction round-trip every time a model writes `cx` instead of `cnot`.
 */
export const GATE_ALIASES: Record<string, string> = {
  cx: 'cnot', cnot_gate: 'cnot', controlled_x: 'cnot', controlled_not: 'cnot',
  hadamard: 'h', pauli_x: 'x', pauli_y: 'y', pauli_z: 'z',
  not: 'x', phase: 's', tgate: 't', sdag: 'sdg', s_dagger: 'sdg', t_gate: 't',
  d: 'displace', displacement: 'displace',
  sq: 'squeeze', squeezing: 'squeeze', squeezer: 'squeeze',
  r: 'rotate', rotation: 'rotate', phase_rotation: 'rotate', fourier: 'rotate',
  beamsplitter: 'bs', beam_splitter: 'bs', bsplit: 'bs',
  kerr_gate: 'kerr', self_kerr: 'kerr',
  cd: 'cdisp', conditional_displacement: 'cdisp', zcd: 'cdisp',
  xcd: 'xcdisp', ycd: 'ycdisp',
  conditional_rotation: 'cr', crot: 'cr',
  jaynes_cummings: 'jc',
  m: 'measure', meas: 'measure',
};

export function canonicalGateId(raw: string): string {
  const k = String(raw ?? '').trim().toLowerCase();
  return GATES_BY_ID.has(k) ? k : (GATE_ALIASES[k] ?? k);
}

// ─── Wire labels ──────────────────────────────────────────────────────────────

/** Human-readable label for the wire at array index `idx`, e.g. "q0", "m1". */
export function wireLabel(wires: Wire[], idx: number): string {
  const wire = wires[idx];
  if (!wire) return `wire${idx}`;
  const typeCount = wires.slice(0, idx).filter(w => w.type === wire.type).length;
  return wire.type === 'qubit' ? `q${typeCount}` : `m${typeCount}`;
}

/** Converts "q0" / "m1" to its index in `wires`. Returns -1 if absent. */
export function wireLabelToIndex(wires: Wire[], label: string): number {
  const match = String(label ?? '').trim().toLowerCase().match(/^([qm])(\d+)$/);
  if (!match) return -1;
  const type = match[1] === 'q' ? 'qubit' : 'qumode';
  const n = parseInt(match[2], 10);
  let count = 0;
  for (let i = 0; i < wires.length; i++) {
    if (wires[i].type === type) {
      if (count === n) return i;
      count++;
    }
  }
  return -1;
}

/** Comma-joined list of every valid label, for error messages. */
export function availableWireLabels(wires: Wire[]): string {
  if (wires.length === 0) return 'none (add wires first)';
  return wires.map((_, i) => wireLabel(wires, i)).join(', ');
}

// ─── Numeric literals ─────────────────────────────────────────────────────────

/**
 * Parses a number the way a physicist writes one: `1.5`, `-0.3`, `pi`, `pi/2`, `3pi/4`,
 * `-pi/4`, `2*pi`. Models emit these constantly; rejecting them wastes a round-trip.
 * Deliberately not `eval` — this grammar is small and closed.
 */
export function parseNumber(raw: string): number | null {
  const s = String(raw ?? '').trim().toLowerCase().replace(/\s+/g, '');
  if (s === '') return null;

  const plain = Number(s);
  if (!isNaN(plain)) return plain;

  // [coefficient] pi [/ divisor]
  const m = s.match(/^([+-]?)(\d*\.?\d*)\*?(pi|π)(?:\/(\d*\.?\d+))?$/);
  if (!m) return null;
  const sign = m[1] === '-' ? -1 : 1;
  const coeff = m[2] === '' ? 1 : Number(m[2]);
  const div = m[4] === undefined ? 1 : Number(m[4]);
  if (isNaN(coeff) || isNaN(div) || div === 0) return null;
  return (sign * coeff * Math.PI) / div;
}

function fmtNumber(v: number): string {
  if (Number.isInteger(v)) return String(v);
  return String(Number(v.toFixed(4)));
}

// ─── Parameters ───────────────────────────────────────────────────────────────

/**
 * Accepts either positional (`"1,0"` / `[1, 0]`) or named (`{alpha_re: 1}` / `"alpha_re=1"`)
 * parameters and returns a full value map merged over the gate's defaults.
 */
export function resolveParameters(
  gate: Gate,
  raw: unknown,
): { values: Record<string, number>; error: string | null } {
  const defaults = getDefaultParameters(gate);
  const declared = gate.parameters ?? [];

  if (raw === undefined || raw === null || raw === '') {
    return { values: defaults, error: null };
  }

  // Named object form — what the structured add_gate tool sends.
  if (typeof raw === 'object' && !Array.isArray(raw)) {
    const out = { ...defaults };
    for (const [key, val] of Object.entries(raw as Record<string, unknown>)) {
      if (!(key in defaults)) {
        return {
          values: defaults,
          error: `Gate "${gate.id}" has no parameter "${key}". Valid: ${declared.map(p => p.name).join(', ') || 'none'}`,
        };
      }
      const n = typeof val === 'number' ? val : parseNumber(String(val));
      if (n === null) {
        return { values: defaults, error: `Parameter "${key}" of "${gate.id}" is not a number: "${String(val)}"` };
      }
      out[key] = n;
    }
    return { values: out, error: null };
  }

  const tokens = Array.isArray(raw)
    ? raw.map(String)
    : String(raw).split(',').map(s => s.trim()).filter(s => s !== '');

  if (tokens.length === 0) return { values: defaults, error: null };

  // Named inline form: "alpha_re=1, alpha_im=0"
  if (tokens.every(t => t.includes('='))) {
    const obj: Record<string, string> = {};
    for (const t of tokens) {
      const idx = t.indexOf('=');
      obj[t.slice(0, idx).trim()] = t.slice(idx + 1).trim();
    }
    return resolveParameters(gate, obj);
  }

  // Positional form, in the gate's declared parameter order.
  if (tokens.length > declared.length) {
    return {
      values: defaults,
      error: `Gate "${gate.id}" takes ${declared.length} parameter(s) (${declared.map(p => p.name).join(', ') || 'none'}), got ${tokens.length}.`,
    };
  }
  const out = { ...defaults };
  for (let i = 0; i < tokens.length; i++) {
    const n = parseNumber(tokens[i]);
    if (n === null) {
      return { values: defaults, error: `Parameter "${declared[i].name}" of "${gate.id}" is not a number: "${tokens[i]}"` };
    }
    out[declared[i].name] = n;
  }
  return { values: out, error: null };
}

/** Encodes parameters positionally, returning '' when every value is at its default. */
function encodeParameters(gate: Gate, values: Record<string, number> | undefined): string {
  const declared = gate.parameters ?? [];
  if (declared.length === 0 || !values) return '';
  const atDefault = declared.every(p => Math.abs((values[p.name] ?? p.defaultValue) - p.defaultValue) < 1e-9);
  if (atDefault) return '';
  return declared.map(p => fmtNumber(values[p.name] ?? p.defaultValue)).join(',');
}

// ─── Placing a single gate ────────────────────────────────────────────────────

/** Horizontal spacing between auto-placed gates, matching the canvas grid. */
const GATE_SPACING = 80;

export function nextGateX(elements: CircuitElement[]): number {
  const maxX = elements.length > 0 ? Math.max(...elements.map(e => e.position.x)) : -GATE_SPACING;
  return maxX + GATE_SPACING;
}

export interface PlaceGateInput {
  gateId: string;
  wireLabel: string;
  targetWireLabel?: string;
  parameters?: unknown;
  generatorExpression?: string;
}

/**
 * Validates a gate placement against the current wires and builds the CircuitElement.
 *
 * Error strings are written as self-correcting prompts (they name the valid options),
 * because that is what lets a model repair its own mistake without a human in the loop.
 */
export function placeGate(
  input: PlaceGateInput,
  wires: Wire[],
  elements: CircuitElement[],
): { element: CircuitElement; error: null } | { element: null; error: string } {
  const gateId = canonicalGateId(input.gateId);
  const gate = GATES_BY_ID.get(gateId);
  if (!gate) {
    return { element: null, error: `Unknown gate id: "${input.gateId}". Valid IDs: ${[...GATES_BY_ID.keys()].join(', ')}` };
  }

  const wireIndex = wireLabelToIndex(wires, input.wireLabel);
  if (wireIndex === -1) {
    return { element: null, error: `Wire "${input.wireLabel}" not found. Current wires: ${availableWireLabels(wires)}` };
  }
  const wire = wires[wireIndex];

  const needsTwo = (gate.numQubits ?? 0) + (gate.numQumodes ?? 0) >= 2;
  let targetWireIndices: number[] | undefined;

  if (input.targetWireLabel) {
    const ti = wireLabelToIndex(wires, input.targetWireLabel);
    if (ti === -1) {
      return { element: null, error: `Target wire "${input.targetWireLabel}" not found. Current wires: ${availableWireLabels(wires)}` };
    }
    if (ti === wireIndex) {
      return { element: null, error: `Gate "${gateId}" needs two distinct wires, but both are "${input.wireLabel}".` };
    }
    targetWireIndices = [ti];
  } else if (needsTwo) {
    return { element: null, error: `Gate "${gateId}" acts on two wires — supply targetWireLabel (format: ${gateId} <primary>><target>).` };
  }

  // Lane-type compatibility. Hybrid gates take the qubit as primary and the qumode as target.
  if (gate.category === 'hybrid' || (gate.numQubits && gate.numQumodes)) {
    if (wire.type !== 'qubit') {
      return { element: null, error: `Gate "${gateId}" needs the qubit first: "${input.wireLabel}" is a qumode. Write "${gateId} <qubit>><qumode>".` };
    }
    if (targetWireIndices && wires[targetWireIndices[0]].type !== 'qumode') {
      return { element: null, error: `Gate "${gateId}" needs a qumode as its target, but "${input.targetWireLabel}" is a qubit.` };
    }
  } else if (gate.category === 'qubit') {
    if (wire.type !== 'qubit') {
      return { element: null, error: `Gate "${gateId}" requires a qubit wire, but "${input.wireLabel}" is a qumode.` };
    }
    if (targetWireIndices && wires[targetWireIndices[0]].type !== 'qubit') {
      return { element: null, error: `Gate "${gateId}" requires both wires to be qubits, but "${input.targetWireLabel}" is a qumode.` };
    }
  } else if (gate.category === 'qumode') {
    if (wire.type !== 'qumode') {
      return { element: null, error: `Gate "${gateId}" requires a qumode wire, but "${input.wireLabel}" is a qubit.` };
    }
    if (targetWireIndices && wires[targetWireIndices[0]].type !== 'qumode') {
      return { element: null, error: `Gate "${gateId}" requires both wires to be qumodes, but "${input.targetWireLabel}" is a qubit.` };
    }
  }

  const { values, error } = resolveParameters(gate, input.parameters);
  if (error) return { element: null, error };

  return {
    element: {
      id: `element-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      gateId,
      position: { x: nextGateX(elements), y: 0 },
      wireIndex,
      targetWireIndices,
      parameterValues: values,
      ...(input.generatorExpression ? { generatorExpression: input.generatorExpression } : {}),
    },
    error: null,
  };
}

// ─── Encoding ─────────────────────────────────────────────────────────────────

/** Gates in execution order (left to right), which is what `#N` indexes. */
export function orderedElements(elements: CircuitElement[]): CircuitElement[] {
  return [...elements].sort((a, b) => a.position.x - b.position.x);
}

/** Resolves a `#N` / `N` reference to an element id. Returns null when out of range. */
export function resolveElementRef(ref: string, elements: CircuitElement[]): string | null {
  const ordered = orderedElements(elements);
  const s = String(ref ?? '').trim();

  const m = s.match(/^#?(\d+)$/);
  if (m) {
    const n = parseInt(m[1], 10);
    if (n >= 1 && n <= ordered.length) return ordered[n - 1].id;
    return null;
  }
  // Tolerate a raw element id, in case the model echoes one back.
  return ordered.some(e => e.id === s) ? s : null;
}

export function encodeWires(wires: Wire[]): string {
  if (wires.length === 0) return 'W (none)';
  const parts = wires.map((w, i) => {
    const label = wireLabel(wires, i);
    const init = w.initialState;
    const isDefault = init === undefined || init === '0' || init === 0;
    return isDefault ? label : `${label}=${init}`;
  });
  return `W ${parts.join(' ')}`;
}

export function encodeGates(wires: Wire[], elements: CircuitElement[]): string {
  const ordered = orderedElements(elements);
  if (ordered.length === 0) return 'G (none)';
  const parts = ordered.map((el, i) => {
    const gate = GATES_BY_ID.get(el.gateId);
    const primary = wireLabel(wires, el.wireIndex);
    const target = el.targetWireIndices?.length ? `>${wireLabel(wires, el.targetWireIndices[0])}` : '';
    const params = gate ? encodeParameters(gate, el.parameterValues) : '';
    const gen = el.generatorExpression ? ` {${el.generatorExpression}}` : '';
    return `#${i + 1} ${el.gateId} ${primary}${target}${params ? ` ${params}` : ''}${gen}`;
  });
  return `G ${parts.join('; ')}`;
}

/** Full circuit in HQC notation — the string sent to the model as the canvas snapshot. */
export function encodeCircuit(wires: Wire[], elements: CircuitElement[]): string {
  if (wires.length === 0) return 'empty (no wires)';
  return `${encodeWires(wires)}\n${encodeGates(wires, elements)}`;
}

/**
 * Compact gate catalogue for the system prompt: id, parameter names, and lane signature.
 * `!py` marks gates the bosonic-qiskit backend cannot run, so the model can warn the user
 * instead of building something that fails at simulation time.
 */
export function encodeGateReference(): string {
  return ALL_GATES.map(g => {
    const params = g.parameters?.map(p => p.name).join(',');
    const nq = g.numQubits ?? 0;
    const nm = g.numQumodes ?? 0;
    let sig = '';
    if (nq && nm) sig = ' [qubit>qumode]';
    else if (nq >= 2) sig = ' [qubit>qubit]';
    else if (nm >= 2) sig = ' [qumode>qumode]';
    else if (nm === 1) sig = ' [qumode]';
    else sig = ' [qubit]';
    const py = PYTHON_BACKEND_GATES.has(g.id) ? '' : ' !py';
    return `${g.id}${params ? `(${params})` : ''}${sig}${py}`;
  }).join('\n');
}

/**
 * Gate ids the Python (bosonic-qiskit) backend accepts — mirrors SUPPORTED_*_GATES in
 * backend/simulation/bosonic.py. Everything else is browser-backend only.
 */
export const PYTHON_BACKEND_GATES = new Set([
  'h', 'x', 'y', 'z', 's', 'sdg', 't', 'rx', 'ry', 'rz', 'cnot',
  'displace', 'squeeze', 'rotate', 'bs', 'kerr',
  'cdisp', 'cr',
  'measure',
]);

/** Gate ids present in `elements` that the Python backend would reject. */
export function unsupportedOnPythonBackend(elements: CircuitElement[]): string[] {
  const bad = new Set<string>();
  for (const el of elements) {
    if (!PYTHON_BACKEND_GATES.has(el.gateId)) bad.add(el.gateId);
  }
  return [...bad];
}

// ─── Decoding ─────────────────────────────────────────────────────────────────

const QUBIT_INITIAL_STATES: QubitInitialState[] = ['0', '1', '+', '-', 'i', '-i'];

/**
 * Parses a wire spec: `"q0 q1 m0"`, or with initial states `"q0=+ m0=2"`.
 * Labels only declare intent — actual ordering follows the order written.
 */
export function decodeWires(spec: string): { wires: Wire[]; errors: string[] } {
  const errors: string[] = [];
  const wires: Wire[] = [];
  const tokens = String(spec ?? '')
    .replace(/^W\s+/i, '')
    .split(/[\s,;]+/)
    .map(t => t.trim())
    .filter(t => t !== '' && t !== '(none)');

  let qubitCount = 0;
  let qumodeCount = 0;

  for (const token of tokens) {
    const eq = token.indexOf('=');
    const label = (eq === -1 ? token : token.slice(0, eq)).toLowerCase();
    const initRaw = eq === -1 ? undefined : token.slice(eq + 1);

    const m = label.match(/^([qm])(\d+)$/);
    if (!m) {
      errors.push(`Bad wire label "${token}". Use q0, q1, … for qubits and m0, m1, … for qumodes.`);
      continue;
    }
    const type = m[1] === 'q' ? 'qubit' : 'qumode';

    let initialState: QubitInitialState | QumodeInitialState | undefined;
    if (initRaw !== undefined) {
      if (type === 'qubit') {
        const norm = initRaw.replace(/[|⟩>]/g, '');
        if (!QUBIT_INITIAL_STATES.includes(norm as QubitInitialState)) {
          errors.push(`Bad qubit initial state "${initRaw}" on ${label}. Valid: ${QUBIT_INITIAL_STATES.join(', ')}`);
        } else {
          initialState = norm as QubitInitialState;
        }
      } else {
        const n = parseInt(initRaw.replace(/[|⟩>]/g, ''), 10);
        if (isNaN(n) || n < 0 || n > 5) {
          errors.push(`Bad qumode initial Fock state "${initRaw}" on ${label}. Valid: 0-5`);
        } else {
          initialState = n as QumodeInitialState;
        }
      }
    }

    const index = type === 'qubit' ? qubitCount++ : qumodeCount++;
    wires.push({
      id: `${type}-${Date.now()}-${wires.length}`,
      type,
      index,
      ...(initialState !== undefined ? { initialState } : {}),
    });
  }

  return { wires, errors };
}

/**
 * Parses a gate spec: `"h q0; cnot q0>q1; displace m0 1,0"`.
 * Leading `#N` markers are accepted and ignored — ordering comes from the sequence itself.
 */
export function decodeGates(
  spec: string,
  wires: Wire[],
  startingElements: CircuitElement[] = [],
): { elements: CircuitElement[]; errors: string[] } {
  const errors: string[] = [];
  const elements = [...startingElements];
  const added: CircuitElement[] = [];

  const statements = String(spec ?? '')
    .replace(/^G\s+/i, '')
    .split(/[;\n]+/)
    .map(s => s.trim())
    .filter(s => s !== '' && s !== '(none)');

  for (const raw of statements) {
    const stmt = raw.replace(/^#\d+\s*/, '').trim();
    if (stmt === '') continue;

    // Optional trailing generator expression in braces, for custom gates.
    let generatorExpression: string | undefined;
    const genMatch = stmt.match(/\{([^}]*)\}\s*$/);
    const body = genMatch ? stmt.slice(0, genMatch.index).trim() : stmt;
    if (genMatch) generatorExpression = genMatch[1].trim();

    const parts = body.split(/\s+/);
    if (parts.length < 2) {
      errors.push(`Cannot parse "${raw}". Expected: <gateId> <wire>[><target>] [params]`);
      continue;
    }

    const gateId = parts[0];
    const wireSpec = parts[1];
    const paramSpec = parts.slice(2).join(' ').trim();

    const arrowSplit = wireSpec.split(/[>→]/).map(s => s.trim()).filter(s => s !== '');
    const primaryLabel = arrowSplit[0];
    const targetLabel = arrowSplit[1];

    const result = placeGate(
      { gateId, wireLabel: primaryLabel, targetWireLabel: targetLabel, parameters: paramSpec || undefined, generatorExpression },
      wires,
      elements,
    );
    if (result.element === null) {
      errors.push(`"${raw}": ${result.error}`);
      continue;
    }
    elements.push(result.element);
    added.push(result.element);
  }

  return { elements: added, errors };
}

/** Parses a full `W …\nG …` document. */
export function decodeCircuit(src: string): { wires: Wire[]; elements: CircuitElement[]; errors: string[] } {
  const text = String(src ?? '');
  const wireLine = text.match(/^\s*W\s+(.*)$/im)?.[1] ?? '';
  const gateLine = text.match(/^\s*G\s+([\s\S]*)$/im)?.[1] ?? '';

  const { wires, errors: wireErrors } = decodeWires(wireLine);
  const { elements, errors: gateErrors } = decodeGates(gateLine, wires);
  return { wires, elements, errors: [...wireErrors, ...gateErrors] };
}
