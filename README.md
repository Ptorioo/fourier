# Fourier — audio analysis and JUCE development for Pi

`@ptorioo/fourier` is a local Pi package for measuring **audio effects and MIDI generators**, and writing **JUCE VST3 effects and instruments**, with editable C++ projects, local builds, reproducible test signals and evidence-backed reports.

- Filesystem-only VST3/AU discovery and isolated parameter inspection.
- Seeded silence, impulses, tones, noise, sweeps, independently gated/phase-controlled multitone and stereo probes, PCM WAV input and raw MIDI events.
- One disposable native process per render; timeouts, cancellation, logs, checkpoints, explicit retries and identity-checked resume.
- Float32 audio archives, optional listening previews, gain/THD/level measurements, RMS envelopes, Markdown/JSON reports and SVG spectra.
- Optional **REA MCP** discovery/static inspection and evidence attachments. Measurements, static/runtime observations and hypotheses stay separate.
- Analytical built-in effects/instrument for calibration without loading any vendor plug-in.
- Reusable paired reference/candidate suites, bounded grid fitting with held-out cases, and specialized dynamics/distortion/decay analysis.
- Timed parameter events and identity/settings-bound state capture/recall, with archived readbacks and resume checks.
- JUCE gain/filter-EQ/compressor/saturation/delay effects and sine/subtractive instruments, local CMake builds and build-to-inspect/render workflow.
- Capability-checked native-host selection, reusable EQ response/phase measurements and declarative pass/fail checks.
- Bounded isolated-band EQ surrogate fitting and sampled control-mapping hypotheses with held-out checks.

No separate GUI builder, playback, cloud service, dependency installation on package load, or automatic binary patching/debugger attachment. Starters use JUCE's generic editor; editable projects can implement custom interfaces. See [Write VST3 plug-ins with JUCE](#write-vst3-plug-ins-with-juce) for the included starter workflow.

## Requirements and setup

Node **22.2+**. The CLI, DSP, archive handling, reporting and Pi tools are TypeScript; no Python, NumPy or Pedalboard installation is required. Native VST3/AU hosting uses a small optional **C++ JUCE helper**, built against your local JUCE checkout with CMake 3.22+ and a C++17 compiler. Built-ins and PCM WAV analysis need no native build. Tested on Windows x64 with Pi 1.4.0 and JUCE 8.0.7; macOS/Linux have not been exercised here. Audio Units require macOS; VST2/AAX/CLAP/DAW scripting are not implemented.

From this directory:

```powershell
npm install
npm run setup
npm run doctor
npm test
pi install path/to/fourier
```

Reload Pi (`/reload`) or start a new session. Use `/fourier` for a summary, `/skill:audio-analysis` for measurements, or `/skill:juce-development` for writing plug-ins. `pi install` registers the local package; this repository has not been published to npm. Setup compiles the TypeScript backend into `dist/`; `npm test` runs the checks. Nothing is installed globally. Published/packed packages include compiled JavaScript and a content-hash build stamp, so unchanged packages do not need a compiler at runtime.

For trusted native plug-ins, build the optional host once in a compiler developer shell:

```powershell
npm run setup:native -- --juce D:/SDKs/JUCE --generator Ninja --jobs 2
npm run doctor
```

Use a supported Visual Studio generator instead of Ninja when not in a developer shell. The host is found at `<package>/native/build/fourier-host[.exe]`, independent of the invocation cwd. Host selection is: explicit operation override → plan/suite `native_host` → `FOURIER_NATIVE_HOST` → package default, where applicable. Pi `doctor`, `inspect`, `plan`, `run`, `match` and EQ identification accept `native_host`; CLI equivalents accept `--native-host PATH`. A selected missing/incompatible helper is an error, never a reason to silently switch helpers.

`doctor` runs only the selected helper's `--capabilities` handshake, not any plug-in. It reports protocol/version, inspect/render/state/automation flags, resolved path/hash and `host_error`. Check `plugins_ready`, plus `state_ready`/`automation_ready` before those features. Executable presence alone is not readiness; old helpers must be rebuilt from current source. Plans/runs record the selected host in provenance; changing it requires a new run rather than resuming old evidence. Built-ins and WAV analysis need no helper even if native readiness is false. No SDK downloads, system plug-in installation or Python environment are involved. Review your local JUCE licence before distributing native builds.

## Quick start in Pi

Use the structured `fourier_*` tools directly—no shell commands, handwritten
plan JSON, or repeated `fourier.mjs` argument lists are needed. For example:

```javascript
fourier_doctor({})
fourier_plan({ plugin: 'builtin:gain', preset: 'effect', out_file: 'runs/eq-plan.json' })
fourier_run({ spec_path: 'runs/eq-plan.json', out_directory: 'runs/eq' })
fourier_eq({ run_directory: 'runs/eq', out_directory: 'runs/eq-response' })
```

