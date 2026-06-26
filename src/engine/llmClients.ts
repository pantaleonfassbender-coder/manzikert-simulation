import type { ModelProvider, ActionAllocation } from './types';
import { MODEL_NAMES } from './models';

const AI_REQUEST_TIMEOUT_MS = 30000;

// Retry tuning. Rate limits (429) on the Netlify AI Gateway are scoped per
// account across the whole token-per-minute window, so when many rounds fire
// at once the gateway pushes back. We retry transient failures with an
// exponential backoff plus jitter rather than letting a single 429 abort a
// game. This is the main guard that keeps large batch runs from collapsing.
const MAX_ATTEMPTS = 5;
const BASE_BACKOFF_MS = 1200;
const MAX_BACKOFF_MS = 20000;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function isRetryableError(error: unknown): boolean {
  const message = (error instanceof Error ? error.message : String(error)).toLowerCase();
  if (error instanceof Error && (error.name === 'AbortError' || error.name === 'TimeoutError')) {
    return true;
  }
  return (
    message.includes('429') ||
    message.includes('rate limit') ||
    message.includes('overloaded') ||
    message.includes('timeout') ||
    message.includes('timed out') ||
    message.includes('aborted') ||
    message.includes('econnreset') ||
    message.includes('fetch failed') ||
    message.includes('500') ||
    message.includes('502') ||
    message.includes('503') ||
    message.includes('504')
  );
}

async function withRetry<T>(fn: () => Promise<T>, label: string): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      if (!isRetryableError(error) || attempt === MAX_ATTEMPTS - 1) {
        throw error;
      }
      const backoff = Math.min(BASE_BACKOFF_MS * 2 ** attempt, MAX_BACKOFF_MS);
      const jitter = Math.floor(Math.random() * 400);
      console.warn(`Retrying ${label} after transient error (attempt ${attempt + 1}/${MAX_ATTEMPTS}); waiting ${backoff + jitter}ms.`);
      await sleep(backoff + jitter);
    }
  }
  throw lastError;
}

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

// Inference is proxied through Netlify AI Gateway. Netlify injects provider
// URLs and credentials into server-side contexts for these direct HTTP calls.
export async function callLLM(provider: ModelProvider, prompt: string): Promise<ActionAllocation> {
  let rawJson = '';

  try {
    if (provider === 'openai') {
      rawJson = await withRetry(() => callOpenAI(prompt), 'openai');
    }
    else if (provider === 'gemini') {
      rawJson = await withRetry(() => callGemini(prompt), 'gemini');
    }
    else if (provider === 'claude') {
      rawJson = await withRetry(() => callClaude(prompt), 'claude');
    }

    // Try extracting JSON if wrapped in markdown
    rawJson = rawJson.replace(/```json\n?|\n?```/g, '').trim();
    const parsed = JSON.parse(rawJson);
    
    // Normalize and validate
    let military = Number(parsed.military) || 0;
    let diplomacy = Number(parsed.diplomacy) || 0;
    let internal = Number(parsed.internal) || 0;
    
    // Auto-balance if they don't add to 100
    const total = military + diplomacy + internal;
    if (total !== 100 && total > 0) {
      military = Math.round((military / total) * 100);
      diplomacy = Math.round((diplomacy / total) * 100);
      internal = 100 - military - diplomacy;
    } else if (total === 0) {
      military = 34; diplomacy = 33; internal = 33;
    }

    return {
      military,
      diplomacy,
      internal,
      messages: parsed.messages || {},
      selfAssessment: parsed.selfAssessment || 'No assessment provided.'
    };
  } catch (error) {
    console.error(`Error calling ${provider}:`, error);
    throw error;
  }
}
