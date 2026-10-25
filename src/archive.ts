import { readFileSync, statSync, writeFileSync } from 'node:fs';
import { crc32, deflateRawSync, inflateRawSync } from 'node:zlib';
import { audioBytes } from './io.js';
import type { Audio } from './types.js';

function npy(descr: string, shape: number[], data: Buffer): Buffer {
  const text = `{'descr': '${descr}', 'fortran_order': False, 'shape': (${shape.join(', ')}${shape.length === 1 ? ',' : ''}), }`;
  const header = Buffer.from(text + ' '.repeat((64 - (10 + text.length + 1) % 64) % 64) + '\n');
  const prefix = Buffer.alloc(10); Buffer.from([0x93, 0x4e, 0x55, 0x4d, 0x50, 0x59, 1, 0]).copy(prefix); prefix.writeUInt16LE(header.length, 8);
  return Buffer.concat([prefix, header, data]);
}
export function saveAudio(path: string, input: Audio, output: Audio, sr: number) {
  const rate = Buffer.alloc(8); rate.writeBigInt64LE(BigInt(sr));
  const files: [string, Buffer][] = [['input', npy('<f4', [input.length, input[0].length], audioBytes(input))], ['output', npy('<f4', [output.length, output[0].length], audioBytes(output))], ['sample_rate', npy('<i8', [], rate)]];
  const chunks: Buffer[] = [], central: Buffer[] = []; let offset = 0, centralSize = 0;
  for (const [key, bytes] of files) {
    const name = Buffer.from(`${key}.npy`), compressed = deflateRawSync(bytes), crc = crc32(bytes), local = Buffer.alloc(30), dir = Buffer.alloc(46);
    local.writeUInt32LE(0x04034b50); local.writeUInt16LE(20, 4); local.writeUInt16LE(8, 8); local.writeUInt32LE(crc, 14); local.writeUInt32LE(compressed.length, 18); local.writeUInt32LE(bytes.length, 22); local.writeUInt16LE(name.length, 26);
    dir.writeUInt32LE(0x02014b50); dir.writeUInt16LE(20, 4); dir.writeUInt16LE(20, 6); dir.writeUInt16LE(8, 10); dir.writeUInt32LE(crc, 16); dir.writeUInt32LE(compressed.length, 20); dir.writeUInt32LE(bytes.length, 24); dir.writeUInt16LE(name.length, 28); dir.writeUInt32LE(offset, 42);
    chunks.push(local, name, compressed); central.push(dir, name); offset += local.length + name.length + compressed.length; centralSize += dir.length + name.length;
  }
  const end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50); end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10); end.writeUInt32LE(centralSize, 12); end.writeUInt32LE(offset, 16);
  writeFileSync(path, Buffer.concat([...chunks, ...central, end]));
}
interface ArrayData { descr: string; shape: number[]; data: Buffer }
function parseNpy(data: Buffer): ArrayData {
  if (data.length < 10 || !data.subarray(0, 6).equals(Buffer.from([0x93, 0x4e, 0x55, 0x4d, 0x50, 0x59])) || ![1, 2, 3].includes(data[6])) throw new Error('Invalid NumPy array');
  const start = data[6] === 1 ? 10 : 12, size = data[6] === 1 ? data.readUInt16LE(8) : data.readUInt32LE(8);
  if (size > 65536 || start + size > data.length) throw new Error('Invalid NumPy header');
  const header = data.toString('utf8', start, start + size), descr = /'descr':\s*'([^']+)'/.exec(header)?.[1], shapeText = /'shape':\s*\(([\d,\s]*)\)/.exec(header)?.[1];
  if (!descr || shapeText === undefined || !/'fortran_order':\s*False/.test(header)) throw new Error('Only C-order numeric arrays are supported');
  const shape = shapeText.split(',').map(v => v.trim()).filter(Boolean).map(Number);
  if (shape.some(n => !Number.isSafeInteger(n) || n < 1) || shape.reduce((a, b) => a * b, 1) > 4_000_000) throw new Error('Array size guard exceeded');
  return { descr, shape, data: data.subarray(start + size) };
}
export function loadAudio(path: string): { input: Audio; output: Audio; sample_rate: number } {
  if (statSync(path).size > 40 * 1024 * 1024) throw new Error('Audio archive exceeds size guard');
  const zip = readFileSync(path), arrays = new Map<string, ArrayData>();
  let end = -1;
  for (let i = zip.length - 22; i >= Math.max(0, zip.length - 65557); i--) if (zip.readUInt32LE(i) === 0x06054b50 && i + 22 + zip.readUInt16LE(i + 20) === zip.length) { end = i; break; }
  if (end < 0) throw new Error('Invalid ZIP archive');
  const count = zip.readUInt16LE(end + 10); let offset = zip.readUInt32LE(end + 16), total = 0;
  if (count !== 3) throw new Error('Unexpected archive entries');
  for (let i = 0; i < count; i++) {
    if (offset + 46 > end || zip.readUInt32LE(offset) !== 0x02014b50) throw new Error('Invalid ZIP directory');
    const flags = zip.readUInt16LE(offset + 8), method = zip.readUInt16LE(offset + 10), compressed = zip.readUInt32LE(offset + 20), size = zip.readUInt32LE(offset + 24), nameLength = zip.readUInt16LE(offset + 28), extra = zip.readUInt16LE(offset + 30), comment = zip.readUInt16LE(offset + 32), local = zip.readUInt32LE(offset + 42);
    const name = zip.toString('utf8', offset + 46, offset + 46 + nameLength);
    if (flags & 1 || ![0, 8].includes(method) || size > 17_000_000 || (total += size) > 34_000_000 || local + 30 > zip.length || zip.readUInt32LE(local) !== 0x04034b50) throw new Error('Unsafe or unsupported audio archive');
    const start = local + 30 + zip.readUInt16LE(local + 26) + zip.readUInt16LE(local + 28);
    if (!['input.npy', 'output.npy', 'sample_rate.npy'].includes(name) || start + compressed > zip.readUInt32LE(end + 16) || offset + 46 + nameLength + extra + comment > end || arrays.has(name)) throw new Error('Invalid ZIP entry bounds or duplicate');
    if (['input.npy', 'output.npy', 'sample_rate.npy'].includes(name)) {
      const source = zip.subarray(start, start + compressed), bytes = method === 8 ? inflateRawSync(source, { maxOutputLength: Math.max(1, size) }) : source;
      if (bytes.length !== size || crc32(bytes) !== zip.readUInt32LE(offset + 16)) throw new Error('Archive CRC/size mismatch');
      arrays.set(name, parseNpy(bytes));
    }
    offset += 46 + nameLength + extra + comment;
  }
  function audio(name: string): Audio {
    const array = arrays.get(name);
    if (!array || array.descr !== '<f4' || array.shape.length !== 2 || ![1, 2].includes(array.shape[0]) || array.data.length !== array.shape[0] * array.shape[1] * 4) throw new Error(`Invalid float32 audio array: ${name}`);
    return Array.from({ length: array.shape[0] }, (_, ch) => Float32Array.from({ length: array.shape[1] }, (_, i) => {
      const value = array.data.readFloatLE((ch * array.shape[1] + i) * 4);
      if (!Number.isFinite(value)) throw new Error('Non-finite audio sample'); return value;
    }));
  }
  const rate = arrays.get('sample_rate.npy');
  if (!rate || rate.shape.length !== 0 || !['<i8', '<i4'].includes(rate.descr) || rate.data.length !== (rate.descr === '<i8' ? 8 : 4)) throw new Error('Invalid sample rate');
  const sr = rate.descr === '<i8' ? Number(rate.data.readBigInt64LE()) : rate.data.readInt32LE();
  if (!Number.isInteger(sr) || sr < 8000 || sr > 192000) throw new Error('Invalid sample rate');
  return { input: audio('input.npy'), output: audio('output.npy'), sample_rate: sr };
}
