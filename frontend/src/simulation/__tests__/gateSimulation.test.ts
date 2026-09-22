// End-to-end tests: every gate is placed on a real circuit and run through
// runSimulation(), then checked against the physics it is supposed to produce.
import { describe, it, expect } from 'vitest';
import { ALL_GATES } from '../../types/circuit';
import type { CircuitElement, Wire } from '../../types/circuit';
import { GATES_MAP, gateEl, qubitWire, qumodeWire, simulate, fockNorm } from './helpers';
import { runSimulation } from '../simulator';

const FOCK = 20;

// ---------------------------------------------------------------------------
// Coverage sweep — every gate in the palette must run
// ---------------------------------------------------------------------------

/**
 * Minimal valid placement for each gate id. This is the sweep that catches
 * "gate throws the moment you drop it on the canvas" bugs — e.g. the missing
 * `sub` import that made xCD/yCD fail with "Simulation error" while zCD worked.
 */
const PLACEMENTS: Record<string, { wires: Wire[]; el: CircuitElement }> = {};
function placeQubit(id: string, params?: Record<string, number>) {
  PLACEMENTS[id] = { wires: [qubitWire(0), qubitWire(1)], el: gateEl(id, 0, { params }) };
}
for (const id of ['h', 'x', 'y', 'z', 's', 'sdg', 't', 'measure']) placeQubit(id);
for (const id of ['rx', 'ry', 'rz']) placeQubit(id, { theta: 0.7 });
PLACEMENTS['cnot'] = { wires: [qubitWire(0, '+'), qubitWire(1)], el: gateEl('cnot', 0, { targets: [1] }) };
PLACEMENTS['displace'] = { wires: [qumodeWire(0)], el: gateEl('displace', 0, { params: { alpha_re: 0.8, alpha_im: 0.3 } }) };
PLACEMENTS['squeeze'] = { wires: [qumodeWire(0)], el: gateEl('squeeze', 0, { params: { r: 0.4, phi: 0.3 } }) };
PLACEMENTS['rotate'] = { wires: [qumodeWire(0, 1)], el: gateEl('rotate', 0, { params: { theta: 0.5 } }) };
PLACEMENTS['kerr'] = { wires: [qumodeWire(0, 1)], el: gateEl('kerr', 0, { params: { kappa: 0.2 } }) };
PLACEMENTS['bs'] = { wires: [qumodeWire(0, 1), qumodeWire(1)], el: gateEl('bs', 0, { targets: [1], params: { theta: Math.PI / 4, phi: 0 } }) };
for (const id of ['cdisp', 'xcdisp', 'ycdisp']) {
  PLACEMENTS[id] = {
    wires: [qubitWire(0), qumodeWire(1)],
    el: gateEl(id, 0, { targets: [1], params: { alpha_re: 1, alpha_im: 0 } }),
  };
}
PLACEMENTS['cr'] = { wires: [qubitWire(0, '+'), qumodeWire(1, 1)], el: gateEl('cr', 0, { targets: [1], params: { theta: 0.4 } }) };
PLACEMENTS['jc'] = { wires: [qubitWire(0), qumodeWire(1, 1)], el: gateEl('jc', 0, { targets: [1], params: { theta: 0.4, phi: 0.3 } }) };
PLACEMENTS['ajc'] = { wires: [qubitWire(0), qumodeWire(1, 0)], el: gateEl('ajc', 0, { targets: [1], params: { theta: 0.4, phi: 0.3 } }) };
PLACEMENTS['custom_cv'] = { wires: [qumodeWire(0, 1)], el: gateEl('custom_cv', 0, { params: { theta: 0.4 }, generatorExpression: 'n' }) };
PLACEMENTS['custom_cvdv'] = {
  wires: [qubitWire(0, '+'), qumodeWire(1, 1)],
  el: gateEl('custom_cvdv', 0, { targets: [1], params: { theta: 0.4 }, generatorExpression: 'z*n' }),
};

