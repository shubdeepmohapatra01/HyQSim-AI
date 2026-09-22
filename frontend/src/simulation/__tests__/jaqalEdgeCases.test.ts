/**
 * Edge cases for the Jaqal importer/exporter that the hand-written happy-path
 * tests in jaqalIO.test.ts do not reach. Everything here is self-contained —
 * unlike jaqalCorpus.test.ts these run without the hybridlane-benchmarking repo.
 *
 * Most of these are regressions found by running the importer over the real
 * corpus; the comment on each block says what actually went wrong.
 */
import { describe, it, expect } from 'vitest';
import type { CircuitElement, Wire } from '../../types/circuit';
import { parseJaqal, generateJaqal } from '../jaqalIO';
import { simulate } from './helpers';

const HEADER = 'from Calibration_PulseDefinitions.QubitBosonPulses usepulses *';

/** Assemble a program from body lines, with the standard header and register. */
function program(body: string[], { qubits = 3 } = {}): string {
  return [HEADER, '', `register q[${qubits}]`, '', 'subcircuit {', ...body.map(l => `    ${l}`), '}'].join('\n');
}

function expectOk(code: string) {
  const result = parseJaqal(code);
  expect(result.success, result.error).toBe(true);
  return result;
}

function expectRejected(code: string, pattern: RegExp) {
  const result = parseJaqal(code);
  expect(result.success, 'expected this program to be rejected').toBe(false);
  expect(result.error).toMatch(pattern);
  return result;
}

// ---------------------------------------------------------------------------
// Whitespace and encoding
// ---------------------------------------------------------------------------

describe('line endings and encoding', () => {
  const body = ['Rz q[2] 4.0297', 'xCD q[2] 1 2 0.98841 0.27302 // trailing comment', 'AJC q[1] 1 2 0.0 0.02'];

  // "\r" is a line terminator that `.` does not match, so /\/\/.*$/ silently
  // failed to strip anything on a CRLF file and every comment line arrived as a
  // statement — "unrecognised statement //". 42 of the 159 corpus files are CRLF.
  it('imports CRLF exactly like LF', () => {
    const lf = program(body);
    const crlf = lf.replace(/\n/g, '\r\n');

    const a = expectOk(lf);
    const b = expectOk(crlf);
    expect(b.elements.map(e => [e.gateId, e.wireIndex, e.parameterValues]))
      .toEqual(a.elements.map(e => [e.gateId, e.wireIndex, e.parameterValues]));
  });

  it('imports lone-CR line endings', () => {
    expect(expectOk(program(body).replace(/\n/g, '\r')).elements).toHaveLength(3);
  });

  it('ignores a UTF-8 BOM', () => {
    expect(expectOk('﻿' + program(body)).elements).toHaveLength(3);
  });

  it('accepts tabs, mixed indentation and blank lines', () => {
    const code = [HEADER, '', 'register q[3]', '', 'subcircuit {', '\tRz q[2] 1.0', '', '        Px q[2]', '}'].join('\n');
    expect(expectOk(code).elements).toHaveLength(2);
  });

  it('strips block comments without losing the line numbering', () => {
    const code = program(['/* disabled\n       for now */', 'Px q[2]', 'Sxx q[0]']);
    expectRejected(code, /Line 9/);
  });
});

// ---------------------------------------------------------------------------
// Registers
// ---------------------------------------------------------------------------

