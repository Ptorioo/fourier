import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { create, build, dspVariants } from '../dist/juce.js';
import { inspect, run, validate } from '../dist/runner.js';
import { dump, packageRoot } from '../dist/io.js';
import { archive } from '../dist/compare.js';

// Opt-in: real compiler/JUCE/trusted native plug-ins. Evidence stays under .fourier.
test('native automation/state and all generated DSP variants', { skip: !process.env.FOURIER_STARTER_JUCE_PATH, timeout: 2_200_000 }, async () => {
  const root = join(packageRoot, '.fourier', `starter-validation-${Date.now()}`); mkdirSync(root, { recursive: true });
  for (const kind of ['effect', 'instrument']) {
    const project = join(root, kind), variants = dspVariants.filter(dsp => (kind === 'instrument') === ['sine', 'subtractive'].includes(dsp));
    create(project, kind === 'effect' ? 'StarterEffect' : 'StarterSynth', kind, 'Frer', kind === 'effect' ? 'Stef' : 'Stsy');
    for (const dsp of variants) {
      // Reuse JUCE compilation: only the generated header and processor TU change.
      const header = join(project, 'StarterDSP.h'), id = dspVariants.indexOf(dsp);
      writeFileSync(header, readFileSync(header, 'utf8').replace(/#define FOURIER_STARTER \d+/, `#define FOURIER_STARTER ${id}`));
      const built = build(project, { juce_path: process.env.FOURIER_STARTER_JUCE_PATH, generator: 'Ninja', jobs: 2 }), evidence = join(root, dsp); mkdirSync(evidence);
      const inspection = await inspect(built.plugin, join(evidence, 'inspection'));
      assert.equal(inspection.status, 'ok'); const gain = Object.keys(inspection.plugin.parameters).find(key => key.endsWith('_gain_db'));
      assert.ok(gain);
      for (const [sr, channels, buffer] of [[48000, 2, 257], [44100, 1, 64]]) {
        const folder = join(evidence, `${sr}-${channels}`); mkdirSync(folder);
        const stimulus = kind === 'effect' ? { kind: 'tone', frequency_hz: 1000, level_dbfs: -6 } : { kind: 'midi', midi: [{ time: .05, data: [144, 60, 100] }, { time: .12, data: [144, 67, 80] }, { time: .2, data: [224, 0, 96] }, { time: .25, data: [176, 64, 127] }, { time: .3, data: [128, 60, 0] }, { time: .32, data: [128, 67, 0] }, { time: .4, data: [176, 64, 0] }, { time: .7, data: [176, 120, 0] }] };
        const base = validate({ plugin: built.plugin, sample_rate: sr, channels, buffer_size: buffer, duration: 1, save_state: true, cases: [
          { id: 'default', stimulus, ...(dsp === 'limiter' ? { parameters: { [gain]: 1 } } : {}) }, { id: 'silent', stimulus: kind === 'effect' ? { kind: 'silence' } : { kind: 'midi', midi: [] } },
          { id: 'changed', stimulus, automation: [{ time: .155125, parameters: { [gain]: .5 } }, { time: .155125, parameters: { [gain]: .6 } }] },
        ] });
        const spec = join(folder, 'plan.json'); dump(spec, base); const state = await run(spec, join(folder, 'run'));
        assert.equal(state.status, 'ok', JSON.stringify(state.cases));
        assert.equal(state.cases[1].result.metrics.output[0].digital_silence, true);
        assert.equal(state.cases[2].result.automation_readbacks.length, 2);
        assert.equal(state.cases[2].result.automation_readbacks[0].sample, Math.round(.155125 * sr));
        const readback = state.cases[2].result.plugin.parameters[gain].raw_value; assert.ok(Math.abs(readback - .6) < .002);
        assert.notEqual(state.cases[0].result.output_sha256, state.cases[2].result.output_sha256);
        if (dsp === 'gain') assert.ok(Math.abs(state.cases[0].result.metrics.gain_db) < .001);
        if (dsp === 'limiter') assert.ok(state.cases.every(c => c.result.metrics.output.every(ch => ch.peak_dbfs === null || ch.peak_dbfs <= -1 + .0001)));
        if (kind === 'instrument') { const a = archive(join(folder, 'run'), 'default'); assert.ok(a.output[0].some(v => v !== 0)); assert.ok(a.output[0].subarray(Math.round(.9 * sr)).every(v => v === 0)); }
        const snap = join(folder, 'run/cases/changed/plugin-state.json');
        dump(spec, { ...base, state_file: snap, save_state: false, cases: [{ id: 'restored', stimulus }] });
        const restored = await run(spec, join(folder, 'restored')); assert.equal(restored.status, 'ok');
        assert.ok(Math.abs(restored.cases[0].result.initial_plugin.parameters[gain].raw_value - readback) < 1e-6);
        dump(spec, { ...base, state_file: snap, parameters: { [gain]: 5 / 6 }, save_state: false, cases: [{ id: 'override', stimulus }] });
        const override = await run(spec, join(folder, 'override')); assert.equal(override.status, 'ok');
        assert.ok(Math.abs(override.cases[0].result.initial_plugin.parameters[gain].raw_value - 5 / 6) < .002);
      }
    }
  }
  console.log(`Native starter evidence: ${root}`);
});
