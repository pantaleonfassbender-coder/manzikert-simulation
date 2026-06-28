import type { ModelProvider, ActionAllocation } from './types';
import { MODEL_NAMES } from './models';

const AI_REQUEST_TIMEOUT_MS = 20000;
// Per-call resilience: transient API errors / occasional malformed JSON are
// retried a few times here. If a call still fails, callLLM throws and the
// caller is responsible for discarding and re-running the whole game run
// (see batch-games-background.ts) — per preregistration Q6.
const MAX_LLM_ATTEMPTS = 3;
const RETRY_BACKOFF_MS = 750;

const delay = (ms: number) => new Promise((res) => setTimeout(res, ms));

type JsonValue = Record<string, any>;
type ProviderConfig = {
  baseUrl: string;
  headers: HeadersInit;
};

function getGatewayFallback(provider: 'anthropic' | 'google' | 'openai'): ProviderConfig {
  const gatewayBaseUrl = process.env.NETLIFY_AI_GATEWAY_BASE_URL;
  const gatewayKey = process.env.NETLIFY_AI_GATEWAY_KEY;

  if (!gatewayBaseUrl || !gatewayKey) {
    throw new Error(`Netlify AI Gateway environment is not available for ${provider} in this server context.`);
  }

  return {
    baseUrl: `${gatewayBaseUrl.replace(/\/$/, '')}/${provider}`,
    headers: { Authorization: `Bearer ${gatewayKey}` },
  };
}

function getOpenAIConfig(): ProviderConfig {
  if (process.env.OPENAI_BASE_URL && process.env.OPENAI_API_KEY) {
    return {
      baseUrl: process.env.OPENAI_BASE_URL.replace(/\/$/, ''),
      headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
    };
  }

  return getGatewayFallback('openai');
}

function getAnthropicConfig(): ProviderConfig {
  if (process.env.ANTHROPIC_BASE_URL && process.env.ANTHROPIC_API_KEY) {
    return {
      baseUrl: process.env.ANTHROPIC_BASE_URL.replace(/\/$/, ''),
      headers: { 'x-api-key': process.env.ANTHROPIC_API_KEY },
    };
  }

  return getGatewayFallback('anthropic');
}

function getGeminiConfig(): ProviderConfig {
  if (process.env.GOOGLE_GEMINI_BASE_URL && process.env.GEMINI_API_KEY) {
    return {
      baseUrl: process.env.GOOGLE_GEMINI_BASE_URL.replace(/\/$/, ''),
      headers: { 'x-goog-api-key': process.env.GEMINI_API_KEY },
    };
  }

  return getGatewayFallback('google');
}

async function postJson(url: string, config: ProviderConfig, body: JsonValue, headers: HeadersInit = {}) {
  const response = await fetch(url, {
    method: 'POST',
    signal: AbortSignal.timeout(AI_REQUEST_TIMEOUT_MS),
    headers: {
      'Content-Type': 'application/json',
      ...config.headers,
      ...headers,
    },
    body: JSON.stringify(body),
  });

  const responseText = await response.text();

  if (!response.ok) {
    throw new Error(`AI Gateway request failed with status ${response.status}: ${responseText}`);
  }

  return JSON.parse(responseText);
}

async function callOpenAI(prompt: string) {
  const config = getOpenAIConfig();
  const data = await postJson(`${config.baseUrl}/v1/chat/completions`, config, {
    model: MODEL_NAMES.openai,
    messages: [
      {
        role: 'system',
        content: 'Return only valid JSON. Do not include markdown or commentary.',
      },
      { role: 'user', content: prompt },
    ],
    response_format: { type: 'json_object' },
  });

  return data.choices?.[0]?.message?.content || '{}';
}

async function callGemini(prompt: string) {
  const config = getGeminiConfig();
  const data = await postJson(`${config.baseUrl}/v1beta/models/${MODEL_NAMES.gemini}:generateContent`, config, {
    contents: [
      {
        role: 'user',
        parts: [{ text: prompt }],
      },
    ],
    generationConfig: {
      responseMimeType: 'application/json',
    },
  });

  return data.candidates?.[0]?.content?.parts?.map((part: JsonValue) => part.text || '').join('') || '{}';
}