describe('every palette gate runs and produces a valid state', () => {
  it('has a placement defined for every gate in ALL_GATES', () => {
    const missing = ALL_GATES.map(g => g.id).filter(id => !(id in PLACEMENTS));
    expect(missing).toEqual([]);
  });

  it.each(ALL_GATES.map(g => [g.id, g.name]))('%s (%s)', (id) => {
    const { wires, el } = PLACEMENTS[id];
    const result = simulate(wires, [el], FOCK);

    for (const [, q] of result.qubitStates) {
      const { x, y, z } = q.blochVector;
      expect(Number.isFinite(x) && Number.isFinite(y) && Number.isFinite(z)).toBe(true);
      expect(Math.hypot(x, y, z)).toBeLessThanOrEqual(1 + 1e-6);
    }
    for (const [, m] of result.qumodeStates) {
      expect(m.fockProbabilities.every(Number.isFinite)).toBe(true);
      expect(fockNorm(m.fockProbabilities)).toBeCloseTo(1, 6);
      expect(m.meanPhotonNumber).toBeGreaterThanOrEqual(0);
    }
  });
});

// ---------------------------------------------------------------------------
// Qubit gates
// ---------------------------------------------------------------------------

describe('qubit gates in a circuit', () => {
  const bloch = (wires: Wire[], els: CircuitElement[]) =>
    simulate(wires, els, 4).qubitStates.get(0)!.blochVector;

  it('H|0⟩ = |+⟩', () => {
    const b = bloch([qubitWire(0)], [gateEl('h', 0)]);
    expect(b.x).toBeCloseTo(1, 9);
    expect(b.z).toBeCloseTo(0, 9);
  });

  it('X|0⟩ = |1⟩ and Y|0⟩ = i|1⟩', () => {
    expect(bloch([qubitWire(0)], [gateEl('x', 0)]).z).toBeCloseTo(-1, 9);
    expect(bloch([qubitWire(0)], [gateEl('y', 0)]).z).toBeCloseTo(-1, 9);
  });

  it('Z|+⟩ = |-⟩', () => {
    expect(bloch([qubitWire(0, '+')], [gateEl('z', 0)]).x).toBeCloseTo(-1, 9);
  });

  it('S|+⟩ = |+i⟩ and S†|+⟩ = |-i⟩ (⟨σy⟩ = ±1)', () => {
    expect(bloch([qubitWire(0, '+')], [gateEl('s', 0)]).y).toBeCloseTo(1, 9);
    expect(bloch([qubitWire(0, '+')], [gateEl('sdg', 0)]).y).toBeCloseTo(-1, 9);
  });

  it('T|+⟩ sits halfway between +x and +y', () => {
    const b = bloch([qubitWire(0, '+')], [gateEl('t', 0)]);
    expect(b.x).toBeCloseTo(Math.SQRT1_2, 9);
    expect(b.y).toBeCloseTo(Math.SQRT1_2, 9);
  });

  it('initial states |0⟩,|1⟩,|+⟩,|-⟩,|i⟩,|-i⟩ point along the right axes', () => {
    const expected: Record<string, [number, number, number]> = {
      '0': [0, 0, 1], '1': [0, 0, -1],
      '+': [1, 0, 0], '-': [-1, 0, 0],
      'i': [0, 1, 0], '-i': [0, -1, 0],
    };
    for (const [st, [x, y, z]] of Object.entries(expected)) {
      const b = bloch([qubitWire(0, st as never)], []);
      expect([b.x, b.y, b.z].map(v => Number(v.toFixed(9)))).toEqual([x, y, z]);
    }
  });

  it('Rx(π)|0⟩ = |1⟩, Ry(π/2)|0⟩ = |+⟩, Rz(π/2)|+⟩ = |+i⟩', () => {
    expect(bloch([qubitWire(0)], [gateEl('rx', 0, { params: { theta: Math.PI } })]).z).toBeCloseTo(-1, 9);
    expect(bloch([qubitWire(0)], [gateEl('ry', 0, { params: { theta: Math.PI / 2 } })]).x).toBeCloseTo(1, 9);
    expect(bloch([qubitWire(0, '+')], [gateEl('rz', 0, { params: { theta: Math.PI / 2 } })]).y).toBeCloseTo(1, 9);
  });

  it('CNOT on |+⟩|0⟩ makes a Bell state: both qubits maximally mixed, only 00/11 measured', () => {
    const wires = [qubitWire(0, '+'), qubitWire(1)];
    const els = [gateEl('cnot', 0, { x: 100, targets: [1] }), gateEl('measure', 0, { x: 200 }), gateEl('measure', 1, { x: 200 })];
    const r = simulate(wires, els, 4, { shots: 4096, measuredWireIndices: [0, 1] });
    for (const idx of [0, 1]) {
      const b = r.qubitStates.get(idx)!.blochVector;
      expect(Math.hypot(b.x, b.y, b.z)).toBeLessThan(1e-9);
    }
    const counts = r.bitstringCounts!;
    expect(Object.keys(counts).sort()).toEqual(['00', '11']);
    expect(counts['00'] / 4096).toBeGreaterThan(0.4);
  });

  it('samples an unbiased 50/50 histogram from a Bell state', () => {
    // Guards against a biased sampler: with 1024 shots a single run swings by a
    // few percent (that is shot noise, not a bug), so average many runs and
    // check the mean sits on 0.5 well inside the standard error.
    const wires = [qubitWire(0, '+'), qubitWire(1)];
    const els = [gateEl('cnot', 0, { x: 100, targets: [1] }), gateEl('measure', 0, { x: 200 }), gateEl('measure', 1, { x: 200 })];
    const trials = 200, shots = 1024;
    let sum = 0;
    for (let t = 0; t < trials; t++) {
      const r = simulate(wires, els, 4, { shots, measuredWireIndices: [0, 1] });
      sum += (r.bitstringCounts!['00'] ?? 0) / shots;
    }
    const mean = sum / trials;
    const sem = 0.5 / Math.sqrt(shots * trials);   // binomial standard error
    expect(Math.abs(mean - 0.5)).toBeLessThan(4 * sem);
  });

  it('samples the histogram from the post-selected state', () => {
    // Post-selecting one half of a Bell state must leave only the matching
    // outcome — the browser and Python backends agree on this.
    const wires = [qubitWire(0, '+'), qubitWire(1)];
    const els = [gateEl('cnot', 0, { x: 100, targets: [1] }), gateEl('measure', 0, { x: 200 }), gateEl('measure', 1, { x: 200 })];
    for (const outcome of [0, 1] as const) {
      const r = runSimulation(wires, els, GATES_MAP, 4, [{ wireIndex: 0, outcome }], 512, [0, 1]);
      expect(r.bitstringCounts).toEqual({ [`${outcome}${outcome}`]: 512 });
    }
  });

  it('measure alone does not disturb the state and samples 50/50 on |+⟩', () => {
    const r = simulate([qubitWire(0, '+')], [gateEl('measure', 0)], 4, { shots: 8192, measuredWireIndices: [0] });
    expect(r.qubitStates.get(0)!.blochVector.x).toBeCloseTo(1, 9);
    expect(r.bitstringCounts!['0'] / 8192).toBeCloseTo(0.5, 1);
  });
});

