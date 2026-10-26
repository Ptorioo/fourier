import { spawn, spawnSync } from 'node:child_process';
import { closeSync, existsSync, mkdirSync, openSync, realpathSync, renameSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { digest, dump, expand, fields, identity, integer, load, number, object, packageRoot, sha, sourceHash } from './io.js';
import { make } from './signals.js';
import { controls, params } from './controls.js';
import { checkHost } from './host.js';
import { report } from './report.js';
import { safeId, verifiedCase } from './integrity.js';
export { safeId, artifactPath, verifyArtifacts } from './integrity.js';
import type { Entry, Plan, Provenance, Request, Result, State, Stimulus } from './types.js';

export function validate(value: unknown): Plan {
  const spec = fields(value, ['schema_version', 'plugin', 'plugin_name', 'sample_rate', 'channels', 'duration', 'buffer_size', 'timeout_seconds', 'parameters', 'cases', 'automation', 'state_file', 'save_state', 'native_host'], 'plan');
  if ((spec.schema_version ?? 1) !== 1 || typeof spec.plugin !== 'string' || spec.plugin_name != null && typeof spec.plugin_name !== 'string') throw new Error('Invalid plan schema / plugin');
  const out: Plan = { schema_version: 1, plugin: spec.plugin, plugin_name: (spec.plugin_name ?? null) as string | null, sample_rate: integer(spec.sample_rate ?? 48000, 'sample_rate', 8000, 192000), channels: integer(spec.channels ?? 2, 'channels', 1, 2), duration: number(spec.duration ?? 3, 'duration', .01, 30), buffer_size: integer(spec.buffer_size ?? 512, 'buffer_size', 16, 32768), timeout_seconds: number(spec.timeout_seconds ?? 30, 'timeout_seconds', 1, 300), parameters: params(spec.parameters ?? {}), cases: [] };
  if (spec.native_host !== undefined) {
    if (typeof spec.native_host !== 'string' || !spec.native_host.trim()) throw new Error('native_host must be a non-empty executable path');
    out.native_host = expand(spec.native_host);
  }
  Object.assign(out, controls(spec, out.duration, out.sample_rate));
  if (!Array.isArray(spec.cases) || spec.cases.length < 1 || spec.cases.length > 64) throw new Error('Plan requires 1..64 cases');
  const names = new Set<string>();
  for (const raw of spec.cases) {
    const item = fields(raw, ['id', 'stimulus', 'parameters', 'automation', 'state_file', 'save_state'], 'case');
    if (!safeId(item.id) || names.has(item.id)) throw new Error('Case IDs must be unique safe names (1..64 ASCII letters/digits/_/-)');
    names.add(item.id);
    const stimulus = object(item.stimulus ?? { kind: 'tone' }, 'stimulus') as Stimulus;
    if (stimulus.kind === 'wav' && typeof stimulus.path === 'string') stimulus.path = expand(stimulus.path);
    make(stimulus, out.sample_rate, out.channels, out.duration);
    out.cases.push({ id: item.id, stimulus, parameters: params(item.parameters ?? {}), ...controls(item, out.duration, out.sample_rate) });
  }
  return out;
}
export function preset(plugin: string, kind = 'effect') {
  if (!['effect', 'generator', 'eq'].includes(kind)) throw new Error('Preset must be effect, generator or eq');
  if (kind === 'eq') return { schema_version: 1, plugin, sample_rate: 48000, channels: 2, duration: 2, buffer_size: 512, timeout_seconds: 30, parameters: {}, cases: [{ id: 'impulse', stimulus: { kind: 'impulse', at_seconds: .25, level_dbfs: -18 } }, { id: 'noise', stimulus: { kind: 'noise', noise_rms_dbfs: -30, seed: 1729 } }, ...[100, 1000, 10000].map(frequency_hz => ({ id: `tone_${frequency_hz}`, stimulus: { kind: 'tone', frequency_hz, level_dbfs: -24 } }))] };
  const cases = kind === 'generator' ? [[60, 64], [60, 100], [60, 127], [72, 100]].map(([note, vel]) => ({ id: `note${note}_velocity${vel}`, stimulus: { kind: 'midi', midi: [{ time: .1, data: [144, note, vel] }, { time: 2, data: [128, note, 0] }] } })) : [
    ...['silence', 'impulse', 'tone', 'noise', 'sweep', 'step_tone'].map(k => ({ id: k, stimulus: { kind: k } })),
    { id: 'resonance', stimulus: { kind: 'resonance', probe_dbfs: -66 } }, { id: 'competition', stimulus: { kind: 'resonance', probe_dbfs: -66, competitor_hz: 1400 } },
  ];
  return { schema_version: 1, plugin, sample_rate: 48000, channels: 2, duration: 3, buffer_size: 512, timeout_seconds: 30, parameters: {}, cases };
}
export function killTree(pid: number) {
  if (process.platform === 'win32') spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, timeout: 5000, stdio: 'ignore' });
  else { try { process.kill(-pid, 'SIGKILL'); } catch { /* Process already exited. */ } }
}
export async function isolated(request: Request, directory: string, timeout: number): Promise<Result> {
  dump(join(directory, 'request.json'), request);
  const response = join(directory, 'response.json'), out = join(directory, 'stdout.log'), err = join(directory, 'stderr.log');
  const stdout = openSync(out, 'wx'), stderr = openSync(err, 'wx');
  const child = spawn(process.execPath, [join(packageRoot, 'dist', 'worker.js'), '--request', join(directory, 'request.json'), '--response', response], { cwd: directory, stdio: ['ignore', stdout, stderr], windowsHide: true, detached: process.platform !== 'win32' });
  closeSync(stdout); closeSync(stderr);
  let done = false, code: number | null = null, reason: string | undefined;
  const completion = new Promise<void>(resolveDone => {
    child.once('error', () => { reason = 'spawn_error'; done = true; resolveDone(); });
    child.once('exit', exitCode => { code = exitCode; if (performance.now() - start > timeout * 1000) reason ??= 'timeout'; done = true; resolveDone(); });
  });
  const cancel = () => { if (child.pid) killTree(child.pid); };
  process.once('SIGINT', cancel); process.once('SIGTERM', cancel); process.once('exit', cancel);
  const start = performance.now();
  try {
    while (!done) {
      if (performance.now() - start > timeout * 1000) reason = 'timeout';
      else if (statSync(out).size + statSync(err).size > 10 * 1024 * 1024) reason = 'log_limit';
      if (reason) { cancel(); child.kill('SIGKILL'); break; }
      await sleep(50);
    }
    await completion;
  } finally { process.removeListener('SIGINT', cancel); process.removeListener('SIGTERM', cancel); process.removeListener('exit', cancel); }
  if (reason) return { status: 'error', error_type: reason, error: `Worker stopped: ${reason}; no automatic retry`, exit_code: code };
  if (!existsSync(response)) return { status: 'error', error_type: 'native_crash', error: 'Worker exited without a response; inspect stderr.log', exit_code: code };
  const result = load<Result>(response);
  if (code !== 0 && result.status === 'ok') return { status: 'error', error_type: 'exit_mismatch', exit_code: code };
  if (!['ok', 'error'].includes(result.status)) throw new Error('Invalid worker response');
  return result;
}
function provenance(spec: Plan, host?: ReturnType<typeof checkHost>): Provenance {
  const files: Record<string, string> = {};
  for (const item of spec.cases) if (item.stimulus.kind === 'wav') { const path = realpathSync(expand(item.stimulus.path!)); item.stimulus.path = path; files[path] = sha(path); }
  for (const item of [spec, ...spec.cases]) if (item.state_file) files[item.state_file] = sha(item.state_file);
  return { input_files: files, tool_source_sha256: sourceHash(), ...(host ? { native_host: host.path, native_host_sha256: sha(host.path) } : {}) };
}
export async function run(specPath: string, directory: string, resume = false, retryFailed = false, nativeHost?: string): Promise<State> {
  const spec = validate(load(specPath)), ident = identity(spec.plugin); spec.plugin = ident.path;
  if (nativeHost !== undefined) spec.native_host = expand(nativeHost);
  const host = !spec.plugin.startsWith('builtin:') ? checkHost(spec.native_host, ['render', ...([spec, ...spec.cases].some(c => c.state_file || c.save_state) ? ['state' as const] : []), ...([spec, ...spec.cases].some(c => c.automation?.length) ? ['automation' as const] : [])]) : undefined;
  const origin = provenance(spec, host), fingerprint = digest({ spec, plugin: ident, provenance: origin });
  directory = expand(directory); const checkpoint = join(directory, 'run.json');
  let state: State;
  if (resume) {
    state = load<State>(checkpoint);
    if (state.fingerprint !== fingerprint) throw new Error('Resume refused: plan, input, tool source or plug-in identity changed; create a new run');
  } else {
    mkdirSync(dirname(directory), { recursive: true }); mkdirSync(directory);
    state = { schema_version: 1, kind: 'measurements', fingerprint, identity: ident, provenance: origin, spec, status: 'running', cases: [] }; dump(checkpoint, state);
  }
  for (const item of spec.cases) {
    const previous = state.cases.find(c => c.id === item.id), target = join(directory, 'cases', item.id);
    if (previous?.status === 'ok') { verifiedCase(directory, previous); continue; }
    if (previous && !retryFailed) throw new Error(`Case ${item.id} failed/interrupted; inspect logs before --retry-failed`);
    if (previous) { if (existsSync(target)) renameSync(target, `${target}-attempt-${Date.now()}-${process.hrtime.bigint()}`); state.cases.splice(state.cases.indexOf(previous), 1); }
    mkdirSync(dirname(target), { recursive: true }); mkdirSync(target);
    const entry: Entry = { id: item.id, status: 'running' }; state.status = 'running'; state.cases.push(entry); dump(checkpoint, state);
    let result = await isolated({ operation: 'render', plugin: spec.plugin, plugin_name: spec.plugin_name, ...(host ? { native_host: host.path, native_host_sha256: host.sha256 } : {}), sample_rate: spec.sample_rate, channels: spec.channels, duration: spec.duration, buffer_size: spec.buffer_size, output: target, stimulus: item.stimulus, parameters: { ...spec.parameters, ...item.parameters }, state_file: item.state_file ?? spec.state_file, save_state: item.save_state ?? spec.save_state, automation: item.automation ?? spec.automation }, target, spec.timeout_seconds);
    if (digest(identity(spec.plugin)) !== digest(ident) || digest(provenance(spec, host)) !== digest(origin)) result = { status: 'error', error_type: 'identity_changed', error: 'Plug-in, input or tool identity changed during execution; stop and investigate' };
    dump(join(target, 'result.json'), result); entry.status = result.status; entry.result = result;
    const artifacts = ['request.json', 'response.json', 'result.json', 'stdout.log', 'stderr.log', 'audio.npz', 'traces.json', 'output.preview.wav', 'plugin-state.json'];
    entry.artifacts = Object.fromEntries(artifacts.filter(name => existsSync(join(target, name))).map(name => [name, sha(join(target, name))]));
    state.status = result.status === 'ok' ? 'running' : 'error'; dump(checkpoint, state); report(directory);
    if (result.status !== 'ok') return state;
  }
  state.status = 'ok'; dump(checkpoint, state); report(directory); return state;
}
export async function inspect(plugin: string, directory: string, timeout = 30, pluginName?: string, nativeHost?: string) {
  number(timeout, 'timeout', 1, 300);
  directory = expand(directory); const ident = identity(plugin);
  const host = !ident.path.startsWith('builtin:') ? checkHost(nativeHost, ['inspect']) : undefined;
  mkdirSync(dirname(directory), { recursive: true }); mkdirSync(directory);
  const result = await isolated({ operation: 'inspect', plugin: ident.path, plugin_name: pluginName, ...(host ? { native_host: host.path, native_host_sha256: host.sha256 } : {}), output: directory, parameters: {} }, directory, timeout);
  if (digest(identity(plugin)) !== digest(ident) || host && sha(host.path) !== host.sha256) throw new Error('Plug-in or host changed during inspection');
  dump(join(directory, 'inspection.json'), { identity: ident, ...(host ? { native_host: host } : {}), ...result });
  const parameters = result.plugin?.parameters, keys = Object.keys(parameters ?? {});
  const summary = result.plugin ? { ...result.plugin, parameters: Object.fromEntries(keys.slice(0, 16).map(key => [key, { ...parameters![key], value: typeof parameters![key].value === 'string' ? parameters![key].value.slice(0, 256) : parameters![key].value, ...(parameters![key].valid_values ? { valid_values: parameters![key].valid_values!.slice(0, 16).map(value => typeof value === 'string' ? value.slice(0, 128) : value), valid_values_truncated: parameters![key].valid_values!.length > 16 || parameters![key].valid_values_truncated } : {}) }])) } : undefined;
  return { directory, identity: ident, ...(host ? { native_host: host } : {}), ...result, ...(summary ? { plugin: summary, parameter_count: keys.length, parameters_truncated: keys.length > 16, inspection: join(directory, 'inspection.json') } : {}) };
}
