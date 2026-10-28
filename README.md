<p align="center">
  <img src="assets/logo.png" width="220" alt="Fourier">
</p>

<h1 align="center"><i>fourier</i></h1>
<p align="center"><i>rebuild your favorite VST</i></p>

<h3>Measure the sound. Understand the behavior. Build your own.</h3>

Fourier gives your [Pi coding agent](https://github.com/earendil-works/pi) a local audio lab and a JUCE workbench. Probe an existing plug-in, turn measurements into DSP hypotheses, and build an editable VST3 effect or instrument—then test it against the original.

## From favorite plug-in to your own DSP

1. **Pick a target.** Discover installed VST3/AU plug-ins and inspect their controls.
2. **Find out what it does.** Send in tones, impulses, sweeps, noise, audio files or MIDI. Measure frequency response, distortion, dynamics, echoes and modulation.
3. **Build your version.** Fit supported models or write DSP in an editable JUCE project. Export accepted fixed-control EQ/filter fits directly to C++.
4. **Compare. Refine. Repeat.** Render both plug-ins on identical inputs, tune candidate controls, and validate on held-out tests. Keep the audio, plots and reports as evidence.

Ask Pi, for example:

> Help me rebuild the behavior of this EQ as a JUCE VST3. Inspect its controls, measure one isolated band, fit a model, then build and compare it on fresh signals.

## What’s in the box

- **Effects and instruments:** VST3 hosting, AU on macOS, MIDI probes, plus built-in calibration processors that need no native build.
- **Repeatable experiments:** seeded signals, parameter sweeps, sample-rate/block-size matrices, timed automation and configuration snapshots.
- **Model fitting and matching:** EQ/filter models, bounded dynamics/distortion/delay/decay/modulation surrogates, grid search and coupled local optimization.
- **JUCE starters:** gain, filter/EQ, compressor, saturation, delay, reverb, phaser, flanger, limiter, chorus and tremolo; sine and subtractive synths.
- **Evidence you can inspect:** float audio archives, WAV previews, SVG spectra, JSON/Markdown reports and explicit pass/fail checks.
- **Less busywork:** compact multi-step workflows, a standalone CLI, and optional REA MCP integration for static/runtime evidence.

## Get started

Requires **Node 22.2+** and Pi. From this checkout:

```sh
npm install
npm run setup
npm run doctor
pi install /absolute/path/to/fourier
```

Reload Pi with `/reload`, then ask for a measurement or a plug-in build. Use `/fourier` for a summary, `/skill:audio-analysis` for experiments, or `/skill:juce-development` for authoring.

For native plug-in hosting and VST3 builds, also bring a **local JUCE checkout, CMake 3.22+ and a C++17 compiler**. Ask Pi to build the native host with `fourier_setup_native`. Built-ins and PCM WAV analysis work without it. Fourier does not download SDKs or install plug-ins into system folders.

Prefer the terminal? See [setup, CLI examples and the full technical reference](AGENTS.md).

## Rebuild behavior, not proprietary source

A close fit is evidence—not proof of an identical algorithm or sound in every situation. Starters are teaching DSP, not finished commercial processors. Full plug-in reconstruction still needs implementation and independent testing; automatic source export is limited to fixed-control EQ/filter models.

Native plug-ins and builds execute code: use trusted inputs. Process isolation is **not a security sandbox**. No playback starts automatically. Windows x64 has been tested; macOS/Linux remain unverified. Review JUCE licensing before distributing builds.

[MIT license](LICENSE) · [Agent guide and tool reference](AGENTS.md)