// ---------------------------------------------------------------------------
// Qumode gates
// ---------------------------------------------------------------------------

describe('qumode gates in a circuit', () => {
  it('D(α)|0⟩ is coherent: n̄ = |α|² and Poissonian statistics', () => {
    const alpha = { re: 1.1, im: -0.4 };
    const r = simulate([qumodeWire(0)], [gateEl('displace', 0, { params: { alpha_re: alpha.re, alpha_im: alpha.im } })], 32);
    const m = r.qumodeStates.get(0)!;
    const a2 = alpha.re ** 2 + alpha.im ** 2;
    expect(m.meanPhotonNumber).toBeCloseTo(a2, 6);
    let fact = 1;
    for (let n = 0; n < 6; n++) {
      if (n > 0) fact *= n;
      expect(m.fockProbabilities[n]).toBeCloseTo(Math.exp(-a2) * a2 ** n / fact, 6);
    }
  });

  it('D(α) then D(-α) returns to vacuum', () => {
    const r = simulate([qumodeWire(0)], [
      gateEl('displace', 0, { x: 100, params: { alpha_re: 1, alpha_im: 0.5 } }),
      gateEl('displace', 0, { x: 200, params: { alpha_re: -1, alpha_im: -0.5 } }),
    ], 32);
    expect(r.qumodeStates.get(0)!.fockProbabilities[0]).toBeCloseTo(1, 6);
  });

  it('S(r)|0⟩ is squeezed vacuum: n̄ = sinh²r, only even Fock states', () => {
    const rSq = 0.5;
    const r = simulate([qumodeWire(0)], [gateEl('squeeze', 0, { params: { r: rSq, phi: 0 } })], 40);
    const m = r.qumodeStates.get(0)!;
    expect(m.meanPhotonNumber).toBeCloseTo(Math.sinh(rSq) ** 2, 5);
    for (let n = 1; n < 10; n += 2) expect(m.fockProbabilities[n]).toBeLessThan(1e-12);
  });

  it('S(r) then S(-r) returns to vacuum (squeezing is invertible)', () => {
    const r = simulate([qumodeWire(0)], [
      gateEl('squeeze', 0, { x: 100, params: { r: 0.5, phi: 0.7 } }),
      gateEl('squeeze', 0, { x: 200, params: { r: -0.5, phi: 0.7 } }),
    ], 40);
    expect(r.qumodeStates.get(0)!.fockProbabilities[0]).toBeCloseTo(1, 6);
  });

  it('R(θ) and Kerr are photon-number preserving', () => {
    for (const el of [
      gateEl('rotate', 0, { params: { theta: 0.9 } }),
      gateEl('kerr', 0, { params: { kappa: 0.3 } }),
    ]) {
      const r = simulate([qumodeWire(0, 2)], [el], FOCK);
      expect(r.qumodeStates.get(0)!.fockProbabilities[2]).toBeCloseTo(1, 9);
    }
  });

  it('R(θ) rotates a coherent state: D(α) then R(π) = D(-α)', () => {
    const a = simulate([qumodeWire(0)], [
      gateEl('displace', 0, { x: 100, params: { alpha_re: 0.9, alpha_im: 0 } }),
      gateEl('rotate', 0, { x: 200, params: { theta: Math.PI } }),
      gateEl('displace', 0, { x: 300, params: { alpha_re: 0.9, alpha_im: 0 } }),
    ], 32);
    // R(π)D(α)|0⟩ = D(-α)|0⟩, so the second D(α) brings it back to vacuum
    expect(a.qumodeStates.get(0)!.fockProbabilities[0]).toBeCloseTo(1, 5);
  });

  it('50:50 beam splitter splits one photon evenly between the modes', () => {
    const r = simulate([qumodeWire(0, 1), qumodeWire(1)],
      [gateEl('bs', 0, { targets: [1], params: { theta: Math.PI / 4, phi: 0 } })], 6);
    expect(r.qumodeStates.get(0)!.meanPhotonNumber).toBeCloseTo(0.5, 9);
    expect(r.qumodeStates.get(1)!.meanPhotonNumber).toBeCloseTo(0.5, 9);
  });

  it('beam splitter conserves total photon number', () => {
    const r = simulate([qumodeWire(0, 2), qumodeWire(1, 1)],
      [gateEl('bs', 0, { targets: [1], params: { theta: 0.6, phi: 0.3 } })], 8);
    const total = r.qumodeStates.get(0)!.meanPhotonNumber + r.qumodeStates.get(1)!.meanPhotonNumber;
    expect(total).toBeCloseTo(3, 8);
  });
});

