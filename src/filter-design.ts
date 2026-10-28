type Complex = [number, number];
const multiply = (a: Complex, b: Complex): Complex => [a[0] * b[0] - a[1] * b[1], a[0] * b[1] + a[1] * b[0]];
function squareRoot(z: Complex): Complex {
  const r = Math.hypot(...z);
  return [Math.sqrt(Math.max(0, (r + z[0]) / 2)), (z[1] < 0 ? -1 : 1) * Math.sqrt(Math.max(0, (r - z[0]) / 2))];
}
// Pair conjugate roots of a Butterworth low-pass -> band transform into real SOS polynomials.
export function bandRoots(n: number, bandwidth: number): [number, number][] {
  const roots: Complex[] = [];
  for (let i = 0; i < n; i++) {
    const angle = Math.PI * (2 * i + 1 + n) / (2 * n), b: Complex = [bandwidth * Math.cos(angle), bandwidth * Math.sin(angle)], b2 = multiply(b, b), d = squareRoot([b2[0] - 4, b2[1]]);
    roots.push([(b[0] + d[0]) / 2, (b[1] + d[1]) / 2], [(b[0] - d[0]) / 2, (b[1] - d[1]) / 2]);
  }
  const used = new Set<number>(), pairs: [number, number][] = [];
  for (let i = 0; i < roots.length; i++) {
    if (used.has(i)) continue;
    let best = -1, distance = Infinity;
    for (let j = i + 1; j < roots.length; j++) if (!used.has(j)) {
      const d = Math.hypot(roots[i][0] - roots[j][0], roots[i][1] + roots[j][1]);
      if (d < distance) { distance = d; best = j; }
    }
    if (best < 0) throw new Error('Could not pair filter roots');
    used.add(i); used.add(best);
    pairs.push([-(roots[i][0] + roots[best][0]), multiply(roots[i], roots[best])[0]]);
  }
  return pairs;
}