describe('register declarations', () => {
  // Wire indices are register offsets, so a second register used to alias onto
  // the first: q[1] and r[1] both became wire 1, silently merging two qubits.
  it('refuses a second register instead of aliasing wires', () => {
    const code = [HEADER, 'register q[2]', 'register r[3]', 'subcircuit {', '    Px q[1]', '    Px r[1]', '}'].join('\n');
    expectRejected(code, /second qubit register/);
  });

  it('refuses a register declared twice', () => {
    const code = [HEADER, 'register q[2]', 'register q[2]', 'subcircuit {', '    Px q[0]', '}'].join('\n');
    expectRejected(code, /declared twice/);
  });

  it('refuses an empty register', () => {
    expectRejected([HEADER, 'register q[0]', 'subcircuit {', '}'].join('\n'), /empty|at least one qubit/);
  });

  it('refuses a qubit index past the end of the register', () => {
    expectRejected(program(['Px q[7]']), /outside the declared register/);
  });

  it('refuses a gate on an undeclared register', () => {
    expectRejected(program(['Px r[0]']), /never declared/);
  });

  it('refuses a program with no register at all', () => {
    expectRejected([HEADER, 'subcircuit {', '    Px q[0]', '}'].join('\n'), /never declared|No qubit register/);
  });
});

// ---------------------------------------------------------------------------
// Mode addressing
// ---------------------------------------------------------------------------

describe('qumode addressing', () => {
  it('gives each distinct (manifold, mode) pair its own wire', () => {
    const r = expectOk(program([
      'zCD q[0] 0 2 0.5 0.0',
      'zCD q[0] 1 2 0.5 0.0',
      'zCD q[0] 1 3 0.5 0.0',
      'zCD q[0] 0 2 0.7 0.0',   // repeat of the first — must reuse its wire
    ]));
    const modes = r.wires.filter(w => w.type === 'qumode').map(w => w.jaqalMode);
    expect(modes).toEqual([{ manifold: 0, index: 2 }, { manifold: 1, index: 2 }, { manifold: 1, index: 3 }]);
    expect(new Set(r.elements.map(e => e.targetWireIndices?.[0])).size).toBe(3);
  });

  // A manifold or mode is a hardware address; a negative one used to sail
  // through and round-trip back out as a nonsense Jaqal program.
  it('refuses a negative manifold or mode', () => {
    expectRejected(program(['zCD q[0] -1 2 0.5 0.0']), /manifold must be zero or positive/);
    expectRejected(program(['zCD q[0] 1 -2 0.5 0.0']), /mode must be zero or positive/);
  });

  it('refuses a non-integer manifold or mode', () => {
    expectRejected(program(['zCD q[0] 1.5 2 0.5 0.0']), /expected an integer/);
  });

  it('refuses the wrong argument count on a hybrid gate', () => {
    expectRejected(program(['zCD q[0] 1 2 0.5']), /takes 5 arguments/);
    expectRejected(program(['xCD q[0] 1 2 0.5 0.0 0.0']), /takes 5 arguments/);
  });
});

// ---------------------------------------------------------------------------
// Subcircuits, constants and legacy spellings
// ---------------------------------------------------------------------------

describe('subcircuit blocks', () => {
  // A repeat count is a shot count, not circuit structure — 35 corpus files
  // were rejected outright over it. It is now imported with a warning.
  it('imports a subcircuit repeat count as a warning, not an error', () => {
    const code = [HEADER, 'register q[1]', 'subcircuit 1024 {', '    Px q[0]', '}'].join('\n');
    const r = expectOk(code);
    expect(r.elements).toHaveLength(1);
    expect(r.warnings?.join(' ')).toMatch(/repeat count 1024/);
  });

  it('resolves a let constant used as the repeat count', () => {
    const code = [HEADER, 'register q[1]', 'let shots 500', 'subcircuit shots {', '    Px q[0]', '}'].join('\n');
    expect(expectOk(code).warnings?.join(' ')).toMatch(/repeat count 500/);
  });

  it('refuses a repeat count that is not a count', () => {
    const code = [HEADER, 'register q[1]', 'subcircuit oops {', '    Px q[0]', '}'].join('\n');
    expectRejected(code, /expected a subcircuit repeat count/);
  });

  it('refuses an unclosed block', () => {
    expectRejected([HEADER, 'register q[1]', 'subcircuit {', '    Px q[0]'].join('\n'), /Unclosed/);
  });

  it('refuses an unmatched closing brace', () => {
    expectRejected([HEADER, 'register q[1]', 'Px q[0]', '}'].join('\n'), /unmatched/);
  });
});

