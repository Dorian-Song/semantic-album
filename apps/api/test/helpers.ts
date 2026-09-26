import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import sharp from 'sharp';
import { createApp } from '../src/app.js';
import type { Env } from '../src/config/env.js';

const run = promisify(execFile);

export async function testApp(overrides: Partial<Env> = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'album-it-'));
  const env: Env = {
    apiHost: '127.0.0.1',
    apiPort: 0,
    dataDir: path.join(dir, 'data'),
    n8nBaseUrl: null,
    vllmEnabled: false,
    vllmBaseUrl: 'http://127.0.0.1:1',
    importConcurrency: 2,
    maxImportBytes: 20 * 1024 * 1024,
    assetGraceMs: 60_000,
    ...overrides,
  };
  const { app, services } = await createApp(env, false);
  return {
    app,
    services,
    dir,
    env,
    close: async () => {
      await app.close();
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

function color(seed: number) {
  return { r: (seed * 37) % 256, g: (seed * 91) % 256, b: (seed * 53) % 256 };
}

export function jpeg(seed: number, width = 64, height = 48) {
  return sharp({ create: { width, height, channels: 3, background: color(seed) } }).jpeg();
}

export function png(seed: number): Promise<Buffer> {
  return sharp({ create: { width: 40, height: 40, channels: 4, background: { ...color(seed), alpha: 1 } } }).png().toBuffer();
}

/** Minimal ISO-BMFF header of an MP4 file: an "ftyp" box with brand "isom". */
export function fakeMp4(): Buffer {
  const box = Buffer.alloc(32);
  box.writeUInt32BE(32, 0);
  box.write('ftypisom', 4, 'ascii');
  box.write('isomiso2avc1mp41', 16, 'ascii');
  return Buffer.concat([box, randomBytes(256)]);
}

/** A real HEIC encoded by heif-enc, or null when the tool is not installed. */
export async function heic(dir: string, seed: number): Promise<Buffer | null> {
  const src = path.join(dir, `src-${seed}.png`);
  const out = path.join(dir, `out-${seed}.heic`);
  await sharp({ create: { width: 64, height: 64, channels: 3, background: color(seed) } }).png().toFile(src);
  try {
    await run('heif-enc', [src, '-o', out]);
    return fs.readFileSync(out);
  } catch {
    return null;
  }
}

export function multipart(filename: string, data: Buffer) {
  const boundary = `----albumtest${randomBytes(8).toString('hex')}`;
  const head = `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: application/octet-stream\r\n\r\n`;
  return {
    payload: Buffer.concat([Buffer.from(head), data, Buffer.from(`\r\n--${boundary}--\r\n`)]),
    headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
  };
}

export function countFiles(dir: string): number {
  if (!fs.existsSync(dir)) return 0;
  return fs.readdirSync(dir, { recursive: true, withFileTypes: true }).filter((e) => e.isFile()).length;
}