These are Pi tool calls, not a script to paste into a shell. Ask Pi for the
measurement you want; the extension supplies the typed tools. It uses the
shared Node backend internally, but Pi does not need to compose CLI commands.
Use `fourier_juce` for project creation/builds and `fourier_report` to regenerate
verified reports. If tools are missing, install/reload the extension rather
than falling back to shell-based analysis. See [Pi tools](#pi-tools) below.

## Quick start without Pi

These examples use built-ins and load no third-party binary:

```powershell
node scripts/fourier.mjs init --plugin builtin:gain --preset effect --out runs/effect-plan.json
node scripts/fourier.mjs run --spec runs/effect-plan.json --out runs/effect-demo
node scripts/fourier.mjs init --plugin builtin:synth --preset generator --out runs/generator-plan.json
node scripts/fourier.mjs run --spec runs/generator-plan.json --out runs/generator-demo
```

Open `runs/effect-demo/REPORT.md` and `spectrum.svg`. To use a real plug-in:

```powershell
node scripts/fourier.mjs discover
node scripts/fourier.mjs inspect --plugin 'C:/path/Effect.vst3' --out runs/inspection
node scripts/fourier.mjs init --plugin 'C:/path/Effect.vst3' --preset effect --out effect-plan.json
# Read inspection.json; edit the plan with exact exposed parameters.
node scripts/fourier.mjs run --spec effect-plan.json --out runs/my-effect
```

For an instrument, use `--preset generator`. A Windows VST3 bundle is resolved to its current-architecture native binary. Multi-plugin files may need `--plugin-name` for inspection and `plugin_name` in the plan. Never select an installer. Discovery does not load plug-ins; inspection/rendering do execute third-party code.

The npm executable is `fourier-audio` when this package is installed. Before launching a backend operation, both Pi tools and the CLI verify hashes of backend TypeScript, build configuration and compiled outputs. Missing/stale `dist/` is rebuilt automatically using the local TypeScript compiler; failed compilation blocks launch rather than using old code. Nothing is downloaded. If build dependencies are absent, the error asks you to install them and run `npm run build`. Explicit `npm run build`/`npm run setup` still work; disposable workers execute the verified JavaScript from `dist/`.

## Pi tools

| Tool | Purpose |
| --- | --- |
| `fourier_doctor` | Check Node and selected native-helper protocol/capabilities without loading plug-ins |
| `fourier_discover` | Find VST3/AU candidates without executing them |
| `fourier_inspect` | Isolated load, parameter metadata/readbacks, identity, instrument flag |
| `fourier_plan` | Validated, non-overwriting plan from typed parameters, cases and render settings |
| `fourier_run` | Render a plan, checkpoint and report |
| `fourier_analyze` | Measure existing PCM WAVs, optionally against an aligned reference |
| `fourier_compare` | Verify archives; channel gains, complex H1/coherence, spectral-bin levels, band envelopes and candidate null errors |
| `fourier_characterize` | Offline RMS/gain trajectories, coherent THD/selected IMD, impulse energy-decay fits |
| `fourier_eq` | Verified impulse/noise EQ gain, wrapped phase, coherence and measured grid extrema |
| `fourier_verify` | Declarative inclusive bounds for gain/level/latency/EQ/candidate-null metrics |
| `fourier_eq_identify` | Create/run/reanalyze explicit isolated-band suites; bounded RBJ models and local control laws |
| `fourier_match` | Create/run paired suites; fit a bounded parameter grid, then evaluate held-out cases |
| `fourier_report` | Rebuild reports without loading a plug-in |
| `fourier_rea` | Optional MCP discovery/read-only calls and external-evidence attachments |
| `fourier_juce` | Check the local build environment, create an effect/instrument project, or build its VST3 |

## Write VST3 plug-ins with JUCE

JUCE authoring additionally needs **CMake 3.22+**, a **C++17 compiler** and a
**local JUCE source checkout**. No SDK is downloaded, copied into projects or
installed by Fourier. Windows builds need a supported Visual Studio generator,
or Ninja with Pi launched from a VS developer shell. macOS needs Xcode tools;
Linux needs JUCE's native audio/GUI development libraries. See the local JUCE
checkout's documentation and licence before distributing your plug-in.

```js
fourier_juce({ action: 'doctor', juce_path: 'D:/SDKs/JUCE' })
fourier_juce({
  action: 'create', project_directory: 'plugins/MyEffect', name: 'MyEffect',
  kind: 'effect', manufacturer_code: 'Acme', plugin_code: 'Gain'
})
// Read/edit PluginProcessor.cpp and .h with Pi's normal file tools.
fourier_juce({
  action: 'build', project_directory: 'plugins/MyEffect', juce_path: 'D:/SDKs/JUCE',
  configuration: 'Release', jobs: 2, timeout_seconds: 1800
})
// Use the returned plugin path, not a system installation:
fourier_inspect({ plugin: '<returned plugin path>', out_directory: 'runs/my-inspection' })
```

Use `kind: 'instrument'`, a different `name` and unique `plugin_code` for a MIDI
instrument. Optional `dsp` selects `gain` (default effect), `filter` (low/high-pass
or peak EQ), `compressor` (linked peak/soft knee), `saturation` (tanh), `delay`
(fractional feedback), `sine` (default instrument), or `subtractive` (polyBLEP
saw/square/sine → one-pole low-pass → ADSR). Each instrument has eight voices,
velocity, sustain and stealing; subtractive adds ±2-semitone pitch bend and CC1
vibrato. All have mono/stereo output, smoothed gain, generic editor and APVTS state.

```js
fourier_juce({ action: 'create', project_directory: 'plugins/Subtractive', name: 'Subtractive',
  kind: 'instrument', dsp: 'subtractive', manufacturer_code: 'Acme', plugin_code: 'Subt' })
```

These are editable **teaching algorithms**, not production processors or recovered
vendor DSP. Saturation has no oversampling; delay-time modulation changes pitch;
filter-mode and synth controls can click; the synth has no resonant filter/MPE.
Read the generated README for algorithms, smoothing, latency/tails and quality
limits. Edit `PluginProcessor.cpp`/`.h`, `StarterDSP.h` and `SubtractiveVoice.h`;
only the selected variant compiles in. Existing creation calls still default to
gain/sine, and no dependency or custom UI has been added.

Names are 1–48 alphanumeric characters starting with a letter. The two identity
codes must each be four alphanumeric characters starting with a letter; assign
your own unique identities and company/bundle metadata before release. Creation
requires a **new directory** and never replaces an existing project's source.
Builds accept generated projects with `fourier-project.json`, reuse `build/`,
and return `plugin`, `configure_log` and `build_log`. `generator` optionally selects
a CMake generator; changing it may require a separately reviewed cache cleanup.
Do not silently delete a user's build or source tree.

The Pi tool's `timeout_seconds` covers the whole operation (10–3600 seconds,
default 1800); cancellation/timeouts use the existing process-tree cleanup and
retain build logs. A failed build is an error, not a successful artifact. There
are no automatic retries. **Build only trusted source/SDKs:** CMake, compiler
hooks and JUCE manifest generation execute native code. No system plug-in copy,
installer, signing/notarization, custom GUI or non-VST3 build is provided.

