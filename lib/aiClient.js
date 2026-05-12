function trimTrailingSlash(s) {
  return String(s || '').replace(/\/+$/, '');
}

function withTimeout(ms) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  return { controller, timer };
}

async function callModel({ config, system, user, temperature = 0.2, maxTokens = 4096 }) {
  if (!config) throw new Error('missing config');
  let provider = config.provider || config.apiType || 'openai';
  const apiKey = config.apiKey || process.env[`${provider.toUpperCase()}_API_KEY`] || '';
  const model = config.model;
  if (!apiKey) throw new Error('missing apiKey');
  if (!model) throw new Error('missing model');
  // 调试：输出实际请求参数
  const logFile = 'D:\\AI\\project\\test\\debug_api.log';
  const logMsg = `[${new Date().toISOString()}] provider=${provider}, model=${model}, baseUrl=${config.baseUrl || '(default)'}\n`;
  try { require('fs').appendFileSync(logFile, logMsg); } catch(e) {}
  // DeepSeek 使用专用 provider 或自动识别 baseUrl
  if (provider === 'deepseek' || (provider === 'openai' && /deepseek/i.test(config.baseUrl || ''))) {
    provider = 'deepseek';
  }
  if (provider === 'anthropic') return callAnthropic({ config, apiKey, model, system, user, temperature, maxTokens });
  if (provider === 'gemini') return callGemini({ config, apiKey, model, system, user, temperature, maxTokens });
  if (provider === 'deepseek') return callDeepSeek({ config, apiKey, model, system, user, temperature, maxTokens });
  return callOpenAICompatible({ config, apiKey, model, system, user, temperature, maxTokens });
}

async function callDeepSeek({ config, apiKey, model, system, user, temperature, maxTokens }) {
  const base = trimTrailingSlash(config.baseUrl || 'https://api.deepseek.com');
  const url = /\/chat\/completions$/.test(base) ? base : `${base}/chat/completions`;
  // 调试：记录实际请求URL
  const logFile = 'D:\\AI\\project\\test\\debug_api.log';
  try { require('fs').appendFileSync(logFile, `  >> 实际请求URL: ${url}\n`); } catch(e) {}
  const messages = [
    { role: 'system', content: system || '' },
    { role: 'user', content: user || '' }
  ];
  const { controller, timer } = withTimeout(config.timeoutMs || 600000);
  try {
    const res = await fetch(url, {
      method: 'POST',
      signal: controller.signal,
      headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({ model, messages, temperature, max_tokens: maxTokens })
    });
    const data = await safeJson(res);
    if (!res.ok) throw new Error(data?.error?.message || data?.message || `DeepSeek error ${res.status}`);
    return data?.choices?.[0]?.message?.content || '';
  } finally {
    clearTimeout(timer);
  }
}

async function callOpenAICompatible({ config, apiKey, model, system, user, temperature, maxTokens }) {
  const base = trimTrailingSlash(config.baseUrl || config.apiUrl || 'https://api.openai.com/v1');
  const url = /\/chat\/completions$/.test(base) ? base : `${base}/chat/completions`;
  const messages = [
    { role: 'system', content: system || '' },
    { role: 'user', content: user || '' }
  ];
  const { controller, timer } = withTimeout(config.timeoutMs || 600000);
  try {
    const res = await fetch(url, {
      method: 'POST',
      signal: controller.signal,
      headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({ model, messages, temperature, max_tokens: maxTokens })
    });
    const data = await safeJson(res);
    if (!res.ok) throw new Error(data?.error?.message || data?.message || `OpenAI-compatible error ${res.status}`);
    return data?.choices?.[0]?.message?.content || '';
  } finally {
    clearTimeout(timer);
  }
}

async function callAnthropic({ config, apiKey, model, system, user, temperature, maxTokens }) {
  const base = trimTrailingSlash(config.baseUrl || config.apiUrl || 'https://api.anthropic.com');
  const url = /\/v1\/messages$/.test(base) ? base : `${base}/v1/messages`;
  const { controller, timer } = withTimeout(config.timeoutMs || 600000);
  try {
    const res = await fetch(url, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'content-type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': config.anthropicVersion || '2023-06-01'
      },
      body: JSON.stringify({
        model,
        max_tokens: maxTokens,
        temperature,
        system: system || '',
        messages: [{ role: 'user', content: user || '' }]
      })
    });
    const data = await safeJson(res);
    if (!res.ok) throw new Error(data?.error?.message || data?.message || `Anthropic error ${res.status}`);
    return (data?.content || []).map(p => p.text || '').join('');
  } finally {
    clearTimeout(timer);
  }
}

async function callGemini({ config, apiKey, model, system, user, temperature, maxTokens }) {
  const base = trimTrailingSlash(config.baseUrl || config.apiUrl || 'https://generativelanguage.googleapis.com');
  const root = /\/v1beta$/.test(base) ? base : `${base}/v1beta`;
  const url = `${root}/models/${encodeURIComponent(model)}:generateContent`;
  const { controller, timer } = withTimeout(config.timeoutMs || 600000);
  try {
    const res = await fetch(url, {
      method: 'POST',
      signal: controller.signal,
      headers: { 'content-type': 'application/json', 'x-goog-api-key': apiKey },
      body: JSON.stringify({
        system_instruction: { parts: [{ text: system || '' }] },
        contents: [{ role: 'user', parts: [{ text: user || '' }] }],
        generationConfig: { temperature, maxOutputTokens: maxTokens }
      })
    });
    const data = await safeJson(res);
    if (!res.ok) throw new Error(data?.error?.message || data?.message || `Gemini error ${res.status}`);
    return (data?.candidates?.[0]?.content?.parts || []).map(p => p.text || '').join('');
  } finally {
    clearTimeout(timer);
  }
}

async function safeJson(res) {
  const text = await res.text();
  try { return JSON.parse(text); } catch (_) { return { message: text }; }
}

module.exports = { callModel };
