/**
 * Wigner quasi-probability distributions.
 *
 * Extracted from QumodeDisplay so the AI layer can derive features from the same numbers
 * the user sees plotted — the model must never be shown a distribution that disagrees
 * with the canvas.
 *
 * g=2 convention: x̂ = a+a†, p̂ = i(a†−a), vacuum variance = 1 in each quadrature.
 * Coordinates (X,P) are eigenvalues of x̂_g2 and p̂_g2.
 *
 *   W_n(X,P) = (1/2π)(−1)^n L_n(R²) exp(−R²/2)          where R² = X²+P²
 *   W_{mn}   = (1/2π)(−1)^m √(m!/n!) (X−iP)^{n−m} L_m^{n−m}(R²) exp(−R²/2)
 *
 * Vacuum check: W_0 = (1/2π)exp(−R²/2), ⟨x̂²⟩ = ∫ X² W_0 dX dP = 1  ✓
 *
 * Index order is `W[ix][ip]` — x along the first axis. The Python backend returns the
 * transpose (`W[p][x]`), so anything consuming `QumodeState.wignerData` must transpose
 * first; see `wignerFromState`.
 */

export type Complex = { re: number; im: number };

export function laguerre(n: number, x: number): number {
  if (n === 0) return 1;
  if (n === 1) return 1 - x;
  let L0 = 1, L1 = 1 - x;
  for (let k = 2; k <= n; k++) { const L2 = ((2*k-1-x)*L1 - (k-1)*L0)/k; L0=L1; L1=L2; }
  return L1;
}

export function associatedLaguerre(n: number, k: number, x: number): number {
  if (n === 0) return 1;
  if (n === 1) return 1 + k - x;
  let L0 = 1, L1 = 1 + k - x;
  for (let m = 2; m <= n; m++) { const L2 = ((2*m-1+k-x)*L1 - (m-1+k)*L0)/m; L0=L1; L1=L2; }
  return L1;
}

/**
 * g=2 convention: ⟨x̂⟩ = 2·Re(A), ⟨p̂⟩ = 2·Im(A)
 * where A = Σ_{n=1}^{N-1} c_{n−1}* · c_n · √n
 */
export function computeQuadratureExpectations(amplitudes: Complex[]): { xMean: number; pMean: number } {
  let reA = 0, imA = 0;
  for (let n = 1; n < amplitudes.length; n++) {
    const sqrtN = Math.sqrt(n);
    reA += (amplitudes[n - 1].re * amplitudes[n].re + amplitudes[n - 1].im * amplitudes[n].im) * sqrtN;
    imA += (amplitudes[n - 1].re * amplitudes[n].im - amplitudes[n - 1].im * amplitudes[n].re) * sqrtN;
  }
  return { xMean: 2 * reA, pMean: 2 * imA };
}

export function computeWignerFunction(
  amplitudes: Complex[],
  gridSize: number,
  range: number,
): number[][] {
  const wigner: number[][] = [];
  const fockDim = amplitudes.length;
  const factorials: number[] = [1];
  for (let i = 1; i < fockDim; i++) factorials[i] = factorials[i - 1] * i;

  for (let ix = 0; ix < gridSize; ix++) {
    wigner[ix] = [];
    const x = ((ix + 0.5) / gridSize - 0.5) * 2 * range;
    for (let ip = 0; ip < gridSize; ip++) {
      const p  = ((ip + 0.5) / gridSize - 0.5) * 2 * range;
      const r2 = x * x + p * p;
      const pf = (1 / (2 * Math.PI)) * Math.exp(-r2 / 2);  // g=2 convention
      let W = 0;
      // Diagonal
      for (let n = 0; n < fockDim; n++) {
        const prob = amplitudes[n].re ** 2 + amplitudes[n].im ** 2;
        W += pf * ((n % 2 === 0) ? 1 : -1) * laguerre(n, r2) * prob;
      }
      // Off-diagonal: power = (X − iP)^k  (no √2 factor in g=2)
      for (let n = 0; n < fockDim; n++) {
        for (let m = 0; m < n; m++) {
          const rhoRe = amplitudes[m].re * amplitudes[n].re + amplitudes[m].im * amplitudes[n].im;
          const rhoIm = amplitudes[m].im * amplitudes[n].re - amplitudes[m].re * amplitudes[n].im;
          if (Math.abs(rhoRe) < 1e-15 && Math.abs(rhoIm) < 1e-15) continue;
          const k    = n - m;
          const sf   = Math.sqrt(factorials[m] / factorials[n]);
          const Lmk  = associatedLaguerre(m, k, r2);
          const sign = (m % 2 === 0) ? 1 : -1;
          let powRe = 1, powIm = 0;
          for (let i = 0; i < k; i++) {
            [powRe, powIm] = [
              powRe * x + powIm * p,
              powIm * x - powRe * p,
            ];
          }
          W += 2 * (rhoRe * pf * sign * sf * Lmk * powRe - rhoIm * pf * sign * sf * Lmk * powIm);
        }
      }
      wigner[ix][ip] = W;
    }
  }
  return wigner;
}

