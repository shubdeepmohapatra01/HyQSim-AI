/**
 * `npm run ai:replay` — offline correctness tests for the AI layer.
 *
 * These make no API calls. They feed the tool calls a model would make through the same
 * validation and decoding path the chat panel uses, and assert the circuit that comes out.
 * That covers the parts we control: notation, validation, intent routing, and the error
 * messages the model has to self-correct from.
 */

import { describe, it, expect } from 'vitest';
import type { Wire, CircuitElement } from '../../types/circuit';
import { parseToolCall, MUTATING_TOOLS } from '../tools';
import { decodeCircuit, encodeCircuit, parseNumber, resolveElementRef, canonicalGateId } from '../hqc';
import { classifyIntent, shouldForceTools, shouldAutoRunSimulation } from '../intent';
import { buildBenchmark, listBenchmarks } from '../benchmarks';
import { checkCircuit, withSanityNotes } from '../sanity';
import { EVAL_CASES, BUILD_CASES, READONLY_CASES } from './cases';

/** Applies a mutation the way ChatPanel does, returning the new circuit. */
function apply(
  wires: Wire[], elements: CircuitElement[],
  name: string, input: Record<string, unknown>,
): { wires: Wire[]; elements: CircuitElement[]; error: string | null } {
  const r = parseToolCall(name, input, wires, elements);
  if (r.mutation === null) return { wires, elements, error: r.error };
  const m = r.mutation;

  switch (m.type) {
    case 'build_circuit':
      return { wires: m.wires, elements: m.elements, error: null };
    case 'add_gate':
      return { wires, elements: [...elements, m.element], error: null };
    case 'remove_gate':
      return { wires, elements: elements.filter(e => e.id !== m.elementId), error: null };
    case 'add_wire': {
      const wt = m.wireType;
      const index = wires.filter(w => w.type === wt).length;
      return { wires: [...wires, { id: `${wt}-${index}`, type: wt, index }], elements, error: null };
    }
    case 'clear_circuit':
      return { wires: [], elements: [], error: null };
    default:
      return { wires, elements, error: null };
  }
}

function structure(wires: Wire[], elements: CircuitElement[]) {
  const gates: Record<string, number> = {};
  for (const e of elements) gates[e.gateId] = (gates[e.gateId] ?? 0) + 1;
  return {
    qubits: wires.filter(w => w.type === 'qubit').length,
    qumodes: wires.filter(w => w.type === 'qumode').length,
    gates,
  };
}

function toSpecs(hqc: string): { wires: string; gates: string } {
  const w = hqc.match(/^\s*W\s+(.*)$/im)![1].trim();
  const g = (hqc.match(/^\s*G\s+([\s\S]*)$/im)?.[1] ?? '').trim();
  return { wires: w, gates: g === '(none)' ? '' : g };
}

describe('parseNumber', () => {
  it('reads plain decimals', () => {
    expect(parseNumber('1.5')).toBeCloseTo(1.5);
    expect(parseNumber('-0.25')).toBeCloseTo(-0.25);
    expect(parseNumber('0')).toBe(0);
  });

  it('reads the pi forms models actually emit', () => {
    expect(parseNumber('pi')).toBeCloseTo(Math.PI);
    expect(parseNumber('pi/2')).toBeCloseTo(Math.PI / 2);
    expect(parseNumber('3pi/4')).toBeCloseTo((3 * Math.PI) / 4);
    expect(parseNumber('-pi/4')).toBeCloseTo(-Math.PI / 4);
    expect(parseNumber('2*pi')).toBeCloseTo(2 * Math.PI);
    expect(parseNumber('π/2')).toBeCloseTo(Math.PI / 2);
  });

  it('rejects nonsense rather than silently returning 0', () => {
    expect(parseNumber('abc')).toBeNull();
    expect(parseNumber('')).toBeNull();
    expect(parseNumber('pi/0')).toBeNull();
  });
});