describe('let constants', () => {
  it('substitutes constants into gate parameters', () => {
    const code = [HEADER, 'register q[1]', 'let angle 1.5708', 'subcircuit {', '    Rz q[0] angle', '}'].join('\n');
    expect(expectOk(code).elements[0].parameterValues?.theta).toBeCloseTo(1.5708, 9);
  });

  it('refuses a gate parameter that names no constant', () => {
    expectRejected(program(['Rz q[0] nope']), /expected a number/);
  });

  it('refuses a non-finite parameter', () => {
    expectRejected(program(['Rz q[0] Infinity']), /expected a number/);
  });
});

describe('legacy qscout.v1.std sidebands', () => {
  // "Blue q[1] 1 0.0 0.02 1 2" is the same gate as "AJC q[1] 1 2 0.0 0.02";
  // only the argument order differs. Verified against paired legacy/modern
  // files in the corpus that encode the same circuit.
  it('imports Blue as AJC and Red as JC, reordering the arguments', () => {
    const legacy = expectOk(program(['Blue q[1] 1 0.0 0.02 1 2', 'Red q[0] 1 0.3 0.04 0 2']));
    const modern = expectOk(program(['AJC q[1] 1 2 0.0 0.02', 'JC q[0] 0 2 0.3 0.04']));

    expect(legacy.elements.map(e => [e.gateId, e.wireIndex, e.parameterValues]))
      .toEqual(modern.elements.map(e => [e.gateId, e.wireIndex, e.parameterValues]));
    expect(legacy.wires.map(w => w.jaqalMode)).toEqual(modern.wires.map(w => w.jaqalMode));
    expect(legacy.warnings?.join(' ')).toMatch(/legacy "Blue" was imported as AJC/);
  });

  it('refuses a higher-order sideband rather than approximating it', () => {
    expectRejected(program(['Blue q[0] 2 0.0 0.02 1 2']), /sideband order 2/);
  });

  it('refuses the modern argument count on the legacy spelling', () => {
    expectRejected(program(['Blue q[0] 1 2 0.0 0.02']), /takes 6 arguments/);
  });
});

// ---------------------------------------------------------------------------
// Statements that must fail loudly
// ---------------------------------------------------------------------------