// ---------------------------------------------------------------------------
// Hybrid gates
// ---------------------------------------------------------------------------

describe('conditional displacement gates in a circuit', () => {
  const A = 0.9;                         // real α
  const OVERLAP = Math.exp(-2 * A * A);  // ⟨-α|α⟩ for real α

  const run = (gateId: string, qubitInit: Parameters<typeof qubitWire>[1]) =>
    simulate([qubitWire(0, qubitInit), qumodeWire(1)],
      [gateEl(gateId, 0, { targets: [1], params: { alpha_re: A, alpha_im: 0 } })], 32);

  it('zCD: |0⟩ displaces by +α, |1⟩ by -α, qubit untouched', () => {
    for (const [init, z] of [['0', 1], ['1', -1]] as const) {
      const r = run('cdisp', init);
      expect(r.qubitStates.get(0)!.blochVector.z).toBeCloseTo(z, 9);
      expect(r.qumodeStates.get(1)!.meanPhotonNumber).toBeCloseTo(A * A, 6);
    }
  });

  it('zCD on |+⟩ makes a cat state: ⟨σx⟩ = ⟨-α|α⟩ = e^{-2|α|²}', () => {
    const r = run('cdisp', '+');
    expect(r.qubitStates.get(0)!.blochVector.x).toBeCloseTo(OVERLAP, 6);
    expect(r.qumodeStates.get(1)!.meanPhotonNumber).toBeCloseTo(A * A, 6);
  });

  it('xCD: |+⟩ displaces by +α, |-⟩ by -α, qubit stays on the x axis', () => {
    for (const [init, x] of [['+', 1], ['-', -1]] as const) {
      const r = run('xcdisp', init);
      expect(r.qubitStates.get(0)!.blochVector.x).toBeCloseTo(x, 9);
      expect(r.qumodeStates.get(1)!.meanPhotonNumber).toBeCloseTo(A * A, 6);
    }
  });

  it('xCD on |0⟩ entangles: ⟨σz⟩ = e^{-2|α|²}', () => {
    const r = run('xcdisp', '0');
    expect(r.qubitStates.get(0)!.blochVector.z).toBeCloseTo(OVERLAP, 6);
  });

  it('yCD: |i⟩ displaces by +α, |-i⟩ by -α, qubit stays on the y axis', () => {
    for (const [init, y] of [['i', 1], ['-i', -1]] as const) {
      const r = run('ycdisp', init);
      expect(r.qubitStates.get(0)!.blochVector.y).toBeCloseTo(y, 9);
      expect(r.qumodeStates.get(1)!.meanPhotonNumber).toBeCloseTo(A * A, 6);
    }
  });

  it('yCD on |0⟩ entangles: ⟨σz⟩ = e^{-2|α|²}', () => {
    const r = run('ycdisp', '0');
    expect(r.qubitStates.get(0)!.blochVector.z).toBeCloseTo(OVERLAP, 6);
  });

  it('each conditional displacement is its own inverse under α → -α', () => {
    for (const id of ['cdisp', 'xcdisp', 'ycdisp']) {
      const r = simulate([qubitWire(0, '+'), qumodeWire(1)], [
        gateEl(id, 0, { x: 100, targets: [1], params: { alpha_re: A, alpha_im: 0.3 } }),
        gateEl(id, 0, { x: 200, targets: [1], params: { alpha_re: -A, alpha_im: -0.3 } }),
      ], 32);
      expect(r.qumodeStates.get(1)!.fockProbabilities[0]).toBeCloseTo(1, 5);
      expect(r.qubitStates.get(0)!.blochVector.x).toBeCloseTo(1, 5);
    }
  });
});