Then `fourier_plan` (`preset: 'effect'` or `'generator'`) → `fourier_run` →
`fourier_compare` validates the local build using inspected parameter names.
No playback starts. For CLI use, pass an options object on stdin to
`node scripts/fourier.mjs juce create --options-stdin` or `juce build --options-stdin`;
`juce doctor` works without stdin. The CLI retains its 10-minute outer limit;
long builds can use the Pi tool or the generated README's direct CMake commands.

### Investigate through tools, without editing JSON

`fourier_plan` uses `preset: 'effect'` for all audio effects (EQ/filter, dynamics, distortion, delay/reverb, etc.) and `preset: 'generator'` for MIDI instruments. There are no separate effect-type presets. It accepts the plan's `parameters`, `cases`, `sample_rate`, `channels`, `duration`, `buffer_size`, `timeout_seconds` and optional `plugin_name` directly. Case parameters override global parameters. Inspect a real plug-in first; controls below belong to the analytical built-in only.

```js
fourier_plan({
  plugin: 'builtin:gain', preset: 'effect', out_file: 'runs/probe-plan.json',
  duration: 0.3, parameters: { gain_db: -6 },
  cases: [
    { id: 'tone', stimulus: { kind: 'tone', frequency_hz: 1000 } },
    { id: 'probe', stimulus: { kind: 'resonance', probe_kind: 'noise', probe_dbfs: -66,
      on_seconds: 0.1, off_seconds: 0.2 } },
    { id: 'two_tones', stimulus: { kind: 'multitone', tones: [
      { frequency_hz: 1000, level_dbfs: -42, channel: 1 },
      { frequency_hz: 1100, level_dbfs: -18, channel: 0,
        phase_degrees: 90, on_seconds: 0.1, off_seconds: 0.2 }
    ] } }
  ]
})
fourier_run({ spec_path: 'runs/probe-plan.json', out_directory: 'runs/probe' })
fourier_compare({
  run_directory: 'runs/probe', out_directory: 'runs/probe-comparison',
  case_ids: ['tone', 'probe'], frequencies_hz: [500, 1000, 2000],
  band_hz: [900, 1100], times_seconds: [0.15, 0.25], window_ms: 80
})
```

These are Pi tool arguments, not a new analysis program. `fourier_compare` writes `comparison.json` and `COMPARISON.md` in a fresh directory. It verifies run fingerprints, artifact hashes and array digests, never loads a plug-in, and handles 1–16 cases with up to 32 frequencies/times each. Tone gain is null for multitone signals, noise probes, silence or a left-driver window spanning its gate. Default `window_seconds` is the final up-to-one-second window. Requested frequencies are evaluated at the nearest FFT bin (actual `bin_hz` is recorded).

For an independent candidate, render a second plan with the **same case IDs and exactly identical input arrays**, then pass its `candidate_run` to `fourier_compare`. It reports raw output-difference levels and relative error, rejecting mismatched inputs/rates/lengths. Neither audio is normalized. Optional integer `lag_samples` aligns reference output to input; `candidate_lag_samples` aligns candidate output to reference output. Positive means the output is delayed; defaults are zero, not reported plug-in latency. Time windows refer to the aligned input. Confirm alignment independently before interpreting null errors.

H1 gain, wrapped `h1_phase_degrees`, coherence and Hann-windowed band-energy ratios are descriptive measurements, **not** proof of LTI behavior, FFT internals or calibrated attack/release constants. Phase includes uncompensated delay and is not group delay or a minimum-phase classification. Use an excited, settled signal and check coherence; coherence is null with only one segment. `input_bin_peak_dbfs` and `output_bin_peak_dbfs` are averaged Hann-windowed, sine-equivalent bin amplitudes, not PSD. They remain available when input excitation is insufficient for H1, but a peak alone does not establish harmonic/intermodulation attribution; use baseline and leakage controls. A quiet right probe can reveal a linked gain curve while the loud left driver controls detection; it does not imply an independent right-channel detector. Hash checks detect accidental artifact changes, not maliciously rewritten history.

The CLI also accepts JSON options through `--options FILE` or bounded `--options-stdin` (mutually exclusive) for `init`, `compare`, `characterize`, `eq`, `verify`, `eq-identify`, `match` and `juce`. Pi tools use stdin automatically; no one-off analysis script or temporary options file is required.

### Reusable EQ measurements and pass/fail checks

