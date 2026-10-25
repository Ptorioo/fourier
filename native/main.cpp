// One trusted plug-in per process. Isolation contains crashes, not malicious native code.
#include <juce_audio_utils/juce_audio_utils.h>
#include <cmath>
#include <cstring>
#include <iostream>
#include <stdexcept>
#include <vector>

using namespace juce;
static void require(bool condition, const String& message) {
    if (!condition) throw std::runtime_error(message.toStdString());
}
static var record() { return var(new DynamicObject()); }
static void set(var& value, const Identifier& key, const var& field) { value.getDynamicObject()->setProperty(key, field); }
static double finiteNumber(const var& value, double low, double high, const String& name) {
    require(value.isInt() || value.isInt64() || value.isDouble(), name + " must be numeric");
    auto n = static_cast<double>(value);
    require(std::isfinite(n) && n >= low && n <= high, name + " out of range"); return n;
}
static int boundedInt(const var& value, int low, int high, const String& name) {
    const auto n = finiteNumber(value, low, high, name);
    require(n == std::floor(n), name + " must be an integer"); return static_cast<int>(n);
}
static String parameterKey(int index, AudioProcessorParameter& parameter) {
    auto label = parameter.getName(128).toLowerCase().retainCharacters("abcdefghijklmnopqrstuvwxyz0123456789 _").replaceCharacter(' ', '_');
    return "p" + String(index) + "_" + (label.isEmpty() ? String("parameter") : label);
}
static var metadata(AudioPluginInstance& plugin, const PluginDescription& description) {
    auto info = record(), parameters = record();
    auto& list = plugin.getParameters();
    require(list.size() <= 4096, "Plug-in exposes too many parameters");
    for (int i = 0; i < list.size(); ++i) {
        auto& p = *list[i];
        if (!p.isAutomatable()) continue; // JUCE also exposes thousands of read-only MIDI controller proxies.
        auto entry = record(); auto raw = p.getValue();
        require(std::isfinite(raw), "Non-finite parameter readback");
        set(entry, "value", p.getText(raw, 2048)); set(entry, "raw_value", raw);
        set(entry, "label", p.getLabel()); set(entry, "index", i); set(entry, "name", p.getName(128));
        if (auto* hosted = dynamic_cast<HostedAudioProcessorParameter*>(&p)) set(entry, "id", hosted->getParameterID());
        set(entry, "automatable", p.isAutomatable());
        set(entry, "range", "Numeric values are normalized [0,1]; strings use the plug-in's text conversion");
        set(entry, "value_type", "normalized_or_text");
        if (p.isDiscrete() && p.getNumSteps() > 1 && p.getNumSteps() <= 256) {
            Array<var> values;
            for (int step = 0; step < p.getNumSteps(); ++step) values.add(p.getText(static_cast<float>(step) / (p.getNumSteps() - 1), 2048));
            set(entry, "valid_values", values); set(entry, "valid_values_truncated", false);
        }
        set(parameters, Identifier(parameterKey(i, p)), entry);
    }
    set(info, "name", description.name); set(info, "is_instrument", description.isInstrument);
    set(info, "reported_latency_samples", plugin.getLatencySamples()); set(info, "parameters", parameters); return info;
}
static void applyParameters(AudioPluginInstance& plugin, const var& parameters) {
    require(parameters.isObject() && parameters.getDynamicObject()->getProperties().size() <= 512, "Invalid parameters");
    auto& list = plugin.getParameters();
    for (const auto& pair : parameters.getDynamicObject()->getProperties()) {
        AudioProcessorParameter* parameter = nullptr;
        for (int i = 0; i < list.size(); ++i) if (parameterKey(i, *list[i]) == pair.name.toString()) { parameter = list[i]; break; }
        require(parameter != nullptr, "Unknown parameter " + pair.name.toString() + "; inspect first");
        require(parameter->isAutomatable(), "Parameter is not writable/automatable: " + pair.name.toString());
        float value;
        if (pair.value.isString()) {
            const auto text = pair.value.toString(); value = parameter->getValueForText(text);
            require(parameter->getText(value, 2048).trim().equalsIgnoreCase(text.trim()), "Text must exactly match a valid formatted parameter value; use normalized [0,1] otherwise");
        } else if (pair.value.isBool()) {
            require(parameter->isBoolean(), "Boolean value requires a boolean parameter"); value = static_cast<bool>(pair.value) ? 1.0f : 0.0f;
        } else value = static_cast<float>(finiteNumber(pair.value, 0, 1, "Normalized parameter"));
        require(std::isfinite(value) && value >= 0 && value <= 1, "Invalid normalized parameter");
        parameter->setValueNotifyingHost(value);
    }
}
static var execute(const var& request) {
    require(request.isObject(), "Request must be an object");
    auto operation = request["operation"].toString();
    require(operation == "inspect" || operation == "render", "Unknown host operation");
    const bool render = operation == "render";
    const double sr = render ? finiteNumber(request["sample_rate"], 8000, 192000, "sample_rate") : 48000;
    const int blockSize = render ? boundedInt(request["buffer_size"], 16, 32768, "buffer_size") : 512;
    File file(request["plugin"].toString()); require(file.exists(), "Plug-in path does not exist");
    AudioPluginFormatManager formats; formats.addDefaultFormats();
    OwnedArray<PluginDescription> descriptions;
    for (int i = 0; i < formats.getNumFormats(); ++i) {
        auto* format = formats.getFormat(i);
        if (format->fileMightContainThisPluginType(file.getFullPathName())) format->findAllTypesForFile(descriptions, file.getFullPathName());
    }
    PluginDescription* selected = nullptr;
    const auto requestedName = request["plugin_name"].toString();
    if (requestedName.isNotEmpty()) {
        for (auto* d : descriptions) if (d->name == requestedName) { require(selected == nullptr, "Ambiguous plug-in name"); selected = d; }
    } else if (descriptions.size() == 1) selected = descriptions[0];
    String names; for (auto* d : descriptions) names += d->name + "; ";
    require(selected != nullptr, "Select plugin_name from discovered types: " + names);
    String error;
    auto plugin = formats.createPluginInstance(*selected, sr, blockSize, error);
    require(plugin != nullptr, "Could not create plug-in: " + error);
    require(request["parameters"].isObject(), "parameters must be an object");
    if (!render) applyParameters(*plugin, request["parameters"]);
    auto response = record(); set(response, "status", "ok");
    if (render) {
        const int channels = boundedInt(request["channels"], 1, 2, "channels");
        const int frames = boundedInt(request["input_frames"], 32, 4000000 / channels, "frames");
        const double duration = finiteNumber(request["duration"], .01, 30, "duration");
        require(std::abs(frames - sr * duration) <= 1, "Frame count/duration mismatch");
        const bool midiInput = request["stimulus"]["kind"].toString() == "midi";
        require(selected->isInstrument == midiInput, "Instrument requires MIDI; effects require audio");
        require(plugin->getBusCount(false) >= 1, "No main output bus");
        auto layout = plugin->getBusesLayout();
        for (int i = 0; i < layout.inputBuses.size(); ++i) layout.inputBuses.getReference(i) = i == 0 && !selected->isInstrument ? AudioChannelSet::canonicalChannelSet(channels) : AudioChannelSet::disabled();
        for (int i = 0; i < layout.outputBuses.size(); ++i) layout.outputBuses.getReference(i) = i == 0 ? AudioChannelSet::canonicalChannelSet(channels) : AudioChannelSet::disabled();
        require(plugin->setBusesLayout(layout), "Plug-in does not support requested mono/stereo layout with sidechains disabled");
        require(plugin->getTotalNumOutputChannels() == channels && (selected->isInstrument || plugin->getTotalNumInputChannels() == channels), "Channel layout mismatch");
        const File output(request["output"].toString());
        if (request["state_file"].toString().isNotEmpty()) {
            require(request["state_plugin_name"].toString() == selected->name, "Snapshot selected plug-in type differs");
            MemoryBlock state; const File stateFile(request["state_file"].toString());
            require(stateFile.getSize() <= 4 * 1024 * 1024 && stateFile.loadFileAsData(state), "Invalid native state file");
            plugin->setStateInformation(state.getData(), static_cast<int>(state.getSize()));
        }
        applyParameters(*plugin, request["parameters"]);
        plugin->setNonRealtime(true); plugin->setRateAndBufferSizeDetails(sr, blockSize); plugin->prepareToPlay(sr, blockSize); plugin->reset();
        set(response, "initial_plugin", metadata(*plugin, *selected));
        struct Automation { int sample; var parameters; }; std::vector<Automation> automation;
        if (!request["automation"].isVoid() && !request["automation"].isUndefined()) {
            auto sequence = request["automation"].getArray(); require(sequence != nullptr && sequence->size() <= 256, "Invalid automation");
            int last = -1;
            for (const auto& event : *sequence) {
                const auto sample = static_cast<int>(std::llround(finiteNumber(event["time"], 0, duration, "Automation time") * sr));
                require(sample >= last && sample < frames && event["parameters"].isObject(), "Unordered/out-of-range automation");
                automation.push_back({sample, event["parameters"]}); last = sample;
            }
        }
        Array<var> readbacks; size_t nextAutomation = 0;
        MemoryBlock bytes;
        require(output.getChildFile("native.input.f32").loadFileAsData(bytes) && bytes.getSize() == static_cast<size_t>(channels) * frames * 4, "Invalid float32 input size");
        AudioBuffer<float> input(channels, frames), rendered(channels, frames);
        for (int ch = 0; ch < channels; ++ch) for (int i = 0; i < frames; ++i) {
            auto word = ByteOrder::littleEndianInt(static_cast<const char*>(bytes.getData()) + (static_cast<size_t>(ch) * frames + i) * 4);
            float v; std::memcpy(&v, &word, 4); require(std::isfinite(v), "Non-finite input"); input.setSample(ch, i, v);
        }
        struct Event { int sample; MidiMessage message; }; std::vector<Event> events;
        auto midi = request["midi"].getArray(); require(midi != nullptr && midi->size() <= 256, "Invalid MIDI event list");
        int previous = -1;
        for (const auto& event : *midi) {
            const auto time = finiteNumber(event["time"], 0, duration, "MIDI time");
            const int sample = static_cast<int>(std::llround(time * sr));
            auto data = event["data"].getArray(); require(data != nullptr && (data->size() == 2 || data->size() == 3) && sample >= previous, "Invalid MIDI event");
            uint8 raw[3] = {};
            for (int i = 0; i < data->size(); ++i) raw[i] = static_cast<uint8>(boundedInt((*data)[i], i == 0 ? 0x80 : 0, i == 0 ? 0xef : 127, "MIDI byte"));
            require(data->size() == ((raw[0] >> 4 == 0xc || raw[0] >> 4 == 0xd) ? 2 : 3), "MIDI byte count mismatch");
            events.push_back({sample, MidiMessage(raw, data->size())}); previous = sample;
        }
        size_t next = 0;
        for (int offset = 0; offset < frames;) {
            while (nextAutomation < automation.size() && automation[nextAutomation].sample == offset) {
                const auto& event = automation[nextAutomation++]; applyParameters(*plugin, event.parameters);
                auto entry = record(), values = record(); const auto all = metadata(*plugin, *selected)["parameters"];
                for (const auto& pair : event.parameters.getDynamicObject()->getProperties()) set(values, pair.name, all[pair.name]);
                set(entry, "sample", offset); set(entry, "parameters", values); readbacks.add(entry);
            }
            const int count = jmin(blockSize, frames - offset, nextAutomation < automation.size() ? automation[nextAutomation].sample - offset : frames - offset);
            AudioBuffer<float> buffer(jmax(plugin->getTotalNumInputChannels(), channels), count); buffer.clear();
            if (!selected->isInstrument) for (int ch = 0; ch < channels; ++ch) buffer.copyFrom(ch, 0, input, ch, offset, count);
            MidiBuffer messages;
            while (next < events.size() && events[next].sample < offset + count) { messages.addEvent(events[next].message, events[next].sample - offset); ++next; }
            { const ScopedLock lock(plugin->getCallbackLock()); ScopedNoDenormals denormals; plugin->processBlock(buffer, messages); }
            for (int ch = 0; ch < channels; ++ch) for (int i = 0; i < count; ++i) { auto v = buffer.getSample(ch, i); require(std::isfinite(v), "Plug-in produced non-finite output"); rendered.setSample(ch, offset + i, v); }
            offset += count;
        }
        set(response, "automation_readbacks", readbacks);
        set(response, "render_controls_version", 1);
        if (request["save_state"].isBool() && static_cast<bool>(request["save_state"])) {
            MemoryBlock state; plugin->getStateInformation(state);
            require(state.getSize() <= 4 * 1024 * 1024 && output.getChildFile("native.state.output.bin").replaceWithData(state.getData(), state.getSize()), "Cannot save bounded native state");
        }
        FileOutputStream stream(output.getChildFile("native.output.f32")); require(stream.openedOk(), "Cannot open native output");
        for (int ch = 0; ch < channels; ++ch) for (int i = 0; i < frames; ++i) require(stream.writeFloat(rendered.getSample(ch, i)), "Failed writing native output");
        stream.flush(); require(stream.getStatus().wasOk(), "Failed flushing native output"); plugin->releaseResources();
    }
    set(response, "plugin", metadata(*plugin, *selected)); return response;
}
int main(int argc, char** argv) {
    if (argc != 5 || String(argv[1]) != "--request" || String(argv[3]) != "--response") { std::cerr << "fourier-host --request FILE --response FILE\n"; return 2; }
    ScopedJuceInitialiser_GUI init;
    var response; int status = 0;
    try {
        File requestFile(String::fromUTF8(argv[2])); require(requestFile.getSize() <= 8 * 1024 * 1024, "Request exceeds size guard");
        var request; auto parsed = JSON::parse(requestFile.loadFileAsString(), request); require(parsed.wasOk(), parsed.getErrorMessage()); response = execute(request);
    } catch (const std::exception& error) { response = record(); set(response, "status", "error"); set(response, "error", String(error.what())); status = 1; }
    if (!File(String::fromUTF8(argv[4])).replaceWithText(JSON::toString(response, false))) { std::cerr << "Cannot write host response\n"; return 1; }
    return status;
}
