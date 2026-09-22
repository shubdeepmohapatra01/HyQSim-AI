// Jaqal import/export, exercised with the real QSCOUT program shape emitted by
// hybridlane's sandia_qscout device.
import { describe, it, expect } from 'vitest';
import { parseJaqal, generateJaqal, JAQAL_PULSE_MODULE } from '../jaqalIO';
import { ALL_GATES } from '../../types/circuit';
import { GATES_MAP, simulate } from './helpers';
import { runSimulation } from '../simulator';

const SAMPLE = `from ${JAQAL_PULSE_MODULE} usepulses *

register q[3]

subcircuit {
    Rz q[2] 4.0297
    Ry q[2] 2.4589
    Rz q[2] 1.5708
    xCD q[2] 1 2 0.98841 0.27302
    Rz q[2] 0.66168
    Ry q[2] 0.55818
    Rz q[2] 10.086
    xCD q[2] 1 2 -0.35932 0.034818
    Rz q[2] 6.2832
    Ry q[2] 1.5708
    AJC q[1] 1 2 0.0 0.02
    AJC q[0] 0 2 0.0 0.02
}`;

describe('parseJaqal', () => {
  const result = parseJaqal(SAMPLE);

  it('imports the sample program', () => {
    expect(result.error).toBeUndefined();
    expect(result.success).toBe(true);
  });

  it('creates one wire per register qubit plus one per (manifold, mode) pair', () => {
    expect(result.wires.filter(w => w.type === 'qubit')).toHaveLength(3);
    const qumodes = result.wires.filter(w => w.type === 'qumode');
    expect(qumodes).toHaveLength(2);
    // (1,2) appears first (xCD), then (0,2) from the last AJC
    expect(qumodes.map(w => w.jaqalMode)).toEqual([
      { manifold: 1, index: 2 },
      { manifold: 0, index: 2 },
    ]);
  });

  it('maps every statement to a gate', () => {
    const ids = result.elements.map(e => e.gateId);
    expect(ids.filter(id => id === 'rz')).toHaveLength(5);
    expect(ids.filter(id => id === 'ry')).toHaveLength(3);
    expect(ids.filter(id => id === 'xcdisp')).toHaveLength(2);
    expect(ids.filter(id => id === 'ajc')).toHaveLength(2);
    expect(result.elements).toHaveLength(12);
  });

  it('reads xCD arguments as (qubit, manifold, mode, Re α, Im α)', () => {
    const xcd = result.elements.filter(e => e.gateId === 'xcdisp');
    expect(xcd[0].wireIndex).toBe(2);                       // q[2]
    expect(xcd[0].targetWireIndices).toEqual([3]);          // first qumode wire
    expect(xcd[0].parameterValues).toEqual({ alpha_re: 0.98841, alpha_im: 0.27302 });
    expect(xcd[1].parameterValues).toEqual({ alpha_re: -0.35932, alpha_im: 0.034818 });
  });

  it('reads AJC arguments as (qubit, manifold, mode, phase, angle)', () => {
    const ajc = result.elements.filter(e => e.gateId === 'ajc');
    expect(ajc[0].wireIndex).toBe(1);
    expect(ajc[0].targetWireIndices).toEqual([3]);          // (1,2) again
    expect(ajc[0].parameterValues).toEqual({ phi: 0, theta: 0.02 });
    expect(ajc[1].wireIndex).toBe(0);
    expect(ajc[1].targetWireIndices).toEqual([4]);          // (0,2) is a new mode
  });

  it('orders gates left to right in the order they appear', () => {
    const xs = result.elements.map(e => e.position.x);
    expect([...xs].sort((a, b) => a - b)).toEqual(xs);
  });

  it('produces a circuit the simulator can run', () => {
    const sim = runSimulation(result.wires, result.elements, GATES_MAP, 8, [], 256, []);
    expect(sim.qubitStates.size).toBe(3);
    expect(sim.qumodeStates.size).toBe(2);
    for (const [, m] of sim.qumodeStates) {
      expect(m.fockProbabilities.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 6);
    }
  });
});

