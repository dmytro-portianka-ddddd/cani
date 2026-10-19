/** Round to cents at every derived edge — no float dust in the books. The
 * signed epsilon lifts binary values like 1.005 (stored as 100.4999…) back
 * over the half-cent boundary they mathematically sit on. */
export function round2(n: number): number {
  const scaled = n * 100;
  return Math.round(scaled + (scaled >= 0 ? 1e-9 : -1e-9)) / 100;
}