describe('gate aliases', () => {
  it('maps the names models reach for onto canonical ids', () => {
    expect(canonicalGateId('cx')).toBe('cnot');
    expect(canonicalGateId('hadamard')).toBe('h');
    expect(canonicalGateId('beam_splitter')).toBe('bs');
    expect(canonicalGateId('displacement')).toBe('displace');
    expect(canonicalGateId('conditional_displacement')).toBe('cdisp');
  });

  it('leaves canonical ids alone', () => {
    expect(canonicalGateId('h')).toBe('h');
    expect(canonicalGateId('cdisp')).toBe('cdisp');
  });
});

describe('HQC round-trip', () => {
  it('re-encodes to what it decoded', () => {
    for (const c of EVAL_CASES) {
      const src = c.reference ?? c.setup;
      if (!src) continue;
      const { wires, elements, errors } = decodeCircuit(src);
      expect(errors, `${c.id}: ${errors.join('; ')}`).toEqual([]);

      const encoded = encodeCircuit(wires, elements);
      const second = decodeCircuit(encoded);
      expect(second.errors, `${c.id} re-decode: ${second.errors.join('; ')}`).toEqual([]);
      expect(encodeCircuit(second.wires, second.elements)).toBe(encoded);
    }
  });

  it('preserves non-default initial states', () => {
    const { wires, elements } = decodeCircuit('W q0=+ m0=2\nG (none)');
    expect(wires[0].initialState).toBe('+');
    expect(wires[1].initialState).toBe(2);
    expect(encodeCircuit(wires, elements)).toContain('q0=+ m0=2');
  });

  it('omits parameters that are at their defaults', () => {
    const { wires, elements } = decodeCircuit('W m0\nG rotate m0');
    expect(encodeCircuit(wires, elements)).toBe('W m0\nG #1 rotate m0');
  });

  it('keeps parameters that are not', () => {
    const { wires, elements } = decodeCircuit('W m0\nG rotate m0 pi/2');
    expect(encodeCircuit(wires, elements)).toContain('rotate m0 1.5708');
  });
});

describe('build_circuit', () => {
  it.each(BUILD_CASES.filter(c => c.reference && !c.setup))('builds $id', (c) => {
    const { wires, elements, error } = apply([], [], 'build_circuit', toSpecs(c.reference!));
    expect(error).toBeNull();

    const s = structure(wires, elements);
    expect(s.qubits).toBe(c.expect!.qubits);
    expect(s.qumodes).toBe(c.expect!.qumodes);
    for (const [gateId, n] of Object.entries(c.expect!.gates)) {
      expect(s.gates[gateId] ?? 0, `${c.id} expected ${n}x ${gateId}`).toBe(n);
    }

    if (c.expect!.sequence) {
      const ordered = [...elements].sort((a, b) => a.position.x - b.position.x).map(e => e.gateId);
      expect(ordered).toEqual(c.expect!.sequence);
    }
  });

  it('places gates in left-to-right execution order', () => {
    const { elements } = apply([], [], 'build_circuit', {
      wires: 'q0 q1', gates: 'h q0; cnot q0>q1; x q1',
    });
    const xs = elements.map(e => e.position.x);
    expect(xs).toEqual([...xs].sort((a, b) => a - b));
    expect(new Set(xs).size).toBe(3);
  });

  it('gives every gate a distinct id even when built in one batch', () => {
    const { elements } = apply([], [], 'build_circuit', {
      wires: 'q0 q1 q2 q3', gates: 'h q0; cnot q0>q1; cnot q1>q2; cnot q2>q3',
    });
    expect(new Set(elements.map(e => e.id)).size).toBe(elements.length);
  });

  it('extends instead of replacing when replace is false', () => {
    const first = apply([], [], 'build_circuit', { wires: 'q0', gates: 'h q0' });
    const second = apply(first.wires, first.elements, 'build_circuit', {
      wires: 'm0', gates: 'displace m0 1,0', replace: false,
    });
    expect(structure(second.wires, second.elements)).toMatchObject({ qubits: 1, qumodes: 1 });
    expect(second.elements).toHaveLength(2);
  });
});

