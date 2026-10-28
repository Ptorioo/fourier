import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { params } from './controls.js';
import { digest, dump, expand, fields, load } from './io.js';
import { validate } from './runner.js';
import type { Plan, Scalar, Stimulus } from './types.js';

const settings = ['sample_rate', 'buffer_size', 'channels'];
const stimulusFields = ['frequency_hz', 'level_dbfs', 'noise_rms_dbfs', 'seed', 'at_seconds', 'on_seconds', 'off_seconds', 'start_hz', 'end_hz', 'competitor_hz', 'competitor_dbfs', 'probe_dbfs', 'probe_kind'];
interface Axis { kind: 'parameter' | 'stimulus' | 'setting'; name: string; values: Scalar[] }
export function expandMatrix(raw: unknown) {
  const o = fields(raw, ['plan', 'plan_file', 'axes'], 'matrix');
  if ((o.plan === undefined) === (o.plan_file === undefined)) throw new Error('Matrix requires exactly one of plan or plan_file');
  if (o.plan_file !== undefined && typeof o.plan_file !== 'string') throw new Error('plan_file must be a path');
  const base = validate(o.plan ?? load(expand(o.plan_file as string)));
  if (!Array.isArray(o.axes) || !o.axes.length || o.axes.length > 8) throw new Error('Matrix requires 1..8 axes');
  const keys = new Set<string>();
  const axes: Axis[] = o.axes.map(rawAxis => {
    const a = fields(rawAxis, ['kind', 'name', 'values'], 'matrix axis');
    if (!['parameter', 'stimulus', 'setting'].includes(String(a.kind)) || typeof a.name !== 'string' || !a.name.trim()) throw new Error('Axis requires kind and name');
    if (a.kind === 'setting' && !settings.includes(a.name) || a.kind === 'stimulus' && !stimulusFields.includes(a.name)) throw new Error('Unsupported matrix setting/stimulus field');
    const key = `${a.kind}:${a.name}`;
    if (keys.has(key)) throw new Error('Matrix axes must be distinct'); keys.add(key);
    if (!Array.isArray(a.values) || !a.values.length || a.values.length > 16 || new Set(a.values).size !== a.values.length) throw new Error('Each axis requires 1..16 distinct scalar values');
    a.values.forEach(v => params({ value: v }));
    if (a.kind === 'parameter' && [base, ...base.cases].some(c => c.automation?.some(e => a.name as string in e.parameters))) throw new Error(`Matrix parameter ${a.name} is shadowed by automation`);
    return a as unknown as Axis;
  });
  type Pick = { axis: Axis; index: number; value: Scalar };
  const product = (selected: Axis[]): Pick[][] => selected.reduce<Pick[][]>((rows, axis) => {
    if (rows.length * axis.values.length > 256) throw new Error('Matrix exceeds 256 combinations');
    return rows.flatMap(row => axis.values.map((value, index) => [...row, { axis, index, value }]));
  }, [[]]);
  const settingRows = product(axes.filter(a => a.kind === 'setting')), caseRows = product(axes.filter(a => a.kind !== 'setting'));
  if (settingRows.length > 16 || caseRows.length * base.cases.length > 64 || settingRows.length * caseRows.length * base.cases.length > 256) throw new Error('Matrix allows <=16 plans, <=64 cases/plan and <=256 total cases');
  let bytes = 0;
  const plans = settingRows.map((row, index) => {
    const plan = structuredClone(base) as Plan & Record<string, unknown>;
    for (const p of row) plan[p.axis.name] = p.value;
    bytes += plan.sample_rate * plan.channels * plan.duration * caseRows.length * base.cases.length * 8;
    if (bytes > 512_000_000) throw new Error('Matrix exceeds 512 MB raw audio budget');
    plan.cases = base.cases.flatMap(c => caseRows.map((picks, j) => {
      const item = structuredClone(c), suffix = `_m${j}`;
      item.id = `${c.id.slice(0, 64 - suffix.length)}${suffix}`;
      for (const p of picks) {
        if (p.axis.kind === 'parameter') item.parameters[p.axis.name] = p.value;
        else (item.stimulus as Stimulus & Record<string, unknown>)[p.axis.name] = p.value;
      }
      return item;
    }));
    return { id: `matrix${index}`, settings: Object.fromEntries(row.map(p => [p.axis.name, p.value])), plan: validate(plan) };
  });
  return { axes, case_combinations: caseRows.map(picks => Object.fromEntries(picks.map(p => [`${p.axis.kind}:${p.axis.name}`, p.value]))), plans };
}
export function createMatrix(raw: unknown) {
  const o = fields(raw, ['plan', 'plan_file', 'axes', 'out_directory'], 'matrix create');
  if (typeof o.out_directory !== 'string') throw new Error('out_directory required');
  const { out_directory, ...design } = o, matrix = expandMatrix(design), directory = expand(out_directory);
  mkdirSync(dirname(directory), { recursive: true }); mkdirSync(directory);
  const plans = matrix.plans.map(p => { const path = join(directory, `${p.id}.plan.json`); dump(path, p.plan); return { id: p.id, spec_path: path, cases: p.plan.cases.length, settings: p.settings }; });
  const report = join(directory, 'matrix.json');
  dump(report, { schema_version: 1, design_sha256: digest(design), axes: matrix.axes, case_combinations: matrix.case_combinations, plans });
  return { status: 'ok', directory, report, plans, total_cases: plans.reduce((sum, p) => sum + p.cases, 0), plugins_loaded: 0 };
}