describe('conditional rotation and Jaynes-Cummings in a circuit', () => {
  it('CR(θ) on |+⟩|1⟩ rotates the qubit phase by 2θ', () => {
    const theta = 0.4;
    const r = simulate([qubitWire(0, '+'), qumodeWire(1, 1)],
      [gateEl('cr', 0, { targets: [1], params: { theta } })], FOCK);
    const b = r.qubitStates.get(0)!.blochVector;
    expect(b.x).toBeCloseTo(Math.cos(2 * theta), 9);
    expect(b.y).toBeCloseTo(Math.sin(2 * theta), 9);
    expect(r.qumodeStates.get(1)!.fockProbabilities[1]).toBeCloseTo(1, 9);
  });

  it('CR(θ) does nothing on the vacuum', () => {
    const r = simulate([qubitWire(0, '+'), qumodeWire(1, 0)],
      [gateEl('cr', 0, { targets: [1], params: { theta: 0.4 } })], FOCK);
    expect(r.qubitStates.get(0)!.blochVector.x).toBeCloseTo(1, 9);
  });

  it('JC(π/2) fully swaps one photon into the qubit excitation', () => {
    const r = simulate([qubitWire(0, '0'), qumodeWire(1, 1)],
      [gateEl('jc', 0, { targets: [1], params: { theta: Math.PI / 2 } })], FOCK);
    expect(r.qubitStates.get(0)!.blochVector.z).toBeCloseTo(-1, 9);
    expect(r.qumodeStates.get(1)!.meanPhotonNumber).toBeCloseTo(0, 9);
  });

  it('JC does nothing on |g,0⟩ (nothing to exchange)', () => {
    const r = simulate([qubitWire(0, '0'), qumodeWire(1, 0)],
      [gateEl('jc', 0, { targets: [1], params: { theta: 0.7 } })], FOCK);
    expect(r.qubitStates.get(0)!.blochVector.z).toBeCloseTo(1, 9);
    expect(r.qumodeStates.get(1)!.fockProbabilities[0]).toBeCloseTo(1, 9);
  });

  it('AJC(π/2) on |g,0⟩ creates one photon and excites the qubit', () => {
    const r = simulate([qubitWire(0, '0'), qumodeWire(1, 0)],
      [gateEl('ajc', 0, { targets: [1], params: { theta: Math.PI / 2, phi: 0 } })], FOCK);
    expect(r.qubitStates.get(0)!.blochVector.z).toBeCloseTo(-1, 9);
    expect(r.qumodeStates.get(1)!.meanPhotonNumber).toBeCloseTo(1, 9);
  });

  it('AJC does nothing on |e,0⟩ (nothing to de-excite into)', () => {
    const r = simulate([qubitWire(0, '1'), qumodeWire(1, 0)],
      [gateEl('ajc', 0, { targets: [1], params: { theta: 0.7, phi: 0 } })], FOCK);
    expect(r.qubitStates.get(0)!.blochVector.z).toBeCloseTo(-1, 9);
    expect(r.qumodeStates.get(1)!.fockProbabilities[0]).toBeCloseTo(1, 9);
  });

  it('AJC blue-sideband Rabi: P(excited) = sin²(θ√(n+1)) from |g,n⟩', () => {
    for (const n of [0, 1, 2]) {
      const theta = 0.55;
      const r = simulate([qubitWire(0, '0'), qumodeWire(1, n as never)],
        [gateEl('ajc', 0, { targets: [1], params: { theta, phi: 0 } })], FOCK);
      const pExcited = (1 - r.qubitStates.get(0)!.blochVector.z) / 2;
      expect(pExcited).toBeCloseTo(Math.sin(theta * Math.sqrt(n + 1)) ** 2, 9);
    }
  });

  it('AJC then its inverse (θ → -θ) returns to the start', () => {
    const r = simulate([qubitWire(0, '0'), qumodeWire(1, 1)], [
      gateEl('ajc', 0, { x: 100, targets: [1], params: { theta: 0.6, phi: 0.4 } }),
      gateEl('ajc', 0, { x: 200, targets: [1], params: { theta: -0.6, phi: 0.4 } }),
    ], FOCK);
    expect(r.qubitStates.get(0)!.blochVector.z).toBeCloseTo(1, 8);
    expect(r.qumodeStates.get(1)!.fockProbabilities[1]).toBeCloseTo(1, 8);
  });

  it('the JC phase φ does not change transfer probabilities, only phases', () => {
    for (const phi of [0, 0.8, 2.5]) {
      const r = simulate([qubitWire(0, '0'), qumodeWire(1, 1)],
        [gateEl('jc', 0, { targets: [1], params: { theta: 0.5, phi } })], FOCK);
      const pExcited = (1 - r.qubitStates.get(0)!.blochVector.z) / 2;
      expect(pExcited).toBeCloseTo(Math.sin(0.5) ** 2, 9);
    }
  });

  it('JC vacuum Rabi: P(excited) = sin²(θ√n) for n = 1', () => {
    for (const theta of [0.3, 0.8, 1.2]) {
      const r = simulate([qubitWire(0, '0'), qumodeWire(1, 1)],
        [gateEl('jc', 0, { targets: [1], params: { theta } })], FOCK);
      const pExcited = (1 - r.qubitStates.get(0)!.blochVector.z) / 2;
      expect(pExcited).toBeCloseTo(Math.sin(theta) ** 2, 9);
    }
  });
});