describe('parseJaqal accepts the rest of the supported gate set', () => {
  it('handles all single-qubit gates, JC, zCD/yCD, let constants and comments', () => {
    const r = parseJaqal(`// a comment
      register q[2]
      let angle 0.5
      subcircuit {
          Px q[0]
          Py q[0]
          Pz q[0]   /* block comment */
          Sz q[1]
          Szd q[1]
          Rx q[0] angle
          zCD q[0] 1 0 0.5 0.0
          yCD q[1] 1 0 0.5 0.0
          JC q[0] 1 0 0.25 0.75
          measure_all
      }`);
    expect(r.error).toBeUndefined();
    const ids = r.elements.map(e => e.gateId);
    expect(ids).toEqual(['x', 'y', 'z', 's', 'sdg', 'rx', 'cdisp', 'ycdisp', 'jc', 'measure', 'measure']);
    expect(r.elements.find(e => e.gateId === 'rx')!.parameterValues).toEqual({ theta: 0.5 });
    expect(r.elements.find(e => e.gateId === 'jc')!.parameterValues).toEqual({ phi: 0.25, theta: 0.75 });
  });

  it('turns FockStatePrep into a qumode initial state', () => {
    const r = parseJaqal(`register q[1]
      subcircuit {
          FockStatePrep q[0] 1 0 3
          zCD q[0] 1 0 0.5 0.0
      }`);
    expect(r.error).toBeUndefined();
    expect(r.wires.find(w => w.type === 'qumode')!.initialState).toBe(3);
  });

  it('accepts semicolon-separated statements and braces on the same line', () => {
    const r = parseJaqal('register q[1]\nsubcircuit { Px q[0]; Py q[0] }');
    expect(r.error).toBeUndefined();
    expect(r.elements.map(e => e.gateId)).toEqual(['x', 'y']);
  });
});

describe('parseJaqal fails loudly on anything it cannot represent', () => {
  const cases: [string, string, RegExp][] = [
    ['native beamsplitter', 'register q[1]\nsubcircuit { Beamsplitter q[0] 1.0 2.0 3.0 4.0 }', /Beamsplitter/],
    ['sideband probe', 'register q[1]\nsubcircuit { Rt_SBProbe q[0] 0.0 1.0 1 2 1 0.0 }', /Rt_SBProbe/],
    ['RampUp', 'register q[1]\nsubcircuit { RampUp q[0] 0.5 }', /RampUp/],
    ['arbitrary-axis R', 'register q[1]\nsubcircuit { R q[0] 0.5 0.5 }', /Rx\/Ry\/Rz/],
    ['Mølmer-Sørensen', 'register q[2]\nsubcircuit { XX q[0] q[1] 1.57 }', /XX/],
    ['loop blocks', 'register q[1]\nloop 4 { Px q[0] }', /loop/i],
    ['macros', 'register q[1]\nmacro foo a { Px a }', /macro/i],
    ['non-numeric subcircuit repeat count', 'register q[1]\nsubcircuit oops { Px q[0] }', /repeat count/],
    ['missing register', 'subcircuit { Px q[0] }', /register/],
    ['out-of-range qubit', 'register q[1]\nsubcircuit { Px q[4] }', /outside the declared register/],
    ['unknown statement', 'register q[1]\nsubcircuit { Frobnicate q[0] }', /unrecognised/],
    ['wrong argument count', 'register q[1]\nsubcircuit { xCD q[0] 1 0 0.5 }', /takes 5 arguments/],
    ['non-numeric parameter', 'register q[1]\nsubcircuit { Rz q[0] banana }', /expected a number/],
    ['unclosed block', 'register q[1]\nsubcircuit { Px q[0]', /Unclosed/],
    ['Fock prep out of range', 'register q[1]\nsubcircuit { FockStatePrep q[0] 1 0 9 }', /outside the range/],
    ['mid-circuit reset', 'register q[1]\nsubcircuit { Px q[0]\nprepare_all }', /prepare_all/],
  ];

  it.each(cases)('rejects %s', (_label, code, pattern) => {
    const r = parseJaqal(code);
    expect(r.success).toBe(false);
    expect(r.error).toMatch(pattern);
  });

  // A numeric repeat count is a shot count, not circuit structure, so it is
  // imported with a warning rather than refused. See jaqalEdgeCases.test.ts.
  it('accepts a numeric subcircuit repeat count with a warning', () => {
    const r = parseJaqal('register q[1]\nsubcircuit 8 { Px q[0] }');
    expect(r.success).toBe(true);
    expect(r.elements.map(e => e.gateId)).toEqual(['x']);
    expect(r.warnings?.join(' ')).toMatch(/repeat count 8/);
  });

  it('reports the offending line number', () => {
    const r = parseJaqal('register q[1]\nsubcircuit {\n    Px q[0]\n    Sx q[0]\n}');
    expect(r.error).toMatch(/^Line 4:/);
  });
});