async function callClaude(prompt: string) {
  const config = getAnthropicConfig();
  const data = await postJson(
    `${config.baseUrl}/v1/messages`,
    config,
    {
      model: MODEL_NAMES.claude,
      max_tokens: 1000,
      messages: [{ role: 'user', content: `${prompt}\n\nOutput only valid JSON.` }],
    },
    { 'anthropic-version': '2023-06-01' },
  );

  return data.content?.map((block: JsonValue) => block.text || '').join('') || '{}';
}

// Largest-remainder rounding so the three categories always sum to exactly 100
// AP (registered constraint) without producing negative values.
function normalizeTo100(military: number, diplomacy: number, internal: number): [number, number, number] {
  const total = military + diplomacy + internal;
  const scaled = [military, diplomacy, internal].map((v) => (v / total) * 100);
  const floored = scaled.map(Math.floor);
  let remainder = 100 - floored.reduce((a, b) => a + b, 0);
  const order = scaled
    .map((v, i) => ({ i, frac: v - Math.floor(v) }))
    .sort((a, b) => b.frac - a.frac);
  for (let k = 0; k < remainder; k++) {
    floored[order[k % 3].i] += 1;
  }
  return [floored[0], floored[1], floored[2]];
}

// Strict validation. A response is treated as a *malformed generation* (and
// therefore retried / ultimately discarded) if it cannot be parsed, omits the
// numeric action points, allocates nothing, or omits the mandatory
// self-assessment (the key dependent variable for the LIWC-22 analysis). No
// placeholder or fallback values are ever substituted into the dataset.
function parseAllocation(rawJson: string): ActionAllocation {
  const cleaned = rawJson.replace(/```json\n?|\n?```/g, '').trim();
  const parsed = JSON.parse(cleaned); // throws on malformed JSON

  const military = Number(parsed.military);
  const diplomacy = Number(parsed.diplomacy);
  const internal = Number(parsed.internal);

  if (![military, diplomacy, internal].every((n) => Number.isFinite(n) && n >= 0)) {
    throw new Error('Malformed allocation: military/diplomacy/internal must be non-negative numbers.');
  }
  if (military + diplomacy + internal <= 0) {
    throw new Error('Malformed allocation: action points sum to zero.');
  }

  const selfAssessment = typeof parsed.selfAssessment === 'string' ? parsed.selfAssessment.trim() : '';
  if (!selfAssessment) {
    throw new Error('Malformed allocation: missing mandatory selfAssessment.');
  }

  const [normMilitary, normDiplomacy, normInternal] = normalizeTo100(military, diplomacy, internal);

  return {
    military: normMilitary,
    diplomacy: normDiplomacy,
    internal: normInternal,
    messages: parsed.messages && typeof parsed.messages === 'object' ? parsed.messages : {},
    selfAssessment,
  };
}

// Inference is proxied through Netlify AI Gateway. Netlify injects provider
// URLs and credentials into server-side contexts for these direct HTTP calls.
export async function callLLM(provider: ModelProvider, prompt: string): Promise<ActionAllocation> {
  let lastError: unknown;

  for (let attempt = 1; attempt <= MAX_LLM_ATTEMPTS; attempt++) {
    try {
      let rawJson = '';
      if (provider === 'openai') {
        rawJson = await callOpenAI(prompt);
      } else if (provider === 'gemini') {
        rawJson = await callGemini(prompt);
      } else if (provider === 'claude') {
        rawJson = await callClaude(prompt);
      } else {
        throw new Error(`Unknown provider: ${provider}`);
      }

      return parseAllocation(rawJson);
    } catch (error) {
      lastError = error;
      console.error(`callLLM ${provider} attempt ${attempt}/${MAX_LLM_ATTEMPTS} failed:`, error);
      if (attempt < MAX_LLM_ATTEMPTS) {
        await delay(RETRY_BACKOFF_MS * attempt);
      }
    }
  }

  throw new Error(
    `callLLM failed for ${provider} after ${MAX_LLM_ATTEMPTS} attempts: ${
      lastError instanceof Error ? lastError.message : String(lastError)
    }`,
  );
}
