// Provider failures are reported as safe reasons: never echo upstream messages,
// which may embed credentials or request bodies.
const ROTATABLE = new Set(['INVALID_CREDENTIAL', 'MISSING_CREDENTIAL', 'AUTHENTICATION_ERROR', 'AUTHENTICATION_FAILED', 'RATE_LIMIT', 'RATE_LIMITED', 'QUOTA_EXCEEDED']);
export function failureError(finish) {
  const f = finish?.failure ?? {};
  const code = typeof f.code === 'string' ? f.code : 'MODEL_ERROR';
  const status = Number.isInteger(f.status) ? f.status : undefined;
  const explanation = code === 'INVALID_REQUEST' || status === 400 ? '请求被服务商拒绝：模型名或请求参数可能不受支持，请在DSH设置的轮次主题页选择可用模型' : status === 401 || code === 'INVALID_CREDENTIAL' ? 'API Key无效或已失效' : status === 403 ? 'API Key无访问权限' : status === 429 || /RATE_LIMIT|QUOTA/.test(code) ? '服务限流或额度不足' : '模型请求失败，请检查服务、模型权限或网络';
  return Object.assign(new Error(`${explanation}（${code.replace(/[^A-Z_0-9-]/gi, '').slice(0, 48)}${status ? ` / HTTP ${status}` : ''}）`), { code, status });
}
