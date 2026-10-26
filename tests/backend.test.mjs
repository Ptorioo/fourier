import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { archive, compare } from '../dist/compare.js';
import { dump, load, readWav, digest, legacyRunFingerprint, sha } from '../dist/io.js';
import { run, isolated, validate } from '../dist/runner.js';
import { create, juce } from '../dist/juce.js';
import { selfTest } from '../dist/selftest.js';
import { runBackend } from '../scripts/bridge.mjs';
import { report } from '../dist/report.js';

const temporary = t => { const dir = mkdtempSync(join(tmpdir(), 'fourier-ts-')); t.after(() => rmSync(dir, { recursive: true, force: true })); return dir; };
const plan = (plugin = 'builtin:gain', parameters = { gain_db: 6 }) => ({ plugin, sample_rate: 48000, channels: 2, duration: .25, parameters, cases: [{ id: 'tone', stimulus: { kind: 'tone', frequency_hz: 997.3 } }, { id: 'noise', stimulus: { kind: 'noise', seed: 12 } }, { id: 'silence', stimulus: { kind: 'silence' } }] });

test('DSP and archive self-checks', () => assert.equal(selfTest().status, 'ok'));
test('runs, resumes, compares and verifies artifacts without Python', async t => {
  const dir = temporary(t), file = join(dir, 'spec.json'), out = join(dir, 'nested', 'run'); dump(file, plan());
  const first = await run(file, out); assert.equal(first.status, 'ok'); assert.equal(first.cases.length, 3);
  assert.ok(Math.abs(first.cases[0].result.metrics.gain_db - 6) < 1e-5);
  const resumed = await run(file, out, true); assert.equal(digest(resumed), digest(first));
  await assert.rejects(run(file, out), /EEXIST/);
  const result = compare(out, join(dir, 'cmp'), { case_ids: ['tone', 'noise', 'silence'], candidate_run: out, frequencies_hz: [997.3, 2000], band_hz: [900, 1100], times_seconds: [.1], window_ms: 80 });
  assert.equal(result.status, 'ok'); assert.equal(result.cases[0].candidate_relative_error_db[0], null);
  assert.ok(Math.abs(result.cases[0].channel_tone_gains_db[0] - 6) < 1e-5);
  const rows = load(join(dir, 'cmp', 'comparison.json')).cases; assert.equal(rows[2].channels[0].spectral_transfer[0].h1_gain_db, null);
  assert.match(readFileSync(join(out, 'REPORT.md'), 'utf8'), /# Fourier audio analysis/);
  assert.match(readFileSync(join(out, 'spectrum.svg'), 'utf8'), /<svg/);
  dump(file, { ...plan(), duration: .3 }); await assert.rejects(run(file, out, true), /Resume refused/);
  const wav = join(out, 'cases', 'tone', 'output.preview.wav'); writeFileSync(wav, 'tampered');
  assert.throws(() => archive(out, 'tone'), /checksum/);
});
test('report regeneration verifies fingerprints, required artifacts and checkpoint results before writing', async t => {
  const dir = temporary(t), file = join(dir, 'spec.json'), out = join(dir, 'run');
  dump(file, { ...plan(), cases: [plan().cases[0]] });
  const state = await run(file, out), checkpoint = join(out, 'run.json'), folder = join(out, 'cases', 'tone');
  const outputs = ['REPORT.md', 'report.json', 'spectrum.svg'].map(name => [name, readFileSync(join(out, name))]);
  const unchanged = () => { for (const [name, bytes] of outputs) assert.deepEqual(readFileSync(join(out, name)), bytes); };
  for (const name of ['traces.json', 'audio.npz', 'result.json']) {
    const path = join(folder, name), bytes = readFileSync(path);
    writeFileSync(path, 'tampered');
    assert.throws(() => report(out), /checksum/); unchanged(); writeFileSync(path, bytes);
  }
  for (const mutate of [
    copy => { copy.spec.duration += 1; },
    copy => { delete copy.fingerprint; },
    copy => { delete copy.cases[0].artifacts['traces.json']; },
    copy => { copy.cases[0].result.metrics.gain_db = 100; },
    copy => { copy.cases[0].id = '../escape'; },
    copy => { copy.cases[0].status = 'error'; },
    copy => { copy.cases[0].artifacts['../outside'] = 'bad'; },
  ]) {
    const copy = structuredClone(state); mutate(copy); dump(checkpoint, copy);
    assert.throws(() => report(out), /fingerprint|artifact|checkpoint/i); unchanged();
  }
  dump(checkpoint, { ...state, status: 'running' }); assert.equal(report(out).status, 'running');
  const pending = structuredClone(state); pending.status = 'running'; pending.cases[0] = { id: 'tone', status: 'running' };
  dump(checkpoint, pending); assert.equal(report(out).status, 'running');
  dump(checkpoint, state); assert.equal(report(out).status, 'ok'); unchanged();
  dump(checkpoint, { ...state, fingerprint: legacyRunFingerprint(checkpoint) });
  assert.equal(report(out).status, 'ok', 'legacy Python fingerprints remain readable');
});
test('failed cases are not silently retried and explicit retries preserve evidence', async t => {
  const dir = temporary(t), file = join(dir, 'spec.json'), out = join(dir, 'run'); dump(file, { ...plan(), parameters: { nonexistent: 1 }, cases: [plan().cases[0]] });
  const failed = await run(file, out); assert.equal(failed.status, 'error');
  assert.equal(report(out).status, 'error');
  await assert.rejects(run(file, out, true), /retry-failed/);
  assert.equal((await run(file, out, true, true)).status, 'error');
});
test('worker deadline produces explicit timeout instead of partial success', async t => {
  const dir = temporary(t);
  const result = await isolated({ operation: 'inspect', plugin: 'builtin:gain', parameters: {}, output: dir }, dir, .00001);
  assert.equal(result.status, 'error'); assert.equal(result.error_type, 'timeout');
});
test('strict plans reject unknown fields, out-of-range MIDI and unsafe cases', () => {
  for (const bad of [{ ...plan(), extra: 1 }, { ...plan(), duration: Infinity }, { ...plan(), channels: true }, { ...plan(), cases: [{ id: '../bad' }] }, { ...plan(), cases: [{ id: 'x', stimulus: { kind: 'midi', midi: [{ time: 0, data: [144, 60, 200] }] } }] }]) assert.throws(() => validate(bad));
});
test('PCM WAV ingestion and analysis preserve scale and reject malformed WAV', async t => {
  const dir = temporary(t), wav = join(dir, 'input.wav'), audio = [Float32Array.from({ length: 4800 }, (_, i) => Math.sin(2 * Math.PI * 1000 * i / 48000) * .25)];
  const header = Buffer.alloc(44); header.write('RIFF'); header.writeUInt32LE(36 + audio[0].length * 2, 4); header.write('WAVEfmt ', 8); header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(1, 22); header.writeUInt32LE(48000, 24); header.writeUInt32LE(48000 * 2, 28); header.writeUInt16LE(2, 32); header.writeUInt16LE(16, 34); header.write('data', 36); header.writeUInt32LE(audio[0].length * 2, 40);
  const pcm = Buffer.alloc(audio[0].length * 2); audio[0].forEach((v, i) => { const value = Math.round(v * 32768); pcm.writeInt16LE(value, i * 2); audio[0][i] = (value || 0) / 32768; }); writeFileSync(wav, Buffer.concat([header, pcm]));
  const [decoded, sr] = readWav(wav); assert.equal(sr, 48000); assert.deepEqual(decoded, audio);
  const result = await runBackend(['analyze', '--output-audio', wav, '--reference', wav, '--out', join(dir, 'analysis')]); assert.equal(result.code, 0, result.stderr);
  const checkpoint = join(dir, 'analysis', 'run.json'), state = load(checkpoint);
  assert.equal(state.cases[0].result.status, 'ok'); assert.ok(state.fingerprint);
  dump(checkpoint, { ...state, spec: { sample_rate: 8000 } });
  assert.throws(() => report(join(dir, 'analysis')), /fingerprint/);
  delete state.fingerprint; dump(checkpoint, state);
  assert.equal(report(join(dir, 'analysis')).status, 'ok', 'historical WAV reports remain readable with checked artifacts');
  writeFileSync(join(dir, 'bad.wav'), 'RIFF'); assert.throws(() => readWav(join(dir, 'bad.wav')));
});
test('JUCE authoring creates both shapes and protects outputs', t => {
  const dir = temporary(t);
  for (const kind of ['effect', 'instrument']) {
    const out = join(dir, kind); const initialized = create(out, 'FixtureGain', kind, 'Frie', 'Fr01'); assert.equal(initialized.kind, kind);
    assert.match(readFileSync(join(out, 'PluginProcessor.cpp'), 'utf8'), /gain/i);
    assert.throws(() => create(out, 'FixtureGain', kind, 'Frie', 'Fr01'), /EEXIST/);
  }
  assert.throws(() => juce('build', { project_directory: join(dir, 'effect'), allow_build: false }), /Unknown/);
  assert.throws(() => create(join(dir, 'unsafe'), '../bad', 'effect', 'Frie', 'Fr01')); 
});
test('legacy Python canonical fingerprints preserve float lexemes and Unicode', t => {
  const dir = temporary(t), file = join(dir, 'run.json');
  writeFileSync(file, '{"spec":{"duration":1.0,"name":"é"},"identity":{"path":"builtin:gain"},"provenance":{"tool_source_sha256":"old"}}');
  const canonical = '{"plugin":{"path":"builtin:gain"},"provenance":{"tool_source_sha256":"old"},"spec":{"duration":1.0,"name":"\\u00e9"}}';
  writeFileSync(join(dir, 'canonical'), canonical); assert.equal(legacyRunFingerprint(file), sha(join(dir, 'canonical')));
});
test('tool stdin options are bounded, strict JSON and validated', async () => {
  const bad = await runBackend(['init', '--plugin', 'builtin:gain', '--out', 'unused.json', '--options-stdin'], { input: '{broken' }); assert.notEqual(bad.code, 0); assert.match(bad.stdout, /Invalid tool options/);
  const unknown = await runBackend(['init', '--plugin', 'builtin:gain', '--out', 'unused.json', '--options-stdin'], { input: '{"extra":true}' }); assert.notEqual(unknown.code, 0); assert.match(unknown.stdout, /Unknown/);
});