```js
fourier_plan({
  plugin: 'builtin:gain', preset: 'effect', out_file: 'runs/eq-plan.json',
  parameters: { gain_db: 6 }
})
fourier_run({ spec_path: 'runs/eq-plan.json', out_directory: 'runs/eq' })
fourier_eq({
  run_directory: 'runs/eq', out_directory: 'runs/eq-response',
  case_ids: ['impulse', 'noise'], frequencies_hz: [100, 1000, 10000]
})
fourier_verify({
  run_directory: 'runs/eq', out_directory: 'runs/eq-checks', checks: [
    { case_id: 'impulse', metric: 'eq_gain_db', frequency_hz: 1000, min: 5.99, max: 6.01 },
    { case_id: 'tone', metric: 'tone_gain_db', min: 5.99, max: 6.01 }
  ]
})
```

The `effect` preset supplies `silence`, `impulse`, `tone` (1,000 Hz), seeded continuous `noise`, `sweep`, `step_tone`, `resonance` and `competition` cases for EQ and other effects. Use explicit cases for additional frequencies, levels or timing. The former `eq` preset value is no longer accepted; use `effect` when creating new plans. Existing plan JSON remains valid because it stores explicit cases, not a preset value. `fourier_eq` analyzes 1–16 selected cases and 1–256 frequencies (default 128 logarithmic points), one channel per call. It verifies archives and reports actual FFT bins, gain, wrapped phase, available noise coherence and grid extrema in `eq.json`. Impulse response uses an unwindowed complex FFT ratio; noise H1 uses the final 75% of the recording. Automated cases are rejected. Allow sufficient settling/decay and control level dependence; these are descriptive curves, not automatic center-frequency/Q, bandwidth, group delay or unique topology recovery.

`fourier_verify` writes `verification.json` for 1–128 checks; each needs `case_id`, `metric`, and inclusive `min` and/or `max`, with optional zero-based `channel` (default 0). Metrics: `tone_gain_db`, `peak_dbfs`, `rms_dbfs`, `dc`, `full_scale_fraction`, `reported_latency_samples`, `impulse_peak_lag_samples`, `eq_gain_db`, `eq_phase_degrees`, `candidate_relative_error_db`. EQ checks require `frequency_hz`; tone checks require a continuous tone and use the final up-to-one-second window. Levels/DC/fractions use the full output. Missing/unexcited metrics fail, never pass by omission. Candidate error requires explicit `candidate_run` with exactly matching inputs; an exact null is marked `exact_null: true`, while a silent reference has undefined relative error. CLI failures exit nonzero and Pi reports an error with the evidence path. Only explicit `lag_samples`/`candidate_lag_samples` are applied; no inferred alignment, normalization or phase unwrapping.

CLI: `init --preset effect`, `eq --run RUN --out NEW --options FILE` and `verify --run RUN --out NEW --options FILE` (or `--options-stdin`). Outputs never overwrite existing evidence.

### Bounded EQ model and control identification

Inspect the selected plug-in first. Explicitly neutralize **all** other bands and wet/output settings, then provide one isolated band and sampled controls. The following variables must come from that inspection; names/roles are not guessed:

```js
fourier_eq_identify({
  action: 'create', plugin: selectedPlugin, out_file: 'runs/eq-suite.json',
  neutral_parameters: neutralSettingsFromInspection,
  bands: [{ id: 'band1', parameters: isolatedBandSettings,
    controls: [{ parameter: inspectedFrequencyKey,
      values: [0.2, 0.3, 0.4, 0.5], held_out_indices: [3] }] }]
})
fourier_eq_identify({ action: 'run', suite: 'runs/eq-suite.json', out_directory: 'runs/identified' })
// Refit existing verified audio without loading a plug-in:
fourier_eq_identify({ action: 'analyze', suite: 'runs/eq-suite.json',
  run_directory: 'runs/identified/run', out_directory: 'runs/reanalyzed' })
```

Native numeric control values remain normalized 0..1; strings retain lookup samples rather than invented numeric laws. Each band gets an anchor plus one-factor-at-a-time control probes. The workflow renders a neutral baseline and −24 dBFS impulse at 250 ms, subtracts baseline magnitude/phase, then fits bounded RBJ bell/shelves/pass/notch/band-pass models with repeated identical sections. Default `families` includes all seven; default `stages` is `[1,2]` (explicit 1..4). This is not a search over arbitrary filter architectures. Select 1–7 bands, at most four controls each, 2–8 values per control, at most 64 total cases and 512 MB raw audio. Duration is 0.5–10 seconds; longer settling/tails may invalidate these probes.

Reports `analysis/eq-identification.json` and `EQ_IDENTIFICATION.md` keep measured points, readbacks, alternatives, acceptance/ambiguity, train/held-out magnitude/phase errors and local linear/exponential/power-law hypotheses. Every fourth frequency is held out of model optimization. Explicit `held_out_indices` exclude control values from law fitting; with four or more values the last is held out by default, otherwise there is no held-out control validation. These frequency bins are not independent renders, and mapping laws must not be extrapolated beyond sampled values. Flat responses cannot identify frequency/Q. A close fit is a best-tested surrogate, **not proof of the original topology or proprietary source**; validate independent signals, levels and rates before reconstruction claims.

CLI equivalents: `eq-identify create|run|analyze --options FILE` or `--options-stdin`; `run` loads only the selected trusted plug-in, while `create`/`analyze` do not load it. Render failures stop without automatic retry. Unsupported formats such as FL-native DLLs still require external host exports or a separately implemented bridge.

### Timed automation and state recall

Plans and cases accept these optional fields:

```js
{ save_state: true,
  automation: [
    { time: 0.125, parameters: { gain_db: -6 } },
    { time: 0.25, parameters: { gain_db: -12 } }
  ] }
```

Those parameter units are for `builtin:gain`; native parameters use inspected
normalized values/exact display strings. Up to 256 ordered events are rounded
to samples **inside** the render. Equal-sample events retain array order. Native
blocks split at events (MIDI offsets and transport are preserved); parameter
readbacks are taken at application time. Plug-in smoothing, quantization and
block-size sensitivity still apply—this is not a VST3 parameter-ramp queue.
A case's `automation` replaces the global list, including `[]` to disable it.

