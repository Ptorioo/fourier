---
name: juce-development
description: >-
  Write, build and test JUCE VST3 audio effects and MIDI instruments with Fourier.
  Create editable CMake projects, diagnose local SDK/compiler builds, implement
  real-time C++ DSP and validate the resulting plug-in with isolated measurements.
---

# Fourier: JUCE plug-in development

Use for creating or editing JUCE effects/instruments, not only inspecting existing
plug-ins. Read the “Write VST3 plug-ins with JUCE” section of the package
[agent guide](../../AGENTS.md#write-vst3-plug-ins-with-juce) and the generated project's README. Use the installed JUCE version's
`docs/CMake API.md`, module headers and examples for version-specific APIs.

## Backend and host setup

Fourier's CLI, measurements, plans and reports run in TypeScript on **Node 22.2+**.
Run `npm run setup` in the package directory to compile the backend; no Python,
Pedalboard or virtual environment is used. Generating/building a project and
hosting its compiled plug-in are separate operations. Before native inspection
or rendering, check `fourier_doctor().plugins_ready` and the separate `state_ready`/
`automation_ready` flags when needed. The check queries the helper protocol, not
just file presence, without loading a plug-in. Pass explicit `native_host` (CLI
`--native-host`) to doctor/inspection/plans/runs/suites when selecting an external
helper; explicit selections override defaults and never silently fall back.
Build the optional C++ JUCE
host with `fourier_setup_native({juce_path:'/absolute/path/to/JUCE'})`: packaged
`native/` builds into `<cwd>/.fourier/native-host`, not the package directory.
A capability check precedes a hash-pinned workspace selection; `activate:false`
disables selection and `build_directory` overrides the output location. Explicit
hosts and `FOURIER_NATIVE_HOST` take precedence; changed selected binaries fail.
Alternatively select an existing compatible `fourier-host` executable. This uses the operator's local trusted
SDK/toolchain; it never downloads JUCE or installs a system plug-in. Built-in
calibration and PCM WAV analysis work without the helper.

## Compact orchestration and fitted-model export

Read [Replication and compact workflows](../../AGENTS.md#replication-tools-and-low-token-workflows). Prefer
`fourier_workflow` after choosing explicit controls: chain identification,
`export-model`, `juce.build`, inspection, matrices, renders and verification using
internal `{"$ref":"earlierStep.field"}` references. Compact summaries cross the
model boundary; full results/checkpoints remain on disk. Avoid repetitive tool
calls and routine JSON reads. It is not a sandbox; explicit step paths may be
outside its checkpoint root. A separate MCP server is unnecessary for Pi.

`fourier_export_model({report,project_directory,name,row_ids})` generates editable
JUCE source from accepted isolated EQ/filter fits (1–7 rows, one per band), with
sample-rate-adaptive double-precision SOS and provenance. Ambiguous fits require
explicit `allow_ambiguous:true`. It refuses unaccepted fits and existing projects.
This is a **fixed-control surrogate**, not a recovered full plug-in: no fitted
control laws, automation/state behavior, neutral-baseline coloration or vendor UI
are exported. Build with `fourier_juce`, then validate independent inputs/rates.
Other effects retain the ordinary hand-editable starters.

## Workflow

1. Establish effect versus MIDI instrument, the actual DSP behavior, parameters,
   intended project directory and local JUCE checkout. Select a small `dsp` starter:
   gain/filter-EQ/compressor/saturation/delay/reverb/phaser/flanger/limiter/chorus/
   tremolo effects or sine/subtractive instruments.
   Defaults remain gain/sine, not an assumed reconstruction of a vendor effect.
   Missing DSP requirements need clarification, not a pile of speculative controls.
2. Call `fourier_juce({action:"doctor", juce_path:"/absolute/path/to/JUCE"})`.
   This checks CMake/compiler candidates and the source checkout without installing
   anything. It does not prove that a compiler works. Ask the user to install
   missing SDKs/toolchains; do not fetch or install them silently. CMake >=3.22 and
   a C++17 toolchain are required. Windows Ninja builds need a VS developer-shell
   environment inherited by Pi; alternatively use a supported Visual Studio
   generator. macOS needs Xcode tools; Linux needs JUCE's native dev libraries.
3. For a new project call `fourier_juce` action `create` with `project_directory`,
   identifier `name`, `kind` (`effect`/`instrument`), `manufacturer_code` and
   `plugin_code`, optionally `dsp` matching the chosen kind. Codes are four alphanumeric characters, starting with a letter;
   names are 1–48 alphanumeric characters, starting with a letter. Use distinct
   plug-in codes for distinct products. The tool refuses any existing directory.
   No JUCE files are copied into the project and no network calls are made.
4. Read/edit `PluginProcessor.cpp`/`.h`, `StarterDSP.h` and `SubtractiveVoice.h`
   using normal file tools. All variants have generic editor, APVTS state, smoothed
   gain and mono/stereo buses. The filter is one low/high-pass/peak RBJ biquad;
   compressor is stereo-linked peak/soft-knee with no lookahead/sidechain;
   saturation is tanh with no oversampling (aliasing); delay uses a preallocated
   fractional read with pitch-changing time modulation. Reverb uses JUCE Freeverb,
   phaser uses JUCE's six-stage algorithm, flanger/chorus use the same JUCE Chorus
   with short/long centre-delay defaults (not through-zero or multi-voice stereo).
   Limiter is linked sample-peak with instantaneous reduction/release smoothing,
   not true-peak/lookahead; its gain is pre-limiter to preserve the sample ceiling.
   Tremolo is shared-phase sine AM. Instruments have eight
   sample-timed voices, velocity, sustain and stealing. Subtractive adds sine/
   polyBLEP saw/square, one-pole non-resonant low-pass, ADSR, ±2-semitone pitch bend
   and CC1 vibrato; sine retains fixed ADSR/no bend. No MPE, production-quality
   model or proprietary code is implied. Read generated README for smoothing,
   latency/tail and quality limits. Add only requested controls/DSP. There is no
   need for a separate GUI builder. If the target being recreated has response
   curves or a spectral analyzer, implement those inside the VST's editor, not
   only a generic parameter panel. For a custom editor, share DSP/display
   coefficients, use APVTS attachments, and keep FFT/painting on the message
   thread with a bounded audio-to-editor FIFO. No custom-editor example is
   included. Do not copy vendor assets.
5. Call `fourier_juce({action:"build", project_directory:"...", juce_path:"..."})`.
   Optional: `configuration` (`Debug`/`Release`), `generator`, `jobs` (1–32,
   default 2), and `timeout_seconds` (10–3600, default 1800 for the whole operation).
   CMake/compilers execute project and SDK code, not a sandbox. Build only trusted
   sources. Configure/build logs are retained in `build/`; failures are errors,
   not working binaries. Do not delete caches, alter the generator or retry after
   an interruption without understanding the failure and getting retry approval.
   Builds reuse the local directory but never install to system plug-in folders.
6. Read `plugin` from the successful result. Call `fourier_inspect` on that path,
   read the full `inspection.json` when the returned summary is truncated, and
   check parameter keys, metadata and the instrument flag. Native keys are
   `p<index>_<name>`; numeric settings are normalized **0..1**, not dB/Hz.
   Strings must exactly match the plug-in's formatted text (the gain starter's
   −6 dB setting is `"-6.0"`); inspect rather than hardcoding a key. Native ID,
   name, index and normalized `raw_value` are recorded for verification. Only
   writable/automatable controls are listed, not read-only MIDI controller proxies.
   Built-ins such as `builtin:gain` instead keep physical `gain_db` values.
   Create a fresh `fourier_plan` with `preset:"effect"` for any audio effect
   (including EQ/filter, compressor, saturation and delay/reverb), or
   `preset:"generator"` for a MIDI instrument, and run it in a new directory. Old Pedalboard plans are not native JUCE plans. Loading this build executes native code. Start with silence,
   known gains, impulses and seeded signals. Instruments need empty-MIDI, note-on,
   note-off/release and polyphony cases. Use `fourier_compare` on known/held-out
   inputs; don't call an unaligned null test or one matching curve proof of a clone.
7. Use plan `automation` for ordered sample-rounded parameter changes and
   `save_state`/`state_file` for end-configuration capture/identity/settings-bound
   recall, before explicit parameters and preparation/reset. Rebuild the optional
   native helper for these features. Native controls remain normalized/text;
   inspect event/initial/final readbacks. APVTS state does not restore active
   voices/delay memory. Use `fourier_match` to create/run paired reference/candidate
   suites with explicit candidate mappings; `fit` searches a bounded grid and
   `optimize` jointly searches 1–8 numeric controls with bounded local Nelder–Mead
   (up to 128 evaluations). Both score held-out IDs only after choosing the winner.
   Native optimization bounds are normalized; built-ins retain physical units.
   Use `window_seconds` and absolute or relative sample error, with an explicit
   reference floor only when intended. `fourier_matrix` expands bounded explicit
   parameter/stimulus/settings axes. `fourier_transitions` creates fixed endpoint
   and automated renders with snapshots and held-out output-interpolation fits;
   it does not recover hidden-state laws or coefficient smoothing. Use `fourier_characterize`
   for offline dynamics, coherent THD/selected IMD and impulse energy-decay fits.
   Use unified `fourier_effects` for verified responses including EQ/filter,
   `fourier_verify` for declarative bounds including windowed absolute RMS/peak
   candidate errors (linear amplitude or dBFS) and explicitly floored relative error, and `fourier_effects_identify` for
   reusable model/control-law experiments. EQ/filter retain explicit neutral/band
   isolation and phase-aware RBJ/Butterworth fitting (explicit 1–8 SOS sections,
   identical or distinct resonance-scaled sections, band-transformed notch/bell,
   peak/skirt band-pass normalization). Defaults remain 1–2 sections. Other fits are static dynamics,
   memoryless waveshapers, integer-feedback delay, RT60 decay or sinusoidal carrier
   trajectories—not unique proprietary topology or reverb/modulation reconstruction.
   These tools replace
   routine ad hoc report-parsing scripts, not independent reference validation.
   Read the audio-analysis skill/AGENTS.md for bounds and measurement caveats.

The build tool accepts generated projects with `fourier-project.json`; it is not
an arbitrary CMake command runner. If renaming a target, update the manifest's
`name` too. Keep generated source editable; never regenerate over a user's DSP.
Inside Pi, use `fourier_juce` and the other structured `fourier_*` tools for
Fourier operations, not shell calls to `fourier.mjs` or handwritten argument
lists. If only this skill is installed, ask the user to install/reload the
extension. Tool errors must not fall back to CLI execution. The standalone CLI
is for explicitly requested non-Pi/CLI workflows; see the package agent guide. Its
outer limit is 10 minutes, while Pi's build tool uses its explicit whole-operation
time limit. Normal source editing and explicitly requested trusted CMake builds
in a developer shell remain appropriate.

The TypeScript worker supervises each native render under the runner's deadline;
cancellation terminates its process tree best-effort and keeps checkpoint/logs.
This is crash isolation, not a sandbox. Changed backend/helper/plug-in identities
require a new run, not resume. Seeded noise differs from the former Python
backend; render reference and candidate with the same current backend.

## Real-time and release requirements

- No allocations, locks, filesystem/network work or UI access in `processBlock`.
  Allocate delay/FFT/voice storage in preparation; clear unused outputs. Preserve
  sample-accurate MIDI timing and handle note-off, release and panic/reset.
- Test different sample rates, mono/stereo, block sizes, zero/short blocks and
  changing parameters. Smooth controls where discontinuities click. Check NaNs,
  denormals, headroom, latency and release tails; report latency when introduced.
- Keep parameter IDs and saved-state compatibility stable. Use APVTS/host-safe
  parameter access; don't change state or UI from the audio callback.
- Separate measured behavior, hypotheses and implementation decisions. A scaffold
  is not a recovered algorithm. Do not substitute another vendor processor when
  asked to implement DSP.
- Set your own company/bundle/product identity and unique codes before release.
  Review the licence in the local JUCE checkout and choose compliant licensing
  before distributing. Generation does not grant a JUCE licence. Signing,
  notarization, installers, custom UI and other plug-in formats are not supplied.
- State what was built and tested, with artifact/log/report paths, and what was
  not checked. No playback is started by these tools.
