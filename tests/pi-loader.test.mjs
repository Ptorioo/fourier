import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { packageRoot } from '../scripts/bridge.mjs';

const host = process.env.PI_HOST_ROOT || (process.env.APPDATA ? join(process.env.APPDATA, 'npm/node_modules/@earendil-works/pi-coding-agent') : '/usr/local/lib/node_modules/@earendil-works/pi-coding-agent');
const loaderPath = join(host, 'dist/core/extensions/loader.js');
async function loadFourier() {
  const { loadExtensions } = await import(pathToFileURL(loaderPath).href);
  const manifest = JSON.parse(await readFile(join(packageRoot, 'package.json'), 'utf8'));
  const loaded = await loadExtensions(manifest.pi.extensions.map(entry => join(packageRoot, entry)), packageRoot);
  assert.deepEqual(loaded.errors, []);
  const { loadSkillsFromDir } = await import(pathToFileURL(join(host, 'dist/core/skills.js')).href);
  for (const entry of manifest.pi.skills) {
    const skillResult = loadSkillsFromDir({ dir: join(packageRoot, entry), source: 'test' });
    assert.deepEqual(skillResult.diagnostics, []);
    assert.equal(skillResult.skills[0].name, entry.split('/').at(-1));
    assert.ok(skillResult.skills[0].description.length > 20);
  }
  const tools = loaded.extensions[0].tools;
  assert.equal(tools.size, 12);
  assert.ok(loaded.extensions[0].commands.has('fourier'));
  return (name, args, ctx = { cwd: packageRoot }) => tools.get(name).definition.execute('test', args, new AbortController().signal, undefined, ctx);
}