`save_state: true` captures the **end-of-case** configuration to
`cases/<id>/plugin-state.json`; start another fresh case with that path as
`state_file`. Restore happens before explicit parameters and preparation/reset;
case parameters override global parameters, and automation follows.
`initial_plugin` is the effective configuration after recall, explicit parameters
and preparation/reset, before timed events—not the untouched snapshot. Final
and event readbacks are recorded separately. Each case still has a fresh instance. Native snapshots contain bounded JUCE state bytes
(max 4 MiB before base64), bound to binary hash, selected plug-in type, sample
rate/channels/block size; built-in snapshots contain parameters and backend
identity. State inputs and saved artifacts are hashed for resume. Changing a
snapshot, code, host, settings or plug-in requires a new run; there is no hidden
carryover or automatic vendor preset import. Rebuild the optional native host
after upgrading Fourier to use these fields. State bytes are plug-in-defined;
parameters do not imply restoration of voices, delay memory or a sample-exact
session. State files can include private patch/file data: do not publish them
without review. Case `save_state: false` disables global capture; omit a global
`state_file` when only selected cases should restore.

### Paired suites and bounded fitting

```js
fourier_match({ action: 'create', reference_plan: 'runs/reference-plan.json',
  candidate: { plugin: '<local candidate .vst3>', parameters: { '<inspected key>': 0.5 } },
  held_out_case_ids: ['noise', 'sweep'], candidate_lag_samples: 0,
  out: 'runs/replication-suite.json' })
fourier_match({ action: 'run', suite: 'runs/replication-suite.json', out: 'runs/paired' })
fourier_match({ action: 'fit', suite: 'runs/replication-suite.json', out: 'runs/search',
  grid: { '<inspected key>': [0.25, 0.5, 0.75] }, timeout_seconds: 1800 })
```

A suite stores two validated plans with identical ordered case IDs/stimuli/rate/
channels/duration. Reference parameters, state and automation **never implicitly
carry to the candidate**: supply `candidate.parameters`, `case_parameters`
(by case ID), `state_file`, `save_state`, `automation`, and/or `case_controls`
(per-case state/save/automation). Inspect both plug-ins; no inferred mapping.
Stimuli are shared and rendered input arrays must match exactly. The suite JSON
is editable for candidate-specific settings; executions require a new directory.

Fit enumerates 1–3 parameter grids, 1–8 values each, at most 32 candidates,
3600 channel-seconds and 1 GB raw audio budget. A grid key shadowed by a case or
automation is rejected. It minimizes summed squared **sample error / reference
output energy**, across all channels and non-held-out samples, after only the
suite's explicit candidate lag (positive = candidate delayed). Silent references
cannot select a fit; exact ties take grid order. No normalization, inferred lag,
gradient optimizer or perceptual metric is used. Held-out IDs are excluded from
selection and scored only for the winner; none means **no held-out evaluation**.
Freeze parameters before interpreting held-outs and don't retune to them.

`match.json` checkpoints every trial, parameter values, run paths and scores;
run artifacts include readbacks and full float audio. Winner comparisons are
written to `comparison-*/comparison.json` and `COMPARISON.md`. A failure stops
without retries, leaving evidence. Suite operations have no resume/retry shortcut;
investigate and use a new output directory. Matching is only the best tested
grid point, not recovery of an algorithm or proof of equivalence. Pi's suite
whole-operation deadline is 10–7200 seconds (default 1800); the CLI still has its
10-minute launcher limit. Large grids can create substantial disk usage.

### Specialized offline measurements

```js
fourier_characterize({ run_directory: 'runs/reference', out_directory: 'runs/characterized',
  case_ids: ['tone', 'two_tones'], measurements: ['dynamics', 'distortion'],
  window_seconds: [1, 2], window_ms: 20, harmonics: 10 })
// Impulse-only cases, long enough to capture the tail:
fourier_characterize({ run_directory: 'runs/reference', out_directory: 'runs/decay',
  case_ids: ['impulse'], measurements: ['decay'] })
```

This verifies 1–16 archived cases and writes `characterization.json` without
loading a plug-in. Select compatible cases/measurements; a mixed incompatible
request fails rather than inventing numbers. `channel` defaults to 0. Dynamics
returns bounded windowed RMS/input-output gain trajectories, **not** fitted
attack/release constants. Distortion requires continuous, distinct 1–2 tone
fundamentals and an integer-cycle selected window. THD sums harmonics 2..N below
Nyquist; two-tone analysis lists selected absolute `2f1−f2`, `2f2−f1`, `f1+f2`,
`f1−f2` products, deduplicated and excluding fundamentals. It is not standardized
IMD, THD+N or an alias/noise-floor claim; leakage, settling and modulation controls
are still necessary. Decay uses an impulse onset and Schroeder reverse-energy
integration: EDT (0..−10 dB), T20 (−5..−25), T30 (−5..−35), fitted slope/R² and
extrapolated RT60. Missing ranges/silent tails return null. Noise or truncation
can bias fits; no automatic noise-floor subtraction is supplied.

CLI equivalents use bounded JSON on stdin:
`match create|run|fit --options-stdin` and
`characterize --run <run> --out <new-dir> --options-stdin`.

### Tools for deeper behavioral investigation