describe('generateJaqal', () => {
  it('round-trips the sample program back to equivalent Jaqal', () => {
    const imported = parseJaqal(SAMPLE);
    const exported = generateJaqal(imported.wires, imported.elements);
    expect(exported.error).toBeUndefined();

    const gateLines = (src: string) =>
      src.split('\n').map(l => l.trim())
        .filter(l => l && !l.startsWith('from') && !l.startsWith('register') && !l.startsWith('subcircuit') && l !== '}');

    // Same gates, same wires, same numbers as the original program
    expect(gateLines(exported.code)).toEqual(gateLines(SAMPLE));
  });

  it('re-imports its own output to the same circuit', () => {
    const first = parseJaqal(SAMPLE);
    const second = parseJaqal(generateJaqal(first.wires, first.elements).code);
    expect(second.error).toBeUndefined();
    expect(second.elements.map(e => ({ id: e.gateId, w: e.wireIndex, t: e.targetWireIndices, p: e.parameterValues })))
      .toEqual(first.elements.map(e => ({ id: e.gateId, w: e.wireIndex, t: e.targetWireIndices, p: e.parameterValues })));
    expect(second.wires.map(w => w.jaqalMode)).toEqual(first.wires.map(w => w.jaqalMode));
  });

  it('emits the pulse module header, register and subcircuit block', () => {
    const { code } = generateJaqal(
      [{ id: 'q0', type: 'qubit', index: 0, initialState: '0' }],
      [{ id: 'e', gateId: 'x', wireIndex: 0, position: { x: 0, y: 0 } }],
    );
    expect(code.split('\n')[0]).toBe(`from ${JAQAL_PULSE_MODULE} usepulses *`);
    expect(code).toContain('register q[1]');
    expect(code).toContain('subcircuit {');
    expect(code.trimEnd().endsWith('}')).toBe(true);
  });

  it('prepares non-default initial states with native rotations', () => {
    const prep = (initialState: string) => generateJaqal(
      [{ id: 'q0', type: 'qubit', index: 0, initialState: initialState as never }],
      [{ id: 'e', gateId: 'x', wireIndex: 0, position: { x: 100, y: 0 } }],
    ).code.split('\n').map(l => l.trim());

    expect(prep('1')).toContain('Px q[0]');
    expect(prep('+')).toContain('Ry q[0] 1.570796');
    expect(prep('-')).toContain('Ry q[0] -1.570796');
    expect(prep('i')).toContain('Rx q[0] -1.570796');
    expect(prep('-i')).toContain('Rx q[0] 1.570796');
  });

  it('decomposes H and T into native rotations', () => {
    const { code } = generateJaqal(
      [{ id: 'q0', type: 'qubit', index: 0, initialState: '0' }],
      [
        { id: 'e1', gateId: 'h', wireIndex: 0, position: { x: 100, y: 0 } },
        { id: 'e2', gateId: 't', wireIndex: 0, position: { x: 200, y: 0 } },
      ],
    );
    const lines = code.split('\n').map(l => l.trim());
    expect(lines).toContain('Pz q[0]');
    expect(lines).toContain('Ry q[0] 1.570796');
    expect(lines).toContain('Rz q[0] 0.785398');
  });

  it('emits measure_all when the circuit has measurements', () => {
    const { code } = generateJaqal(
      [{ id: 'q0', type: 'qubit', index: 0, initialState: '0' }],
      [{ id: 'e', gateId: 'measure', wireIndex: 0, position: { x: 100, y: 0 } }],
    );
    expect(code).toContain('measure_all');
  });

  it('refuses to export gates the ion trap has no native pulse for', () => {
    for (const gateId of ['cnot', 'displace', 'squeeze', 'rotate', 'kerr', 'bs', 'cr', 'custom_cv']) {
      const r = generateJaqal(
        [
          { id: 'q0', type: 'qubit', index: 0, initialState: '0' },
          { id: 'm0', type: 'qumode', index: 1, initialState: 0 },
        ],
        [{ id: 'e', gateId, wireIndex: gateId === 'cnot' ? 0 : 1, position: { x: 100, y: 0 }, targetWireIndices: [1] }],
      );
      expect(r.success, `${gateId} should not export`).toBe(false);
      expect(r.error).toContain(gateId);
    }
  });

  it('refuses to export a circuit with no qubits', () => {
    const r = generateJaqal([{ id: 'm0', type: 'qumode', index: 0, initialState: 0 }], []);
    expect(r.success).toBe(false);
    expect(r.error).toMatch(/at least one qubit/);
  });
});

describe('Jaqal gate coverage', () => {
  it('every Jaqal-native HyQSim gate is in the palette', () => {
    const ids = new Set(ALL_GATES.map(g => g.id));
    for (const id of ['rx', 'ry', 'rz', 'x', 'y', 'z', 's', 'sdg', 'h', 't',
                      'cdisp', 'xcdisp', 'ycdisp', 'jc', 'ajc', 'measure']) {
      expect(ids.has(id), `${id} missing from ALL_GATES`).toBe(true);
    }
  });

  it('an imported AJC actually excites the qubit when simulated', () => {
    const r = parseJaqal(`register q[1]\nsubcircuit { AJC q[0] 1 0 0.0 1.5707963 }`);
    expect(r.error).toBeUndefined();
    const sim = simulate(r.wires, r.elements, 12);
    expect(sim.qubitStates.get(0)!.blochVector.z).toBeCloseTo(-1, 8);
    expect(sim.qumodeStates.get(1)!.meanPhotonNumber).toBeCloseTo(1, 8);
  });
});
