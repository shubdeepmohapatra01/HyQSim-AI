// Matrix-level unit tests: one block per gate.
// Each gate's generator matrix is checked for unitarity, structure and
// against an independently-derived reference construction.
import { describe, it, expect } from 'vitest';
import type { Complex, Matrix } from '../complex';
import { complex, ONE, ZERO, add, sub, mul, scale, identity } from '../complex';
import { GATES, Rx, Ry, Rz, CNOT } from '../qubit';
import {
  annihilationMatrix, creationMatrix, numberMatrix,
  displacementMatrix, squeezingMatrix, rotationMatrix, kerrMatrix, beamSplitterMatrix,
} from '../qumode';
import {
  zConditionalDisplacementMatrix,
  xConditionalDisplacementMatrix,
  yConditionalDisplacementMatrix,
  conditionalRotationMatrix,
  jaynesCouplingMatrix,
  antiJaynesCummingsMatrix,
} from '../tensor';
import { buildCustomUnitary } from '../customGenerator';
import { dagger, kron, matMul, expectMatricesClose, expectUnitary } from './helpers';

const F = 12;               // Fock truncation used for CV tests
const SAFE = 6;             // subspace where truncation error is negligible
const ALPHA: Complex = { re: 0.6, im: -0.35 };

// ---------------------------------------------------------------------------
// Qubit gates
// ---------------------------------------------------------------------------

describe('qubit gates', () => {
  const named: [string, Matrix][] = [
    ['H', GATES.H], ['X', GATES.X], ['Y', GATES.Y], ['Z', GATES.Z],
    ['S', GATES.S], ['Sdg', GATES.Sdg], ['T', GATES.T],
    ['Rx', Rx(0.7)], ['Ry', Ry(0.7)], ['Rz', Rz(0.7)], ['CNOT', CNOT],
  ];

  it.each(named)('%s is unitary', (_name, U) => expectUnitary(U));

  it('H² = X² = Y² = Z² = I', () => {
    for (const U of [GATES.H, GATES.X, GATES.Y, GATES.Z]) {
      expectMatricesClose(matMul(U, U), identity(2));
    }
  });

  it('S² = Z, T² = S, S·S† = I', () => {
    expectMatricesClose(matMul(GATES.S, GATES.S), GATES.Z);
    expectMatricesClose(matMul(GATES.T, GATES.T), GATES.S);
    expectMatricesClose(matMul(GATES.S, GATES.Sdg), identity(2));
  });

  it('Rx/Ry/Rz(θ) = cos(θ/2)I - i sin(θ/2)σ', () => {
    const theta = 0.9;
    const c = Math.cos(theta / 2), s = Math.sin(theta / 2);
    const build = (P: Matrix): Matrix =>
      identity(2).map((row, i) => row.map((v, j) =>
        add(scale(v, c), mul(complex(0, -s), P[i][j]))));
    expectMatricesClose(Rx(theta), build(GATES.X));
    expectMatricesClose(Ry(theta), build(GATES.Y));
    expectMatricesClose(Rz(theta), build(GATES.Z));
  });

  it('Rx(2π) = -I (spinor sign)', () => {
    expectMatricesClose(Rx(2 * Math.PI), identity(2).map(r => r.map(v => scale(v, -1))));
  });

  it('CNOT permutes |10⟩ ↔ |11⟩ and fixes |00⟩,|01⟩', () => {
    const expected: Matrix = [
      [ONE, ZERO, ZERO, ZERO],
      [ZERO, ONE, ZERO, ZERO],
      [ZERO, ZERO, ZERO, ONE],
      [ZERO, ZERO, ONE, ZERO],
    ];
    expectMatricesClose(CNOT, expected);
  });
});

// ---------------------------------------------------------------------------
// Qumode ladder operators
// ---------------------------------------------------------------------------

describe('ladder operators', () => {
  it('a† is the adjoint of a', () => {
    expectMatricesClose(creationMatrix(F), dagger(annihilationMatrix(F)));
  });

  it('a†a = n on the truncated space', () => {
    const n = matMul(creationMatrix(F), annihilationMatrix(F));
    expectMatricesClose(n, numberMatrix(F));
  });

  it('[a, a†] = I except at the truncation boundary', () => {
    const a = annihilationMatrix(F), ad = creationMatrix(F);
    const comm = matMul(a, ad).map((row, i) => row.map((v, j) => sub(v, matMul(ad, a)[i][j])));
    for (let i = 0; i < F - 1; i++) {
      expect(Math.abs(comm[i][i].re - 1)).toBeLessThan(1e-12);
    }
    // Boundary term: [a,a†]_{F-1,F-1} = -(F-1)
    expect(comm[F - 1][F - 1].re).toBeCloseTo(-(F - 1), 9);
  });
});