| Question | Tools and experiment |
| --- | --- |
| Relative or absolute detection; depth/range law? | `fourier_inspect` → `fourier_plan`/`fourier_run` level and parameter cases → `fourier_compare` settled gains |
| Local spectral competition or global suppression? | `fourier_plan` multitone: target-only, near/far competitor, competitor-only and energy-matched controls; compare frequency and time-band measurements |
| Stereo linking, channel asymmetry or polarity sensitivity? | Multitone per-tone `channel` and `phase_degrees`; mirror channels, vary inspected link/routing settings; compare both channels |
| Attack/release and detector memory? | Independently gate tones, or gate a resonance driver while a quiet probe continues; compare short time-band windows, not fitted time constants |
| Frequency-dependent phase or new spectral components? | `fourier_compare` H1 phase/coherence and input/output bin levels; settled excitation, neutral baseline and leakage/delay controls are essential |
| Sample-rate, block-size, quality or latency dependence? | Separate `fourier_plan` render settings/parameter cases; compare `fourier_run` readbacks, impulse lag and settled response |
| Existing musical material or static implementation clues? | `fourier_analyze` aligned PCM WAVs; optional read-only `fourier_rea` with target identity and evidence attachment |

All use the extension's tools; no task-specific analysis script is required. Label independent DSP candidates as hypotheses and validate them against held-out inputs.

## Plan format and parameter sweeps

Paths are relative to the invocation cwd, **not the plan file**. Prefer absolute plug-in/WAV paths. Plans are JSON data, never executable expressions.

```json
{
  "schema_version": 1,
  "plugin": "builtin:gain",
  "sample_rate": 48000,
  "channels": 2,
  "duration": 3,
  "buffer_size": 512,
  "timeout_seconds": 30,
  "parameters": {},
  "cases": [
    {"id": "gain_minus6", "parameters": {"gain_db": -6}, "stimulus": {"kind": "tone", "frequency_hz": 1000, "level_dbfs": -18}},
    {"id": "gain_zero", "parameters": {"gain_db": 0}, "stimulus": {"kind": "tone", "frequency_hz": 1000, "level_dbfs": -18}}
  ]
}
```

Case parameters override plan parameters. Unknown host parameters fail; exact exposed readbacks are recorded after processing, including raw host values for real plug-ins.

**Native parameter contract:** inspect first and use the returned `p<index>_<name>` keys. Native numeric values are JUCE-normalized **0..1**, not dB/Hz. Strings must exactly match formatted plug-in text (for example `"-6.0"` for the starter gain); boolean values require a boolean parameter. Metadata exposes native ID, name, index, units and normalized `raw_value`. Only writable/automatable parameters are listed, excluding JUCE's read-only MIDI controller proxies. The tool's summary is bounded to 16 parameters/16 enum values; `inspection.json` keeps full metadata. Built-ins retain physical units, e.g. `gain_db: -6`. Quantized controls can differ from requested values: **check readbacks before interpreting results**. Each case starts a new plugin instance; no hidden preset/state carryover is assumed. Fourier `state_file`/`save_state` recall captured configuration, not arbitrary vendor preset-file formats or patch browsers; use exposed patch controls, a Fourier snapshot, or render elsewhere and analyze its WAV.

| Stimulus | Fields (defaults) |
| --- | --- |
| `silence` | Digital zero |
| `impulse` | `level_dbfs` (-18 peak), `at_seconds` (0.1 or duration/4) |
| `tone` | `frequency_hz` (1000), `level_dbfs` (-18 peak) |
| `multitone` | `tones`: 1–32 components, each with required `frequency_hz`, optional `level_dbfs` (-18 peak), `phase_degrees` (0), `channel` (omitted = all), `on_seconds` (0), `off_seconds` (duration); optional top-level `noise_rms_dbfs`/`seed` |
| `noise` | `noise_rms_dbfs` (-24), `seed` (12345) |
| `sweep` | Logarithmic `start_hz` (20), `end_hz` (min(20000, 0.4×sr)), 10 ms edge fades |
| `step_tone` | Tone fields, `on_seconds` (duration/3), `off_seconds` (2×duration/3) |
| `resonance` | Tone fields, `noise_rms_dbfs` (-36), optional `competitor_hz`/`competitor_dbfs` (-18), optional stereo `probe_dbfs` (-66 recommended), `probe_kind` (`tone`/`noise`), optional `on_seconds`/`off_seconds` (duration/3, 2×duration/3) |
| `wav` | `path` to PCM WAV matching sample rate/channels; zero-padded to duration, never implicitly trimmed/resampled |
| `midi` | `midi`: ordered `{"time":0.1,"data":[144,60,100]}` / note-off events; empty list for free-running instruments |

`resonance` removes target/competitor-adjacent DFT bins from its seeded background using sine/cosine projections, then normalizes **background RMS**, not total energy. Use bin-centred frequencies when requiring exact tone/noise separation. `probe_dbfs` puts a continuous quiet target sine (peak dBFS) or `probe_kind: "noise"` seeded broadband probe (RMS dBFS) on channel 1 while channel 0 drives the processor; this assumes nothing about the plug-in's link/routing controls. If either gate time is specified, the entire left driver (tones and background) is gated while the right probe continues. Normalized background RMS is the ungated value; gating reduces whole-render RMS. Recovery remains conditional on the continuing quiet probe. Built-ins: `builtin:gain` (`gain_db`), `builtin:delay` (`delay_samples`), `builtin:clip` (`threshold`) and a simple `builtin:synth` (`gain_db`, MIDI notes).