describe('incremental edits', () => {
  it('adds a gate without disturbing the rest', () => {
    const base = decodeCircuit('W q0 q1 q2 q3\nG h q0; cnot q0>q1; cnot q1>q2; cnot q2>q3');
    const r = apply(base.wires, base.elements, 'add_gate', { gateId: 'h', wireLabel: 'q2' });
    expect(r.error).toBeNull();
    expect(structure(r.wires, r.elements).gates).toEqual({ h: 2, cnot: 3 });
  });

  it('removes a gate by its canvas number', () => {
    const base = decodeCircuit('W q0 q1 q2 q3\nG h q0; cnot q0>q1; cnot q1>q2; cnot q2>q3');
    const r = apply(base.wires, base.elements, 'remove_gate', { ref: '#4' });
    expect(r.error).toBeNull();
    expect(structure(r.wires, r.elements).gates).toEqual({ h: 1, cnot: 2 });
  });

  it('accepts a bare number as a gate reference', () => {
    const base = decodeCircuit('W q0\nG h q0; x q0');
    expect(resolveElementRef('2', base.elements)).toBe(base.elements[1].id);
    expect(resolveElementRef('#2', base.elements)).toBe(base.elements[1].id);
  });

  it('rejects an out-of-range gate reference with a usable message', () => {
    const base = decodeCircuit('W q0\nG h q0');
    const r = apply(base.wires, base.elements, 'remove_gate', { ref: '#7' });
    expect(r.error).toContain('#1');
    expect(r.elements).toHaveLength(1);
  });
});

describe('validation errors name the valid options', () => {
  it('unknown gate id lists the real ones', () => {
    const r = apply(...Object.values(decodeCircuit('W q0\nG (none)')).slice(0, 2) as [Wire[], CircuitElement[]],
      'add_gate', { gateId: 'flurb', wireLabel: 'q0' });
    expect(r.error).toContain('flurb');
    expect(r.error).toContain('cnot');
  });

  it('missing wire lists the wires that exist', () => {
    const base = decodeCircuit('W q0 m0\nG (none)');
    const r = apply(base.wires, base.elements, 'add_gate', { gateId: 'h', wireLabel: 'q9' });
    expect(r.error).toContain('q9');
    expect(r.error).toContain('q0, m0');
  });

  it('rejects a qubit gate on a qumode lane', () => {
    const base = decodeCircuit('W q0 m0\nG (none)');
    const r = apply(base.wires, base.elements, 'add_gate', { gateId: 'h', wireLabel: 'm0' });
    expect(r.error).toContain('qubit');
  });

  it('rejects a hybrid gate with the qumode first, and says which way round', () => {
    const { errors } = decodeCircuit('W q0 m0\nG cdisp m0>q0 2,0');
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('qubit');
  });

  it('rejects a two-wire gate given only one wire', () => {
    const { errors } = decodeCircuit('W q0 q1\nG cnot q0');
    expect(errors[0]).toContain('two wires');
  });

  it('rejects a gate whose two wires are the same', () => {
    const { errors } = decodeCircuit('W q0 q1\nG cnot q0>q0');
    expect(errors[0]).toContain('distinct');
  });

  it('rejects an unknown parameter name', () => {
    const base = decodeCircuit('W m0\nG (none)');
    const r = apply(base.wires, base.elements, 'add_gate', {
      gateId: 'squeeze', wireLabel: 'm0', parameters: { nonsense: 1 },
    });
    expect(r.error).toContain('nonsense');
    expect(r.error).toContain('r');
  });

  it('reports every bad statement, not just the first', () => {
    const { errors } = decodeCircuit('W q0\nG flurb q0; h q9; x q0');
    expect(errors).toHaveLength(2);
  });
});

