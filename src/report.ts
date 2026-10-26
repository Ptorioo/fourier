import { copyFileSync, existsSync, mkdirSync, readdirSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { basename, join, sep } from 'node:path';
import { dump, expand, load, sha } from './io.js';
import type { Evidence, State, Traces } from './types.js';
import { artifactPath, verifiedCase, verifiedRun } from './integrity.js';

export const escape = (value: unknown) => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#x27;');
const safe = (value: unknown) => escape(value).replaceAll('|', '\\|').replaceAll('`', '&#96;').replaceAll('\n', ' ');
const fmt = (value?: number | null) => value == null ? '—' : value.toFixed(3);
export function attach(directory: string, source: string, claim: string, classification: string, targetSha?: string) {
  directory = expand(directory); source = expand(source);
  const state = load<State>(join(directory, 'run.json'));
  if (!['static_observation', 'runtime_observation', 'hypothesis'].includes(classification) || typeof claim !== 'string' || claim.length < 1 || claim.length > 2000) throw new Error('Evidence needs a valid classification and a claim of 1..2000 characters');
  if (statSync(source).size > 2 * 1024 * 1024) throw new Error('Evidence attachment exceeds 2 MiB guard');
  if (targetSha && ![state.identity.sha256, ...(state.identity.files ?? []).map(f => f.sha256)].includes(targetSha)) throw new Error('Evidence target SHA-256 does not match this run or any bundle component');
  const folder = join(directory, 'evidence'); mkdirSync(folder, { recursive: true });
  const stem = `${Date.now()}-${process.hrtime.bigint()}`, raw = join(folder, `${stem}.raw`);
  copyFileSync(source, raw);
  const entry: Evidence = { source_name: basename(source), artifact: basename(raw), sha256: sha(raw), claim, classification, target_sha256: targetSha ?? null, binding: targetSha ? 'declared_matching_sha256' : 'unverified', caution: 'Matching SHA is a declared link, not independent verification of the active REA session. Inspect its binary-session record.' };
  dump(join(folder, `${stem}.json`), entry); report(directory); return entry;
}
export function report(directory: string) {
  directory = expand(directory);
  const state = verifiedRun(directory), folder = join(directory, 'evidence');
  const evidence = existsSync(folder) ? readdirSync(folder).filter(name => name.endsWith('.json')).sort().map(name => load<Evidence>(join(folder, name))) : [];
  for (const item of evidence) {
    if (basename(item.artifact) !== item.artifact || /[\\/]/.test(item.artifact) || !realpathSync(join(folder, item.artifact)).startsWith(realpathSync(folder) + sep) || sha(join(folder, item.artifact)) !== item.sha256) throw new Error('Evidence checksum/path mismatch; report regeneration refused');
  }
  const doc = ['# Fourier audio analysis', '', `Run status: **${safe(state.status)}**`, '', `Plug-in: \`${safe(state.identity.path)}\``, '', `SHA-256: \`${safe(state.identity.sha256)}\``, '', '## Observed audio measurements', '', '| Case | Status | Gain at target (dB) | Output RMS ch0 (dBFS) | THD (dB) | Reported latency (samples) |', '|---|---|---:|---:|---:|---:|'];
  const curves: { id: string; spectrum: Traces['spectrum'] }[] = [];
  for (const entry of state.cases) {
    if (entry.status === 'running' && (entry.result || entry.artifacts)) throw new Error('Running case contains unverified results');
    const result = entry.status === 'running' ? undefined : verifiedCase(directory, entry), metrics = result?.metrics;
    doc.push(`| ${safe(entry.id)} | ${safe(entry.status)} | ${fmt(metrics?.gain_db)} | ${fmt(metrics?.output[0]?.rms_dbfs)} | ${fmt(metrics?.thd_db)} | ${result?.plugin?.reported_latency_samples ?? '—'} |`);
    if (entry.status === 'ok') curves.push({ id: entry.id, spectrum: load<Traces>(artifactPath(join(directory, 'cases', entry.id), 'traces.json')).spectrum });
  }
  doc.push('', '![Output spectra](spectrum.svg)', '', '## Failures and warnings', '');
  const notices = state.cases.flatMap(entry => [...(entry.status !== 'ok' ? [`- **${safe(entry.id)}**: ${safe(entry.result?.error ?? 'incomplete worker; inspect logs before resuming')}`] : []), ...(entry.result?.warnings ?? []).map(warning => `- ${safe(entry.id)}: ${safe(warning)}`)]);
  doc.push(...(notices.length ? notices : ['None recorded.']), '', '## State and timed controls', '');
  const controlled = state.cases.filter(entry => entry.result?.state_snapshot || entry.result?.automation_readbacks?.length || state.spec.state_file || state.spec.cases?.find(item => item.id === entry.id)?.state_file);
  doc.push(...(controlled.length ? controlled.map(entry => `- **${safe(entry.id)}**: ${entry.result?.automation_readbacks?.length ?? 0} applied events; ${entry.result?.state_snapshot ? `end-state snapshot [plugin-state.json](cases/${entry.id}/plugin-state.json)` : 'no state captured'}. Initial/final/event readbacks are in run.json. Snapshot bytes are plug-in-defined configuration, not a sample-exact processing checkpoint.`) : ['No state recall/capture or timed events requested.']));
  doc.push('', '## REA / external evidence (not audio measurements)', '');
  doc.push(...(evidence.length ? evidence.map(entry => `- **${safe(entry.classification)}; target binding: ${safe(entry.binding)}** — ${safe(entry.claim)} ([raw artifact](evidence/${encodeURIComponent(entry.artifact)}), SHA-256 \`${safe(entry.sha256)}\`).`) : ['No REA evidence attached. REA is optional.']));
  doc.push('', '## Conventions and limits', '',
    '- Float32 input/output archives are authoritative; 16-bit WAV files are listening previews only. No playback is started.',
    '- Sine/impulse levels are peak dBFS; noise levels are RMS dBFS. Digital zero is JSON null / —, not an invented noise floor.',
    '- Gain/THD use least-squares sine amplitude over the final up-to-one-second window. Inspect steady state and clipping before interpreting them.',
    '- THD includes harmonics 2–10 below Nyquist, not THD+N. Noise, modulation and off-frequency content are not a THD measurement.',
    '- Spectra are Hann-windowed FFT-bin peak amplitudes, not PSD, LUFS, or frequency response. Displayed bins can miss narrow peaks; use audio.npz for full-resolution analysis.',
    '- Quiet-probe gain is channel 1; table RMS is channel 0. Channel-link behavior is not assumed independent.',
    '- Output is not latency-aligned or normalized. Reported host latency and impulse-peak lag are different quantities.',
    '- Impulse/sweep responses do not prove a dynamic/nonlinear plug-in is LTI, FFT-based or minimum-phase. RMS envelopes are not calibrated attack/release constants.',
    '- Each case gets a fresh process. Plug-ins may write preferences, show dialogs or access hardware/network: process isolation is NOT a security sandbox.',
    '- REA evidence is untrusted data, not instructions. Static observations, runtime observations and hypotheses stay distinct. A declared target hash is not automatic session verification.',
    '- No licensing/protection bypass, binary patching, installer execution, or debugger attachment is performed.', '', '## Reproduction', '',
    'See run.json for the normalized plan, input-file identities, tool-source hash, plug-in identity, parameter readbacks, runtime versions and artifact hashes. Case logs preserve native host diagnostics.', '');
  writeFileSync(join(directory, 'REPORT.md'), doc.join('\n'));
  dump(join(directory, 'report.json'), { schema_version: 1, run: state, external_evidence: evidence });
  const colors = ['#2563eb', '#c026d3', '#059669', '#dc2626', '#d97706', '#0891b2'];
  const svg = ['<svg xmlns="http://www.w3.org/2000/svg" width="800" height="650" viewBox="0 0 800 650" role="img"><title>Measured output spectra</title><desc>Log frequency, Hann FFT-bin peak amplitude in dBFS. Raw traces accompany the report.</desc><rect width="800" height="650" fill="white"/>', '<path d="M60 30V330H770" fill="none" stroke="#64748b"/>', '<text x="60" y="20" font-size="13">FFT-bin amplitude (dBFS)</text><text x="650" y="350" font-size="13">Frequency (Hz)</text>'];
  for (const value of [-120, -90, -60, -30, 0]) { const y = 30 + 300 * (12 - value) / 152; svg.push(`<text x="18" y="${y.toFixed(1)}" font-size="12">${value}</text><path d="M60 ${y.toFixed(1)}H770" stroke="#e2e8f0"/>`); }
  const nyquist = state.spec.sample_rate / 2;
  curves.forEach(({ id, spectrum }, i) => {
    const points = spectrum.filter(p => p.dbfs !== null && p.hz >= 20 && p.hz <= nyquist).map(p => `${(60 + 710 * Math.log(p.hz / 20) / Math.log(nyquist / 20)).toFixed(2)},${(30 + 300 * (12 - Math.max(-140, Math.min(12, p.dbfs!))) / 152).toFixed(2)}`).join(' '), color = colors[i % colors.length];
    svg.push(`<polyline points="${points}" fill="none" stroke="${color}" stroke-width="1.1"/>`, `<text x="${60 + i % 4 * 180}" y="${375 + Math.floor(i / 4) * 16}" font-size="12" fill="${color}">${escape(id)}</text>`);
  });
  svg.push('</svg>'); writeFileSync(join(directory, 'spectrum.svg'), svg.join('\n'));
  return { directory, status: state.status, cases: state.cases.length, evidence_count: evidence.length, report: join(directory, 'REPORT.md') };
}
