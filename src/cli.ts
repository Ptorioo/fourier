import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { parseArgs } from 'node:util';
import { platform } from 'node:os';
import { arraySha, digest, discovery, dump, expand, fields, load, number, object, readWav, sha, stringify, version } from './io.js';
import { measure, stats } from './measure.js';
import { saveAudio } from './archive.js';
import { inspect, preset, run, validate } from './runner.js';
import { attach, report } from './report.js';
import { compare } from './compare.js';
import { characterize } from './characterize.js';
import { match } from './match.js';
import { buildHost, juce } from './juce.js';
import { hostDoctor } from './host.js';
import { characterizeEq } from './eq.js';
import { verify } from './verify.js';
import { identifyEq } from './eq-identify.js';
import type { Audio } from './types.js';

async function readOptions() {
  const chunks: Buffer[] = []; let size = 0;
  for await (const chunk of process.stdin) { const data = Buffer.from(chunk); size += data.length; if (size > 1_000_000) throw new Error('Tool options exceed the 1,000,000-byte limit'); chunks.push(data); }
  try { const value: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8')); stringify(value); return object(value, 'options'); }
  catch (error) { throw new Error(`Invalid tool options: ${error instanceof Error ? error.message : error}`); }
}
export async function main(argv = process.argv.slice(2)) {
  const command = argv[0], action = ['juce', 'match', 'eq-identify'].includes(command) ? argv[1] : undefined;
  const schemas: Record<string, Record<string, { type: 'string' | 'boolean'; multiple?: boolean }>> = {
    doctor: {}, 'self-test': {}, 'setup-native': { juce: { type: 'string' }, generator: { type: 'string' }, jobs: { type: 'string' } },
    juce: { 'options-stdin': { type: 'boolean' } }, match: { 'options-stdin': { type: 'boolean' } },
    'eq-identify': { 'options-stdin': { type: 'boolean' }, 'native-host': { type: 'string' } },
    eq: { run: { type: 'string' }, out: { type: 'string' }, 'options-stdin': { type: 'boolean' } },
    verify: { run: { type: 'string' }, out: { type: 'string' }, 'options-stdin': { type: 'boolean' } },
    characterize: { run: { type: 'string' }, out: { type: 'string' }, 'options-stdin': { type: 'boolean' } }, discover: { root: { type: 'string', multiple: true } },
    inspect: { plugin: { type: 'string' }, 'plugin-name': { type: 'string' }, out: { type: 'string' }, timeout: { type: 'string' } },
    init: { plugin: { type: 'string' }, preset: { type: 'string' }, out: { type: 'string' }, 'options-stdin': { type: 'boolean' } },
    run: { spec: { type: 'string' }, out: { type: 'string' }, resume: { type: 'boolean' }, 'retry-failed': { type: 'boolean' } },
    compare: { run: { type: 'string' }, out: { type: 'string' }, 'options-stdin': { type: 'boolean' } },
    report: { run: { type: 'string' } }, evidence: { run: { type: 'string' }, file: { type: 'string' }, claim: { type: 'string' }, classification: { type: 'string' }, 'target-sha256': { type: 'string' } },
    analyze: { 'output-audio': { type: 'string' }, reference: { type: 'string' }, 'tone-hz': { type: 'string' }, out: { type: 'string' } },
  };
  for (const name of ['doctor', 'inspect', 'init', 'run', 'match']) schemas[name]['native-host'] = { type: 'string' };
  for (const schema of Object.values(schemas)) if ('options-stdin' in schema) schema.options = { type: 'string' };
  if (['--help', '-h', undefined].includes(command)) return { commands: Object.keys(schemas), usage: 'fourier-audio COMMAND [--options]. Node >=22; setup-native --juce PATH builds optional VST3/AU host. Never load untrusted native code.' };
  if (!schemas[command]) throw new Error(`Unknown command: ${command}`);
  const { values } = parseArgs({ args: argv.slice(action ? 2 : 1), options: schemas[command], strict: true, allowPositionals: false });
  const required = (name: string): string => { const value = values[name]; if (typeof value !== 'string' || !value) throw new Error(`--${name} required`); return value; };
  const path = (name: string) => expand(required(name));
  if (values.options && values['options-stdin']) throw new Error('Use --options FILE or --options-stdin, not both');
  const options = async () => values.options ? object(load(path('options')), 'options') : values['options-stdin'] ? readOptions() : {};
  const host = values['native-host'] === undefined ? undefined : required('native-host');
  if (command === 'doctor') {
    return { fourier: version, node: process.version, executable: process.execPath, platform: `${platform()} ${process.arch}`, audio_ready: true, ...hostDoctor(host), sandbox: false, rea: 'Optional: use fourier_rea in Pi; CLI accepts evidence files from any MCP client' };
  }
  if (command === 'setup-native') return buildHost({ juce_path: required('juce'), ...(values.generator ? { generator: required('generator') } : {}), ...(values.jobs ? { jobs: Number(required('jobs')) } : {}) });
  if (command === 'juce') return juce(action ?? '', await options());
  if (command === 'discover') return { plugins: discovery(values.root as string[] | undefined), loaded_plugins: 0 };
  if (command === 'init') {
    const opts = fields(await options(), ['plugin_name', 'sample_rate', 'channels', 'duration', 'buffer_size', 'timeout_seconds', 'parameters', 'cases', 'state_file', 'save_state', 'automation', 'native_host'], 'plan option');
    const spec = validate({ ...preset(required('plugin'), typeof values.preset === 'string' ? values.preset : 'effect'), ...opts, ...(host ? { native_host: host } : {}) }), target = path('out');
    mkdirSync(dirname(target), { recursive: true }); writeFileSync(target, stringify(spec, 2) + '\n', { flag: 'wx' });
    return { plan: target, cases: spec.cases.length, next: 'Run with fourier_run into a new directory; parameters and cases were validated.' };
  }
  if (command === 'inspect') return inspect(required('plugin'), path('out'), values.timeout ? Number(required('timeout')) : 30, values['plugin-name'] as string | undefined, host);
  if (command === 'run') {
    const target = path('out'), state = await run(path('spec'), target, values.resume === true, values['retry-failed'] === true, host);
    return { status: state.status, directory: target, report: join(target, 'REPORT.md'), completed: state.cases.filter(c => c.status === 'ok').length, total: state.spec.cases.length };
  }
  if (command === 'match') return match(action ?? '', { ...await options(), ...(host ? { native_host: host } : {}) });
  if (command === 'eq-identify') return identifyEq(action ?? '', { ...await options(), ...(host ? { native_host: host } : {}) });
  if (command === 'eq') return characterizeEq(path('run'), path('out'), await options());
  if (command === 'verify') return verify(path('run'), path('out'), await options());
  if (command === 'characterize') return characterize(path('run'), path('out'), await options());
  if (command === 'compare') return compare(path('run'), path('out'), await options());
  if (command === 'report') return report(path('run'));
  if (command === 'evidence') return attach(path('run'), path('file'), required('claim'), required('classification'), values['target-sha256'] as string | undefined);
  if (command === 'analyze') {
    const outputPath = path('output-audio'), [y, sr] = readWav(outputPath), inputs: Record<string, string> = { [outputPath]: sha(outputPath) };
    let x: Audio = y.map(ch => new Float32Array(ch.length));
    if (values.reference) { const reference = path('reference'), [wav, rate] = readWav(reference); if (rate !== sr || wav.length !== y.length || wav[0].length !== y[0].length) throw new Error('Reference/output WAV must have identical sample rates and shapes; align explicitly'); x = wav; inputs[reference] = sha(reference); }
    const stimulus = values['tone-hz'] ? { kind: 'tone', frequency_hz: number(Number(required('tone-hz')), 'tone_hz', 10, sr * .45) } : { kind: 'wav' };
    const [metrics, traces] = measure(x, y, sr, stimulus);
    if (values.reference) metrics.raw_null_difference = stats(y.map((ch, c) => ch.map((v, i) => v - x[c][i])));
    const target = path('out'), folder = join(target, 'cases', 'wav'); mkdirSync(dirname(target), { recursive: true }); mkdirSync(target); mkdirSync(folder, { recursive: true });
    saveAudio(join(folder, 'audio.npz'), x, y, sr); dump(join(folder, 'traces.json'), traces);
    const result = { status: 'ok' as const, input_sha256: arraySha(x), output_sha256: arraySha(y), metrics, warnings: ['No latency alignment applied; raw null difference is meaningful only for already-aligned signals.'] }; dump(join(folder, 'result.json'), result);
    const state = { schema_version: 1, kind: 'wav_analysis', identity: { path: 'PCM WAV analysis (no plug-in loaded)', sha256: digest(inputs), kind: 'wav' }, provenance: { input_files: inputs }, spec: { sample_rate: sr }, status: 'ok', cases: [{ id: 'wav', status: 'ok', result, artifacts: Object.fromEntries(['audio.npz', 'traces.json', 'result.json'].map(name => [name, sha(join(folder, name))])) }] };
    dump(join(target, 'run.json'), { ...state, fingerprint: digest({ spec: state.spec, plugin: state.identity, provenance: state.provenance }) }); return report(target);
  }
  // Built-in self checks never load a third-party plug-in.
  const { selfTest } = await import('./selftest.js'); return selfTest();
}
try {
  const result = await main(); console.log(stringify(result));
  if ('status' in result && result.status === 'error') process.exitCode = 1;
} catch (error) {
  console.log(stringify({ status: 'error', error_type: error instanceof Error ? error.name : 'Error', error: error instanceof Error ? error.message : String(error) })); process.exitCode = 1;
}
