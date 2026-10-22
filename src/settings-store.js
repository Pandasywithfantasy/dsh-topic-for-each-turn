import { mkdir, readFile, writeFile, rename, unlink } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
// The theme plugin owns its own model settings file. Writing the plugin's own
// Config through the settings service is refused when the entry was inserted by
// a profile patch `insert:` block, so config is read-only here.
export const SETTINGS_FILE = 'model-settings.json';
export function validateSettings(value) {
  if (!value || value.version !== 1) throw new Error('模型设置文件格式不兼容，请在设置页重新保存');
  const { provider, model, reasoningEffort, maxTokens } = value;
  if (typeof provider !== 'string' || !provider.trim() || provider.length > 200) throw new Error('模型设置文件缺少有效服务商');
  if (typeof model !== 'string' || !model.trim() || model.length > 200) throw new Error('模型设置文件缺少有效模型');
  if (typeof reasoningEffort !== 'string' || reasoningEffort.length > 40) throw new Error('模型设置文件的推理强度无效');
  if (!Number.isInteger(maxTokens) || maxTokens < 80 || maxTokens > 4096) throw new Error('模型设置文件的输出上限无效');
  return { provider, model, reasoningEffort, maxTokens };
}
export function effectiveConfig(config, stored) { return { ...config, ...(stored ?? {}) }; }
export class SettingsStore {
  constructor(root) { this.root = root; }
  path() { return join(this.root, SETTINGS_FILE); }
  async read() {
    try { return validateSettings(JSON.parse(await readFile(this.path(), 'utf8'))); }
    catch (e) { if (e.code === 'ENOENT') return undefined; throw new Error('读取主题模型设置失败：' + e.message); }
  }
  async save(settings) {
    const target = this.path(); await mkdir(this.root, { recursive: true });
    const temp = target + '.' + randomUUID() + '.tmp';
    try { await writeFile(temp, JSON.stringify({ version: 1, ...settings }, null, 2), { flag: 'wx' }); await rename(temp, target); }
    finally { await unlink(temp).catch(e => { if (e.code !== 'ENOENT') throw e; }); }
  }
}
