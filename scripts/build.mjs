import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const pending = new Map();
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
function snapshot(root) {
  const sources = [];
  const visit = directory => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) visit(path);
      else if (entry.name.endsWith('.ts') && path !== join(root, 'src', 'index.ts')) sources.push(relative(root, path).replaceAll('\\', '/'));
    }
  };
  visit(join(root, 'src')); sources.sort();
  const inputs = [...sources, 'tsconfig.json', 'tsconfig.build.json', 'scripts/build.mjs'];
  const source = hash(JSON.stringify(inputs.map(name => [name, hash(readFileSync(join(root, name)))])));
  const outputs = Object.fromEntries(sources.map(name => {
    const output = name.replace(/^src\//, 'dist/').replace(/\.ts$/, '.js');
    return [output, existsSync(join(root, output)) ? hash(readFileSync(join(root, output))) : null];
  }));
  return { source, outputs };
}

// Both Pi tools and the CLI check content, not mtimes, before launching dist/cli.js.
export function buildBackend(root = packageRoot, force = false) {
  root = resolve(root);
  if (pending.has(root)) return pending.get(root);
  const operation = (async () => {
    const stamp = join(root, 'dist', '.build.json'), before = snapshot(root);
    try {
      if (!force && Object.values(before.outputs).every(Boolean) && JSON.stringify(JSON.parse(readFileSync(stamp, 'utf8'))) === JSON.stringify(before)) return;
    } catch { /* Missing/invalid stamp requires a successful local compilation. */ }
    const compiler = join(root, 'node_modules', 'typescript', 'bin', 'tsc');
    if (!existsSync(compiler)) throw new Error('Fourier backend is missing or stale. Install build dependencies with npm install --include=dev, then run npm run build. No compiler was downloaded.');
    await new Promise((done, fail) => {
      const child = spawn(process.execPath, [compiler, '-p', 'tsconfig.build.json', '--noEmitOnError'], { cwd: root, shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
      let output = '';
      for (const stream of [child.stdout, child.stderr]) stream.on('data', chunk => { output = (output + chunk).slice(-128 * 1024); });
      const timer = setTimeout(() => child.kill('SIGKILL'), 60000);
      child.once('error', error => { clearTimeout(timer); fail(error); });
      child.once('close', code => { clearTimeout(timer); code === 0 ? done() : fail(new Error(`Fourier backend build failed (${code}):\n${output}`)); });
    });
    const after = snapshot(root);
    if (before.source !== after.source || !Object.values(after.outputs).every(Boolean)) throw new Error('Fourier sources changed during compilation or outputs are missing; retry the build before launch.');
    writeFileSync(stamp, JSON.stringify(after));
  })();
  pending.set(root, operation);
  return operation.finally(() => pending.delete(root));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  buildBackend(packageRoot, true).catch(error => { console.error(error.message); process.exitCode = 1; });
}