`multitone` sums components without normalization or clipping. `channel` is an available zero-based channel index; explicit null is invalid. Phase is in −360…360 degrees. Gates are abrupt sample masks and must contain at least one sample; discontinuities can create broadband energy, so use settled windows for spectral interpretation. Optional seeded noise is continuous, has the specified RMS and is identical in every channel; unlike `resonance`, its tone-adjacent bins are not removed. Leave peak headroom when summing components. Top-level tone controls are rejected: place them inside each component.

Guards: 1–64 cases, 1–2 channels, 8–192 kHz, 0.01–30 seconds, at least 32 frames, at most 4 million channel-samples, 16–32768-frame host blocks, 1–300 seconds per worker, 10 MiB worker log limit. Split bigger experiments into multiple plans. The Node launcher imposes a 10-minute outer operation limit and retains a checkpoint on interruption.

## Artifacts, recovery and WAV analysis

```text
run/
  run.json                  normalized plan, identities, versions, readbacks, checkpoints
  report.json               machine-readable aggregate
  REPORT.md                 measurements, failures, conventions and evidence
  spectrum.svg              accessible SVG preview (log-spaced sampled bins)
  cases/<id>/
    request.json, response.json, result.json, stdout.log, stderr.log
    audio.npz               float32 input/output and sample_rate; load with allow_pickle=False
    traces.json             output spectrum and 20 ms RMS envelope
    output.preview.wav      16-bit listening copy, omitted if output exceeds full scale
    plugin-state.json       optional end-of-case, identity/settings-bound configuration
  evidence/                 checksummed raw REA/external artifacts + classifications
```

A new run/inspection directory is required. Failures stop the plan, are not successful measurements, and are never retried automatically. After investigating:

```powershell
node scripts/fourier.mjs run --spec effect-plan.json --out runs/my-effect --resume
# Only after explicitly deciding to retry a failed/interrupted case:
node scripts/fourier.mjs run --spec effect-plan.json --out runs/my-effect --resume --retry-failed
node scripts/fourier.mjs report --run runs/my-effect
node scripts/fourier.mjs analyze --output-audio wet.wav --reference dry.wav --tone-hz 1000 --out runs/wav-check
```

Report regeneration verifies the stored run fingerprint, all finished-case artifact hashes (including traces/audio), and agreement between result files and checkpoint metrics before writing reports. It also works for failed or interrupted runs; cases still running contribute no measurements. Historical WAV analyses without a fingerprint remain readable with artifact/result verification; newly created WAV analyses include a fingerprint. These hashes detect changes, not an adversary who rewrites the checkpoint and all hashes.

Resume verifies normalized plan, input WAV hashes, source hash, plug-in identity and all completed-case artifact hashes. Failed attempts are renamed, not deleted. Changed inputs/code/binaries require a new run. WAV analysis accepts 8/16/24/32-bit **integer PCM**, not IEEE-float WAV; reference/output must already match rate, channels, length and alignment. It does not load a plug-in.

### Migration from the Python backend

The Python package and virtual-environment setup have been removed. Replace `FOURIER_PYTHON` with optional `FOURIER_NATIVE_HOST` only when using an external native host. Existing built-in plan fields and the original ten Pi tools remain available (now fifteen with match/characterize/EQ/verification/identification); native plans must be recreated using current JUCE inspection keys and normalized/text values, not Pedalboard parameter names or physical numeric values.

The TypeScript backend uses Mulberry32/Box–Muller seeded noise rather than NumPy PCG64; seeds are reproducible **within this backend**, not sample-identical to former Python runs. Current tools read old NumPy `.npz` measurement archives for comparison and verify their original fingerprints, but cannot resume old checkpoints because source/host identities changed. Candidate null comparisons still require byte-identical input arrays; re-render both sides with the same backend. Existing local `.fourier/venv` directories are unused and are not automatically deleted.

## REA MCP integration

**Optional and real, not a required analysis backend.** Existing server `rea` is reused without changing global configuration. `fourier_rea` routes through Pi 1.4+'s `ctx.executeTool`, preserving normal tool validation, hooks, permission checks and cancellation. A failed/blocked MCP call remains an error; there is no silent CLI/debugger fallback.

1. `fourier_rea({"action":"discover"})` gets the installed catalog. Use native `mcp` search/describe to inspect current schemas.
2. `fourier_rea({"action":"call","tool":"rea_binary_session"})` saves session/provider/capability evidence. Connection alone does not prove a healthy native engine.
3. Verify target identity; explicitly open the correct native plug-in image with the discovered `rea_open_binary` schema. Do not disrupt another active REA session. Use allowlisted overview/string/procedure/function tools to investigate specific hypotheses.
4. Read the saved raw evidence. Attach it using `fourier_rea({"action":"attach","artifact_path":"...","run_directory":"...","claim":"A specific, bounded finding","classification":"static_observation"})`.

Attachment classifications are `static_observation`, `runtime_observation`, and `hypothesis` (default). An optional `target_sha256` must match the run's binary/bundle/component; it is explicitly a **declared** association, not automatic proof of the MCP session's active target. Without it, the report says **unverified**. Raw artifacts are bounded to 2 MiB, checksummed, treated as untrusted data, and never executed.

