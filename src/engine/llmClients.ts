import OpenAI from 'openai';
import Anthropic from '@anthropic-ai/sdk';
import { GoogleGenAI } from '@google/genai';
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

// Models do not reliably return a bare JSON object even when asked to: Gemini in
// particular tends to wrap it in prose or append a second fragment, which made
// JSON.parse throw and silently drop that faction to a canned fallback move
// every round. Pull out the first brace-balanced object (respecting strings and
// escapes) so leading/trailing text no longer breaks parsing.
function extractFirstJsonObject(raw: string): string {
  const start = raw.indexOf('{');
  if (start === -1) return raw;

  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < raw.length; i++) {
    const ch = raw[i];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (ch === '\\') {
      escaped = true;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return raw.slice(start, i + 1);
    }
  }
  // Unbalanced (e.g. the response was truncated): return from the first brace so
  // the caller's JSON.parse surfaces a clear error and the retry/fallback runs.
  return raw.slice(start);
}

function isRetryableError(error: unknown): boolean {
  const status = (error as { status?: number })?.status;
  if (status === 429 || (typeof status === 'number' && status >= 500)) return true;
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

// Inference is proxied through the Netlify AI Gateway using the official
// provider SDKs. In a deployed Netlify context the platform injects per-provider
// credentials (OPENAI_API_KEY/OPENAI_BASE_URL, etc.), so the SDKs route through
// the gateway with no extra config. When those are absent (local dev, scripts)
// we fall back to the always-present gateway key + base URL. Crucially, each SDK
// already knows the correct request path for its provider, which avoids the
// hand-built URL mistakes that previously caused a faction's calls to 404 and
// silently fall back to a canned move.
function gatewayCreds(): { baseUrl: string; key: string } | null {
  const baseUrl = process.env.NETLIFY_AI_GATEWAY_BASE_URL;
  const key = process.env.NETLIFY_AI_GATEWAY_KEY;
  if (baseUrl && key) return { baseUrl: baseUrl.replace(/\/$/, ''), key };
  return null;
}

function openaiClient(): OpenAI {
  if (process.env.OPENAI_API_KEY) {
    return new OpenAI({
      apiKey: process.env.OPENAI_API_KEY,
      baseURL: process.env.OPENAI_BASE_URL,
      timeout: AI_REQUEST_TIMEOUT_MS,
    });
  }
  const gw = gatewayCreds();
  if (gw) return new OpenAI({ apiKey: gw.key, baseURL: `${gw.baseUrl}/v1`, timeout: AI_REQUEST_TIMEOUT_MS });
  throw new Error('No OpenAI or AI Gateway credentials are available in this context.');
}

function anthropicClient(): Anthropic {
  if (process.env.ANTHROPIC_API_KEY) {
    return new Anthropic({
      apiKey: process.env.ANTHROPIC_API_KEY,
      baseURL: process.env.ANTHROPIC_BASE_URL,
      timeout: AI_REQUEST_TIMEOUT_MS,
    });
  }
  const gw = gatewayCreds();
  if (gw) return new Anthropic({ apiKey: gw.key, baseURL: gw.baseUrl, timeout: AI_REQUEST_TIMEOUT_MS });
  throw new Error('No Anthropic or AI Gateway credentials are available in this context.');
}

function geminiClient(): GoogleGenAI {
  if (process.env.GEMINI_API_KEY) {
    return new GoogleGenAI({
      apiKey: process.env.GEMINI_API_KEY,
      httpOptions: process.env.GOOGLE_GEMINI_BASE_URL ? { baseUrl: process.env.GOOGLE_GEMINI_BASE_URL } : undefined,
    });
  }
  const gw = gatewayCreds();
  if (gw) return new GoogleGenAI({ apiKey: gw.key, httpOptions: { baseUrl: gw.baseUrl } });
  throw new Error('No Gemini or AI Gateway credentials are available in this context.');
}

async function callOpenAI(prompt: string): Promise<string> {
  const completion = await openaiClient().chat.completions.create({
    model: MODEL_NAMES.openai,
    messages: [
      { role: 'system', content: 'Return only valid JSON. Do not include markdown or commentary.' },
      { role: 'user', content: prompt },
    ],
    response_format: { type: 'json_object' },
  });
  return completion.choices?.[0]?.message?.content || '{}';
}

async function callGemini(prompt: string): Promise<string> {
  const response = await geminiClient().models.generateContent({
    model: MODEL_NAMES.gemini,
    contents: prompt,
    // A generous output budget: this is a reasoning model whose internal
    // thinking can count against the cap, and a too-small limit truncated the
    // JSON mid-object (so the move failed to parse and fell back to a default).
    config: { responseMimeType: 'application/json', maxOutputTokens: 4096 },
  });
  return response.text || '{}';
}

async function callClaude(prompt: string): Promise<string> {
  const message = await anthropicClient().messages.create({
    model: MODEL_NAMES.claude,
    max_tokens: 2048,
    messages: [{ role: 'user', content: `${prompt}\n\nOutput only valid JSON.` }],
  });
  return message.content
    .map((block) => (block.type === 'text' ? block.text : ''))
    .join('') || '{}';
}

export async function callLLM(provider: ModelProvider, prompt: string): Promise<ActionAllocation> {
  let rawJson = '';

  try {
    if (provider === 'openai') {
      rawJson = await withRetry(() => callOpenAI(prompt), 'openai');
    } else if (provider === 'gemini') {
      rawJson = await withRetry(() => callGemini(prompt), 'gemini');
    } else if (provider === 'claude') {
      rawJson = await withRetry(() => callClaude(prompt), 'claude');
    }

    // Strip any markdown fencing, then isolate the first complete JSON object so
    // surrounding prose or a trailing fragment can't break the parse.
    rawJson = rawJson.replace(/```json\n?|\n?```/g, '').trim();
    rawJson = extractFirstJsonObject(rawJson);
    const parsed = JSON.parse(rawJson);

    // Normalize and validate the three allocation channels.
    let military = Number(parsed.military) || 0;
    let diplomacy = Number(parsed.diplomacy) || 0;
    let internal = Number(parsed.internal) || 0;

    // Auto-balance if they don't add to 100.
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
      selfAssessment: parsed.selfAssessment || 'No assessment provided.',
    };
  } catch (error) {
    console.error(`Error calling ${provider}:`, error);
    throw error;
  }
}
