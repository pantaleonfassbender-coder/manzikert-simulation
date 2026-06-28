import OpenAI from 'openai';
import Anthropic from '@anthropic-ai/sdk';
import { GoogleGenAI } from '@google/genai';
import type { ModelProvider, ActionAllocation } from './types';
import { MODEL_NAMES } from './models';

const AI_REQUEST_TIMEOUT_MS = 20000;
// Per-call resilience: transient API errors / occasional malformed JSON are
// retried a few times here. If a call still fails, callLLM throws and the
// caller is responsible for discarding and re-running the whole game run
// (see batch-games-background.ts) — per preregistration Q6.
const MAX_LLM_ATTEMPTS = 3;
const RETRY_BACKOFF_MS = 750;
// The SDKs do their own retrying; we disable it so MAX_LLM_ATTEMPTS is the
// single, authoritative retry budget for a call.
const SDK_MAX_RETRIES = 0;

const delay = (ms: number) => new Promise((res) => setTimeout(res, ms));

type ProviderCreds = { baseURL: string; apiKey: string };

// Inference is proxied through Netlify AI Gateway. Netlify injects credentials
// into server-side contexts in one of two forms: provider-specific variables
// (OPENAI_API_KEY / OPENAI_BASE_URL, ...) which the official SDKs auto-detect,
// or the always-present gateway variables (NETLIFY_AI_GATEWAY_KEY /
// NETLIFY_AI_GATEWAY_BASE_URL). We prefer the provider variables when present
// and otherwise point the SDK at the gateway endpoint for that provider, so a
// call succeeds whenever either form is available. Each provider is resolved
// independently — e.g. Anthropic creds being present does not imply OpenAI's.
function resolveCreds(
  provider: ModelProvider,
  providerKey: string | undefined,
  providerBaseUrl: string | undefined,
  gatewaySegment: string,
  gatewayBaseSuffix: string,
): ProviderCreds {
  if (providerKey && providerBaseUrl) {
    return { apiKey: providerKey, baseURL: providerBaseUrl.replace(/\/$/, '') };
  }

  const gatewayBaseUrl = process.env.NETLIFY_AI_GATEWAY_BASE_URL;
  const gatewayKey = process.env.NETLIFY_AI_GATEWAY_KEY;

  if (!gatewayBaseUrl || !gatewayKey) {
    throw new Error(`Netlify AI Gateway environment is not available for ${provider} in this server context.`);
  }

  return {
    apiKey: gatewayKey,
    baseURL: `${gatewayBaseUrl.replace(/\/$/, '')}/${gatewaySegment}${gatewayBaseSuffix}`,
  };
}

async function callOpenAI(prompt: string) {
  // OpenAI SDK appends `/chat/completions` to baseURL, so the gateway base
  // must include the `/v1` segment.
  const { apiKey, baseURL } = resolveCreds(
    'openai',
    process.env.OPENAI_API_KEY,
    process.env.OPENAI_BASE_URL,
    'openai',
    '/v1',
  );
  const client = new OpenAI({ apiKey, baseURL, maxRetries: SDK_MAX_RETRIES, timeout: AI_REQUEST_TIMEOUT_MS });

  const completion = await client.chat.completions.create({
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

  return completion.choices?.[0]?.message?.content || '{}';
}

async function callGemini(prompt: string) {
  // @google/genai appends `/v1beta/models/...` to httpOptions.baseUrl, so the
  // gateway base is just the `/google` provider segment.
  const { apiKey, baseURL } = resolveCreds(
    'gemini',
    process.env.GEMINI_API_KEY,
    process.env.GOOGLE_GEMINI_BASE_URL,
    'google',
    '',
  );
  const client = new GoogleGenAI({ apiKey, httpOptions: { baseUrl: baseURL, timeout: AI_REQUEST_TIMEOUT_MS } });

  const response = await client.models.generateContent({
    model: MODEL_NAMES.gemini,
    contents: prompt,
    config: { responseMimeType: 'application/json' },
  });

  return response.text || '{}';
}

async function callClaude(prompt: string) {
  // Anthropic SDK appends `/v1/messages` to baseURL, so the gateway base is
  // just the `/anthropic` provider segment.
  const { apiKey, baseURL } = resolveCreds(
    'claude',
    process.env.ANTHROPIC_API_KEY,
    process.env.ANTHROPIC_BASE_URL,
    'anthropic',
    '',
  );
  const client = new Anthropic({ apiKey, baseURL, maxRetries: SDK_MAX_RETRIES, timeout: AI_REQUEST_TIMEOUT_MS });

  const message = await client.messages.create({
    model: MODEL_NAMES.claude,
    max_tokens: 1000,
    messages: [{ role: 'user', content: `${prompt}\n\nOutput only valid JSON.` }],
  });

  return message.content.map((block) => (block.type === 'text' ? block.text : '')).join('') || '{}';
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

// Inference is proxied through Netlify AI Gateway via the official provider
// SDKs (see resolveCreds for how credentials are sourced).
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