// ---------------------------------------------------------------------------
// Displacement D(α)
// ---------------------------------------------------------------------------

describe('displacement D(α)', () => {
  it('is unitary on the low-photon subspace', () => {
    expectUnitary(displacementMatrix(ALPHA, 32), SAFE, 1e-8);
  });

  it('D(0) = I', () => {
    expectMatricesClose(displacementMatrix(ZERO, F), identity(F));
  });

  it('D(α)D(-α) = I on the low-photon subspace', () => {
    const D = displacementMatrix(ALPHA, 32);
    const Dm = displacementMatrix({ re: -ALPHA.re, im: -ALPHA.im }, 32);
    const P = matMul(D, Dm);
    for (let i = 0; i < SAFE; i++) {
      for (let j = 0; j < SAFE; j++) {
        expect(Math.hypot(P[i][j].re - (i === j ? 1 : 0), P[i][j].im)).toBeLessThan(1e-8);
      }
    }
  });

  it('D(-α) = D(α)†', () => {
    const D = displacementMatrix(ALPHA, F);
    const Dm = displacementMatrix({ re: -ALPHA.re, im: -ALPHA.im }, F);
    expectMatricesClose(Dm, dagger(D), 1e-8);
  });

  it('D(α)|0⟩ is a coherent state: |⟨n|α⟩|² = e^{-|α|²}|α|^{2n}/n!', () => {
    const alpha: Complex = { re: 0.8, im: 0 };
    const D = displacementMatrix(alpha, 32);
    const a2 = alpha.re * alpha.re + alpha.im * alpha.im;
    let fact = 1;
    for (let n = 0; n < 8; n++) {
      if (n > 0) fact *= n;
      const expected = Math.exp(-a2) * Math.pow(a2, n) / fact;
      const got = D[n][0].re ** 2 + D[n][0].im ** 2;
      expect(got).toBeCloseTo(expected, 8);
    }
  });
});

// ---------------------------------------------------------------------------
// Squeezing S(r,φ)
// ---------------------------------------------------------------------------

describe('squeezing S(r,φ)', () => {
  it('is unitary on the low-photon subspace', () => {
    expectUnitary(squeezingMatrix(0.4, 0.3, 40), SAFE, 1e-7);
  });

  it('S(0,φ) = I', () => {
    expectMatricesClose(squeezingMatrix(0, 0.5, F), identity(F));
  });

  it('couples only even↔even and odd↔odd Fock states (parity conserving)', () => {
    const S = squeezingMatrix(0.4, 0.3, F);
    for (let i = 0; i < F; i++) {
      for (let j = 0; j < F; j++) {
        if ((i - j) % 2 !== 0) expect(Math.hypot(S[i][j].re, S[i][j].im)).toBeLessThan(1e-12);
      }
    }
  });

  it('S(r)|0⟩ has mean photon number sinh²(r)', () => {
    const r = 0.4;
    const S = squeezingMatrix(r, 0, 60);
    let nbar = 0;
    for (let n = 0; n < 60; n++) nbar += n * (S[n][0].re ** 2 + S[n][0].im ** 2);
    expect(nbar).toBeCloseTo(Math.sinh(r) ** 2, 6);
  });
});

// ---------------------------------------------------------------------------
// Rotation R(θ) and Kerr K(κ)
// ---------------------------------------------------------------------------

describe('rotation R(θ) and Kerr K(κ)', () => {
  it('R is unitary and diagonal with phases e^{-iθn}', () => {
    const theta = 0.73;
    const R = rotationMatrix(theta, F);
    expectUnitary(R);
    for (let n = 0; n < F; n++) {
      expect(R[n][n].re).toBeCloseTo(Math.cos(theta * n), 12);
      expect(R[n][n].im).toBeCloseTo(-Math.sin(theta * n), 12);
    }
  });

  it('R(θ₁)R(θ₂) = R(θ₁+θ₂) and R(2π) = I', () => {
    expectMatricesClose(matMul(rotationMatrix(0.4, F), rotationMatrix(0.9, F)), rotationMatrix(1.3, F));
    expectMatricesClose(rotationMatrix(2 * Math.PI, F), identity(F), 1e-10);
  });

  it('Kerr is unitary and diagonal with phases e^{-iκn²}', () => {
    const kappa = 0.21;
    const K = kerrMatrix(kappa, F);
    expectUnitary(K);
    for (let n = 0; n < F; n++) {
      expect(K[n][n].re).toBeCloseTo(Math.cos(kappa * n * n), 12);
      expect(K[n][n].im).toBeCloseTo(-Math.sin(kappa * n * n), 12);
    }
  });
});

