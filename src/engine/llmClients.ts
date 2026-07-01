import Anthropic from '@anthropic-ai/sdk';
import OpenAI from 'openai';
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

const delay = (ms: number) => new Promise((res) => setTimeout(res, ms));

// Inference is proxied through Netlify AI Gateway. Netlify injects the provider
// credentials and base URLs (ANTHROPIC_*, OPENAI_*, GEMINI_* / GOOGLE_GEMINI_*)
// into every server-side context, and the official SDKs auto-detect them, so a
// zero-config constructor talks to the gateway with no keys or URLs in code.
// The clients are created lazily (first use) so importing this module never
// requires the env vars to be present, and retries are disabled at the SDK
// level so our own attempt loop below is the single source of retry behaviour.
let anthropicClient: Anthropic | null = null;
let openaiClient: OpenAI | null = null;
let geminiClient: GoogleGenAI | null = null;

function getAnthropic(): Anthropic {
  if (!anthropicClient) {
    anthropicClient = new Anthropic({ timeout: AI_REQUEST_TIMEOUT_MS, maxRetries: 0 });
  }
  return anthropicClient;
}

function getOpenAI(): OpenAI {
  if (!openaiClient) {
    openaiClient = new OpenAI({ timeout: AI_REQUEST_TIMEOUT_MS, maxRetries: 0 });
  }
  return openaiClient;
}

function getGemini(): GoogleGenAI {
  if (!geminiClient) {
    geminiClient = new GoogleGenAI({ httpOptions: { timeout: AI_REQUEST_TIMEOUT_MS } });
  }
  return geminiClient;
}

async function callOpenAI(prompt: string): Promise<string> {
  const completion = await getOpenAI().chat.completions.create({
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

async function callGemini(prompt: string): Promise<string> {
  const response = await getGemini().models.generateContent({
    model: MODEL_NAMES.gemini,
    contents: prompt,
    config: {
      responseMimeType: 'application/json',
    },
  });

  return response.text || '{}';
}

async function callClaude(prompt: string): Promise<string> {
  const message = await getAnthropic().messages.create({
    model: MODEL_NAMES.claude,
    max_tokens: 1000,
    messages: [{ role: 'user', content: `${prompt}\n\nOutput only valid JSON.` }],
  });

  return message.content
    .map((block) => (block.type === 'text' ? block.text : ''))
    .join('') || '{}';
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
