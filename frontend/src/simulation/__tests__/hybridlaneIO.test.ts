// HybridLane (PennyLane) import/export coverage for the hybrid gate set,
// including the gates added for Jaqal support (xCD, yCD, JC, AJC).
import { describe, it, expect } from 'vitest';
import { parseHybridLane, generateHybridLane } from '../hybridlaneIO';
import type { CircuitElement, Wire } from '../../types/circuit';

describe('parseHybridLane hybrid gates', () => {
  const r = parseHybridLane(`
qml.Hadamard(wires=0)
hqml.ConditionalDisplacement(1.0, 0.0, wires=[0, "m0"])
hqml.ConditionalXDisplacement(0.5, 0.0, wires=[0, "m0"])
hqml.ConditionalYDisplacement(0.5, 0.0, wires=[0, "m0"])
hqml.JaynesCummings(0.3, 0.2, wires=[0, "m0"])
hqml.AntiJaynesCummings(0.4, 0.1, wires=[0, "m0"])
`);

  it('imports every conditional displacement and sideband gate', () => {
    expect(r.success).toBe(true);
    expect(r.elements.map(e => e.gateId)).toEqual(['h', 'cdisp', 'xcdisp', 'ycdisp', 'jc', 'ajc']);
  });

  it('converts displacement parameters from polar to cartesian', () => {
    expect(r.elements.find(e => e.gateId === 'xcdisp')!.parameterValues).toEqual({ alpha_re: 0.5, alpha_im: 0 });
  });

  it('keeps JC/AJC parameters as (theta, phi)', () => {
    expect(r.elements.find(e => e.gateId === 'jc')!.parameterValues).toEqual({ theta: 0.3, phi: 0.2 });
    expect(r.elements.find(e => e.gateId === 'ajc')!.parameterValues).toEqual({ theta: 0.4, phi: 0.1 });
  });
});

describe('generateHybridLane hybrid gates', () => {
  const wires: Wire[] = [
    { id: 'q0', type: 'qubit', index: 0, initialState: '0' },
    { id: 'm0', type: 'qumode', index: 1, initialState: 0 },
  ];
  const el = (gateId: string, params: Record<string, number>, x: number): CircuitElement =>
    ({ id: `e-${gateId}`, gateId, wireIndex: 0, targetWireIndices: [1], position: { x, y: 0 }, parameterValues: params });

  it('emits the hybridlane names for xCD, yCD, JC and AJC', () => {
    const { code, success } = generateHybridLane(wires, [
      el('xcdisp', { alpha_re: 0.5, alpha_im: 0 }, 100),
      el('ycdisp', { alpha_re: 0.5, alpha_im: 0 }, 200),
      el('jc', { theta: 0.3, phi: 0.2 }, 300),
      el('ajc', { theta: 0.4, phi: 0.1 }, 400),
    ]);
    expect(success).toBe(true);
    expect(code).toContain('hqml.ConditionalXDisplacement(');
    expect(code).toContain('hqml.ConditionalYDisplacement(');
    expect(code).toContain('hqml.JaynesCummings(0.3, 0.2, wires=[0, "m0"])');
    expect(code).toContain('hqml.AntiJaynesCummings(0.4, 0.1, wires=[0, "m0"])');
  });

  it('round-trips a hybrid circuit through generate → parse', () => {
    const original = [
      el('xcdisp', { alpha_re: 0.5, alpha_im: 0 }, 100),
      el('ajc', { theta: 0.4, phi: 0.1 }, 200),
    ];
    const { code } = generateHybridLane(wires, original);
    const back = parseHybridLane(code);
    expect(back.success).toBe(true);
    // The generator ends the circuit with a qml.expval(PauliZ) return, which the
    // parser reads back as a measure gate — ignore it for the gate comparison.
    const gates = back.elements.filter(e => e.gateId !== 'measure');
    expect(gates.map(e => e.gateId)).toEqual(['xcdisp', 'ajc']);
    expect(gates[0].parameterValues).toEqual({ alpha_re: 0.5, alpha_im: 0 });
    expect(gates[1].parameterValues).toEqual({ theta: 0.4, phi: 0.1 });
  });
});