To register REA for this Pi session only, set `FOURIER_REA_COMMAND` to the executable and `FOURIER_REA_ARGS` to a JSON array (defaults to `["mcp"]`). For a globally installed `rea-agents` on Windows, a reliable command is the absolute `node.exe` path, with args `["<absolute npm-root>/rea-agents/scripts/rea.mjs","mcp"]`; do not assume a `.cmd` launcher works as a native executable. Existing `mcp.json` entries take precedence. `FOURIER_REA_SERVER` changes the server name (default `rea`). Fourier does **not** install REA/Ghidra/Frida. See [REA documentation](https://github.com/morluto/rea/blob/main/docs/client-configuration.md#pi) for current setup.

The bridge allowlists static inspection; native runtime scripting, hooks and debugger attachment require **separate explicit approval** and an agreed owned target process. Use native REA tools for an authorized runtime investigation, save output, then attach it as `runtime_observation`. The disposable render worker is not a long-lived debugging host. No licensing/protection bypass, patching or installer execution is provided.

CLI attachment works with any MCP client, without Pi:

```powershell
node scripts/fourier.mjs evidence --run runs/my-effect --file rea-result.json --classification hypothesis --claim 'Candidate detector path; not yet corroborated by runtime data.'
```

## Interpretation and safety limits

- **Not a sandbox.** Plug-ins can write preferences, open dialogs, access hardware/network, spawn processes or crash. Use trusted plug-ins or an OS sandbox/VM. Process-tree termination is best effort, not containment of deliberately escaping processes.
- No playback is started, but never route experimental signals to speakers at unsafe levels.
- Float archives are unnormalized. Sine gain/THD use least-squares amplitude over the final up-to-one-second window; insufficient settling, modulation, clipping and release tails can invalidate a stationary interpretation.
- Spectra are Hann FFT-bin peak amplitudes, not PSD/LUFS or a measured transfer function. The SVG samples bins for size and may miss a narrow peak; the float archive supports full-resolution analysis. THD is harmonics 2–10 below Nyquist, not THD+N. Near-zero numerical THD should not be interpreted as a calibrated noise floor.
- Raw 20 ms RMS envelopes are not fitted attack/release constants. Host-reported latency, impulse-peak lag and effective host delay compensation are not interchangeable. No automatic normalization, latency correction, general nonlinear transfer-function recovery or loudness standard is claimed.
- Static imports/strings, audio behavior, and runtime observations are different evidence. Neither matched curves nor a decompiled candidate function proves recovery of proprietary DSP.

## Development and verification

`npm test` compiles TypeScript, runs Node backend/bridge/REA tests (including actual Pi extension and both skill loaders, preferring the locally installed SDK; `PI_HOST_ROOT` overrides local/global auto-detection), and built-in DSP self-checks. Archive tests include independent NumPy-generated fixtures and malformed ZIP rejection; no Python is needed. The defaults use only built-ins and mocked MCP outcomes; they do not automatically load installed vendor plug-ins or attach debuggers. Tests cover tool-argument plans, stdin limits, broadband/gated probes, multitone phase/channel/gate validation, known gain/delay phase calibration, spectral-bin levels, single-segment coherence, spectral/band comparisons, candidate input identity, explicit alignment, tampered archives and skill frontmatter. JUCE tests cover both templates, non-overwriting creation,
identifier/injection rejection and local SDK/toolchain validation. Both
skills and tools run through the actual Pi loader. Replication tests cover automation event timing/order, state precedence/settings/hash rejection, bounded fitting and held-out selection, coherent distortion rejection and analytic decay calibration. EQ tests additionally cover fail-closed host selection before plug-in loading, analytic impulse curves, declarative failures/exact nulls, all seven RBJ families, repeated sections, ambiguous flat fits, sampled mapping laws and suite/run mismatches. The actual Pi-loader test exercises the three new EQ tools. No custom-editor example is included.

Default tests may skip unavailable native prerequisites; a green default run
alone is not proof of native integration. Use the required suite in a compiler
developer shell after building the current host:

```powershell
$env:FOURIER_JUCE_PATH = 'D:/SDKs/JUCE'
$env:FOURIER_JUCE_GENERATOR = 'Ninja' # optional; use your supported generator
npm run setup:native -- --juce $env:FOURIER_JUCE_PATH --generator Ninja --jobs 2
npm run test:integration
```

`test:integration` fails instead of skipping when the Pi loader, local JUCE
checkout, compiler, or compatible native host is unavailable. It executes the
actual Pi extension/skill loaders, typed analysis tools (including report
integrity rejection), scaffolding, and effect/instrument VST3 build → inspect →
render checks. Artifacts stay under `.fourier/`; no SDK download or system
plug-in installation occurs. The separate installed-vendor inspection test
remains opt-in via `FOURIER_INSPECT_PLUGIN`.

For all seven DSP branches plus native automation/state, set
`FOURIER_STARTER_JUCE_PATH` to your trusted JUCE checkout and run
`node --test tests/native-replication.test.mjs` from a Ninja-capable developer
shell. This reuses compiled JUCE between variants and leaves source/log/audio
under `.fourier/starter-validation-*`. Validated locally with JUCE 8.0.7/MSVC on
Windows x64: all seven VST3 variants, 48 kHz stereo/block 257 and 44.1 kHz
mono/block 64, silence, tone/MIDI, same-sample events and state/parameter precedence.
DAW UI/automation, CPU profiling, release packaging and macOS/Linux are not verified.

The native inspection check in `tests/pi-loader.test.mjs` is skipped unless `FOURIER_INSPECT_PLUGIN` selects a trusted installed plug-in. It runs through the Pi-loaded `fourier_inspect` tool, keeps local artifacts under `.fourier/` and prints the inspection path. Behavioral experiments use generic plans with the selected plug-in's inspected controls; no vendor-specific parameter names or expected responses are built into the tests.

For development, `npm install` supplies TypeScript, Node typings and the Pi SDK dev dependencies. `npm run typecheck` checks the backend and extension against the real SDK; `npm run check` validates launcher JS syntax. `npm pack --dry-run` checks the installable package. The package regression test also launches its payload without `node_modules`, confirming that current prebuilt output needs no runtime compiler. See the development checks and safety limits above for native inspection and remaining release requirements.
