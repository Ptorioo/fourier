import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadAudio, saveAudio } from './archive.js';
import { amplitude, measure, spectrum } from './measure.js';
import { arraySha } from './io.js';
import { make, midiEvents } from './signals.js';
import { validate } from './runner.js';
import { execute } from './worker.js';

export function selfTest() {
  let tests = 0;
  const check = (fn: () => void) => { fn(); tests++; };
  const dir = mkdtempSync(join(tmpdir(), 'fourier-selftest-'));
  try {
    check(() => {
      const x = make({ kind: 'tone', frequency_hz: 997.3, level_dbfs: -18 }, 48000, 2, .1);
      assert.ok(Math.abs(amplitude(x[0], 48000, 997.3) - 10 ** (-18 / 20)) < 1e-7);
      const [m] = measure(x, x.map(ch => ch.map(v => v * 2)), 48000, { kind: 'tone', frequency_hz: 997.3 });
      assert.ok(Math.abs(m.gain_db! - 20 * Math.log10(2)) < 1e-5);
    });
    check(() => {
      for (const n of [32, 33, 101]) {
        const x = Float64Array.from({ length: n }, (_, i) => Math.sin(i * .5) + i / 20), [r, im] = spectrum(x);
        for (const k of [0, 1, 7, n - 1]) {
          let a = 0, b = 0; for (let j = 0; j < n; j++) { a += x[j] * Math.cos(2 * Math.PI * k * j / n); b -= x[j] * Math.sin(2 * Math.PI * k * j / n); }
          assert.ok(Math.abs(r[k] - a) < 1e-8); assert.ok(Math.abs(im[k] - b) < 1e-8);
        }
      }
    });
    check(() => {
      const a = make({ kind: 'noise', seed: 123 }, 48000, 2, .1), b = make({ kind: 'noise', seed: 123 }, 48000, 2, .1);
      assert.equal(arraySha(a), arraySha(b));
      const x = make({ kind: 'silence' }, 48000, 1, .1), [m, t] = measure(x, x, 48000, { kind: 'silence' });
      assert.equal(m.output[0].peak_dbfs, null); assert.ok(t.spectrum.every(p => p.dbfs === null));
    });
    check(() => {
      const x = make({ kind: 'multitone', tones: [{ frequency_hz: 700, channel: 0 }, { frequency_hz: 1400, channel: 1 }] }, 48000, 2, .1);
      assert.ok(amplitude(x[0], 48000, 700) > .12); assert.ok(amplitude(x[1], 48000, 700) < 1e-7);
      saveAudio(join(dir, 'audio.npz'), x, x, 48000);
      const archive = loadAudio(join(dir, 'audio.npz')); assert.equal(arraySha(archive.input), arraySha(x)); assert.equal(archive.sample_rate, 48000);
    });
    check(() => {
      assert.throws(() => validate({ plugin: 'builtin:gain', channels: true, cases: [{ id: 'x' }] }));
      assert.throws(() => validate({ plugin: 'builtin:gain', cases: [{ id: '../escape' }] }));
      assert.throws(() => validate({ plugin: 'builtin:gain', cases: [{ id: 'x', stimulus: { kind: 'multitone', tones: [] } }] }));
      assert.throws(() => midiEvents([{ time: 0, data: [0x90, 60, 255] }], 1));
      assert.throws(() => midiEvents([{ time: .5, data: [0x90, 60, 1] }, { time: 0, data: [0x80, 60, 0] }], 1));
    });
    check(() => {
      const result = execute({ operation: 'render', plugin: 'builtin:gain', output: dir, parameters: { gain_db: 6 }, sample_rate: 48000, channels: 2, duration: .1, buffer_size: 512, stimulus: { kind: 'tone' } });
      assert.ok(Math.abs(result.metrics!.gain_db! - 6) < 1e-5);
      assert.throws(() => execute({ operation: 'inspect', plugin: 'builtin:gain', output: dir, parameters: { mystery: 1 } }));
      const delayed = execute({ operation: 'render', plugin: 'builtin:delay', output: dir, parameters: { delay_samples: 123 }, sample_rate: 48000, channels: 1, duration: .1, buffer_size: 512, stimulus: { kind: 'impulse' } });
      assert.equal(delayed.metrics!.impulse_peak_lag_samples, 123);
    });
    check(() => {
      const synth = execute({ operation: 'render', plugin: 'builtin:synth', output: dir, parameters: {}, sample_rate: 48000, channels: 2, duration: .3, buffer_size: 512, stimulus: { kind: 'midi', midi: [{ time: .01, data: [144, 69, 100] }, { time: .2, data: [128, 69, 0] }] } });
      assert.ok(synth.metrics!.output[0].peak_dbfs! > -25);
    });
    return { status: 'ok', tests, native_plugins_loaded: 0 };
  } finally { rmSync(dir, { recursive: true, force: true }); }
}
