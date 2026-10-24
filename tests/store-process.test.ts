import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { Store } from '../src/core/store.js';
test('separate OS processes share one rolling account quota', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'motion-multiprocess-')),
    path = join(dir, 'state.sqlite');
  const initial = new Store(path);
  initial.close();
  const script =
    "import {Store} from './src/core/store.ts';const s=new Store(process.env.TEST_DB);console.log(s.reserve('shared',1,1000));s.close();";
  const run = () =>
    new Promise<number>((resolve, reject) => {
      const p = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script], {
        cwd: process.cwd(),
        env: { ...process.env, TEST_DB: path },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let out = '';
      let err = '';
      p.stdout.on('data', (x) => (out += x));
      p.stderr.on('data', (x) => (err += x));
      p.on('exit', (code) => (code === 0 ? resolve(Number(out.trim())) : reject(new Error(err))));
    });
  try {
    assert.deepEqual(
      (await Promise.all([run(), run(), run()])).sort((a, b) => a - b),
      [0, 60000, 60000]
    );
  } finally {
    rmSync(dir, { recursive: true });
  }
});
