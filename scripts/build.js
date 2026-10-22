import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
const files = ['src/core.js', 'src/continuity.js', 'src/index.js', 'src/client.js', 'src/preview.js', 'src/llm-error.js', 'src/settings-panel.js', 'src/model-settings.js', 'src/settings-bridge.js', 'src/settings-store.js', 'src/batch.js', 'src/batch-panel.js'];
for (const file of files) {
  const result = spawnSync(process.execPath, ['--check', file], { stdio: 'inherit' });
  if (result.status !== 0) process.exit(result.status ?? 1);
}
await mkdir('lib', { recursive: true });
const preview = (await readFile('src/preview.js', 'utf8')).replace(/^export /gm, '');
const client = (await readFile('src/client.js', 'utf8')).replace('/* PREVIEW_ADAPTER */', preview).replace('/* SETTINGS_PANEL */', (await readFile('src/batch-panel.js', 'utf8')) + '\n' + (await readFile('src/settings-panel.js', 'utf8')));
await writeFile('lib/client.js', client);
console.log('Build OK: host syntax checked; client emitted to lib/client.js (no bundler dependency).');
