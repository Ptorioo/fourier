import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { platform } from 'node:os';
import { arraySha, audioBytes, builtins, dump, identity, integer, load, number, packageRoot, preview, version } from './io.js';
import { saveAudio } from './archive.js';
import { controls, events, snapshot } from './controls.js';
import { make, midiEvents } from './signals.js';
import { measure } from './measure.js';
import type { Audio, PluginInfo, Request, Result, Scalar, Stimulus } from './types.js';

export function nativeHost(): string {
  const path = process.env.FOURIER_NATIVE_HOST || join(packageRoot, 'native', 'build', 'fourier-host' + (process.platform === 'win32' ? '.exe' : ''));
  if (!existsSync(path)) throw new Error('JUCE host not built. Run npm run setup:native -- --juce /path/to/JUCE, or set FOURIER_NATIVE_HOST to the built fourier-host executable. Built-ins and analyze-wav do not need it.');
  return path;
}
type Rendered = Pick<Result, 'plugin' | 'initial_plugin' | 'automation_readbacks'> & { plugin: PluginInfo; audio?: Audio };
function native(request: Request, input?: Audio): Rendered {
  const file = join(request.output, 'native.request.json'), response = join(request.output, 'native.result.json');
  dump(file, { ...request, midi: request.stimulus?.kind === 'midi' ? midiEvents(request.stimulus.midi ?? [], request.duration!) : [], input_frames: input?.[0].length ?? 0 });
  if (input) writeFileSync(join(request.output, 'native.input.f32'), audioBytes(input));
  // The runner's worker deadline covers this child too, including process-tree termination.
  const result = spawnSync(nativeHost(), ['--request', file, '--response', response], { stdio: ['ignore', 'inherit', 'inherit'], windowsHide: true });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    if (existsSync(response)) throw new Error(load<{ error: string }>(response).error);
    throw new Error(`JUCE host exited with code ${result.status} / signal ${result.signal}`);
  }
  const info = load<Rendered & { status: string; error?: string; render_controls_version?: number }>(response);
  if (info.status !== 'ok') throw new Error(info.error ?? 'Native host failed');
  if (!input) return { plugin: info.plugin };
  if ((request.state_file || request.save_state || request.automation?.length) && (info.render_controls_version !== 1 || !info.initial_plugin || !Array.isArray(info.automation_readbacks) || info.automation_readbacks.length !== (request.automation?.length ?? 0))) throw new Error('Native host lacks verified state/automation support; rebuild it with the current Fourier source');
  const output = join(request.output, 'native.output.f32'), expected = request.channels! * input[0].length * 4;
  if (statSync(output).size !== expected) throw new Error('Invalid native output size');
  const bytes = readFileSync(output), audio = Array.from({ length: request.channels! }, (_, ch) => Float32Array.from({ length: input[0].length }, (_, i) => bytes.readFloatLE((ch * input[0].length + i) * 4)));
  return { plugin: info.plugin, initial_plugin: info.initial_plugin, automation_readbacks: info.automation_readbacks, audio };
}
function configure(path: string, parameters: Record<string, Scalar>): PluginInfo {
  const defaults: Record<string, Record<string, number>> = { 'builtin:gain': { gain_db: 0 }, 'builtin:delay': { delay_samples: 128 }, 'builtin:clip': { threshold: .25 }, 'builtin:synth': { gain_db: -18 } };
  const values = { ...defaults[path] }, ranges: Record<string, [number, number]> = { gain_db: [-120, 24], delay_samples: [0, 48000], threshold: [.0001, 1] };
  for (const [key, value] of Object.entries(parameters)) {
    if (!(key in values)) throw new Error(`Unknown parameter: ${key}; inspect first`);
    values[key] = key === 'delay_samples' ? integer(value, key, ...ranges[key]) : number(value, key, ...ranges[key]);
  }
  return { name: path, is_instrument: path === 'builtin:synth', parameters: Object.fromEntries(Object.entries(values).map(([k, v]) => [k, { value: v }])), reported_latency_samples: values.delay_samples ?? 0 };
}
function builtin(path: string, audio: Audio, info: PluginInfo, stimulus: Stimulus, sr: number, duration: number): Audio {
  const value = (key: string) => info.parameters[key].value as number;
  if (path === 'builtin:gain') return audio.map(ch => ch.map(v => v * 10 ** (value('gain_db') / 20)));
  if (path === 'builtin:clip') return audio.map(ch => ch.map(v => Math.max(-value('threshold'), Math.min(value('threshold'), v))));
  const result = audio.map(ch => new Float32Array(ch.length));
  if (path === 'builtin:delay') { const delay = value('delay_samples'); if (delay < audio[0].length) audio.forEach((ch, i) => result[i].set(ch.subarray(0, ch.length - delay), delay)); return result; }
  const active = new Map<number, { start: number; velocity: number }>();
  for (const { time, data } of [...midiEvents(stimulus.midi ?? [], duration), { time: duration, data: [0xb0, 123, 0] }]) {
    const status = data[0] & 0xf0, note = data[1];
    if (status === 0x90 && data[2] > 0) {
      if (active.has(note)) throw new Error('Built-in synth does not support overlapping same-note voices');
      active.set(note, { start: time, velocity: data[2] / 127 });
    } else if (status === 0x80 || status === 0x90 && data[2] === 0 || status === 0xb0 && note === 123) {
      for (const pitch of status === 0xb0 ? [...active.keys()] : [note]) {
        const voice = active.get(pitch); if (!voice) continue; active.delete(pitch);
        for (let i = Math.max(0, Math.ceil(voice.start * sr)); i < Math.min(audio[0].length, Math.ceil((time + .05) * sr)); i++) {
          const age = i / sr - voice.start, envelope = Math.max(0, Math.min(1, age / .005)) * Math.max(0, Math.min(1, (time + .05 - i / sr) / .05));
          const tone = envelope * Math.sin(2 * Math.PI * 440 * 2 ** ((pitch - 69) / 12) * age) * voice.velocity * 10 ** (value('gain_db') / 20);
          for (const ch of result) ch[i] += tone;
        }
      }
    }
  }
  return result;
}
export function execute(request: Request): Result {
  const start = performance.now(), isBuiltin = builtins.includes(request.plugin);
  const versions = { fourier: version, node: process.versions.node, platform: `${platform()} ${process.arch}`, backend: isBuiltin ? 'typescript' : 'juce' };
  if (request.operation === 'inspect') {
    const info = isBuiltin ? configure(request.plugin, request.parameters) : native(request).plugin;
    return { status: 'ok', plugin: info, versions, elapsed_seconds: (performance.now() - start) / 1000 };
  }
  const sr = request.sample_rate!, channels = request.channels!, duration = request.duration!, stimulus = request.stimulus!;
  const input = make(stimulus, sr, channels, duration);
  Object.assign(request, controls(request as Request & Record<string, unknown>, duration, sr));
  const hash = identity(request.plugin).sha256, restored = request.state_file ? snapshot(request.state_file, hash, versions.backend, sr, channels, request.buffer_size!) : undefined;
  let info: PluginInfo, initial: PluginInfo, output: Audio, readbacks: NonNullable<Result['automation_readbacks']> = [];
  if (isBuiltin) {
    let parameters = { ...restored?.parameters, ...request.parameters };
    info = configure(request.plugin, parameters); initial = structuredClone(info);
    if (info.is_instrument !== (stimulus.kind === 'midi')) throw new Error('Instrument requires a midi stimulus; effects require audio');
    const source = info.is_instrument ? builtin(request.plugin, input, configure(request.plugin, { gain_db: 0 }), stimulus, sr, duration) : input;
    output = input.map(ch => new Float32Array(ch.length));
    const schedule = events(request.automation, sr); let offset = 0;
    for (const event of [...schedule, { sample: input[0].length, parameters: {} }]) {
      const value = (key: string) => info.parameters[key].value as number;
      for (let i = offset; i < event.sample; i++) for (let ch = 0; ch < channels; ch++) {
        const v = source[ch][i];
        output[ch][i] = request.plugin === 'builtin:delay' ? source[ch][i - value('delay_samples')] ?? 0 : request.plugin === 'builtin:clip' ? Math.max(-value('threshold'), Math.min(value('threshold'), v)) : v * 10 ** (value('gain_db') / 20);
      }
      offset = event.sample;
      if (offset < input[0].length) { parameters = { ...parameters, ...event.parameters }; info = configure(request.plugin, parameters); readbacks.push({ sample: offset, parameters: structuredClone(info.parameters) }); }
    }
  } else {
    if (restored) writeFileSync(join(request.output, 'native.state.input.bin'), Buffer.from(restored.data!, 'base64'));
    const rendered = native({ ...request, state_file: restored ? join(request.output, 'native.state.input.bin') : undefined, ...(restored ? { state_plugin_name: restored.plugin_name } : {}) }, input);
    info = rendered.plugin; initial = rendered.initial_plugin ?? info; readbacks = rendered.automation_readbacks ?? []; output = rendered.audio!;
  }
  if (request.save_state) {
    const bytes = !isBuiltin ? readFileSync(join(request.output, 'native.state.output.bin')) : undefined;
    if (bytes && bytes.length > 4 * 1024 * 1024) throw new Error('Native state exceeds 4 MiB');
    dump(join(request.output, 'plugin-state.json'), { schema_version: 1, plugin_sha256: hash, plugin_name: info.name, backend: versions.backend, sample_rate: sr, channels, buffer_size: request.buffer_size, parameters: Object.fromEntries(Object.entries(info.parameters).map(([key, value]) => [key, value.value])), ...(bytes ? { data: bytes.toString('base64') } : {}) });
  }
  if (output.length !== channels || output.some(ch => ch.length !== input[0].length || ch.some(v => !Number.isFinite(v)))) throw new Error('Invalid/non-finite plug-in output');
  saveAudio(join(request.output, 'audio.npz'), input, output, sr);
  const warning = preview(join(request.output, 'output.preview.wav'), output, sr);
  const [metrics, traces] = measure(input, output, sr, stimulus); dump(join(request.output, 'traces.json'), traces);
  if (!isBuiltin) for (const name of ['native.input.f32', 'native.output.f32', 'native.state.input.bin', 'native.state.output.bin']) rmSync(join(request.output, name), { force: true });
  return { status: 'ok', plugin: info, initial_plugin: initial, automation_readbacks: readbacks, ...(request.save_state ? { state_snapshot: 'plugin-state.json' } : {}), versions, input_sha256: arraySha(input), output_sha256: arraySha(output), input_frames: input[0].length, output_frames: output[0].length, metrics, warnings: warning ? [warning] : [], elapsed_seconds: (performance.now() - start) / 1000 };
}
if (process.argv[2] === '--request') {
  const response = process.argv[5];
  try { dump(response, execute(load<Request>(process.argv[3]))); }
  catch (error) { console.error(error); dump(response, { status: 'error', error_type: error instanceof Error ? error.name : 'Error', error: String(error).slice(0, 8192) }); process.exitCode = 1; }
}
