import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { aligned, archive, compare } from './compare.js';
import { arraySha, dump, expand, fields, integer, load, object, sha, stringify } from './io.js';
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
function objective(reference: string, candidate: string, ids: string[], lag: number) {
  let totalError = 0, totalPower = 0, frames = 0;
  const cases = ids.map(id => {
    const a = archive(reference, id), b = archive(candidate, id);
    if (a.sr !== b.sr || arraySha(a.input) !== arraySha(b.input) || a.output.length !== b.output.length || a.output[0].length !== b.output[0].length) throw new Error('Candidate inputs/outputs must match exactly before explicit alignment');
    const [x, y] = aligned(a.output, b.output, lag); let error = 0, power = 0;
    for (let c = 0; c < x.length; c++) for (let i = 0; i < x[c].length; i++) { power += x[c][i] ** 2; error += (y[c][i] - x[c][i]) ** 2; }
    const count = x.length * x[0].length; totalError += error; totalPower += power; frames += count;
    return { id, mse: error / count, relative_mse: power > 1e-24 ? error / power : null };
  });
  return { mse: frames ? totalError / frames : null, relative_mse: totalPower > 1e-24 ? totalError / totalPower : null, cases };
}
export async function match(action: string, raw: unknown) {
  if (action === 'create') {
    const o = fields(raw, ['reference_plan', 'candidate', 'held_out_case_ids', 'candidate_lag_samples', 'out'], 'suite create');
    if (typeof o.reference_plan !== 'string' || typeof o.out !== 'string') throw new Error('reference_plan and out paths required');
    const reference = validate(load(expand(o.reference_plan))), c = fields(o.candidate, ['plugin', 'plugin_name', 'parameters', 'case_parameters', 'case_controls', 'state_file', 'save_state', 'automation'], 'candidate');
    if (typeof c.plugin !== 'string' || !c.plugin) throw new Error('Explicit candidate plugin required');
    const caseControls = object(c.case_controls ?? {}, 'case_controls');
    for (const [id, control] of Object.entries(caseControls)) { if (!reference.cases.some(item => item.id === id)) throw new Error('Unknown candidate case control ID'); fields(control, ['state_file', 'save_state', 'automation'], 'candidate case control'); }
    const cases = object(c.case_parameters ?? {}, 'case_parameters');
    if (Object.keys(cases).some(id => !reference.cases.some(item => item.id === id))) throw new Error('Unknown candidate case parameter ID');
    // Never carry a reference plug-in state or parameter keys into a different candidate implicitly.
    const { case_parameters: _caseParameters, case_controls: _caseControls, ...candidateOptions } = c;
    const candidate = validate({ ...reference, ...candidateOptions, plugin_name: c.plugin_name ?? null, cases: reference.cases.map(item => ({ id: item.id, stimulus: item.stimulus, parameters: cases[item.id] ?? {}, ...object(caseControls[item.id] ?? {}, 'case control') })),  parameters: c.parameters ?? {}, state_file: c.state_file, save_state: c.save_state, automation: c.automation });
    const value = suite({ schema_version: 1, reference, candidate, held_out_case_ids: o.held_out_case_ids, candidate_lag_samples: o.candidate_lag_samples }), target = expand(o.out);
    mkdirSync(dirname(target), { recursive: true }); writeFileSync(target, stringify(value, 2) + '\n', { flag: 'wx' });
    return { status: 'ok', suite: target, cases: reference.cases.length, held_out_case_ids: value.held_out_case_ids };
  }
  if (action !== 'run' && action !== 'fit') throw new Error('match action must be create, run or fit');
  const o = fields(raw, action === 'fit' ? ['suite', 'out', 'grid'] : ['suite', 'out'], 'suite execution');
  if (typeof o.suite !== 'string' || typeof o.out !== 'string') throw new Error('suite and out paths required');
  const specPath = expand(o.suite), s = suite(load(specPath)), root = expand(o.out), all = s.reference.cases.map(c => c.id), train = all.filter(id => !s.held_out_case_ids.includes(id));
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
  mkdirSync(dirname(root), { recursive: true }); mkdirSync(root);
  const manifest = { status: 'running', action, suite_sha256: sha(specPath), suite: s, reference_run: '', evaluations: [] as { index: number; parameters: Record<string, Scalar>; directory: string; fit: ReturnType<typeof objective> }[], error: '' };
  const checkpoint = join(root, 'match.json'); dump(checkpoint, manifest);
  try {
    const reference = await render(s.reference, root, 'reference'); manifest.reference_run = reference; dump(checkpoint, manifest);
    for (let i = 0; i < combinations.length; i++) {
      const candidate = await render({ ...s.candidate, parameters: { ...s.candidate.parameters, ...combinations[i] } }, root, `candidate-${i}`);
      const fit = objective(reference, candidate, action === 'fit' ? train : all, s.candidate_lag_samples);
      if (action === 'fit' && fit.relative_mse === null) throw new Error('Cannot fit against silent reference output');
      manifest.evaluations.push({ index: i, parameters: combinations[i], directory: candidate, fit }); dump(checkpoint, manifest);
    }
    const best = [...manifest.evaluations].sort((a, b) => (a.fit.relative_mse ?? Infinity) - (b.fit.relative_mse ?? Infinity) || a.index - b.index)[0];
    const held = s.held_out_case_ids.length ? objective(reference, best.directory, s.held_out_case_ids, s.candidate_lag_samples) : null;
    for (let i = 0; i < all.length; i += 16) compare(reference, join(root, `comparison-${i / 16}`), { case_ids: all.slice(i, i + 16), candidate_run: best.directory, candidate_lag_samples: s.candidate_lag_samples });
    manifest.status = 'ok'; dump(checkpoint, { ...manifest, best_tested: best.index, held_out: held, objective: 'Summed squared sample error / summed reference output energy over all channels and fit cases after explicit lag; exact ties use grid order. Not perceptual equivalence. Held-out cases are scored only after selection; none means no independent validation.' });
    return { status: 'ok', directory: root, report: checkpoint, evaluations: manifest.evaluations.length, best_tested_parameters: best.parameters, fit_relative_mse: best.fit.relative_mse, held_out_relative_mse: held?.relative_mse ?? null, held_out_evaluated: held !== null, held_out_informative: held !== null && held.relative_mse !== null };
  } catch (error) { manifest.status = 'error'; manifest.error = String(error); dump(checkpoint, manifest); throw error; }
}
