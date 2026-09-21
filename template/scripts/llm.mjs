// Camada única de LLM para o worker. Configuração por variáveis (secrets.env ou ambiente):
//   LLM_KEY        credencial
//   LLM_MODEL      modelo (ex.: gemini-3.5-flash-lite, claude-haiku-4-5-20251001, gpt-5-mini, llama3.1)
//   LLM_PROVIDER   gemini | anthropic | openai | ollama  (opcional: inferido da chave e do modelo)
//   LLM_BASE_URL   opcional; OpenAI-compatível self-hosted (Ollama, LiteLLM, OpenRouter…)
// Compat: GEMINI_API_KEY / GEMINI_MODEL continuam aceitos.
export function llmConfig(env = process.env) {
  const key = env.LLM_KEY || env.GEMINI_API_KEY || '';
  const model = env.LLM_MODEL || env.GEMINI_MODEL || '';
  const base = env.LLM_BASE_URL || '';
  let provider = (env.LLM_PROVIDER || '').toLowerCase();
  if (!provider) {
    if (/^claude/.test(model) || /^sk-ant-/.test(key)) provider = 'anthropic';
    else if (/^gemini/.test(model) || /^(AIza|AQ\.)/.test(key)) provider = 'gemini';
    else if (base && !key) provider = 'ollama';
    else provider = 'openai';
  }
  const defaults = { gemini: 'gemini-3.5-flash-lite', anthropic: 'claude-haiku-4-5-20251001', openai: 'gpt-5-mini', ollama: 'llama3.1' };
  return { provider, key, model: model || defaults[provider], base };
}

/** Devolve o texto do modelo; com { json: true } faz o parse (tolerante a cercas ```json). */
/** Tenta de novo em 429/5xx (modelo sobrecarregado): 3 tentativas, 3 s e 9 s de espera. */
export async function complete(prompt, opts = {}) {
  let last;
  for (let i = 0; i < 3; i++) {
    try { return await completeOnce(prompt, opts); }
    catch (e) { last = e; if (!/\b(429|5\d\d)\b/.test(String(e.message))) throw e; await new Promise((r) => setTimeout(r, 3000 * (i * 2 + 1))); }
  }
  throw last;
}
const TIMEOUT = 5 * 60 * 1000; // uma resposta longa leva minutos; sem limite, um socket morto trava o worker
async function completeOnce(prompt, { json = false, maxTokens = 16000, temperature = 0.3, cfg = llmConfig() } = {}) {
  const { provider, key, model, base } = cfg;
  if (!key && provider !== 'ollama') throw new Error('LLM_KEY não configurada');
  const jsonHint = json ? '\n\nResponda somente com JSON válido, sem texto fora do objeto e sem cercas de código.' : '';
  let text;
  if (provider === 'gemini') {
    const r = await fetch(`${base || 'https://generativelanguage.googleapis.com'}/v1beta/models/${model}:generateContent?key=${key}`, {
      method: 'POST', signal: AbortSignal.timeout(TIMEOUT), headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ contents: [{ role: 'user', parts: [{ text: prompt }] }], generationConfig: { temperature, maxOutputTokens: maxTokens, ...(json ? { responseMimeType: 'application/json' } : {}) } })
    });
    if (!r.ok) throw new Error(`gemini ${r.status}: ${(await r.text()).slice(0, 300)}`);
    text = (await r.json()).candidates?.[0]?.content?.parts?.map((p) => p.text).join('') ?? '';
  } else if (provider === 'anthropic') {
    const r = await fetch(`${base || 'https://api.anthropic.com'}/v1/messages`, {
      method: 'POST', signal: AbortSignal.timeout(TIMEOUT), headers: { 'content-type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model, max_tokens: maxTokens, temperature, messages: [{ role: 'user', content: prompt + jsonHint }] })
    });
    if (!r.ok) throw new Error(`anthropic ${r.status}: ${(await r.text()).slice(0, 300)}`);
    text = (await r.json()).content?.filter((c) => c.type === 'text').map((c) => c.text).join('') ?? '';
  } else { // openai e compatíveis (ollama expõe /v1)
    const url = `${base || (provider === 'ollama' ? 'http://localhost:11434/v1' : 'https://api.openai.com/v1')}/chat/completions`;
    const r = await fetch(url, {
      method: 'POST', signal: AbortSignal.timeout(TIMEOUT), headers: { 'content-type': 'application/json', ...(key ? { authorization: `Bearer ${key}` } : {}) },
      body: JSON.stringify({ model, temperature, max_tokens: maxTokens, messages: [{ role: 'user', content: prompt + jsonHint }], ...(json ? { response_format: { type: 'json_object' } } : {}) })
    });
    if (!r.ok) throw new Error(`${provider} ${r.status}: ${(await r.text()).slice(0, 300)}`);
    text = (await r.json()).choices?.[0]?.message?.content ?? '';
  }
  if (!json) return text;
  const clean = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  try { return JSON.parse(clean); } catch { const m = clean.match(/\{[\s\S]*\}/); if (m) return JSON.parse(m[0]); throw new Error('resposta não é JSON: ' + clean.slice(0, 200)); }
}