describe('intent classification', () => {
  it.each(EVAL_CASES)('classifies $id as $intent', (c) => {
    expect(classifyIntent(c.prompt)).toBe(c.intent);
  });

  it('only forces a tool call for build requests', () => {
    for (const c of BUILD_CASES) expect(shouldForceTools(classifyIntent(c.prompt))).toBe(true);
    for (const c of READONLY_CASES) expect(shouldForceTools(classifyIntent(c.prompt))).toBe(false);
  });

  it('treats a mutation request as build even when it also asks about results', () => {
    expect(classifyIntent('Add a squeeze gate and tell me the photon number')).toBe('build');
  });

  it('falls back to explain on unrecognised phrasing, never to build', () => {
    expect(classifyIntent('hmm')).toBe('explain');
    expect(classifyIntent('the circuit')).toBe('explain');
  });
});

describe('simulation trigger policy', () => {
  it('auto-runs for a results question with no fresh result', () => {
    expect(shouldAutoRunSimulation('analyze', false, true)).toBe(true);
  });

  it('does not re-run when a fresh result already exists', () => {
    expect(shouldAutoRunSimulation('analyze', true, true)).toBe(false);
  });

  it('never runs for explain or build', () => {
    expect(shouldAutoRunSimulation('explain', false, true)).toBe(false);
    expect(shouldAutoRunSimulation('build', false, true)).toBe(false);
  });

  it('does not run on an empty canvas', () => {
    expect(shouldAutoRunSimulation('analyze', false, false)).toBe(false);
  });
});

describe('read-only intents cannot mutate the canvas', () => {
  it.each(READONLY_CASES)('$id is guarded', (c) => {
    const intent = classifyIntent(c.prompt);
    expect(intent).not.toBe('build');
    // ChatPanel refuses any mutating tool when the intent is not build. Assert the tool
    // set that guard covers is the complete set of mutating tools.
    expect([...MUTATING_TOOLS].sort()).toEqual(
      ['add_gate', 'add_wire', 'build_circuit', 'clear_circuit', 'load_benchmark', 'remove_gate'],
    );
  });
});