// ---------------------------------------------------------------------------
// Beam splitter BS(θ,φ)
// ---------------------------------------------------------------------------

describe('beam splitter BS(θ,φ)', () => {
  const fd = 5;

  it('is unitary', () => {
    expectUnitary(beamSplitterMatrix(0.6, 0.4, fd), undefined, 1e-9);
  });

  it('BS(0,φ) = I', () => {
    expectMatricesClose(beamSplitterMatrix(0, 0.4, fd), identity(fd * fd), 1e-10);
  });

  it('conserves total photon number', () => {
    const BS = beamSplitterMatrix(0.6, 0.4, fd);
    for (let i = 0; i < fd * fd; i++) {
      for (let j = 0; j < fd * fd; j++) {
        const nOut = Math.floor(i / fd) + (i % fd);
        const nIn = Math.floor(j / fd) + (j % fd);
        if (nOut !== nIn) expect(Math.hypot(BS[i][j].re, BS[i][j].im)).toBeLessThan(1e-10);
      }
    }
  });

  it('50:50 splits one photon evenly: U|1,0⟩ = cosθ|1,0⟩ - sinθ|0,1⟩', () => {
    const theta = Math.PI / 4;
    const BS = beamSplitterMatrix(theta, 0, fd);
    const inIdx = 1 * fd + 0;               // |1,0⟩
    const keep = BS[1 * fd + 0][inIdx];
    const swap = BS[0 * fd + 1][inIdx];
    expect(keep.re).toBeCloseTo(Math.cos(theta), 9);
    expect(swap.re).toBeCloseTo(-Math.sin(theta), 9);
  });

  it('BS(θ)BS(-θ) = I', () => {
    expectMatricesClose(matMul(beamSplitterMatrix(0.6, 0, fd), beamSplitterMatrix(-0.6, 0, fd)),
      identity(fd * fd), 1e-9);
  });
});

// ---------------------------------------------------------------------------
// Conditional displacements — zCD / xCD / yCD
// ---------------------------------------------------------------------------

