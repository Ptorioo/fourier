import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { params } from './controls.js';
import { eqFrequencies, eqResponse, type EqPoint } from './eq.js';
import { eqFamilies, fitEq, type EqFamily } from './eq-model.js';
import { digest, dump, expand, fields, identity, integer, load, number, sha, stringify } from './io.js';
import { run, safeId, validate } from './runner.js';
import type { Case, Scalar, State } from './types.js';

interface Experiment { id: string; band: string; parameter: string | null; value: Scalar | null; held_out: boolean }
function design(raw: unknown) {
  const o = fields(raw, ['effect', 'plugin', 'plugin_name', 'native_host', 'neutral_parameters', 'bands', 'sample_rate', 'channels', 'duration', 'buffer_size', 'timeout_seconds', 'families', 'stages'], 'EQ identification design');
  if (o.effect !== 'eq' && o.effect !== 'filter') throw new Error('EQ effect must be eq or filter');
  if (typeof o.plugin !== 'string') throw new Error('Explicit plugin required');
  const neutral = params(o.neutral_parameters);
  if (!Object.keys(neutral).length) throw new Error('Explicit neutral_parameters required: disable/neutralize every band and wet/output controls');
  if (!Array.isArray(o.bands) || !o.bands.length || o.bands.length > 7) throw new Error('Select 1..7 bands with explicit isolation parameters');
  const duration = number(o.duration ?? 2, 'duration', .5, 10), experiments: Experiment[] = [], stimulus = { kind: 'impulse' as const, at_seconds: .25, level_dbfs: -24 };
  const cases: Case[] = [{ id: 'neutral', stimulus, parameters: {} }], names = new Set<string>();
  for (const [index, rawBand] of o.bands.entries()) {
    const b = fields(rawBand, ['id', 'parameters', 'controls'], 'identification band');
    if (!safeId(b.id) || names.has(b.id)) throw new Error('Band IDs must be distinct safe names'); names.add(b.id);
    const band = params(b.parameters);
    if (!Object.keys(band).length) throw new Error('Each band requires explicit parameters isolating it from neutral');
    const anchor = `band${index}`;
    cases.push({ id: anchor, stimulus, parameters: band }); experiments.push({ id: anchor, band: b.id, parameter: null, value: null, held_out: false });
    const controls = b.controls ?? [];
    if (!Array.isArray(controls) || controls.length > 4) throw new Error('Select at most 4 controls per band');
    const keys = new Set<string>();
    for (const [controlIndex, rawControl] of controls.entries()) {
      const control = fields(rawControl, ['parameter', 'values', 'held_out_indices'], 'identification control');
      if (typeof control.parameter !== 'string' || !control.parameter || keys.has(control.parameter)) throw new Error('Control parameter names must be distinct per band'); keys.add(control.parameter);
      if (!Array.isArray(control.values) || control.values.length < 2 || control.values.length > 8 || new Set(control.values).size !== control.values.length) throw new Error('Each control requires 2..8 distinct explicit values');
      const values = control.values, held = control.held_out_indices ?? (values.length >= 4 ? [values.length - 1] : []);
      if (!Array.isArray(held) || new Set(held).size !== held.length || held.some(i => !Number.isInteger(i) || i < 0 || i >= values.length) || values.length - held.length < 2) throw new Error('held_out_indices must leave at least two training values');
      values.forEach((value, i) => {
        const id = `band${index}_control${controlIndex}_value${i}`;
        cases.push({ id, stimulus, parameters: { ...band, ...params({ [control.parameter as string]: value }) } });
        experiments.push({ id, band: b.id as string, parameter: control.parameter as string, value: value as Scalar, held_out: held.includes(i) });
      });
    }
  }
  const families = o.families ?? [...eqFamilies], stages = o.stages ?? [1, 2];
  if (!Array.isArray(families) || !families.length || new Set(families).size !== families.length || families.some(f => !eqFamilies.includes(f))) throw new Error('families must select distinct supported RBJ families');
  if (!Array.isArray(stages) || !stages.length || stages.length > 4 || new Set(stages).size !== stages.length || stages.some(s => !Number.isInteger(s) || s < 1 || s > 4)) throw new Error('stages must select distinct integers 1..4');
  const { effect: _effect, bands: _bands, neutral_parameters: _neutral, families: _families, stages: _stages, ...settings } = o;
  const plan = validate({ ...settings, plugin: o.plugin, duration, parameters: neutral, cases });
  if (plan.duration * plan.sample_rate * plan.channels * cases.length * 8 > 512_000_000) throw new Error('EQ identification exceeds 512 MB raw archive budget');
  return { effect: o.effect, plan, experiments, families: families as EqFamily[], stages: stages as number[] };
}
function readSuite(path: string) {
  const value = fields(load(expand(path)), ['schema_version', 'design'], 'EQ identification suite');
  if (value.schema_version !== 1) throw new Error('Unsupported EQ identification suite schema');
  return design(value.design);
}
// Return evidence-backed local laws plus raw samples, not an extrapolated universal control mapping.
export function mappingLaws(samples: { x: number; y: number; held_out: boolean }[]) {
  const training = samples.filter(s => !s.held_out), held = samples.filter(s => s.held_out);
  if (training.length < 2 || new Set(training.map(s => s.x)).size < 2) return [];
  const span = Math.max(...samples.map(s => s.y)) - Math.min(...samples.map(s => s.y));
  if (span < Math.max(1e-5, .001 * Math.max(...samples.map(s => Math.abs(s.y))))) return []; // Unexcited/coupled or constant physical target: no inferred mapping.
  const fitLaw = (name: string, exponent = 1) => {
    if (name === 'exponential' && samples.some(s => s.y <= 0) || name === 'power' && samples.some(s => s.x < 0) || name === 'power' && training.length < 3) return [];
    const tx = (x: number) => name === 'power' ? x ** exponent : x, ty = (y: number) => name === 'exponential' ? Math.log(y) : y;
    const mx = training.reduce((s, p) => s + tx(p.x), 0) / training.length, my = training.reduce((s, p) => s + ty(p.y), 0) / training.length;
    const denominator = training.reduce((s, p) => s + (tx(p.x) - mx) ** 2, 0);
    if (denominator < 1e-20) return [];
    const b = training.reduce((s, p) => s + (tx(p.x) - mx) * (ty(p.y) - my), 0) / denominator, a = my - b * mx;
    const predict = (x: number) => name === 'exponential' ? Math.exp(a + b * x) : a + b * tx(x);
    const error = (rows: typeof samples) => rows.length ? Math.sqrt(rows.reduce((sum, p) => sum + (predict(p.x) - p.y) ** 2, 0) / rows.length) : null;
    const training_rmse = error(training)!, held_out_rmse = error(held);
    return [{ form: name === 'exponential' ? 'y = exp(a + b*x)' : name === 'power' ? 'y = a + b*x^exponent' : 'y = a + b*x', a, b, exponent, training_rmse, held_out_rmse, held_out_validated: held_out_rmse !== null && held_out_rmse / span <= .05 }];
  };
  const powers = Array.from({ length: 64 }, (_, i) => (i + 1) / 8).flatMap(p => fitLaw('power', p)).sort((a, b) => a.training_rmse - b.training_rmse);
  let power = powers[0];
  if (power) {
    let low = Math.max(.125, power.exponent - .125), high = Math.min(8, power.exponent + .125);
    for (let i = 0; i < 35; i++) {
      const left = low + (high - low) / 3, right = high - (high - low) / 3;
      if (fitLaw('power', left)[0].training_rmse < fitLaw('power', right)[0].training_rmse) high = right; else low = left;
    }
    power = fitLaw('power', (low + high) / 2)[0];
  }
  const laws = [...fitLaw('linear'), ...fitLaw('exponential'), ...(power ? [power] : [])], bestError = Math.min(...laws.map(l => l.training_rmse));
  // Prefer the simpler law when differences are below measurement-scale precision.
  const tied = laws.filter(l => l.training_rmse <= bestError + span * 1e-4);
  return [...tied, ...laws.filter(l => !tied.includes(l)).sort((a, b) => a.training_rmse - b.training_rmse)];
}
function analyze(suitePath: string, directory: string, output: string, channel: number) {
  const suite = readSuite(suitePath), state = load<State>(join(directory, 'run.json'));
  const stripHost = (value: typeof suite.plan) => { const { native_host: _host, ...rest } = value; return rest; };
  suite.plan.plugin = state.identity.path;
  if (digest(stripHost(suite.plan)) !== digest(stripHost(state.spec))) throw new Error('Identification run does not match the suite design');
  const hz = eqFrequencies(state.spec.sample_rate, 192), baseline = eqResponse(directory, 'neutral', channel, hz);
  const rows = suite.experiments.map(experiment => {
    const measured = eqResponse(directory, experiment.id, channel, hz), points: EqPoint[] = measured.points.map((p, i) => {
      const b = baseline.points[i];
      return { ...p, gain_db: p.gain_db === null || b.gain_db === null ? null : p.gain_db - b.gain_db, phase_degrees: p.phase_degrees === null || b.phase_degrees === null ? null : ((p.phase_degrees - b.phase_degrees + 540) % 360) - 180 };
    });
    return { ...experiment, parameters: measured.source.result.plugin?.parameters ?? null, fit: fitEq(points, state.spec.sample_rate, suite.families, suite.stages), points };
  });
  const mappings = [...new Set(rows.filter(r => r.parameter).map(r => `${r.band}\0${r.parameter}`))].map(key => {
    const selected = rows.filter(r => `${r.band}\0${r.parameter}` === key), [band, parameter] = key.split('\0');
    const topologyConsistent = new Set(selected.map(r => `${r.fit.best.model.family}/${r.fit.best.model.stages}`)).size === 1;
    const targets = (['frequency_hz', 'q', 'gain_db'] as const).map(target => {
      const samples = selected.map(r => ({ case_id: r.id, value: r.value, held_out: r.held_out, fitted_value: r.fit.accepted && r.fit.best.model.family !== 'flat' && (target !== 'gain_db' || ['bell', 'low_shelf', 'high_shelf'].includes(r.fit.best.model.family)) ? r.fit.best.model[target] * (target === 'gain_db' ? r.fit.best.model.stages : 1) : null, ambiguous: r.fit.ambiguous }));
      const numeric = samples.filter(s => typeof s.value === 'number' && s.fitted_value !== null).map(s => ({ x: s.value as number, y: s.fitted_value!, held_out: s.held_out }));
      return { target, samples, laws: topologyConsistent && numeric.length === samples.length ? mappingLaws(numeric) : [] };
    });
    return { band, parameter, topology_consistent: topologyConsistent, targets };
  });
  mkdirSync(dirname(output), { recursive: true }); mkdirSync(output); const report = join(output, 'effects-identification.json');
  dump(report, { status: 'ok', effect: suite.effect, suite_sha256: sha(suitePath), run_sha256: sha(join(directory, 'run.json')), identity: state.identity, channel, baseline_parameters: baseline.source.result.plugin?.parameters ?? null, rows, mappings, limits: ['All bands except the isolated test band must be neutralized explicitly by the caller. This workflow does not discover unknown parameter names or secretly infer control roles.', 'Impulse at 250 ms allows settling, but long smoothing, nonlinearities, changing latency or an insufficient decay tail can invalidate a static fit. Validate with independent renders and levels.', 'Models select the best tested surrogate, not uniquely recovered proprietary topology. Mapping laws are local hypotheses over sampled numeric controls; strings retain lookup samples. Flat responses do not identify frequency/Q. Total cascaded bell/shelf gain is reported for mappings.', 'Every fourth frequency is held out of model optimization. Explicit/default held-out control values are excluded from mapping-law fitting; no held-out values means no mapping validation.'] });
  const models = rows.filter(r => r.parameter === null).map(r => ({ band: r.band, ...r.fit.best.model, accepted: r.fit.accepted, ambiguous: r.fit.ambiguous, ...r.fit.best.held_out }));
  const lines = ['# Measured EQ surrogate identification', '', 'Best tested models — not proof of the original internal implementation.', '', '| Band | Family | Stages | Frequency Hz | Q | Section gain dB | Held-out magnitude RMSE dB | Held-out phase RMSE ° | Accepted | Ambiguous |', '|---|---|---:|---:|---:|---:|---:|---:|---|---|', ...models.map(m => `| ${m.band} | ${m.family} | ${m.stages} | ${m.frequency_hz.toFixed(3)} | ${m.q.toFixed(4)} | ${m.gain_db.toFixed(3)} | ${m.magnitude_rmse_db.toFixed(5)} | ${m.phase_rmse_degrees.toFixed(4)} | ${m.accepted} | ${m.ambiguous} |`), '', '## Control mapping hypotheses', 'Numeric laws are fitted on training values only. Unchanged/unidentifiable targets have no law; string controls retain lookup samples. Consult JSON for every sample, alternative and residual.'];
  for (const mapping of mappings) {
    lines.push('', `### ${mapping.band} / ${mapping.parameter}`, `Consistent selected topology across values: ${mapping.topology_consistent}`);
    for (const target of mapping.targets) {
      const law = target.laws[0];
      if (law) lines.push(`- ${target.target}: ${law.form}; a=${law.a}, b=${law.b}, exponent=${law.exponent}; held-out RMSE=${law.held_out_rmse}; held-out validated=${law.held_out_validated}`);
    }
  }
  lines.push('', 'Limits: explicit band isolation is required; 250 ms settling may be insufficient; fits are bounded RBJ hypotheses, not unique topology recovery. Held-out frequencies are not an independent render. Local laws must not be extrapolated.');
  writeFileSync(join(output, 'EFFECTS_IDENTIFICATION.md'), lines.join('\n') + '\n', { flag: 'wx' });
  return { status: 'ok', effect: suite.effect, directory: output, report, fits: rows.length, accepted: rows.filter(r => r.fit.accepted).length, ambiguous: rows.filter(r => r.fit.ambiguous).length, mappings: mappings.length, models };
}
export async function identifyEq(action: string, raw: unknown) {
  if (action === 'create') {
    const o = fields(raw, ['out_file', 'effect', 'plugin', 'plugin_name', 'native_host', 'neutral_parameters', 'bands', 'sample_rate', 'channels', 'duration', 'buffer_size', 'timeout_seconds', 'families', 'stages'], 'EQ identification create');
    if (typeof o.out_file !== 'string') throw new Error('out_file required');
    const { out_file, ...configuration } = o, suite = design(configuration), path = expand(out_file);
    // Resolve the selected artifact, but do not load it during suite creation.
    suite.plan.plugin = identity(suite.plan.plugin).path; configuration.plugin = suite.plan.plugin;
    mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, stringify({ schema_version: 1, design: configuration }, 2) + '\n', { flag: 'wx' });
    return { status: 'ok', suite: path, cases: suite.plan.cases.length, next: 'effects-identify run; inspect exact names first and explicitly neutralize all other bands.' };
  }
  if (!['run', 'analyze'].includes(action)) throw new Error('EQ identification action must be create, run or analyze');
  const o = fields(raw, action === 'run' ? ['suite', 'out_directory', 'native_host', 'channel'] : ['suite', 'run_directory', 'out_directory', 'channel'], 'EQ identification execution');
  if (typeof o.suite !== 'string' || typeof o.out_directory !== 'string') throw new Error('suite and out_directory required');
  const suitePath = expand(o.suite), output = expand(o.out_directory), channel = integer(o.channel ?? 0, 'channel', 0, 1);
  if (action === 'analyze') { if (typeof o.run_directory !== 'string') throw new Error('run_directory required'); return analyze(suitePath, expand(o.run_directory), output, channel); }
  const suite = readSuite(suitePath);
  if (channel >= suite.plan.channels) throw new Error('channel exceeds plan channels');
  if (o.native_host !== undefined) { if (typeof o.native_host !== 'string' || !o.native_host.trim()) throw new Error('native_host must be a non-empty path'); suite.plan.native_host = expand(o.native_host); }
  mkdirSync(dirname(output), { recursive: true }); mkdirSync(output); const plan = join(output, 'plan.json'); dump(plan, suite.plan);
  const state = await run(plan, join(output, 'run'));
  if (state.status !== 'ok') throw new Error(`EQ identification render failed; inspect ${output}; no automatic retry`);
  return analyze(suitePath, join(output, 'run'), join(output, 'analysis'), channel);
}
