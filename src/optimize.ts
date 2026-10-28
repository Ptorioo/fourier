export interface SearchOptions { bounds: [number, number][]; initial: number[]; max_evaluations: number; tolerance?: number }
/** Bounded joint Nelder–Mead in unit coordinates. Local search, not a global-optimum claim. */
export async function minimize(options: SearchOptions, objective: (point: number[]) => Promise<number>) {
  const { bounds, initial, max_evaluations: budget } = options, n = bounds.length, tolerance = options.tolerance ?? 1e-5;
  if (!n || n > 8 || initial.length !== n || !Number.isInteger(budget) || budget < n + 2 || budget > 128 || !Number.isFinite(tolerance) || tolerance <= 0 || tolerance > .1 || bounds.some(([lo, hi], i) => !Number.isFinite(lo) || !Number.isFinite(hi) || lo >= hi || !Number.isFinite(initial[i]) || initial[i] < lo || initial[i] > hi)) throw new Error('Invalid bounded search: 1..8 dimensions, finite ordered bounds/initial values, dimensions+2..128 evaluations, tolerance (0,.1]');
  type Vertex = { x: number[]; value: number };
  const cache = new Map<string, Vertex>(), trace: { point: number[]; value: number }[] = [];
  async function evaluate(input: number[]): Promise<Vertex> {
    const x = input.map(v => Math.max(0, Math.min(1, v))), key = x.map(v => v.toPrecision(13)).join(',');
    if (cache.has(key)) return cache.get(key)!;
    if (trace.length >= budget) return { x, value: Infinity };
    const point = x.map((v, i) => bounds[i][0] + v * (bounds[i][1] - bounds[i][0])), value = await objective(point);
    if (!Number.isFinite(value)) throw new Error('Optimizer objective must be finite');
    const vertex = { x, value }; cache.set(key, vertex); trace.push({ point, value }); return vertex;
  }
  const x = initial.map((v, i) => (v - bounds[i][0]) / (bounds[i][1] - bounds[i][0])), simplex = [await evaluate(x)];
  for (let i = 0; i < n; i++) simplex.push(await evaluate(x.map((v, j) => j === i ? v + (v <= .8 ? .15 : -.15) : v)));
  let converged = false;
  for (let iteration = 0; trace.length < budget && iteration < budget * 20; iteration++) {
    simplex.sort((a, b) => a.value - b.value);
    if (simplex.every(v => v.x.every((p, i) => Math.abs(p - simplex[0].x[i]) <= tolerance))) { converged = true; break; }
    const worst = simplex[n], center = x.map((_, i) => simplex.slice(0, n).reduce((sum, v) => sum + v.x[i], 0) / n);
    const reflected = await evaluate(center.map((v, i) => 2 * v - worst.x[i]));
    if (reflected.value < simplex[0].value) {
      const expanded = await evaluate(center.map((v, i) => v + 2 * (reflected.x[i] - v)));
      simplex[n] = expanded.value < reflected.value ? expanded : reflected;
    } else if (reflected.value < simplex[n - 1].value) simplex[n] = reflected;
    else {
      const outside = reflected.value < worst.value, target = outside ? reflected : worst;
      const contracted = await evaluate(center.map((v, i) => v + .5 * (target.x[i] - v)));
      if (contracted.value < (outside ? reflected.value : worst.value)) simplex[n] = contracted;
      else for (let i = 1; i <= n; i++) simplex[i] = await evaluate(simplex[0].x.map((v, j) => v + .5 * (simplex[i].x[j] - v)));
    }
  }
  const best = [...trace].sort((a, b) => a.value - b.value)[0];
  return { best, evaluations: trace.length, converged, trace, method: 'Bounded joint Nelder–Mead; unit-scaled coordinates, cached points, explicit render budget; local optimum only.' };
}