describe('conditional displacements', () => {
  const fd = 16;
  const D = displacementMatrix(ALPHA, fd);
  const Dm = displacementMatrix({ re: -ALPHA.re, im: -ALPHA.im }, fd);

  // Reference construction: P₊ ⊗ D(α) + P₋ ⊗ D(-α), with P± the projectors
  // onto the ±1 eigenvectors of the given Pauli axis.
  function projectorReference(vPlus: Complex[], vMinus: Complex[]): Matrix {
    const proj = (v: Complex[]): Matrix =>
      [0, 1].map(i => [0, 1].map(j => mul(v[i], { re: v[j].re, im: -v[j].im })));
    const A = kron(proj(vPlus), D);
    const B = kron(proj(vMinus), Dm);
    return A.map((row, i) => row.map((val, j) => add(val, B[i][j])));
  }

  const s = 1 / Math.sqrt(2);
  const AXES = {
    z: { U: zConditionalDisplacementMatrix(ALPHA, fd), plus: [ONE, ZERO], minus: [ZERO, ONE] },
    x: { U: xConditionalDisplacementMatrix(ALPHA, fd), plus: [complex(s), complex(s)], minus: [complex(s), complex(-s)] },
    y: { U: yConditionalDisplacementMatrix(ALPHA, fd), plus: [complex(s), complex(0, s)], minus: [complex(s), complex(0, -s)] },
  };

  for (const [axis, { U, plus, minus }] of Object.entries(AXES)) {
    describe(`${axis}CD`, () => {
      // Regression test for the missing `sub` import that made xCD/yCD throw
      // "ReferenceError: sub is not defined" at build time of the matrix.
      it('builds without throwing and has the right shape', () => {
        expect(U.length).toBe(2 * fd);
        expect(U[0].length).toBe(2 * fd);
        for (const row of U) {
          for (const v of row) {
            expect(Number.isFinite(v.re)).toBe(true);
            expect(Number.isFinite(v.im)).toBe(true);
          }
        }
      });

      it('is unitary on the low-photon subspace', () => {
        expectUnitary(U, SAFE, 1e-7);
      });

      it('equals P₊⊗D(α) + P₋⊗D(-α) for its Pauli axis', () => {
        expectMatricesClose(U, projectorReference(plus, minus), 1e-10);
      });
    });
  }

  it('zCD is block diagonal in the qubit basis', () => {
    const U = AXES.z.U;
    for (let i = 0; i < 2 * fd; i++) {
      for (let j = 0; j < 2 * fd; j++) {
        if (Math.floor(i / fd) !== Math.floor(j / fd)) {
          expect(Math.hypot(U[i][j].re, U[i][j].im)).toBeLessThan(1e-14);
        }
      }
    }
  });

  it('xCD = (H⊗I)·zCD·(H⊗I)', () => {
    const H = kron(GATES.H, identity(fd));
    expectMatricesClose(AXES.x.U, matMul(matMul(H, AXES.z.U), H), 1e-10);
  });

  it('yCD = (V⊗I)·zCD·(V⊗I)† with V = S·H', () => {
    const V = kron(matMul(GATES.S, GATES.H), identity(fd));
    expectMatricesClose(AXES.y.U, matMul(matMul(V, AXES.z.U), dagger(V)), 1e-10);
  });

  it('all three reduce to the identity for α = 0', () => {
    for (const build of [zConditionalDisplacementMatrix, xConditionalDisplacementMatrix, yConditionalDisplacementMatrix]) {
      expectMatricesClose(build(ZERO, fd), identity(2 * fd), 1e-12);
    }
  });

  it('the three axes give genuinely different unitaries', () => {
    const flat = (M: Matrix) => M.flat().map(c => `${c.re.toFixed(6)},${c.im.toFixed(6)}`).join('|');
    const keys = [flat(AXES.z.U), flat(AXES.x.U), flat(AXES.y.U)];
    expect(new Set(keys).size).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// Conditional rotation CR(θ)
// ---------------------------------------------------------------------------

describe('conditional rotation CR(θ)', () => {
  const fd = 10;
  const theta = 0.55;
  const U = conditionalRotationMatrix(theta, fd);

  it('is unitary', () => expectUnitary(U));

  it('is block diagonal with R(+θ) on |0⟩ and R(-θ) on |1⟩', () => {
    expectMatricesClose(U, kron([[ONE, ZERO], [ZERO, ZERO]], rotationMatrix(theta, fd))
      .map((row, i) => row.map((v, j) =>
        add(v, kron([[ZERO, ZERO], [ZERO, ONE]], rotationMatrix(-theta, fd))[i][j]))), 1e-12);
  });

  it('CR(0) = I', () => {
    expectMatricesClose(conditionalRotationMatrix(0, fd), identity(2 * fd), 1e-12);
  });
});

// ---------------------------------------------------------------------------
// Jaynes-Cummings JC(θ)
// ---------------------------------------------------------------------------

describe('Jaynes-Cummings JC(θ)', () => {
  const fd = 8;
  const theta = 0.4;
  const U = jaynesCouplingMatrix(theta, 0, fd);

  it('is unitary away from the truncation boundary', () => {
    // Basis: |g,n⟩ = n, |e,n⟩ = fd+n. The |e,fd-1⟩ partner lies outside the
    // truncation, so exclude the top rung.
    const P = matMul(dagger(U), U);
    for (const i of [0, 1, 2, 3, fd, fd + 1, fd + 2]) {
      expect(Math.hypot(P[i][i].re - 1, P[i][i].im)).toBeLessThan(1e-12);
    }
  });

  it('JC(0) = I', () => {
    expectMatricesClose(jaynesCouplingMatrix(0, 0, fd), identity(2 * fd), 1e-12);
  });

  it('|g,0⟩ is decoupled (no photon to exchange)', () => {
    expect(U[0][0].re).toBeCloseTo(1, 12);
    for (let i = 1; i < 2 * fd; i++) {
      expect(Math.hypot(U[i][0].re, U[i][0].im)).toBeLessThan(1e-14);
    }
  });

  it('U|g,n⟩ = cos(θ√n)|g,n⟩ - i sin(θ√n)|e,n-1⟩', () => {
    for (let n = 1; n < fd; n++) {
      const c = Math.cos(theta * Math.sqrt(n)), s = Math.sin(theta * Math.sqrt(n));
      expect(U[n][n].re).toBeCloseTo(c, 12);
      expect(U[fd + n - 1][n].re).toBeCloseTo(0, 12);
      expect(U[fd + n - 1][n].im).toBeCloseTo(-s, 12);
    }
  });

  it('θ = π/(2√n) fully transfers the n-photon component', () => {
    const n = 1;
    const full = jaynesCouplingMatrix(Math.PI / (2 * Math.sqrt(n)), 0, fd);
    expect(Math.hypot(full[n][n].re, full[n][n].im)).toBeLessThan(1e-12);
    expect(Math.hypot(full[fd + n - 1][n].re, full[fd + n - 1][n].im)).toBeCloseTo(1, 12);
  });
});

// ---------------------------------------------------------------------------
// Anti-Jaynes-Cummings AJC(θ,φ)
// ---------------------------------------------------------------------------

describe('anti-Jaynes-Cummings AJC(θ,φ)', () => {
  const fd = 8;
  const theta = 0.4;
  const U = antiJaynesCummingsMatrix(theta, 0, fd);

  it('is unitary away from the truncation boundary', () => {
    const P = matMul(dagger(U), U);
    for (const i of [0, 1, 2, 3, fd, fd + 1, fd + 2]) {
      expect(Math.hypot(P[i][i].re - 1, P[i][i].im)).toBeLessThan(1e-12);
    }
  });

  it('AJC(0) = I', () => {
    expectMatricesClose(antiJaynesCummingsMatrix(0, 0.7, fd), identity(2 * fd), 1e-12);
  });

  it('|e,0⟩ is decoupled (its partner |g,-1⟩ does not exist)', () => {
    expect(U[fd][fd].re).toBeCloseTo(1, 12);
    for (let i = 0; i < 2 * fd; i++) {
      if (i !== fd) expect(Math.hypot(U[i][fd].re, U[i][fd].im)).toBeLessThan(1e-14);
    }
  });

  it('U|g,n⟩ = cos(θ√(n+1))|g,n⟩ - i e^{iφ} sin(θ√(n+1))|e,n+1⟩', () => {
    const phi = 0.9;
    const V = antiJaynesCummingsMatrix(theta, phi, fd);
    for (let n = 0; n < fd - 1; n++) {
      const c = Math.cos(theta * Math.sqrt(n + 1)), s = Math.sin(theta * Math.sqrt(n + 1));
      expect(V[n][n].re).toBeCloseTo(c, 12);
      expect(V[fd + n + 1][n].re).toBeCloseTo(s * Math.sin(phi), 12);
      expect(V[fd + n + 1][n].im).toBeCloseTo(-s * Math.cos(phi), 12);
    }
  });

  it('θ = π/2 fully excites |g,0⟩ into |e,1⟩ (blue sideband π-pulse)', () => {
    const full = antiJaynesCummingsMatrix(Math.PI / 2, 0, fd);
    expect(Math.hypot(full[0][0].re, full[0][0].im)).toBeLessThan(1e-12);
    expect(Math.hypot(full[fd + 1][0].re, full[fd + 1][0].im)).toBeCloseTo(1, 12);
  });

  it('JC and AJC move excitations in opposite directions', () => {
    const jc = jaynesCouplingMatrix(theta, 0, fd);
    // JC lowers the photon number when exciting the qubit, AJC raises it
    expect(Math.hypot(jc[fd + 0][1].re, jc[fd + 0][1].im)).toBeGreaterThan(0.1);  // |g,1⟩ → |e,0⟩
    expect(Math.hypot(U[fd + 1][0].re, U[fd + 1][0].im)).toBeGreaterThan(0.1);    // |g,0⟩ → |e,1⟩
    expect(Math.hypot(jc[fd + 1][0].re, jc[fd + 1][0].im)).toBeLessThan(1e-14);
    expect(Math.hypot(U[fd + 0][1].re, U[fd + 0][1].im)).toBeLessThan(1e-14);
  });
});

// ---------------------------------------------------------------------------
// Custom generator gates
// ---------------------------------------------------------------------------

describe('custom generator gates', () => {
  // Convention: custom gates build e^{-iθG}, while Rx(θ) = e^{-iθX/2},
  // so generator "x" at angle θ equals Rx(2θ).
  it('DV generator "x" gives e^{-iθx} = Rx(2θ)', () => {
    const theta = 0.83;
    const { unitary, type } = buildCustomUnitary('x', theta, 8);
    expect(type).toBe('dv');
    expectMatricesClose(unitary, Rx(2 * theta), 1e-9);
  });

  it('CV generator "n" reproduces R(θ)', () => {
    const theta = 0.31;
    const { unitary, type } = buildCustomUnitary('n', theta, F);
    expect(type).toBe('cv');
    expectMatricesClose(unitary, rotationMatrix(theta, F), 1e-9);
  });

  it('hybrid generator "z*n" reproduces CR(θ)', () => {
    const theta = 0.42;
    const fd = 8;
    const { unitary, type } = buildCustomUnitary('z*n', theta, fd);
    expect(type).toBe('hybrid');
    expectMatricesClose(unitary, conditionalRotationMatrix(theta, fd), 1e-9);
  });

  it('rejects non-Hermitian generators', () => {
    expect(() => buildCustomUnitary('a', 0.5, 6)).toThrow();
  });
});