test('actual Pi loader registers and executes Fourier tools', { skip: !existsSync(loaderPath) && 'Set PI_HOST_ROOT to run the real Pi loader test' }, async () => {
  const invoke = await loadFourier();
  const doctor = await invoke('fourier_doctor', {}, { cwd: packageRoot });
  assert.equal(JSON.parse(doctor.content[0].text).audio_ready, true);
  const directory = await mkdtemp(join(tmpdir(), 'fourier-pi-'));
  try {
    const plan = join(directory, 'plan.json');
    await invoke('fourier_plan', { plugin: 'builtin:gain', preset: 'effect', out_file: plan }, { cwd: packageRoot });
    const output = join(directory, 'run');
    const result = await invoke('fourier_run', { spec_path: plan, out_directory: output }, { cwd: packageRoot });
    assert.equal(JSON.parse(result.content[0].text).completed, 8);
    const controlled = join(directory, 'controlled.json');
    await invoke('fourier_plan', {
      plugin: 'builtin:gain', preset: 'effect', out_file: controlled, duration: .3, parameters: { gain_db: -3 },
      cases: [
        { id: 'tone', stimulus: { kind: 'tone', level_dbfs: -30 } },
        { id: 'probe', stimulus: { kind: 'resonance', probe_kind: 'noise', probe_dbfs: -66, on_seconds: .1, off_seconds: .2 } },
        { id: 'multitone', stimulus: { kind: 'multitone', tones: [
          { frequency_hz: 1000, level_dbfs: -30, phase_degrees: 45, channel: 0 },
          { frequency_hz: 4000, level_dbfs: -42, channel: 1, on_seconds: .1, off_seconds: .2 },
        ] } },
      ],
    }, { cwd: packageRoot });
    const generated = JSON.parse(await readFile(controlled, 'utf8'));
    assert.equal(generated.cases[1].stimulus.probe_kind, 'noise');
    assert.equal(generated.parameters.gain_db, -3);
    await assert.rejects(invoke('fourier_plan', { plugin: 'builtin:gain', preset: 'effect', out_file: controlled }, { cwd: packageRoot }));
    const controlledRun = join(directory, 'controlled-run');
    await invoke('fourier_run', { spec_path: controlled, out_directory: controlledRun }, { cwd: packageRoot });
    const compared = await invoke('fourier_compare', {
      run_directory: controlledRun, out_directory: join(directory, 'compared'), candidate_run: controlledRun,
      frequencies_hz: [1000], band_hz: [900, 1100], times_seconds: [.15],
    }, { cwd: packageRoot });
    const comparison = JSON.parse(await readFile(JSON.parse(compared.content[0].text).report, 'utf8'));
    assert.ok(Math.abs(comparison.cases[0].channels[0].tone_gain_db + 3) < .001);
    assert.equal(comparison.cases[1].channels[0].tone_gain_db, null);
    assert.equal(comparison.cases[1].channels[1].tone_gain_db, null);
    assert.ok(comparison.cases[1].comparison.null_difference[0].digital_silence);
    const transfer = comparison.cases[2].channels[0].spectral_transfer[0];
    assert.ok(Math.abs(transfer.h1_gain_db + 3) < .001);
    assert.ok(Math.abs(transfer.h1_phase_degrees) < .001);
    assert.ok(Number.isFinite(transfer.output_bin_peak_dbfs));
    assert.ok(transfer.segments >= 2);
    const markdown = await readFile(join(directory, 'compared', 'COMPARISON.md'), 'utf8');
    assert.match(markdown, /Wrapped phase \(degrees\)/);
    assert.match(markdown, /## Time-band estimates/);
    await assert.rejects(invoke('fourier_plan', {
      plugin: 'builtin:gain', preset: 'effect', out_file: join(directory, 'invalid.json'),
      cases: [{ id: '../escape', stimulus: { kind: 'tone' } }],
    }, { cwd: packageRoot }));
    assert.equal(existsSync(join(directory, 'invalid.json')), false);
    const specialized = await invoke('fourier_characterize', { run_directory: controlledRun, out_directory: join(directory, 'specialized'), case_ids: ['tone'], measurements: ['dynamics', 'distortion'] }, { cwd: packageRoot });
    assert.equal(JSON.parse(specialized.content[0].text).status, 'ok');
    const suite = join(directory, 'suite.json');
    await invoke('fourier_match', { action: 'create', reference_plan: controlled, candidate: { plugin: 'builtin:gain' }, held_out_case_ids: ['probe', 'multitone'], out: suite }, { cwd: packageRoot });
    const fitted = await invoke('fourier_match', { action: 'fit', suite, out: join(directory, 'fitted'), grid: { gain_db: [-6, -3, 0] } }, { cwd: packageRoot });
    assert.equal(JSON.parse(fitted.content[0].text).best_tested_parameters.gain_db, -3);
    const rea = await invoke('fourier_rea', { action: 'call', tool: 'binary_session', save_directory: directory }, {
      cwd: packageRoot, tools: [{ name: 'mcp' }], executeTool: async (name, args) => {
        assert.equal(name, 'mcp'); assert.equal(args.tool, 'rea_binary_session');
        return { isError: false, result: { content: [{ type: 'text', text: 'Fixture only, not live REA evidence' }] } };
      },
    });
    const artifact = JSON.parse(rea.content[0].text).artifact;
    assert.equal(JSON.parse(await readFile(artifact, 'utf8')).source, 'REA MCP');
    await invoke('fourier_rea', { action: 'attach', artifact_path: artifact, run_directory: output, claim: 'Fixture validates report wiring, not DSP behavior.', classification: 'hypothesis' }, { cwd: packageRoot });
    assert.match(await readFile(join(output, 'REPORT.md'), 'utf8'), /Fixture validates report wiring/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('JUCE scaffolding and validation through the actual Pi tools', { skip: !existsSync(loaderPath) }, async () => {
  const invoke = await loadFourier();
  const directory = await mkdtemp(join(tmpdir(), 'fourier-juce project-'));
  try {
    const doctor = JSON.parse((await invoke('fourier_juce', { action: 'doctor' })).content[0].text);
    assert.equal(doctor.native_build_verified, false);
    for (const kind of ['effect', 'instrument']) {
      const project = join(directory, kind);
      const args = { action: 'create', project_directory: project, name: `Test${kind}`, kind, manufacturer_code: 'Frer', plugin_code: kind === 'effect' ? 'Fxgn' : 'Syne' };
      const result = JSON.parse((await invoke('fourier_juce', args)).content[0].text);
      assert.equal(result.kind, kind);
      assert.match(await readFile(join(project, 'CMakeLists.txt'), 'utf8'), new RegExp(`IS_SYNTH ${kind === 'instrument' ? 'TRUE' : 'FALSE'}`));
      assert.ok(existsSync(join(project, '.gitignore')));
      await assert.rejects(invoke('fourier_juce', args));
    }
    const invalid = join(directory, 'invalid');
    await assert.rejects(invoke('fourier_juce', { action: 'create', project_directory: invalid, name: 'bad;injection', kind: 'effect', manufacturer_code: 'Frer', plugin_code: 'Fxgn' }));
    assert.equal(existsSync(invalid), false);
    await assert.rejects(invoke('fourier_juce', { action: 'build', project_directory: join(directory, 'effect'), juce_path: directory }));
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('opt-in native JUCE effect and instrument build/inspect/render through Pi tools', { skip: !process.env.FOURIER_JUCE_PATH, timeout: 2_200_000 }, async () => {
  const invoke = await loadFourier();
  const directory = join(packageRoot, '.fourier', `juce-native-${Date.now()}`);
  for (const kind of ['effect', 'instrument']) {
    const project = join(directory, kind);
    await invoke('fourier_juce', { action: 'create', project_directory: project, name: kind === 'effect' ? 'FourierGain' : 'FourierSine', kind, manufacturer_code: 'Frer', plugin_code: kind === 'effect' ? 'Fxgn' : 'Syne' });
    const built = JSON.parse((await invoke('fourier_juce', { action: 'build', project_directory: project, juce_path: process.env.FOURIER_JUCE_PATH,
      ...(process.env.FOURIER_JUCE_GENERATOR ? { generator: process.env.FOURIER_JUCE_GENERATOR } : {}), jobs: 2, timeout_seconds: 1000 })).content[0].text);
    assert.equal(built.installed, false);
    assert.ok(existsSync(built.plugin));
    await invoke('fourier_inspect', { plugin: built.plugin, out_directory: join(project, 'inspection') });
    const inspection = JSON.parse(await readFile(join(project, 'inspection/inspection.json'), 'utf8'));
    assert.equal(inspection.plugin.is_instrument, kind === 'instrument');
    assert.ok(Object.keys(inspection.plugin.parameters).length <= 4, 'read-only MIDI controller proxies excluded');
    assert.ok(Object.values(inspection.plugin.parameters).every(parameter => parameter.automatable));
    const gainKey = Object.keys(inspection.plugin.parameters).find(key => inspection.plugin.parameters[key].id === 'gain_db' || key.endsWith('_gain_db'));
    assert.ok(gainKey, 'JUCE gain parameter discovered');
    const cases = kind === 'effect' ? [
      { id: 'unity', stimulus: { kind: 'tone' } },
      { id: 'minus6', parameters: { [gainKey]: '-6.0' }, stimulus: { kind: 'tone' } },
    ] : [
      { id: 'no_midi', stimulus: { kind: 'midi', midi: [] } },
      { id: 'note', stimulus: { kind: 'midi', midi: [{ time: .1, data: [144, 60, 100] }, { time: .4, data: [128, 60, 0] }] } },
    ];
    await invoke('fourier_plan', { plugin: built.plugin, preset: kind === 'effect' ? 'effect' : 'generator', out_file: join(project, 'plan.json'), duration: .8, cases });
    const result = JSON.parse((await invoke('fourier_run', { spec_path: join(project, 'plan.json'), out_directory: join(project, 'run') })).content[0].text);
    assert.equal(result.completed, 2);
    const state = JSON.parse(await readFile(join(project, 'run/run.json'), 'utf8'));
    for (const entry of state.cases) {
      assert.equal(existsSync(join(project, 'run/cases', entry.id, 'native.input.f32')), false);
      assert.equal(existsSync(join(project, 'run/cases', entry.id, 'native.output.f32')), false);
      assert.ok(!Object.keys(entry.artifacts).some(name => name.endsWith('.f32')), 'only intentional artifacts checkpointed');
    }
    if (kind === 'effect') {
      assert.ok(Math.abs(state.cases[0].result.metrics.gain_db) < .001);
      assert.ok(Math.abs(state.cases[1].result.metrics.gain_db + 6) < .001);
    } else {
      assert.ok(state.cases[0].result.metrics.output[0].digital_silence);
      const peak = state.cases[1].result.metrics.output[0].peak_dbfs;
      assert.ok(Number.isFinite(peak) && peak > -50 && peak < 0);
      const traces = JSON.parse(await readFile(join(project, 'run/cases/note/traces.json'), 'utf8'));
      assert.equal(traces.rms_envelope.at(-1).output_rms_dbfs, null);
    }
    console.log(`JUCE ${kind} artifact: ${built.plugin}; measurements: ${project}/run/REPORT.md`);
  }
});

test('opt-in native parameter inspection through Pi tool', { skip: !process.env.FOURIER_INSPECT_PLUGIN }, async () => {
  const invoke = await loadFourier();
  const directory = join(packageRoot, '.fourier', `native-inspect-${Date.now()}`);
  await invoke('fourier_inspect', { plugin: process.env.FOURIER_INSPECT_PLUGIN, out_directory: directory });
  const inspection = JSON.parse(await readFile(join(directory, 'inspection.json'), 'utf8'));
  assert.equal(inspection.status, 'ok');
  assert.ok(Object.keys(inspection.plugin.parameters).length);
  console.log(`Native inspection artifact: ${directory}/inspection.json`);
});
