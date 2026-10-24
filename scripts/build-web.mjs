import { build } from 'esbuild';
import { mkdir, copyFile } from 'node:fs/promises';
await mkdir('dist/web', { recursive: true });
await build({
  entryPoints: ['web/consent.ts'],
  bundle: true,
  outfile: 'dist/web/consent.js',
  platform: 'browser',
  format: 'esm',
  target: ['es2022'],
  minify: true,
});
for (const file of ['consent.html', 'consent.css'])
  await copyFile('web/' + file, 'dist/web/' + file);
