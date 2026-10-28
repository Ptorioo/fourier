import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { archive, compare } from './compare.js';
import { analysisWindow, candidateError, type ErrorOptions } from './audio-error.js';
import { minimize } from './optimize.js';
import { arraySha, dump, expand, fields, integer, load, number, object, sha, stringify } from './io.js';
import { params } from './controls.js';
import { run, validate } from './runner.js';
import type { Plan, Scalar } from './types.js';

interface Suite { schema_version: 1; reference: Plan; candidate: Plan; held_out_case_ids: string[]; candidate_lag_samples: number }
function suite(raw: unknown): Suite {
  const s = fields(raw, ['schema_version', 'reference', 'candidate', 'held_out_case_ids', 'candidate_lag_samples'], 'suite');
  if (s.schema_version !== 1) throw new Error('Unsupported suite schema');
  const reference = validate(s.reference), candidate = validate(s.candidate), ids = reference.cases.map(c => c.id), held = s.held_out_case_ids ?? [];
  if (reference.sample_rate !== candidate.sample_rate || reference.channels !== candidate.channels || reference.duration !== candidate.duration || stringify(reference.cases.map(c => ({ id: c.id, stimulus: c.stimulus }))) !== stringify(candidate.cases.map(c => ({ id: c.id, stimulus: c.stimulus })))) throw new Error('Suite plans must share ordered case IDs, stimuli and audio settings');
  if (!Array.isArray(held) || new Set(held).size !== held.length || held.some(id => typeof id !== 'string' || !ids.includes(id))) throw new Error('held_out_case_ids must be distinct suite IDs');
  return { schema_version: 1, reference, candidate, held_out_case_ids: held as string[], candidate_lag_samples: integer(s.candidate_lag_samples ?? 0, 'candidate_lag_samples', -4_000_000, 4_000_000) };
}
async function render(plan: Plan, root: string, name: string) {
  const spec = join(root, `${name}.plan.json`), directory = join(root, name); dump(spec, plan);
  const state = await run(spec, directory, false, false);
  if (state.status !== 'ok') throw new Error(`Suite stopped at failed ${name} run; evidence preserved at ${directory}. No automatic retry.`);
  return directory;
}
function objective(reference: string, candidate: string, ids: string[], lag: number, options: ErrorOptions = {}) {
  let totalError = 0, totalPower = 0, frames = 0;
  const cases = ids.map(id => {
    const a = archive(reference, id), b = archive(candidate, id);
    if (a.sr !== b.sr || arraySha(a.input) !== arraySha(b.input) || a.output.length !== b.output.length || a.output[0].length !== b.output[0].length) throw new Error('Candidate inputs/outputs must match exactly before explicit alignment');
    const measured = candidateError(a.output, b.output, a.sr, lag, options.window_seconds, options.reference_floor_dbfs);
    let error = 0, power = 0, count = 0;
    for (const c of measured.channels) { error += c.squared_error; power += c.reference_energy; count += c.samples; }
    totalError += error; totalPower += power; frames += count;
    const floor = options.reference_floor_dbfs === undefined ? 0 : 10 ** (options.reference_floor_dbfs / 10) * count;
    return { id, mse: error / count, relative_mse: Math.max(power, floor) > 0 ? error / Math.max(power, floor) : null };
  });
  const floor = options.reference_floor_dbfs === undefined ? 0 : 10 ** (options.reference_floor_dbfs / 10) * frames;
  return { mse: frames ? totalError / frames : null, relative_mse: Math.max(totalPower, floor) > 0 ? totalError / Math.max(totalPower, floor) : null, cases };
}
export async function match(action: string, raw: unknown) {
  if (action === 'create') {
    const o = fields(raw, ['reference_plan', 'candidate', 'held_out_case_ids', 'candidate_lag_samples', 'out'], 'suite create');
    if (typeof o.reference_plan !== 'string' || typeof o.out !== 'string') throw new Error('reference_plan and out paths required');
    const reference = validate(load(expand(o.reference_plan))), c = fields(o.candidate, ['plugin', 'plugin_name', 'parameters', 'case_parameters', 'case_controls', 'state_file', 'save_state', 'automation', 'native_host'], 'candidate');
    if (typeof c.plugin !== 'string' || !c.plugin) throw new Error('Explicit candidate plugin required');
    const caseControls = object(c.case_controls ?? {}, 'case_controls');
    for (const [id, control] of Object.entries(caseControls)) { if (!reference.cases.some(item => item.id === id)) throw new Error('Unknown candidate case control ID'); fields(control, ['state_file', 'save_state', 'automation'], 'candidate case control'); }
    const cases = object(c.case_parameters ?? {}, 'case_parameters');
    if (Object.keys(cases).some(id => !reference.cases.some(item => item.id === id))) throw new Error('Unknown candidate case parameter ID');
    // Never carry a reference plug-in state or parameter keys into a different candidate implicitly.
    const { case_parameters: _caseParameters, case_controls: _caseControls, ...candidateOptions } = c;
    const candidate = validate({ ...reference, ...candidateOptions, plugin_name: c.plugin_name ?? null, cases: reference.cases.map(item => ({ id: item.id, stimulus: item.stimulus, parameters: cases[item.id] ?? {}, ...object(caseControls[item.id] ?? {}, 'case control') })),  parameters: c.parameters ?? {}, state_file: c.state_file, save_state: c.save_state, automation: c.automation, native_host: c.native_host });
    const value = suite({ schema_version: 1, reference, candidate, held_out_case_ids: o.held_out_case_ids, candidate_lag_samples: o.candidate_lag_samples }), target = expand(o.out);
    mkdirSync(dirname(target), { recursive: true }); writeFileSync(target, stringify(value, 2) + '\n', { flag: 'wx' });
    return { status: 'ok', suite: target, cases: reference.cases.length, held_out_case_ids: value.held_out_case_ids };
  }
  if (!['run', 'fit', 'optimize'].includes(action)) throw new Error('match action must be create, run, fit or optimize');
  const o = fields(raw, ['suite', 'out', 'native_host', 'window_seconds', 'reference_floor_dbfs', ...(action === 'fit' ? ['grid'] : action === 'optimize' ? ['search'] : [])], 'suite execution');
  const errorOptions: ErrorOptions = { window_seconds: o.window_seconds as [number, number] | undefined, reference_floor_dbfs: o.reference_floor_dbfs as number | undefined };
  if (typeof o.suite !== 'string' || typeof o.out !== 'string') throw new Error('suite and out paths required');
  const specPath = expand(o.suite), s = suite(load(specPath)), root = expand(o.out), all = s.reference.cases.map(c => c.id), train = all.filter(id => !s.held_out_case_ids.includes(id));
  if (o.native_host !== undefined) {
    if (typeof o.native_host !== 'string' || !o.native_host.trim()) throw new Error('native_host must be a non-empty executable path');
    s.reference.native_host = s.candidate.native_host = expand(o.native_host);
  }
  analysisWindow(Math.round(s.reference.duration * s.reference.sample_rate) - Math.abs(s.candidate_lag_samples), s.reference.sample_rate, errorOptions.window_seconds, Math.max(0, -s.candidate_lag_samples));
  if (errorOptions.reference_floor_dbfs !== undefined) number(errorOptions.reference_floor_dbfs, 'reference_floor_dbfs', -300, 0);
  let combinations: Record<string, Scalar>[] = [{}];
  if (action === 'fit') {
    const grid = object(o.grid, 'grid'), entries = Object.entries(grid);
    if (entries.length < 1 || entries.length > 3 || !train.length) throw new Error('Fit requires 1..3 grid parameters and at least one non-held-out case');
    for (const [key, values] of entries) {
      if (!Array.isArray(values) || !values.length || values.length > 8 || combinations.length * values.length > 32) throw new Error('Grid allows 1..8 values per parameter and <=32 total evaluations');
      if (s.candidate.cases.some(c => key in c.parameters) || (s.candidate.automation ?? []).some(e => key in e.parameters) || s.candidate.cases.some(c => (c.automation ?? []).some(e => key in e.parameters))) throw new Error(`Grid parameter ${key} is shadowed by case parameters/automation`);
      combinations = combinations.flatMap(combo => values.map(value => ({ ...combo, ...params({ [key]: value }) })));
    }
    const audioSeconds = s.reference.duration * s.reference.channels * all.length * (combinations.length + 1);
    if (audioSeconds > 3600 || s.reference.sample_rate * audioSeconds * 8 > 1_000_000_000) throw new Error('Fit exceeds 3600 channel-seconds or 1 GB raw archive budget; reduce grid/cases/duration');
  }
  let search: { keys: string[]; bounds: [number, number][]; initial: number[]; max_evaluations: number; tolerance?: number; metric: 'relative_mse' | 'mse' } | undefined;
  if (action === 'optimize') {
    const option = fields(o.search, ['bounds', 'initial', 'max_evaluations', 'tolerance', 'metric'], 'search'), bounds = object(option.bounds, 'search bounds'), keys = Object.keys(bounds), initial = object(option.initial ?? {}, 'search initial');
    if (!train.length || keys.length < 1 || keys.length > 8 || Object.keys(initial).some(key => !keys.includes(key))) throw new Error('Search requires 1..8 numeric parameters, matching initial keys and non-held-out cases');
    for (const key of keys) {
      if (s.candidate.cases.some(c => key in c.parameters) || (s.candidate.automation ?? []).some(e => key in e.parameters) || s.candidate.cases.some(c => (c.automation ?? []).some(e => key in e.parameters))) throw new Error(`Search parameter ${key} is shadowed by case parameters/automation`);
      const pair = bounds[key]; if (!Array.isArray(pair) || pair.length !== 2 || pair.some(v => typeof v !== 'number' || !Number.isFinite(v)) || pair[0] >= pair[1]) throw new Error('Search bounds must be finite increasing pairs');
      if (!s.candidate.plugin.startsWith('builtin:') && (pair[0] < 0 || pair[1] > 1)) throw new Error('Native parameter bounds must be normalized [0,1]');
    }
    search = { keys, bounds: keys.map(key => bounds[key] as [number, number]), initial: keys.map(key => initial[key] as number ?? s.candidate.parameters[key] as number ?? ((bounds[key] as number[])[0] + (bounds[key] as number[])[1]) / 2), max_evaluations: integer(option.max_evaluations ?? 32, 'max_evaluations', keys.length + 2, 128), tolerance: option.tolerance as number | undefined, metric: (option.metric ?? 'relative_mse') as 'relative_mse' | 'mse' };
    if (!['relative_mse', 'mse'].includes(search.metric) || search.initial.some((v, i) => typeof v !== 'number' || !Number.isFinite(v) || v < search!.bounds[i][0] || v > search!.bounds[i][1]) || (search.tolerance !== undefined && (!Number.isFinite(search.tolerance) || search.tolerance <= 0 || search.tolerance > .1))) throw new Error('Invalid search metric, initial values or tolerance');
    const seconds = s.reference.duration * s.reference.channels * all.length * (search.max_evaluations + 1);
    if (seconds > 3600 || s.reference.sample_rate * seconds * 8 > 1_000_000_000) throw new Error('Search exceeds 3600 channel-seconds or 1 GB raw archive budget');
  }
  mkdirSync(dirname(root), { recursive: true }); mkdirSync(root);
  const manifest = { status: 'running', action, suite_sha256: sha(specPath), suite: s, scoring: errorOptions, search, reference_run: '', evaluations: [] as { index: number; parameters: Record<string, Scalar>; directory: string; fit: ReturnType<typeof objective> }[], error: '' };
  const checkpoint = join(root, 'match.json'); dump(checkpoint, manifest);
  try {
    const reference = await render(s.reference, root, 'reference'); manifest.reference_run = reference; dump(checkpoint, manifest);
    const metric = search?.metric ?? 'relative_mse';
    const evaluate = async (parameters: Record<string, Scalar>) => {
      const i = manifest.evaluations.length, candidate = await render({ ...s.candidate, parameters: { ...s.candidate.parameters, ...parameters } }, root, `candidate-${i}`);
      const fit = objective(reference, candidate, action !== 'run' ? train : all, s.candidate_lag_samples, errorOptions);
      if (action !== 'run' && fit[metric] === null) throw new Error('Cannot fit relative error against silent reference output; choose mse or an explicit reference floor');
      manifest.evaluations.push({ index: i, parameters, directory: candidate, fit }); dump(checkpoint, manifest);
      return fit[metric] ?? 0;
    };
    const optimization = search ? await minimize(search, point => evaluate(Object.fromEntries(search.keys.map((key, i) => [key, point[i]])))) : null;
    if (!search) for (const parameters of combinations) await evaluate(parameters);
    const best = [...manifest.evaluations].sort((a, b) => (a.fit[metric] ?? Infinity) - (b.fit[metric] ?? Infinity) || a.index - b.index)[0];
    const held = s.held_out_case_ids.length ? objective(reference, best.directory, s.held_out_case_ids, s.candidate_lag_samples, errorOptions) : null;
    for (let i = 0; i < all.length; i += 16) compare(reference, join(root, `comparison-${i / 16}`), { case_ids: all.slice(i, i + 16), candidate_run: best.directory, candidate_lag_samples: s.candidate_lag_samples, ...errorOptions });
    manifest.status = 'ok'; dump(checkpoint, { ...manifest, best_tested: best.index, held_out: held, optimization, objective: `Summed squared sample ${metric === 'mse' ? 'error / sample count' : 'error / reference output energy (with explicit optional floor)'} over the selected reference-clock window and fit cases after explicit lag. Local search, not perceptual equivalence or a global optimum. Held-out cases are scored only after selection; none means no independent validation.` });
    return { status: 'ok', directory: root, report: checkpoint, evaluations: manifest.evaluations.length, best_tested_parameters: best.parameters, fit_mse: best.fit.mse, optimization_converged: optimization?.converged ?? null, fit_relative_mse: best.fit.relative_mse, held_out_mse: held?.mse ?? null, held_out_relative_mse: held?.relative_mse ?? null, held_out_evaluated: held !== null, held_out_informative: held !== null && held[metric] !== null };
  } catch (error) { manifest.status = 'error'; manifest.error = String(error); dump(checkpoint, manifest); throw error; }
}
