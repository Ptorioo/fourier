import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { create } from './juce.js';
import { eqFamilies, eqSections, eqTopologies, type EqModel } from './eq-model.js';
import { dump, expand, fields, load, sha } from './io.js';

/** Export selected fixed-control SOS fits, with runtime sample-rate conversion, not inferred control laws. */
export function exportModel(raw: unknown) {
  const o = fields(raw, ['report', 'project_directory', 'name', 'manufacturer_code', 'plugin_code', 'row_ids', 'allow_ambiguous'], 'model export');
  if (typeof o.report !== 'string' || typeof o.project_directory !== 'string') throw new Error('report and project_directory required');
  const reportPath = expand(o.report), report = load<any>(reportPath);
  if (report.status !== 'ok' || !['eq', 'filter'].includes(report.effect) || !Array.isArray(report.rows)) throw new Error('Expected a successful EQ/filter identification report');
  if (o.allow_ambiguous !== undefined && typeof o.allow_ambiguous !== 'boolean') throw new Error('allow_ambiguous must be boolean');
  const ids = o.row_ids;
  if (ids !== undefined && (!Array.isArray(ids) || !ids.length || new Set(ids).size !== ids.length || ids.some(id => typeof id !== 'string' || report.rows.filter((r: any) => r.id === id).length !== 1))) throw new Error('row_ids must select distinct known report rows');
  const rows = report.rows.filter((r: any) => ids ? (ids as string[]).includes(r.id) : r.parameter === null);
  if (!rows.length || rows.length > 7) throw new Error('Select 1..7 fitted rows (one fixed configuration per isolated band)');
  if (new Set(rows.map((r: any) => r.band)).size !== rows.length) throw new Error('Select only one fixed configuration per isolated band');
  const prototypes: number[][] = [], models: EqModel[] = [];
  for (const row of rows) {
    if (!row.fit?.accepted || (row.fit.ambiguous && !o.allow_ambiguous)) throw new Error(`Refusing unaccepted/ambiguous model ${row.id}; inspect residuals, explicitly allow ambiguity if appropriate`);
    const model = row.fit.best?.model as EqModel;
    if (!model || ![...eqFamilies, 'flat'].includes(model.family) || !eqTopologies.includes(model.topology ?? 'identical') || ![undefined, 'peak', 'skirt'].includes(model.bandpass_gain) || !Number.isInteger(model.stages) || model.stages < 1 || model.stages > 8 || !Number.isFinite(model.frequency_hz) || model.frequency_hz < 10 || model.frequency_hz > 96000 || !Number.isFinite(model.q) || model.q < .01 || model.q > 100 || !Number.isFinite(model.gain_db) || Math.abs(model.gain_db) > 60) throw new Error('Invalid exported model');
    models.push(model);
    if (model.family === 'flat') continue;
    // At quarter-rate k=tan(pi*f/fs)=1. Inverse bilinear conversion avoids low-frequency cancellation.
    for (const [b0, b1, b2, a1, a2] of eqSections({ ...model, frequency_hz: 12000 }, 48000)) prototypes.push([model.frequency_hz, (b0 - b1 + b2) / 4, (b0 - b2) / 2, (b0 + b1 + b2) / 4, (1 - a1 + a2) / 4, (1 - a2) / 2, (1 + a1 + a2) / 4]);
  }
  const created = create(o.project_directory, o.name, 'effect', o.manufacturer_code ?? 'Frie', o.plugin_code ?? 'Ffit', 'gain'), directory = created.project_directory;
  const count = prototypes.length, values = prototypes.map(p => `        {{${p.map(n => n.toPrecision(17)).join(', ')}}}`).join(',\n');
  const header = `#pragma once
#define FOURIER_STARTER 0
#include <JuceHeader.h>
#include <array>
#include <cmath>
// Generated fixed-control surrogate; provenance: fourier-model.json. No original vendor code/assets.
inline juce::AudioProcessorValueTreeState::ParameterLayout starterParameters()
{
    juce::AudioProcessorValueTreeState::ParameterLayout p;
    p.add(std::make_unique<juce::AudioParameterFloat>(juce::ParameterID{"gain_db", 1}, "Output gain", -24.0f, 24.0f, 0.0f));
    p.add(std::make_unique<juce::AudioParameterBool>(juce::ParameterID{"bypass", 1}, "Filter bypass", false));
    return p;
}
class StarterDSP
{
public:
    explicit StarterDSP(juce::AudioProcessorValueTreeState& p) : bypass(p.getRawParameterValue("bypass")) {}
    double tail() const { return tailSeconds; }
    void prepare(double rate, int, int)
    {
        tailSeconds = 0;
        for (size_t i = 0; i < prototype.size(); ++i)
        {
            const auto& p = prototype[i];
            const double k = std::tan(juce::MathConstants<double>::pi * std::min(p[0], rate * 0.49) / rate), k2 = k * k;
            const double d = p[4] + p[5] * k + p[6] * k2;
            coefficients[i] = {{(p[1] + p[2] * k + p[3] * k2) / d, 2 * (p[3] * k2 - p[1]) / d, (p[1] - p[2] * k + p[3] * k2) / d, 2 * (p[6] * k2 - p[4]) / d, (p[4] - p[5] * k + p[6] * k2) / d}};
            const double a1 = coefficients[i][3], a2 = coefficients[i][4], discriminant = a1 * a1 - 4 * a2;
            const double radius = discriminant < 0 ? std::sqrt(std::abs(a2)) : std::max(std::abs((-a1 + std::sqrt(discriminant)) / 2), std::abs((-a1 - std::sqrt(discriminant)) / 2));
            if (radius > 0) tailSeconds += -std::log(1e5) / (rate * std::log(std::min(radius, 1.0 - 1e-12)));
        }
        reset();
    }
    void reset() { state = {}; }
    void process(juce::AudioBuffer<float>& buffer)
    {
        // Keep the filter history running while bypassed; transition semantics were not inferred by this export.
        for (int channel = 0; channel < std::min(2, buffer.getNumChannels()); ++channel)
            for (int sample = 0; sample < buffer.getNumSamples(); ++sample)
            {
                const double input = buffer.getSample(channel, sample);
                double x = input * ${Math.pow(10, models.filter(m => m.family === 'flat').reduce((sum, m) => sum + m.gain_db, 0) / 20).toPrecision(17)};
                for (size_t i = 0; i < coefficients.size(); ++i)
                {
                    const auto& c = coefficients[i]; auto& s = state[channel][i];
                    const double y = c[0] * x + s[0]; s[0] = c[1] * x - c[3] * y + s[1]; s[1] = c[2] * x - c[4] * y; x = y;
                }
                buffer.setSample(channel, sample, static_cast<float>(bypass->load() > 0.5f ? input : x));
            }
    }
private:
    std::atomic<float>* bypass;
    double tailSeconds = 0;
    const std::array<std::array<double, 7>, ${count}> prototype = {{
${values}
    }};
    std::array<std::array<double, 5>, ${count}> coefficients {};
    std::array<std::array<std::array<double, 2>, ${count}>, 2> state {};
};
`;
  writeFileSync(join(directory, 'StarterDSP.h'), header);
  const provenance = { schema_version: 1, source_report: reportPath, source_sha256: sha(reportPath), row_ids: rows.map((r: any) => r.id), models, analog_sections: prototypes, limits: ['Fixed-control static fit export only: no inferred parameter mapping or automation/state-transition implementation.', 'Exported isolated models are relative to the neutral baseline; its coloration/global gain is not composed automatically.', 'Runtime bilinear sample-rate conversion clamps cutoff below Nyquist; behavior outside the measured range requires validation.', 'Generic JUCE editor, new identity and no copied vendor assets. Build then validate on independent stimuli; acceptance is not proprietary topology recovery.'] };
  dump(join(directory, 'fourier-model.json'), provenance);
  const readme = join(directory, 'README.md');
  writeFileSync(readme, `# Exported fixed-control surrogate\n\nSelected rows: ${provenance.row_ids.join(', ')}.\n\n${provenance.limits.map(limit => '- ' + limit).join('\n')}\n\nThe generated SOS replaces the gain starter DSP described below.\n\n` + readFileSync(readme, 'utf8'));
  return { status: 'ok', ...created, kind: 'fixed_control_surrogate', row_ids: provenance.row_ids, models: models.length, sections: count, provenance: join(directory, 'fourier-model.json'), limits: provenance.limits };
}