// ---------------------------------------------------------------------------
// Custom generator gates
// ---------------------------------------------------------------------------

describe('custom generator gates in a circuit', () => {
  // Note: the palette exposes only CV ("custom_cv") and hybrid ("custom_cvdv")
  // custom gates — the DV generator path is covered at matrix level in
  // gateMatrices.test.ts.
  it('custom CV generator "n" preserves photon number', () => {
    const r = simulate([qumodeWire(0, 2)], [gateEl('custom_cv', 0, { params: { theta: 0.5 }, generatorExpression: 'n' })], FOCK);
    expect(r.qumodeStates.get(0)!.fockProbabilities[2]).toBeCloseTo(1, 9);
  });

  it('custom hybrid generator "z*n" matches the built-in CR gate', () => {
    const theta = 0.35;
    const wires = [qubitWire(0, '+'), qumodeWire(1, 1)];
    const custom = simulate(wires, [gateEl('custom_cvdv', 0, { targets: [1], params: { theta }, generatorExpression: 'z*n' })], FOCK);
    const builtin = simulate(wires, [gateEl('cr', 0, { targets: [1], params: { theta } })], FOCK);
    const a = custom.qubitStates.get(0)!.blochVector;
    const b = builtin.qubitStates.get(0)!.blochVector;
    expect(a.x).toBeCloseTo(b.x, 8);
    expect(a.y).toBeCloseTo(b.y, 8);
    expect(a.z).toBeCloseTo(b.z, 8);
  });

  it('custom CV generator "a + ad" acts as a displacement along x', () => {
    const theta = 0.5;
    const r = simulate([qumodeWire(0)], [gateEl('custom_cv', 0, { params: { theta }, generatorExpression: 'a + ad' })], 32);
    // e^{-iθ(a+a†)} = D(-iθ), so n̄ = θ²
    expect(r.qumodeStates.get(0)!.meanPhotonNumber).toBeCloseTo(theta * theta, 5);
  });
});
