// diagnose-apis.mjs — isolate the three-provider API failure.
// Mirrors src/engine/llmClients.ts (same env vars, same URL construction, same
// headers) but makes ONE call per provider and prints the final URL, HTTP
// status, and raw body. No game loop, no Blobs, no timeouts, no repo needed.
//
// Run with direct provider keys (see the env vars below), then: node diagnose-apis.mjs

const MODEL_NAMES = {
  openai: 'gpt-5.5',
  gemini: 'gemini-3.1-pro-preview',
  claude: 'claude-opus-4-8',
};

const PROMPT = 'Return a JSON object: {"ok": true}. Output only valid JSON.';

function gatewayFallback(provider) {
  const base = process.env.NETLIFY_AI_GATEWAY_BASE_URL;
  const key = process.env.NETLIFY_AI_GATEWAY_KEY;
  if (!base || !key) throw new Error(`No direct key set and gateway env not available for ${provider}`);
  return { baseUrl: `${base.replace(/\/$/, '')}/${provider}`, headers: { Authorization: `Bearer ${key}` } };
}

function openaiConfig() {
  if (process.env.OPENAI_BASE_URL && process.env.OPENAI_API_KEY)
    return { baseUrl: process.env.OPENAI_BASE_URL.replace(/\/$/, ''), headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}` } };
  return gatewayFallback('openai');
}
function anthropicConfig() {
  if (process.env.ANTHROPIC_BASE_URL && process.env.ANTHROPIC_API_KEY)
    return { baseUrl: process.env.ANTHROPIC_BASE_URL.replace(/\/$/, ''), headers: { 'x-api-key': process.env.ANTHROPIC_API_KEY } };
  return gatewayFallback('anthropic');
}
function geminiConfig() {
  if (process.env.GOOGLE_GEMINI_BASE_URL && process.env.GEMINI_API_KEY)
    return { baseUrl: process.env.GOOGLE_GEMINI_BASE_URL.replace(/\/$/, ''), headers: { 'x-goog-api-key': process.env.GEMINI_API_KEY } };
  return gatewayFallback('google');
}

async function probe(name, url, headers, body) {
  console.log(`\n=== ${name} ===`);
  console.log(`URL: ${url}`);
  try {
    const res = await fetch(url, {
      method: 'POST',
      signal: AbortSignal.timeout(30000),
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify(body),
    });
    const text = await res.text();
    console.log(res.ok ? `HTTP ${res.status} OK` : `HTTP ${res.status} ${res.statusText}  <-- FAILED`);
    console.log(`Body (first 600 chars):\n${text.slice(0, 600)}`);
  } catch (e) {
    console.log(`FETCH THREW: ${e.message}`);
  }
}

async function main() {
  try {
    const c = openaiConfig();
    await probe('OpenAI', `${c.baseUrl}/v1/chat/completions`, c.headers, {
      model: MODEL_NAMES.openai,
      messages: [{ role: 'user', content: PROMPT }],
      response_format: { type: 'json_object' },
    });
  } catch (e) { console.log(`\n=== OpenAI ===\nCONFIG ERROR: ${e.message}`); }

  try {
    const c = geminiConfig();
    await probe('Gemini', `${c.baseUrl}/v1beta/models/${MODEL_NAMES.gemini}:generateContent`, c.headers, {
      contents: [{ role: 'user', parts: [{ text: PROMPT }] }],
      generationConfig: { responseMimeType: 'application/json' },
    });
  } catch (e) { console.log(`\n=== Gemini ===\nCONFIG ERROR: ${e.message}`); }

  try {
    const c = anthropicConfig();
    await probe('Anthropic', `${c.baseUrl}/v1/messages`, { ...c.headers, 'anthropic-version': '2023-06-01' }, {
      model: MODEL_NAMES.claude,
      max_tokens: 1000,
      messages: [{ role: 'user', content: PROMPT }],
    });
  } catch (e) { console.log(`\n=== Anthropic ===\nCONFIG ERROR: ${e.message}`); }

  console.log('\nDone. A provider is working if it prints "HTTP 200 OK".');
}

main();