describe('unrepresentable programs are refused, never silently truncated', () => {
  const cases: [string, string, RegExp][] = [
    ['loop', [HEADER, 'register q[1]', 'loop 4 {', '    Px q[0]', '}'].join('\n'), /"loop" blocks are not supported/],
    ['macro', [HEADER, 'register q[1]', 'macro foo a { Px a }'].join('\n'), /"macro" definitions are not supported/],
    ['map', [HEADER, 'register q[2]', 'map a q[0]'].join('\n'), /"map" aliases are not supported/],
    ['parallel block', program(['<', 'Px q[0]', '>']), /parallel blocks/],
    ['idle pulse', program(['I_Px q[0]']), /idle-padding pulse/],
    ['MS gate', program(['MS q[0] q[1] 0 1']), /Mølmer-Sørensen/],
    ['Sx gate', program(['Sx q[0]']), /square-root-of-X/],
    ['arbitrary rotation', program(['R q[0] 0.1 0.2']), /arbitrary-axis rotation/],
    ['unknown gate', program(['Frobnicate q[0]']), /unrecognised statement "Frobnicate"/],
    ['mid-circuit reset', [HEADER, 'register q[1]', 'Px q[0]', 'prepare_all'].join('\n'), /"prepare_all" after a gate/],
  ];

  for (const [name, code, pattern] of cases) {
    it(`refuses ${name}`, () => expectRejected(code, pattern));
  }

  it('reports the line number of the offending statement', () => {
    const r = expectRejected(program(["Px q[0]", "Px q[0]", "Sx q[0]"]), /Line 8/);
    expect(r.elements).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// FockStatePrep
// ---------------------------------------------------------------------------

describe('FockStatePrep', () => {
  it('sets the qumode initial state', () => {
    const r = expectOk(program(['FockStatePrep q[0] 1 2 3', 'zCD q[0] 1 2 0.5 0.0']));
    expect(r.wires.find(w => w.type === 'qumode')?.initialState).toBe(3);
  });

  it('refuses a Fock state HyQSim cannot prepare', () => {
    expectRejected(program(['FockStatePrep q[0] 1 2 9']), /outside the range/);
  });

  it('refuses preparing the same mode twice', () => {
    expectRejected(program(['FockStatePrep q[0] 1 2 1', 'FockStatePrep q[0] 1 2 2']), /prepared twice/);
  });

  it('refuses preparing a mode that has already been acted on', () => {
    expectRejected(program(['zCD q[0] 1 2 0.5 0.0', 'FockStatePrep q[0] 1 2 1']), /comes after a gate/);
  });
});

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

describe('export', () => {
  const qubit = (index: number): Wire => ({ id: `q${index}`, type: 'qubit', index, initialState: '0' });
  const gate = (gateId: string, wireIndex: number, x: number, extra: Partial<CircuitElement> = {}): CircuitElement =>
    ({ id: `${gateId}-${x}`, gateId, wireIndex, position: { x, y: 0 }, ...extra });

  // Two wires exporting to the same (manifold, mode) would be merged back into
  // a single qumode on re-import — a silent change of physics.
  it('refuses to export two qumode wires that claim the same address', () => {
    const wires: Wire[] = [
      qubit(0),
      { id: 'm0', type: 'qumode', index: 1, initialState: 0, jaqalMode: { manifold: 1, index: 1 } },
      { id: 'm1', type: 'qumode', index: 2, initialState: 0, jaqalMode: { manifold: 1, index: 1 } },
    ];
    const out = generateJaqal(wires, [gate('cdisp', 0, 0, { targetWireIndices: [1], parameterValues: { alpha_re: 0.5, alpha_im: 0 } })]);
    expect(out.success).toBe(false);
    expect(out.error).toMatch(/both claim the Jaqal address/);
  });

  // A canvas-built qumode has no jaqalMode, so it is assigned one — and that
  // assignment must dodge the addresses already taken by imported wires.
  it('assigns a free address to a qumode wire that has none', () => {
    const wires: Wire[] = [
      qubit(0),
      { id: 'm0', type: 'qumode', index: 1, initialState: 0, jaqalMode: { manifold: 1, index: 0 } },
      { id: 'm1', type: 'qumode', index: 2, initialState: 0 },
    ];
    const elements = [
      gate('cdisp', 0, 0, { targetWireIndices: [1], parameterValues: { alpha_re: 0.5, alpha_im: 0 } }),
      gate('cdisp', 0, 100, { targetWireIndices: [2], parameterValues: { alpha_re: 0.7, alpha_im: 0 } }),
    ];
    const out = generateJaqal(wires, elements);
    expect(out.success, out.error).toBe(true);

    const addresses = [...out.code.matchAll(/zCD q\[0\] (\d+) (\d+)/g)].map(m => `${m[1]}:${m[2]}`);
    expect(new Set(addresses).size).toBe(2);

    const back = parseJaqal(out.code);
    expect(back.wires.filter(w => w.type === 'qumode')).toHaveLength(2);
  });

  // Jaqal has no exponent syntax, so String() switching to "1e+21" produced a
  // program no Jaqal parser would read back.
  it('never writes exponent notation', () => {
    const out = generateJaqal([qubit(0)], [gate('rz', 0, 0, { parameterValues: { theta: 1.23e-7 } })]);
    expect(out.success, out.error).toBe(true);
    expect(out.code).not.toMatch(/e[+-]\d/i);
  });

  it('refuses a parameter too large to write as a plain decimal', () => {
    const out = generateJaqal([qubit(0)], [gate('rz', 0, 0, { parameterValues: { theta: 1e21 } })]);
    expect(out.success).toBe(false);
    expect(out.error).toMatch(/too large/);
  });

  it('refuses a non-finite parameter', () => {
    const out = generateJaqal([qubit(0)], [gate('rz', 0, 0, { parameterValues: { theta: NaN } })]);
    expect(out.success).toBe(false);
  });

  it('names every unexportable gate at once instead of failing on the first', () => {
    const wires: Wire[] = [qubit(0), { id: 'm0', type: 'qumode', index: 1, initialState: 0 }];
    const out = generateJaqal(wires, [
      gate('squeeze', 1, 0, { parameterValues: { r: 0.5, phi: 0 } }),
      gate('kerr', 1, 100, { parameterValues: { kappa: 0.1 } }),
    ]);
    expect(out.success).toBe(false);
    expect(out.error).toMatch(/kerr/);
    expect(out.error).toMatch(/squeeze/);
  });
});

// ---------------------------------------------------------------------------
// Round trip
// ---------------------------------------------------------------------------

describe('round trip', () => {
  const source = program([
    'Rz q[2] 4.0297',
    'Ry q[2] 2.4589',
    'xCD q[2] 1 2 0.98841 0.27302',
    'yCD q[2] 1 2 -0.35932 0.034818',
    'zCD q[1] 0 2 0.27375 -0.4841',
    'AJC q[1] 1 2 0.0 0.02',
    'JC q[0] 0 2 0.1 0.5',
    'measure_all',
  ]);

  it('reaches a fixed point after one export', () => {
    const first = generateJaqal(expectOk(source).wires, expectOk(source).elements);
    expect(first.success, first.error).toBe(true);

    const second = generateJaqal(expectOk(first.code).wires, expectOk(first.code).elements);
    expect(second.code).toBe(first.code);
  });

  it('preserves gate order, parameters and mode addresses', () => {
    const before = expectOk(source);
    const after = expectOk(generateJaqal(before.wires, before.elements).code);

    expect(after.elements.map(e => e.gateId)).toEqual(before.elements.map(e => e.gateId));
    expect(after.elements.map(e => e.parameterValues)).toEqual(before.elements.map(e => e.parameterValues));
    expect(after.wires.filter(w => w.type === 'qumode').map(w => w.jaqalMode))
      .toEqual(before.wires.filter(w => w.type === 'qumode').map(w => w.jaqalMode));
  });

  // The two circuits must not merely look alike — they must simulate alike.
  it('simulates to the same state after a round trip', () => {
    const before = expectOk(source);
    const after = expectOk(generateJaqal(before.wires, before.elements).code);

    const a = simulate(before.wires, before.elements, 8, { shots: 1 });
    const b = simulate(after.wires, after.elements, 8, { shots: 1 });

    for (const [wire, stateA] of a.qumodeStates) {
      const stateB = b.qumodeStates.get(wire);
      expect(stateB, `qumode wire ${wire} missing after round trip`).toBeDefined();
      expect(stateB!.meanPhotonNumber).toBeCloseTo(stateA.meanPhotonNumber, 9);
    }
    for (const [wire, stateA] of a.qubitStates) {
      const stateB = b.qubitStates.get(wire)!;
      expect(stateB.blochVector.x).toBeCloseTo(stateA.blochVector.x, 9);
      expect(stateB.blochVector.y).toBeCloseTo(stateA.blochVector.y, 9);
      expect(stateB.blochVector.z).toBeCloseTo(stateA.blochVector.z, 9);
    }
  });

  it('survives the legacy dialect too', () => {
    const legacy = expectOk(program(['Blue q[1] 1 0.0 0.02 1 2', 'Red q[0] 1 0.3 0.04 0 2']));
    const out = generateJaqal(legacy.wires, legacy.elements);
    expect(out.success, out.error).toBe(true);
    // Legacy in, modern out — the exporter only speaks the current dialect.
    expect(out.code).toMatch(/AJC q\[1\] 1 2/);
    expect(out.code).toMatch(/JC q\[0\] 0 2/);
    expect(out.code).not.toMatch(/Blue|Red/);
  });
});
