import { fields, integer, number, readWav } from './io.js';
import type { Audio, MidiEvent, Stimulus } from './types.js';

export function midiEvents(events: unknown, duration: number): MidiEvent[] {
  if (!Array.isArray(events) || events.length > 256) throw new Error('midi must be a list of at most 256 events');
  let previous = -1;
  return events.map(event => {
    const data = fields(event, ['time', 'data'], 'MIDI event'), time = number(data.time, 'MIDI time', 0, duration), bytes = data.data;
    if (!Array.isArray(bytes) || ![2, 3].includes(bytes.length) || bytes.some(b => !Number.isInteger(b) || b < 0 || b > 255) || bytes[0] < 0x80 || bytes[0] > 0xef || bytes.slice(1).some(b => b > 127) || bytes.length !== ([0xc, 0xd].includes(bytes[0] >> 4) ? 2 : 3)) throw new Error('Only well-formed channel MIDI messages with 7-bit data are accepted');
    if (time < previous) throw new Error('MIDI events must be ordered by time');
    previous = time; return { time, data: bytes as number[] };
  });
}
// Mulberry32 + Box-Muller: deterministic within this backend, not NumPy's PCG64 sequence.
function random(seed: number) {
  function uniform() { let t = seed = (seed + 0x6d2b79f5) >>> 0; t = Math.imul(t ^ t >>> 15, t | 1); t ^= t + Math.imul(t ^ t >>> 7, t | 61); return ((t ^ t >>> 14) >>> 0) / 4294967296; }
  return () => Math.sqrt(-2 * Math.log(Math.max(uniform(), 1e-30))) * Math.cos(2 * Math.PI * uniform());
}
export function make(stimulus: Stimulus, sr: number, channels: number, duration: number): Audio {
  fields(stimulus, ['kind', 'frequency_hz', 'level_dbfs', 'noise_rms_dbfs', 'seed', 'at_seconds', 'on_seconds', 'off_seconds', 'start_hz', 'end_hz', 'competitor_hz', 'competitor_dbfs', 'probe_dbfs', 'probe_kind', 'path', 'midi', 'tones'], 'stimulus');
  const kind = stimulus.kind ?? 'tone';
  if (!['silence', 'impulse', 'tone', 'multitone', 'noise', 'sweep', 'step_tone', 'resonance', 'wav', 'midi'].includes(kind)) throw new Error(`Unsupported stimulus: ${kind}`);
  if (stimulus.tones !== undefined && kind !== 'multitone') throw new Error('tones requires multitone stimulus');
  if (kind === 'multitone' && Object.keys(stimulus).some(k => !['kind', 'tones', 'noise_rms_dbfs', 'seed'].includes(k))) throw new Error('Multitone controls belong in individual tones');
  const n = Math.round(sr * duration);
  if (n < 32 || n * channels > 4_000_000) throw new Error('Stimulus guard: >=32 frames and <=4 million channel-samples');
  const f = number(stimulus.frequency_hz ?? 1000, 'frequency_hz', 10, sr * .45), level = 10 ** (number(stimulus.level_dbfs ?? -18, 'level_dbfs (peak)', -120, 0) / 20);
  const normal = random(integer(stimulus.seed ?? 12345, 'seed', 0, 2 ** 32 - 1));
  const audio = Array.from({ length: channels }, () => new Float64Array(n));
  const noise = (db: number) => {
    const x = Float64Array.from({ length: n }, normal);
    const rms = Math.sqrt(x.reduce((s, v) => s + v * v, 0) / n), scale = 10 ** (number(db, 'noise_rms_dbfs', -120, -6) / 20) / Math.max(rms, 1e-30);
    return x.map(v => v * scale);
  };
  if (kind === 'multitone') {
    if (!Array.isArray(stimulus.tones) || !stimulus.tones.length || stimulus.tones.length > 32) throw new Error('multitone requires 1..32 tones');
    for (const tone of stimulus.tones) {
      fields(tone, ['frequency_hz', 'level_dbfs', 'phase_degrees', 'channel', 'on_seconds', 'off_seconds'], 'tone');
      const hz = number(tone.frequency_hz, 'tone frequency_hz', 10, sr * .45), peak = 10 ** (number(tone.level_dbfs ?? -18, 'tone level_dbfs', -120, 0) / 20), phase = number(tone.phase_degrees ?? 0, 'phase_degrees', -360, 360) * Math.PI / 180;
      const on = number(tone.on_seconds ?? 0, 'tone on_seconds', 0, duration), off = number(tone.off_seconds ?? duration, 'tone off_seconds', 0, duration);
      if (Math.ceil(on * sr) >= Math.min(n, Math.ceil(off * sr))) throw new Error('Tone gate must contain at least one sample');
      if (tone.channel !== undefined) integer(tone.channel, 'tone channel', 0, channels - 1);
      for (let i = 0; i < n; i++) if (i / sr >= on && i / sr < off) for (let ch = 0; ch < channels; ch++) if (tone.channel === undefined || ch === tone.channel) audio[ch][i] += peak * Math.sin(2 * Math.PI * hz * i / sr + phase);
    }
    if (stimulus.noise_rms_dbfs !== undefined) { const x = noise(stimulus.noise_rms_dbfs); for (const ch of audio) for (let i = 0; i < n; i++) ch[i] += x[i]; }
    return audio.map(ch => Float32Array.from(ch));
  }
  let x = audio[0];
  if (['tone', 'step_tone', 'resonance'].includes(kind)) {
    let on = 0, off = duration;
    if (kind === 'step_tone' || kind === 'resonance' && (stimulus.on_seconds !== undefined || stimulus.off_seconds !== undefined)) {
      on = number(stimulus.on_seconds ?? duration / 3, 'on_seconds', 0, duration); off = number(stimulus.off_seconds ?? duration * 2 / 3, 'off_seconds', 0, duration);
      if (on >= off) throw new Error('on_seconds must precede off_seconds');
    }
    const frequencies = [f];
    let cf = 0, cl = 0;
    if (kind === 'resonance' && stimulus.competitor_hz !== undefined) { cf = number(stimulus.competitor_hz, 'competitor_hz', 10, sr * .45); cl = 10 ** (number(stimulus.competitor_dbfs ?? -18, 'competitor_dbfs', -120, 0) / 20); frequencies.push(cf); }
    let background: Float64Array | undefined;
    if (kind === 'resonance') {
      background = noise(stimulus.noise_rms_dbfs ?? -36);
      const bins = new Set(frequencies.flatMap(hz => { const k = Math.round(hz * n / sr); return [Math.max(0, k - 1), k, k + 1]; }));
      for (const k of bins) {
        let sine = 0, cosine = 0;
        for (let i = 0; i < n; i++) { const phase = 2 * Math.PI * k * i / n; sine += background[i] * Math.sin(phase); cosine += background[i] * Math.cos(phase); }
        for (let i = 0; i < n; i++) { const phase = 2 * Math.PI * k * i / n; background[i] -= (k === 0 ? cosine : 2 * (sine * Math.sin(phase) + cosine * Math.cos(phase))) / n; }
      }
      const rms = Math.sqrt(background.reduce((s, v) => s + v * v, 0) / n), target = 10 ** ((stimulus.noise_rms_dbfs ?? -36) / 20);
      background = background.map(v => v * target / Math.max(rms, 1e-30));
    }
    for (let i = 0; i < n; i++) if (i / sr >= on && i / sr < off) x[i] = level * Math.sin(2 * Math.PI * f * i / sr) + cl * Math.sin(2 * Math.PI * cf * i / sr) + (background?.[i] ?? 0);
  } else if (kind === 'noise') x = noise(stimulus.noise_rms_dbfs ?? -24);
  else if (kind === 'impulse') {
    const at = Math.round(number(stimulus.at_seconds ?? Math.min(.1, duration / 4), 'at_seconds', 0, duration) * sr);
    if (at >= n) throw new Error('Impulse must occur before duration ends'); x[at] = level;
  } else if (kind === 'sweep') {
    const start = number(stimulus.start_hz ?? 20, 'start_hz', 10, sr * .45), end = number(stimulus.end_hz ?? Math.min(20000, sr * .4), 'end_hz', start + 1, sr * .49), k = Math.log(end / start) / duration, fade = Math.min(Math.round(.01 * sr), Math.floor(n / 4));
    for (let i = 0; i < n; i++) x[i] = level * Math.sin(2 * Math.PI * start * Math.expm1(k * i / sr) / k) * (i < fade ? i / (fade - 1) : i >= n - fade ? (n - 1 - i) / (fade - 1) : 1);
  } else if (kind === 'wav') {
    if (typeof stimulus.path !== 'string') throw new Error('WAV path required');
    const [wav, rate] = readWav(stimulus.path);
    if (rate !== sr || wav.length !== channels) throw new Error('WAV must match sample_rate/channels; no implicit resampling or downmixing');
    if (wav[0].length > n) throw new Error('WAV is longer than duration; explicit trimming required');
    return wav.map(ch => { const out = new Float32Array(n); out.set(ch); return out; });
  } else if (kind === 'midi') midiEvents(stimulus.midi ?? [], duration);
  const out = Array.from({ length: channels }, () => Float32Array.from(x));
  if (stimulus.probe_kind !== undefined && stimulus.probe_dbfs === undefined) throw new Error('probe_kind requires probe_dbfs');
  if (stimulus.probe_dbfs !== undefined) {
    if (channels !== 2 || kind !== 'resonance') throw new Error('Quiet probe requires stereo resonance stimulus');
    const probe = 10 ** (number(stimulus.probe_dbfs, 'probe_dbfs', -120, -30) / 20);
    if ((stimulus.probe_kind ?? 'tone') === 'tone') out[1] = Float32Array.from({ length: n }, (_, i) => probe * Math.sin(2 * Math.PI * f * i / sr));
    else if (stimulus.probe_kind === 'noise') out[1] = Float32Array.from(noise(stimulus.probe_dbfs));
    else throw new Error('probe_kind must be tone (peak dBFS) or noise (RMS dBFS)');
  }
  return out;
}
