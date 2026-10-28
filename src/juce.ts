import { spawnSync } from 'node:child_process';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync, statSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { digest, dump, expand, fields, integer, load, packageRoot, sha } from './io.js';
import { checkHost, workspaceHostFile } from './host.js';

function identifier(value: unknown, name: string, pattern = /^[A-Za-z][A-Za-z0-9]{0,47}$/): string {
  if (typeof value !== 'string' || !pattern.test(value)) throw new Error(`Invalid ${name}: ${value}`);
  return value;
}
export function juceDirectory(value: unknown): string {
  if (typeof value !== 'string') throw new Error('juce_path must be a local JUCE source directory');
  const directory = expand(value);
  for (const file of ['CMakeLists.txt', 'modules/juce_audio_processors/juce_audio_processors.h', 'extras/Build/CMake/JUCEUtils.cmake']) if (!existsSync(join(directory, file))) throw new Error(`Not a JUCE source checkout: missing ${join(directory, file)}`);
  return directory;
}
function which(name: string): string | null {
  const result = spawnSync(process.platform === 'win32' ? 'where.exe' : 'which', [name], { encoding: 'utf8', windowsHide: true, timeout: 10000 });
  return result.status === 0 ? result.stdout.trim().split(/\r?\n/)[0] : null;
}
export function doctor(jucePath?: unknown) {
  const cmake = which('cmake'); let version: string | null = null;
  if (cmake) { const r = spawnSync(cmake, ['--version'], { encoding: 'utf8', windowsHide: true, timeout: 10000 }); if (r.error || r.status !== 0 || !r.stdout.trim()) throw new Error(`CMake version check failed: ${r.error ?? r.stderr}`); version = r.stdout.trim().split(/\r?\n/)[0]; }
  return { cmake, cmake_version: version, juce_path: jucePath ? juceDirectory(jucePath) : null, compiler_candidates: Object.fromEntries(['cl', 'clang++', 'g++'].map(name => [name, which(name)])), ninja: which('ninja'), native_build_verified: false, note: 'Needs CMake >=3.22, a C++17 toolchain and a local JUCE checkout. On Windows use a VS developer shell or a matching CMake VS generator. Compiler discovery is not a build test. No downloads or installs.' };
}
// IDs are embedded in generated C++; append variants without renumbering existing starters.
export const dspVariants = ['gain', 'filter', 'compressor', 'saturation', 'delay', 'sine', 'subtractive', 'reverb', 'phaser', 'flanger', 'limiter', 'chorus', 'tremolo'];
export function create(projectDirectory: unknown, nameValue: unknown, kind: unknown, manufacturerCode: unknown, pluginCode: unknown, dspValue?: unknown) {
  if (typeof projectDirectory !== 'string') throw new Error('project_directory required');
  const name = identifier(nameValue, 'name'), manufacturer = identifier(manufacturerCode, 'manufacturer_code', /^[A-Za-z][A-Za-z0-9]{3}$/), code = identifier(pluginCode, 'plugin_code', /^[A-Za-z][A-Za-z0-9]{3}$/);
  if (!['effect', 'instrument'].includes(String(kind))) throw new Error('kind must be effect or instrument');
  const dsp = dspValue ?? (kind === 'instrument' ? 'sine' : 'gain');
  if (typeof dsp !== 'string' || !dspVariants.filter(v => (kind === 'instrument') === ['sine', 'subtractive'].includes(v)).includes(dsp)) throw new Error(`dsp must match kind: effects ${dspVariants.filter(v => !['sine', 'subtractive'].includes(v)).join('/')}; instruments sine/subtractive`);
  const directory = expand(projectDirectory), templates = join(packageRoot, 'templates', 'juce'), values: Record<string, string> = { NAME: name, MANUFACTURER_CODE: manufacturer, PLUGIN_CODE: code, SYNTH: kind === 'instrument' ? 'TRUE' : 'FALSE', DSP_ID: String(dspVariants.indexOf(dsp)), DSP: dsp };
  const files = readdirSync(templates).filter(name => name.endsWith('.in')).sort();
  if (['CMakeLists.txt', 'PluginProcessor.h', 'PluginProcessor.cpp', 'README.md', '.gitignore', 'StarterDSP.h', 'SubtractiveVoice.h'].some(name => !files.includes(name + '.in'))) throw new Error('JUCE templates are missing; reinstall Fourier');
  mkdirSync(dirname(directory), { recursive: true }); mkdirSync(directory);
  for (const filename of files) { let text = readFileSync(join(templates, filename), 'utf8'); for (const [key, value] of Object.entries(values)) text = text.replaceAll(`@${key}@`, value); writeFileSync(join(directory, filename.slice(0, -3)), text, { flag: 'wx' }); }
  dump(join(directory, 'fourier-project.json'), { schema_version: 1, name, kind, dsp });
  return { project_directory: directory, kind, dsp, target: `${name}_VST3`, files: [...files.map(f => f.slice(0, -3)), 'fourier-project.json'].sort(), next: 'Edit PluginProcessor.cpp/.h; call fourier_juce build with juce_path. Selected DSP starter is intentionally small, not an inferred proprietary algorithm. Read README.md for algorithm and quality limitations. Assign your own identity and review JUCE licensing before distribution.' };
}
export function runCmake(command: string[], logfile: string) {
  const fd = openSync(logfile, 'w');
  try {
    const result = spawnSync(command[0], command.slice(1), { stdio: ['ignore', fd, fd], windowsHide: true });
    if (result.error || result.status !== 0) { const bytes = readFileSync(logfile); throw new Error(`CMake exited ${result.status}: ${result.error ?? ''}; full log: ${logfile}\n${bytes.subarray(Math.max(0, bytes.length - 6000)).toString('utf8')}`); }
  } finally { closeSync(fd); }
}
function buildOptions(options: Record<string, unknown>) {
  const configuration = options.configuration ?? 'Release', generator = options.generator;
  if (!['Debug', 'Release'].includes(String(configuration))) throw new Error('configuration must be Debug or Release');
  const jobs = integer(options.jobs ?? 2, 'jobs', 1, 32);
  if (generator !== undefined && (typeof generator !== 'string' || !generator.trim() || generator.length > 100 || /[\x00-\x1f]/.test(generator))) throw new Error('Invalid CMake generator');
  const cmake = which('cmake'); if (!cmake) throw new Error('CMake not found on PATH; install CMake >=3.22');
  return { configuration: configuration as string, generator: generator as string | undefined, jobs, cmake, juce: juceDirectory(options.juce_path) };
}
export function build(projectDirectory: unknown, options: Record<string, unknown>) {
  if (typeof projectDirectory !== 'string') throw new Error('project_directory required');
  const directory = expand(projectDirectory), project = load<{ schema_version: number; kind: string; name: string }>(join(directory, 'fourier-project.json'));
  if (project.schema_version !== 1 || !['effect', 'instrument'].includes(project.kind)) throw new Error('Expected a Fourier JUCE project');
  const name = identifier(project.name, 'project name'), settings = buildOptions(options), buildDirectory = join(directory, 'build'); mkdirSync(buildDirectory, { recursive: true });
  const configureLog = join(buildDirectory, 'configure.log'), buildLog = join(buildDirectory, 'build.log');
  runCmake([settings.cmake, '-S', directory, '-B', buildDirectory, `-DFOURIER_JUCE_PATH:PATH=${settings.juce}`, `-DCMAKE_BUILD_TYPE=${settings.configuration}`, ...(settings.generator ? ['-G', settings.generator] : [])], configureLog);
  runCmake([settings.cmake, '--build', buildDirectory, '--config', settings.configuration, '--target', `${name}_VST3`, '--parallel', String(settings.jobs)], buildLog);
  const record = join(buildDirectory, `fourier-vst3-${settings.configuration}.txt`);
  if (!existsSync(record)) throw new Error(`Build returned success but VST3 artifact record missing: ${record}`);
  const plugin = expand(readFileSync(record, 'utf8').trim());
  if (!plugin.toLowerCase().endsWith('.vst3') || !existsSync(plugin)) throw new Error(`Build returned success but VST3 artifact missing: ${plugin}`);
  return { status: 'ok', project_directory: directory, plugin, configuration: settings.configuration, configure_log: configureLog, build_log: buildLog, installed: false, next: 'Inspect plugin, then plan and run it. Loading the build executes native code; only load trusted source.' };
}
export function buildHost(options: Record<string, unknown>) {
  fields(options, ['juce_path', 'configuration', 'generator', 'jobs', 'build_directory', 'activate'], 'native build option');
  if (options.build_directory !== undefined && (typeof options.build_directory !== 'string' || !options.build_directory.trim())) throw new Error('build_directory must be a non-empty path');
  if (options.activate !== undefined && typeof options.activate !== 'boolean') throw new Error('activate must be boolean');
  const settings = buildOptions(options), directory = join(packageRoot, 'native'), buildDirectory = expand(options.build_directory as string ?? join('.fourier', 'native-host'));
  if (buildDirectory === directory || buildDirectory === packageRoot) throw new Error('Select a separate native build directory');
  mkdirSync(buildDirectory, { recursive: true });
  const lock = join(buildDirectory, '.fourier-build.lock'), fd = openSync(lock, 'wx');
  try {
    const configureLog = join(buildDirectory, 'configure.log'), buildLog = join(buildDirectory, 'build.log');
    runCmake([settings.cmake, '-S', directory, '-B', buildDirectory, `-DFOURIER_JUCE_PATH:PATH=${settings.juce}`, `-DCMAKE_BUILD_TYPE=${settings.configuration}`, ...(settings.generator ? ['-G', settings.generator] : [])], configureLog);
    runCmake([settings.cmake, '--build', buildDirectory, '--config', settings.configuration, '--target', 'fourier-host', '--parallel', String(settings.jobs)], buildLog);
    const host = join(buildDirectory, `fourier-host${process.platform === 'win32' ? '.exe' : ''}`);
    if (!existsSync(host) || !statSync(host).isFile()) throw new Error(`Native host artifact missing: ${host}`);
    const capabilities = checkHost(host, ['inspect', 'render', 'state', 'automation']);
    const record = { schema_version: 1, path: host, sha256: capabilities.sha256, source_sha256: digest(['CMakeLists.txt', 'main.cpp'].map(f => sha(join(directory, f)))) };
    if (options.activate !== false) dump(workspaceHostFile(), record);
    return { status: 'ok', host, native_host: host, build_directory: buildDirectory, configure_log: configureLog, build_log: buildLog, activated: options.activate !== false, workspace_record: options.activate !== false ? workspaceHostFile() : null, capabilities, installed: false };
  } finally { closeSync(fd); rmSync(lock, { force: true }); }
}
export function juce(action: string, value: unknown) {
  const allowed: Record<string, string[]> = { doctor: ['juce_path'], create: ['project_directory', 'name', 'kind', 'manufacturer_code', 'plugin_code', 'dsp'], build: ['project_directory', 'juce_path', 'configuration', 'generator', 'jobs'] };
  if (!allowed[action]) throw new Error('Unknown JUCE action');
  const o = fields(value, allowed[action], 'JUCE option');
  if (action === 'doctor') return doctor(o.juce_path);
  if (action === 'create') return create(o.project_directory, o.name, o.kind, o.manufacturer_code, o.plugin_code, o.dsp);
  return build(o.project_directory, o);
}