describe('shared/ fixtures are current', () => {
  // hqc.ts and hqc.py both exist, and backend/tests/test_hqc.py checks the Python side
  // against these files. If the generated files go stale, the Python tests keep passing
  // against an old catalogue while the app moves on — so the staleness must fail here.
  it('gates.json matches the live gate catalogue', async () => {
    const { readFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    const { buildGateSpec, SHARED_DIR } = await import('./gatespec');
    const onDisk = JSON.parse(readFileSync(join(SHARED_DIR, 'gates.json'), 'utf8'));
    expect(onDisk, 'run `npm run ai:gatespec` to regenerate').toEqual(buildGateSpec());
  });

  it('hqc_cases.json matches what the encoder currently produces', async () => {
    const { readFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    const { buildGoldenCases, SHARED_DIR } = await import('./gatespec');
    const onDisk = JSON.parse(readFileSync(join(SHARED_DIR, 'hqc_cases.json'), 'utf8'));
    expect(onDisk, 'run `npm run ai:gatespec` to regenerate').toEqual(buildGoldenCases());
  });
});

describe('verified benchmarks', () => {
  it('load_benchmark returns the repo circuit, not an improvisation', () => {
    const r = parseToolCall('load_benchmark', { benchmarkId: 'cat-state' }, [], []);
    expect(r.error).toBeNull();
    expect(r.mutation?.type).toBe('load_benchmark');
    if (r.mutation?.type !== 'load_benchmark') throw new Error('wrong mutation');

    const counts: Record<string, number> = {};
    for (const e of r.mutation.elements) counts[e.gateId] = (counts[e.gateId] ?? 0) + 1;
    // The verified construction: H → CD → H → S† → H → CD → H → S
    expect(counts).toEqual({ h: 4, cdisp: 2, sdg: 1, s: 1 });
    expect(r.mutation.fockTruncation).toBe(32);
  });

  it('honours alpha, scaling the CD gates as CD(alpha/sqrt2)', () => {
    const r = parseToolCall('load_benchmark', { benchmarkId: 'cat-state', parameters: { alpha: 2 } }, [], []);
    if (r.mutation?.type !== 'load_benchmark') throw new Error('wrong mutation');
    const cds = r.mutation.elements
      .filter(e => e.gateId === 'cdisp')
      .sort((a, b) => a.position.x - b.position.x);
    expect(cds[0].parameterValues!.alpha_re).toBeCloseTo(2 / Math.SQRT2, 4);
    expect(cds[1].parameterValues!.alpha_im).toBeCloseTo(Math.PI / (8 * 2 * Math.SQRT2), 4);
  });

  it('leaves the qumode in vacuum — alpha is never an initial state', () => {
    const r = parseToolCall('load_benchmark', { benchmarkId: 'cat-state', parameters: { alpha: 2 } }, [], []);
    if (r.mutation?.type !== 'load_benchmark') throw new Error('wrong mutation');
    for (const w of r.mutation.wires) {
      if (w.type === 'qumode') expect(w.initialState ?? 0).toBe(0);
    }
  });

  it('names the valid benchmarks when given an unknown one', () => {
    const r = parseToolCall('load_benchmark', { benchmarkId: 'schrodinger' }, [], []);
    expect(r.error).toContain('cat-state');
  });

  it('rejects an unknown benchmark parameter', () => {
    const r = parseToolCall('load_benchmark', { benchmarkId: 'cat-state', parameters: { beta: 1 } }, [], []);
    expect(r.error).toContain('beta');
    expect(r.error).toContain('alpha');
  });

  it('every benchmark builds and re-encodes cleanly', () => {
    for (const b of listBenchmarks()) {
      const built = buildBenchmark(b.id);
      expect(built.error, `${b.id}: ${built.error}`).toBeNull();
      const { wires, elements } = built.circuit!;
      const round = decodeCircuit(encodeCircuit(wires, elements));
      expect(round.errors, `${b.id}: ${round.errors.join('; ')}`).toEqual([]);
    }
  });
});

describe('sanity checks', () => {
  it('flags an aborted cat state (H + CD with no closing interferometer)', () => {
    const { wires, elements } = decodeCircuit('W q0 m0\nG h q0; cdisp q0>m0 2,0');
    const warnings = checkCircuit(wires, elements);
    expect(warnings).toHaveLength(1);
    expect(warnings[0].message).toContain('load_benchmark');
    expect(warnings[0].message).toContain('cat-state');
  });

  it('does not flag the verified cat state', () => {
    const built = buildBenchmark('cat-state');
    expect(checkCircuit(built.circuit!.wires, built.circuit!.elements)).toEqual([]);
  });

  it('flags a qumode initialised to a non-zero Fock state', () => {
    const { wires, elements } = decodeCircuit('W q0 m0=2\nG h q0');
    const warnings = checkCircuit(wires, elements, 'build a cat state with alpha = 2');
    expect(warnings.some(w => w.message.includes('gate parameter'))).toBe(true);
  });

  it('stays quiet when the user actually asked for a Fock state', () => {
    const { wires, elements } = decodeCircuit('W q0 m0=2\nG h q0');
    for (const prompt of [
      'put the qumode in Fock state 2',
      'initialise the mode to |2>',
      'start the qumode in number state 2',
    ]) {
      expect(checkCircuit(wires, elements, prompt), prompt).toEqual([]);
    }
  });

  it('warns conservatively when no prompt context is available', () => {
    const { wires, elements } = decodeCircuit('W q0 m0=2\nG h q0');
    expect(checkCircuit(wires, elements).length).toBe(1);
  });

  it('does not flag a qumode in vacuum', () => {
    const { wires, elements } = decodeCircuit('W m0\nG displace m0 2,0');
    expect(checkCircuit(wires, elements)).toEqual([]);
  });

  it('flags qubits left untouched in a multi-qubit circuit', () => {
    const { wires, elements } = decodeCircuit('W q0 q1 q2 q3\nG h q0; cnot q0>q1');
    const warnings = checkCircuit(wires, elements);
    expect(warnings.some(w => w.message.includes('q2, q3'))).toBe(true);
  });

  it('does not flag a complete GHZ chain', () => {
    const { wires, elements } = decodeCircuit(
      'W q0 q1 q2 q3\nG h q0; cnot q0>q1; cnot q1>q2; cnot q2>q3',
    );
    expect(checkCircuit(wires, elements)).toEqual([]);
  });

  it('appends notes so the model sees them in the tool result', () => {
    const { wires, elements } = decodeCircuit('W q0 m0\nG h q0; cdisp q0>m0 2,0');
    const out = withSanityNotes('Built: ...', checkCircuit(wires, elements));
    expect(out).toContain('CHECK:');
    expect(withSanityNotes('Built: ...', [])).toBe('Built: ...');
  });
});

describe('eval references match the verified circuits', () => {
  // This is the check that was missing. The cat-state reference used to assert a 2-gate
  // circuit, so the suite happily passed the aborted preparation the model produced.
  it.each(EVAL_CASES.filter(c => c.expectBenchmark))(
    '$id matches benchmark $expectBenchmark',
    (c) => {
      const built = buildBenchmark(c.expectBenchmark!, c.expectBenchmarkParams);
      expect(built.error).toBeNull();

      const actual: Record<string, number> = {};
      for (const e of built.circuit!.elements) actual[e.gateId] = (actual[e.gateId] ?? 0) + 1;
      expect(actual, `${c.id}: expectation disagrees with circuits.ts`).toEqual(c.expect!.gates);

      expect(built.circuit!.wires.filter(w => w.type === 'qubit')).toHaveLength(c.expect!.qubits);
      expect(built.circuit!.wires.filter(w => w.type === 'qumode')).toHaveLength(c.expect!.qumodes);

      // Gate counts alone are not enough: the first version of this test passed while the
      // reference carried the wrong CD amplitudes. Compare the full encoding.
      const { wires, elements, errors } = decodeCircuit(c.reference!);
      expect(errors, `${c.id}: ${errors.join('; ')}`).toEqual([]);
      expect(
        encodeCircuit(wires, elements),
        `${c.id}: reference disagrees with circuits.ts — regenerate it from the benchmark`,
      ).toBe(encodeCircuit(built.circuit!.wires, built.circuit!.elements));
    },
  );

  it.each(EVAL_CASES.filter(c => c.expectVacuumQumodes))('$id expects vacuum qumodes', (c) => {
    const { wires, errors } = decodeCircuit(c.reference!);
    expect(errors).toEqual([]);
    for (const w of wires) {
      if (w.type === 'qumode') expect(w.initialState ?? 0).toBe(0);
    }
  });
});

describe('empty-circuit guard', () => {
  // Observed with Gemini 3.6 Flash: build_circuit called with gates:"" produced "W q0 q1"
  // — a plausible-looking canvas that prepares nothing.
  it('flags wires with no gates', () => {
    const { wires, elements } = decodeCircuit('W q0 q1\nG (none)');
    const warnings = checkCircuit(wires, elements);
    expect(warnings).toHaveLength(1);
    expect(warnings[0].message).toContain('NO gates');
    expect(warnings[0].message).toContain('h q0; cnot q0>q1');
  });

  it('does not flag a bare wire set that sets initial states', () => {
    const { wires, elements } = decodeCircuit('W q0=+ m0=2\nG (none)');
    const prompt = 'Create a circuit with one qubit in |+> and a qumode in Fock state 2';
    expect(checkCircuit(wires, elements, prompt)).toEqual([]);
  });

  it('does not flag an entirely empty canvas', () => {
    expect(checkCircuit([], [])).toEqual([]);
  });

  it('does not flag a circuit that has gates', () => {
    const { wires, elements } = decodeCircuit('W q0 q1\nG h q0; cnot q0>q1');
    expect(checkCircuit(wires, elements)).toEqual([]);
  });
});