export function computeWignerFromDensityMatrix(
  rho: Complex[][],
  gridSize: number,
  range: number,
): number[][] {
  const wigner: number[][] = [];
  const fockDim = rho.length;
  const factorials: number[] = [1];
  for (let i = 1; i < fockDim; i++) factorials[i] = factorials[i - 1] * i;

  for (let ix = 0; ix < gridSize; ix++) {
    wigner[ix] = [];
    const x = ((ix + 0.5) / gridSize - 0.5) * 2 * range;
    for (let ip = 0; ip < gridSize; ip++) {
      const p  = ((ip + 0.5) / gridSize - 0.5) * 2 * range;
      const r2 = x * x + p * p;
      const pf = (1 / (2 * Math.PI)) * Math.exp(-r2 / 2);  // g=2 convention
      let W = 0;
      for (let m = 0; m < fockDim; m++) {
        for (let n = 0; n < fockDim; n++) {
          const rRe = rho[m][n].re, rIm = rho[m][n].im;
          if (Math.abs(rRe) < 1e-15 && Math.abs(rIm) < 1e-15) continue;
          if (m === n) {
            W += pf * ((n % 2 === 0) ? 1 : -1) * laguerre(n, r2) * rRe;
          } else if (m < n) {
            // ρ_{mn} term: power = (X−iP)^{n-m}
            const k   = n - m;
            const sf  = Math.sqrt(factorials[m] / factorials[n]);
            const Lmk = associatedLaguerre(m, k, r2);
            const sign = (m % 2 === 0) ? 1 : -1;
            let powRe = 1, powIm = 0;
            for (let i = 0; i < k; i++) {
              [powRe, powIm] = [
                powRe * x + powIm * p,
                powIm * x - powRe * p,
              ];
            }
            W += rRe * pf * sign * sf * Lmk * powRe - rIm * pf * sign * sf * Lmk * powIm;
          } else {
            // ρ_{mn} with m>n term: power = (X+iP)^{m-n}  (complex conjugate)
            const k   = m - n;
            const sf  = Math.sqrt(factorials[n] / factorials[m]);
            const Lnk = associatedLaguerre(n, k, r2);
            const sign = (n % 2 === 0) ? 1 : -1;
            let powRe = 1, powIm = 0;
            for (let i = 0; i < k; i++) {
              [powRe, powIm] = [
                powRe * x - powIm * p,
                powIm * x + powRe * p,
              ];
            }
            W += rRe * pf * sign * sf * Lnk * powRe - rIm * pf * sign * sf * Lnk * powIm;
          }
        }
      }
      wigner[ix][ip] = W;
    }
  }
  return wigner;
}

/** Transposes a square grid — used to convert the backend's W[p][x] into W[x][p]. */
export function transpose(grid: number[][]): number[][] {
  const n = grid.length;
  const out: number[][] = [];
  for (let i = 0; i < n; i++) {
    out[i] = [];
    for (let j = 0; j < n; j++) out[i][j] = grid[j][i];
  }
  return out;
}
