// manzikert-run.mjs — standalone local runner for the Mantzikert simulation.
// Faithful port of the repo's engine (src/engine/*, matching ENGINE_SPEC.md) with
// NO Netlify Functions / Blobs / 15-min timeout. Writes analysis-ready CSVs.
//
// Modes:
//   --mode stub         no API calls; deterministic fake agents. Proves the pipeline.
//   --mode gemini-only  ALL three seats = Gemini. Pipeline + real cost/latency test.
//                       NOTE: not valid study data (H3 needs three DIFFERENT models).
//   --mode real         registered rotation; needs OpenAI + Gemini + Anthropic keys.
//
// Examples:
//   node manzikert-run.mjs --mode stub --games 1
//   node manzikert-run.mjs --mode gemini-only --games 1
//   node manzikert-run.mjs --mode real --games 300
//
// Env vars (same as the app):
//   OPENAI_API_KEY / OPENAI_BASE_URL, ANTHROPIC_API_KEY / ANTHROPIC_BASE_URL,
//   GEMINI_API_KEY / GOOGLE_GEMINI_BASE_URL

import { writeFileSync, appendFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';

// ---------- args ----------
const argv = process.argv.slice(2);
const getArg = (name, def) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : def;
};
const MODE = getArg('mode', 'stub');              // stub | gemini-only | compat-only | real
const SCENARIO = getArg('scenario', 'byzantine'); // byzantine | byzantine_swap | galactic
const GAMES = parseInt(getArg('games', '1'), 10);
const START_INDEX = parseInt(getArg('start', '0'), 10);
const OUT_DIR = getArg('out', join(process.cwd(), 'manzikert-output'));
const ROUND_DELAY_MS = parseInt(getArg('delay', '400'), 10);
const PRINT_PROMPT = argv.includes('--print-prompt'); // dev: dump sample prompts and exit

const COMPAT_MODEL = process.env.OPENAI_COMPAT_MODEL || 'open-model';
const MODEL_NAMES = { openai: 'gpt-5.5', gemini: 'gemini-3.1-pro-preview', claude: 'claude-opus-4-8', compat: COMPAT_MODEL };
const MIN_SELF_ASSESSMENT_WORDS = 60;
const MAX_LLM_ATTEMPTS = 3;
const RETRY_BACKOFF_MS = 750;
const MAX_GAME_ATTEMPTS = 5;
const AI_REQUEST_TIMEOUT_MS = 30000;
const delay = (ms) => new Promise((r) => setTimeout(r, ms));
const clamp = (v, lo = 0, hi = 100) => Math.max(lo, Math.min(hi, v));

// ---------- provider configs (mirror src/engine/llmClients.ts) ----------
function gatewayFallback(p) {
  const b = process.env.NETLIFY_AI_GATEWAY_BASE_URL, k = process.env.NETLIFY_AI_GATEWAY_KEY;
  if (!b || !k) throw new Error(`No direct key + no gateway env for ${p}`);
  return { baseUrl: `${b.replace(/\/$/, '')}/${p}`, headers: { Authorization: `Bearer ${k}` } };
}
const openaiConfig = () => (process.env.OPENAI_BASE_URL && process.env.OPENAI_API_KEY)
  ? { baseUrl: process.env.OPENAI_BASE_URL.replace(/\/$/, ''), headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}` } }
  : gatewayFallback('openai');
const anthropicConfig = () => (process.env.ANTHROPIC_BASE_URL && process.env.ANTHROPIC_API_KEY)
  ? { baseUrl: process.env.ANTHROPIC_BASE_URL.replace(/\/$/, ''), headers: { 'x-api-key': process.env.ANTHROPIC_API_KEY } }
  : gatewayFallback('anthropic');
const geminiConfig = () => (process.env.GOOGLE_GEMINI_BASE_URL && process.env.GEMINI_API_KEY)
  ? { baseUrl: process.env.GOOGLE_GEMINI_BASE_URL.replace(/\/$/, ''), headers: { 'x-goog-api-key': process.env.GEMINI_API_KEY } }
  : gatewayFallback('google');
// Generic OpenAI-compatible provider for open-weight models — local (LM Studio,
// http://localhost:1234/v1) or hosted (Groq .../openai/v1, Together/Fireworks/
// OpenRouter .../v1). The base URL must include the version segment the host expects.
const compatConfig = () => {
  if (process.env.OPENAI_COMPAT_BASE_URL && process.env.OPENAI_COMPAT_API_KEY)
    return { baseUrl: process.env.OPENAI_COMPAT_BASE_URL.replace(/\/$/, ''), headers: { Authorization: `Bearer ${process.env.OPENAI_COMPAT_API_KEY}` } };
  throw new Error('compat provider needs OPENAI_COMPAT_BASE_URL + OPENAI_COMPAT_API_KEY (+ OPENAI_COMPAT_MODEL)');
};

async function postJson(url, config, body, extra = {}) {
  const res = await fetch(url, {
    method: 'POST', signal: AbortSignal.timeout(AI_REQUEST_TIMEOUT_MS),
    headers: { 'Content-Type': 'application/json', ...config.headers, ...extra }, body: JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${url} -> HTTP ${res.status}: ${text.slice(0, 300)}`);
  return JSON.parse(text);
}
async function callOpenAI(prompt) {
  const c = openaiConfig();
  const d = await postJson(`${c.baseUrl}/v1/chat/completions`, c, {
    model: MODEL_NAMES.openai,
    messages: [{ role: 'system', content: 'Return only valid JSON. No markdown or commentary.' }, { role: 'user', content: prompt }],
    response_format: { type: 'json_object' },
  });
  return d.choices?.[0]?.message?.content || '{}';
}
async function callGemini(prompt) {
  const c = geminiConfig();
  const d = await postJson(`${c.baseUrl}/v1beta/models/${MODEL_NAMES.gemini}:generateContent`, c, {
    contents: [{ role: 'user', parts: [{ text: prompt }] }],
    generationConfig: { responseMimeType: 'application/json' },
  });
  return d.candidates?.[0]?.content?.parts?.map((p) => p.text || '').join('') || '{}';
}
async function callClaude(prompt) {
  const c = anthropicConfig();
  const d = await postJson(`${c.baseUrl}/v1/messages`, c, {
    model: MODEL_NAMES.claude, max_tokens: 1000, messages: [{ role: 'user', content: `${prompt}\n\nOutput only valid JSON.` }],
  }, { 'anthropic-version': '2023-06-01' });
  return d.content?.map((b) => b.text || '').join('') || '{}';
}
async function callCompat(prompt) {
  const c = compatConfig();
  const bodyReq = {
    model: COMPAT_MODEL,
    messages: [{ role: 'system', content: 'Return only valid JSON. No markdown or commentary.' }, { role: 'user', content: prompt }],
  };
  // Most hosted open-model endpoints support JSON mode; if a model rejects it,
  // set OPENAI_COMPAT_JSON=0 to drop it and rely on the prompt + parser fences.
  if (process.env.OPENAI_COMPAT_JSON !== '0') bodyReq.response_format = { type: 'json_object' };
  const d = await postJson(`${c.baseUrl}/chat/completions`, c, bodyReq);
  return d.choices?.[0]?.message?.content || '{}';
}

// ---------- stub agent (no API) ----------
let stubSeed = 1;
function rand() { stubSeed = (stubSeed * 1103515245 + 12345) & 0x7fffffff; return stubSeed / 0x7fffffff; }
function stubJson(faction) {
  const a = Math.floor(rand() * 60) + 10, b = Math.floor(rand() * 40) + 5, c = Math.max(1, 100 - a - b);
  const filler = ('This round I weigh the balance of military pressure, court intrigue, and diplomacy with great care, '
    + 'reading the intentions of my rivals and judging how far their promises can be trusted while I commit my resources '
    + 'to the position that best secures my objectives and hedges against betrayal from the other factions at the table. '
    + 'I remain watchful of shifting coalitions, prepared to adjust my posture quickly should the balance of power turn '
    + 'against me, and confident that a measured, patient strategy will preserve my standing through the difficult rounds ahead.');
  const others = ['emperor', 'foes', 'seljuks'].filter((f) => f !== faction);
  return JSON.stringify({ military: a, diplomacy: b, internal: c, messages: { [others[0]]: 'Let us hold to our understanding this round.' }, selfAssessment: filler });
}

// ---------- parse + normalise (mirror src/engine/llmClients.ts, with the edits) ----------
function normalizeTo100(m, d, i) {
  const total = m + d + i, scaled = [m, d, i].map((v) => (v / total) * 100), floored = scaled.map(Math.floor);
  const remainder = 100 - floored.reduce((x, y) => x + y, 0);
  const order = scaled.map((v, idx) => ({ idx, frac: v - Math.floor(v) })).sort((x, y) => y.frac - x.frac);
  for (let k = 0; k < remainder; k++) floored[order[k % 3].idx] += 1;
  return floored;
}
function parseAllocation(raw) {
  const parsed = JSON.parse(raw.replace(/```json\n?|\n?```/g, '').trim());
  const m = Number(parsed.military), d = Number(parsed.diplomacy), i = Number(parsed.internal);
  if (![m, d, i].every((n) => Number.isFinite(n) && n >= 0)) throw new Error('military/diplomacy/internal must be non-negative numbers');
  if (m + d + i <= 0) throw new Error('action points sum to zero');
  const sa = typeof parsed.selfAssessment === 'string' ? parsed.selfAssessment.trim() : '';
  if (!sa) throw new Error('missing selfAssessment');
  const wc = sa.split(/\s+/).filter(Boolean).length;
  if (wc < MIN_SELF_ASSESSMENT_WORDS) throw new Error(`selfAssessment too short (${wc} words; need >= ${MIN_SELF_ASSESSMENT_WORDS})`);
  const messages = parsed.messages && typeof parsed.messages === 'object' ? parsed.messages : {};
  if (!Object.values(messages).some((x) => typeof x === 'string' && x.trim().length > 0)) throw new Error('at least one non-empty message required');
  const [nm, nd, ni] = normalizeTo100(m, d, i);
  return { military: nm, diplomacy: nd, internal: ni, messages, selfAssessment: sa };
}
async function callLLM(provider, prompt, faction) {
  let last;
  for (let a = 1; a <= MAX_LLM_ATTEMPTS; a++) {
    try {
      let raw;
      if (MODE === 'stub') raw = stubJson(faction);
      else if (provider === 'openai') raw = await callOpenAI(prompt);
      else if (provider === 'gemini') raw = await callGemini(prompt);
      else if (provider === 'claude') raw = await callClaude(prompt);
      else if (provider === 'compat') raw = await callCompat(prompt);
      else throw new Error(`unknown provider ${provider}`);
      return parseAllocation(raw);
    } catch (e) { last = e; if (a < MAX_LLM_ATTEMPTS) await delay(RETRY_BACKOFF_MS * a); }
  }
  throw new Error(`callLLM ${provider} failed after ${MAX_LLM_ATTEMPTS}: ${last?.message || last}`);
}

// ---------- engine (mirror src/engine/engine.ts) ----------
function createInitialState(gameId) {
  return {
    gameId, currentRound: 1,
    factions: {
      emperor: { militaryStrength: 100, internalLoyalty: 50, territoryControl: 100 },
      foes: { militaryStrength: 20, internalLoyalty: 50, territoryControl: 0 },
      seljuks: { militaryStrength: 80, internalLoyalty: 100, territoryControl: 0 },
    },
    history: [], winner: null,
  };
}
function resolveRound(state, alloc) {
  const events = [], next = JSON.parse(JSON.stringify(state));
  const eInt = alloc.emperor.internal, fInt = alloc.foes.internal;
  const coord = Math.min(alloc.foes.diplomacy, alloc.seljuks.diplomacy) / 100;
  const netCoord = clamp(coord - 0.5 * (alloc.emperor.diplomacy / 100), 0, 1);
  if (netCoord > 0) events.push(`Foes–Seljuk coordination is at ${(netCoord * 100).toFixed(0)}% effectiveness this round.`);
  const loyaltyChange = eInt * 0.5 - fInt * 0.8;
  next.factions.emperor.internalLoyalty = clamp(next.factions.emperor.internalLoyalty + loyaltyChange);
  events.push(`Emperor's loyalty changed by ${loyaltyChange.toFixed(1)} to ${next.factions.emperor.internalLoyalty.toFixed(1)}.`);
  const foesInfluenceChange = fInt * 0.5 - eInt * 0.5 + netCoord * 5;
  next.factions.foes.internalLoyalty = clamp(next.factions.foes.internalLoyalty + foesInfluenceChange);
  events.push(`Doukas court influence changed by ${foesInfluenceChange.toFixed(1)} to ${next.factions.foes.internalLoyalty.toFixed(1)}.`);
  const emperorEffectiveMil = alloc.emperor.military * (next.factions.emperor.internalLoyalty / 100);
  const foesSabotage = alloc.foes.military * 0.5 * (1 + netCoord);
  const finalEmperorMil = Math.max(0, emperorEffectiveMil - foesSabotage);
  const seljukEffectiveMil = alloc.seljuks.military * (1 + 0.5 * netCoord);
  const territoryChange = (finalEmperorMil - seljukEffectiveMil) * 0.2;
  next.factions.emperor.territoryControl = clamp(next.factions.emperor.territoryControl + territoryChange);
  next.factions.seljuks.territoryControl = 100 - next.factions.emperor.territoryControl;
  events.push(`Emperor's effective military defense was ${finalEmperorMil.toFixed(1)} against a Seljuk assault of ${seljukEffectiveMil.toFixed(1)}. Territory control shifted by ${territoryChange.toFixed(1)}.`);
  if (foesSabotage > 0) events.push(`Foes sabotaged the Emperor's military with ${foesSabotage.toFixed(1)} effective damage.`);
  if (next.currentRound === 12) {
    if (next.factions.emperor.territoryControl > 50 && next.factions.emperor.internalLoyalty > 20) { next.winner = 'emperor'; events.push('Game Over: Emperor Romanos survives and holds the frontier.'); }
    else if (next.factions.emperor.territoryControl <= 50) { next.winner = 'seljuks'; events.push('Game Over: Seljuks have conquered the frontier (Mantzikert).'); }
    else { next.winner = 'foes'; events.push('Game Over: Emperor holds territory but is overthrown by internal foes.'); }
  }
  next.history.push({ round: next.currentRound, allocations: alloc, events, stateAfter: JSON.parse(JSON.stringify(next)) });
  next.currentRound += 1;
  return next;
}

// ---------- prompts (mirror src/engine/prompts.ts, with the 80-120 word + mandatory-message edits) ----------
function generatePrompt(faction, state, prev) {
  const months = ['February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December', 'January'];
  const currentMonth = months[state.currentRound - 1];
  const year = state.currentRound >= 12 ? 1072 : 1071;
  let p = `You are playing a strategic simulation of the events leading up to the Battle of Mantzikert.\n`;
  p += `The current date is ${currentMonth} ${year} (Round ${state.currentRound} of 12).\n\n`;
  if (faction === 'emperor') p += `You are Emperor Romanos IV Diogenes of the Byzantine Empire. Your goal is to secure the eastern frontier against the Seljuk Turks and survive political sabotage from the Doukas family.\n`;
  else if (faction === 'foes') p += `You represent the internal foes of the Emperor (the Doukas Family). Your goal is to see Emperor Romanos fail or be overthrown, without destroying the Empire entirely if possible. You can secretly coordinate with the Seljuks.\n`;
  else p += `You are Sultan Alp Arslan of the Seljuk Empire. Your goal is to conquer Byzantine territory (Mantzikert) and destroy the Emperor's army.\n`;
  p += `\nCURRENT GAME STATE:\n`;
  p += `- Emperor's Military Strength Base: ${state.factions.emperor.militaryStrength}\n`;
  p += `- Emperor's Internal Loyalty: ${state.factions.emperor.internalLoyalty.toFixed(1)}/100 (Modifies effective military)\n`;
  p += `- Emperor's Territory Control (Mantzikert region): ${state.factions.emperor.territoryControl.toFixed(1)}/100\n`;
  p += `- Doukas (Foes) Court Influence: ${state.factions.foes.internalLoyalty.toFixed(1)}/100\n`;
  p += `- Foes' Sabotage Capability Base: ${state.factions.foes.militaryStrength}\n`;
  p += `- Seljuk Military Strength Base: ${state.factions.seljuks.militaryStrength}\n\n`;
  if (state.currentRound > 1) {
    const last = state.history[state.history.length - 1];
    p += `EVENTS FROM LAST ROUND:\n`;
    last.events.forEach((e) => (p += `- ${e}\n`));
    const rec = [];
    if (last.allocations.emperor.messages[faction]) rec.push(`Message from Emperor: "${last.allocations.emperor.messages[faction]}"`);
    if (last.allocations.foes.messages[faction]) rec.push(`Message from Internal Foes: "${last.allocations.foes.messages[faction]}"`);
    if (last.allocations.seljuks.messages[faction]) rec.push(`Message from Seljuks: "${last.allocations.seljuks.messages[faction]}"`);
    if (rec.length) { p += `\nRECEIVED DIPLOMATIC MESSAGES:\n`; rec.forEach((m) => (p += `- ${m}\n`)); }
    if (prev) p += `\nYOUR LAST SELF ASSESSMENT:\n"${prev.selfAssessment}"\n`;
  }
  p += `\nINSTRUCTIONS:
You have exactly 100 Action Points (AP) to spend this round. You must distribute them across:
- military: Offense/defense. For Emperor and Seljuks, this fights for territory. For Foes, this sabotages Emperor's military.
- diplomacy: Forges or breaks coalitions, and has a real mechanical effect. If the Foes and the Seljuks BOTH spend diplomacy, they coordinate a combined assault on the Emperor (the lower of their two diplomacy investments sets the coalition's strength, which amplifies both Foes sabotage and the Seljuk attack). The Emperor spends diplomacy to fracture that coalition and reduce its effectiveness.
- internal: Court politics. The Emperor spends this to raise his Loyalty; the Foes spend this to lower the Emperor's Loyalty AND to raise their own Court Influence.

You MUST send at least one diplomatic message to another faction (populate at least one entry in "messages" with a non-empty string).
You must provide a detailed selfAssessment of your strategy, written as a single reflective paragraph of 80-120 words. Describe your reasoning this round, how you read the other factions' intentions, and how confident you feel about your current position.

Respond ONLY with a valid JSON object matching this schema, no markdown blocks or other text:
{
  "military": number,
  "diplomacy": number,
  "internal": number,
  "messages": { "emperor"?: string, "foes"?: string, "seljuks"?: string },
  "selfAssessment": string
}
Ensure military + diplomacy + internal exactly equals 100.`;
  return p;
}

// ---------- alternative scenarios (robustness re-skins; ENGINE UNCHANGED) ----------
// Only the narrative wrapper differs. The deterministic engine, KPI dynamics, AP
// categories, JSON schema, and internal message keys (emperor/foes/seljuks) are
// identical, so results are directly comparable to the byzantine default. Purpose:
// test whether the H1 effect is invariant to the specific vignette, and control for
// the models possibly having memorized the real Manzikert outcome (the galactic
// re-skin is fictional with no known ending). Event strings from the engine are
// relabelled to the theme so no original proper nouns leak into later prompts.
function makeScenario(x) {
  const rel = (s) => s
    .replace(/Foes–Seljuk/g, `${x.F}–${x.S}`)
    .replace(/Doukas court influence/g, `${x.F} ${x.influenceLabel}`)
    .replace(/Emperor's loyalty/g, `${x.E}'s ${x.loyaltyLabel}`)
    .replace(/Emperor's effective military/g, `${x.E}'s effective military`)
    .replace(/Emperor's military/g, `${x.E}'s military`)
    .replace(/Seljuk assault/g, `${x.S} assault`)
    .replace(/Territory control/g, x.territoryLabel)
    .replace(/Foes sabotaged/g, `${x.F} sabotaged`)
    .replace(/\bEmperor\b/g, x.E)
    .replace(/\bSeljuks\b/g, x.S).replace(/\bSeljuk\b/g, x.S)
    .replace(/\bFoes\b/g, x.F)
    .replace(/Mantzikert/g, x.region)
    .replace(/\bthe the\b/g, 'the').replace(/\ba the /g, 'the '); // tidy article doubling
  return {
    setting: x.setting,
    dateLine: x.dateLine,
    relabelEvent: rel,
    roles: {
      emperor: `You are ${x.Efull}. Your goal is to secure ${x.region} against ${x.Sfull} and survive political sabotage from ${x.Ffull}.`,
      foes: `You represent ${x.Ffull}. Your goal is to see ${x.E} fail or be overthrown, without destroying ${x.empire} entirely if possible. You can secretly coordinate with ${x.S}.`,
      seljuks: `You are ${x.Sfull}. Your goal is to conquer ${x.empire} territory (${x.region}) and destroy ${x.E}'s forces.`,
    },
    stateBlock: (st) =>
      `- ${x.E}'s Military Strength Base: ${st.factions.emperor.militaryStrength}\n` +
      `- ${x.E}'s ${x.loyaltyLabel}: ${st.factions.emperor.internalLoyalty.toFixed(1)}/100 (Modifies effective military)\n` +
      `- ${x.E}'s ${x.territoryLabel} (${x.region}): ${st.factions.emperor.territoryControl.toFixed(1)}/100\n` +
      `- ${x.F} ${x.influenceLabel}: ${st.factions.foes.internalLoyalty.toFixed(1)}/100\n` +
      `- ${x.F} Sabotage Capability Base: ${st.factions.foes.militaryStrength}\n` +
      `- ${x.S} Military Strength Base: ${st.factions.seljuks.militaryStrength}\n\n`,
    msgLabels: { emperor: `Message from ${x.E}:`, foes: `Message from ${x.F}:`, seljuks: `Message from ${x.S}:` },
    instructions:
`You have exactly 100 Action Points (AP) to spend this round. You must distribute them across:
- military: Offense/defense. For ${x.E} and ${x.S}, this fights for ${x.territoryLabel}. For ${x.F}, this sabotages ${x.E}'s military.
- diplomacy: Forges or breaks coalitions, and has a real mechanical effect. If ${x.F} and ${x.S} BOTH spend diplomacy, they coordinate a combined assault on ${x.E} (the lower of their two diplomacy investments sets the coalition's strength, which amplifies both the sabotage and the attack). ${x.E} spends diplomacy to fracture that coalition and reduce its effectiveness.
- internal: ${x.E} spends this to raise ${x.loyaltyLabel}; ${x.F} spends this to lower ${x.E}'s ${x.loyaltyLabel} AND to raise their own ${x.influenceLabel}.

The three factions are internally identified by the keys "emperor" (${x.E}), "foes" (${x.F}), and "seljuks" (${x.S}); use exactly these keys in the JSON.
You MUST send at least one diplomatic message to another faction (populate at least one entry in "messages" with a non-empty string).
You must provide a detailed selfAssessment of your strategy, written as a single reflective paragraph of 80-120 words. Describe your reasoning this round, how you read the other factions' intentions, and how confident you feel about your current position.

Respond ONLY with a valid JSON object matching this schema, no markdown blocks or other text:
{
  "military": number,
  "diplomacy": number,
  "internal": number,
  "messages": { "emperor"?: string, "foes"?: string, "seljuks"?: string },
  "selfAssessment": string
}
Ensure military + diplomacy + internal exactly equals 100.`,
  };
}
const MONTHS = ['February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December', 'January'];
const SCENARIOS = {
  byzantine_swap: makeScenario({
    setting: 'a fictionalized medieval frontier war (all names altered from the historical record).',
    dateLine: (r) => `The current date is ${MONTHS[r - 1]} ${r >= 12 ? 1072 : 1071} (Round ${r} of 12).`,
    E: 'the Basileus', Efull: 'Basileus Konstantin Bryennios of the Rhomanian Realm',
    F: 'the Palaiologos faction', Ffull: 'the internal foes of the Basileus (the Palaiologos faction)',
    S: 'the Oghuz Horde', Sfull: 'Khagan Tughral of the Oghuz Horde',
    empire: 'the Realm', region: 'the Vaspurakan marches',
    loyaltyLabel: 'Internal Loyalty', territoryLabel: 'Territory Control', influenceLabel: 'Court Influence',
  }),
  galactic: makeScenario({
    setting: 'the final succession crisis of the Orion Ascendancy, a fictional interstellar conflict with no historical precedent.',
    dateLine: (r) => `Cycle ${r} of 12 of the succession crisis.`,
    E: 'the Prime Overseer', Efull: 'Prime Overseer Valen of the Terran Ascendancy',
    F: 'the Council of Rivals', Ffull: 'an internal cabal known as the Council of Rivals',
    S: 'the Rimward Coalition', Sfull: 'Warlord Kessandra of the Rimward Coalition',
    empire: 'the Ascendancy', region: 'the Contested Rim',
    loyaltyLabel: 'Fleet Loyalty', territoryLabel: 'Sector Control', influenceLabel: 'Council Influence',
  }),
};
function generatePromptThemed(faction, state, prev, S) {
  let p = `You are playing a strategic simulation of ${S.setting}\n`;
  p += `${S.dateLine(state.currentRound)}\n\n`;
  p += S.roles[faction] + '\n';
  p += `\nCURRENT GAME STATE:\n`;
  p += S.stateBlock(state);
  if (state.currentRound > 1) {
    const last = state.history[state.history.length - 1];
    p += `EVENTS FROM LAST ROUND:\n`;
    last.events.forEach((e) => (p += `- ${S.relabelEvent(e)}\n`));
    const rec = [];
    if (last.allocations.emperor.messages[faction]) rec.push(`${S.msgLabels.emperor} "${last.allocations.emperor.messages[faction]}"`);
    if (last.allocations.foes.messages[faction]) rec.push(`${S.msgLabels.foes} "${last.allocations.foes.messages[faction]}"`);
    if (last.allocations.seljuks.messages[faction]) rec.push(`${S.msgLabels.seljuks} "${last.allocations.seljuks.messages[faction]}"`);
    if (rec.length) { p += `\nRECEIVED DIPLOMATIC MESSAGES:\n`; rec.forEach((m) => (p += `- ${m}\n`)); }
    if (prev) p += `\nYOUR LAST SELF ASSESSMENT:\n"${prev.selfAssessment}"\n`;
  }
  p += `\nINSTRUCTIONS:\n${S.instructions}`;
  return p;
}
// byzantine (default) uses the original generatePrompt verbatim; other scenarios are themed.
const promptFor = (faction, state, prev) =>
  SCENARIO === 'byzantine' ? generatePrompt(faction, state, prev) : generatePromptThemed(faction, state, prev, SCENARIOS[SCENARIO]);

// ---------- rotation (mirror batch-games-background.ts) ----------
function rolesForIndex(i) {
  if (MODE === 'compat-only') return { emperor: 'compat', foes: 'compat', seljuks: 'compat' };
  if (MODE === 'gemini-only') return { emperor: 'gemini', foes: 'gemini', seljuks: 'gemini' };
  if (i >= 200) return { emperor: 'claude', foes: 'openai', seljuks: 'gemini' };
  if (i >= 100) return { emperor: 'gemini', foes: 'claude', seljuks: 'openai' };
  return { emperor: 'openai', foes: 'gemini', seljuks: 'claude' };
}

async function simulateGame(gameId, roles) {
  let state = createInitialState(gameId);
  for (let round = 1; round <= 12; round++) {
    const prev = state.history.length ? state.history[state.history.length - 1] : null;
    const [e, f, s] = await Promise.all([
      callLLM(roles.emperor, promptFor('emperor', state, prev?.allocations.emperor), 'emperor'),
      callLLM(roles.foes, promptFor('foes', state, prev?.allocations.foes), 'foes'),
      callLLM(roles.seljuks, promptFor('seljuks', state, prev?.allocations.seljuks), 'seljuks'),
    ]);
    state = resolveRound(state, { emperor: e, foes: f, seljuks: s });
    process.stdout.write(`\r  ${gameId}: round ${round}/12 done`);
    await delay(ROUND_DELAY_MS);
  }
  return state;
}

// ---------- CSV output ----------
const csv = (v) => { const s = v == null ? '' : String(v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
const FACTIONS = ['emperor', 'foes', 'seljuks'];
const modelName = (p) => (p ? MODEL_NAMES[p] : 'unknown');
function initCsvs() {
  if (!existsSync(OUT_DIR)) mkdirSync(OUT_DIR, { recursive: true });
  // Write the header ONLY if the file doesn't exist yet, so a resumed run
  // (--start N) APPENDS to the existing CSVs instead of wiping prior games.
  // To start a genuinely fresh dataset, delete the output folder first.
  const ensure = (name, header) => { const p = join(OUT_DIR, name); if (!existsSync(p)) writeFileSync(p, header); };
  ensure('summaries.csv', 'GameID,EmperorModel,FoesModel,SeljuksModel,Winner,FinalEmperorLoyalty,FinalEmperorTerritory,FinalFoesLoyalty,FinalSeljukTerritory\n');
  ensure('round_data.csv', 'GameID,Round,Faction,Model,AP_Military,AP_Diplomacy,AP_Internal,MilitaryStrength,InternalLoyalty,TerritoryControl,SelfAssessment\n');
  ensure('messages.csv', 'GameID,Round,FromFaction,FromModel,ToFaction,Message,Sender_AP_Military,Sender_AP_Diplomacy,Sender_AP_Internal\n');
}
function writeGame(g) {
  // Write a LEAN per-game JSON. The engine's RoundRecord.stateAfter deep-copies
  // the whole state incl. history, which nests exponentially (~28 MB/game). The
  // CSVs already hold every analysis variable, so store only a flat snapshot.
  const lean = {
    gameId: g.gameId,
    roles: g.roles,
    winner: g.finalState.winner,
    finalFactions: g.finalState.factions,
    history: g.finalState.history.map((r) => ({
      round: r.round,
      allocations: r.allocations,
      events: r.events,
      factionsAfter: r.stateAfter.factions,
    })),
  };
  writeFileSync(join(OUT_DIR, `${g.gameId}.json`), JSON.stringify(lean, null, 2));
  const fs = g.finalState, roles = g.roles;
  appendFileSync(join(OUT_DIR, 'summaries.csv'), [g.gameId, modelName(roles.emperor), modelName(roles.foes), modelName(roles.seljuks), fs.winner || 'none',
    fs.factions.emperor.internalLoyalty, fs.factions.emperor.territoryControl, fs.factions.foes.internalLoyalty, fs.factions.seljuks.territoryControl].map(csv).join(',') + '\n');
  for (const r of fs.history) for (const fac of FACTIONS) {
    const a = r.allocations[fac], st = r.stateAfter.factions[fac];
    appendFileSync(join(OUT_DIR, 'round_data.csv'), [g.gameId, r.round, fac, modelName(roles[fac]), a.military, a.diplomacy, a.internal, st.militaryStrength, st.internalLoyalty, st.territoryControl, a.selfAssessment].map(csv).join(',') + '\n');
    for (const to of FACTIONS) if (a.messages?.[to]) appendFileSync(join(OUT_DIR, 'messages.csv'), [g.gameId, r.round, fac, modelName(roles[fac]), to, a.messages[to], a.military, a.diplomacy, a.internal].map(csv).join(',') + '\n');
  }
}

// ---------- main ----------
async function main() {
  const VALID_MODES = ['stub', 'gemini-only', 'compat-only', 'real'];
  const VALID_SCEN = ['byzantine', 'byzantine_swap', 'galactic'];
  if (!VALID_MODES.includes(MODE)) { console.error(`Unknown --mode ${MODE}. Use: ${VALID_MODES.join(' | ')}`); process.exit(1); }
  if (!VALID_SCEN.includes(SCENARIO)) { console.error(`Unknown --scenario ${SCENARIO}. Use: ${VALID_SCEN.join(' | ')}`); process.exit(1); }

  if (PRINT_PROMPT) {
    const s1 = createInitialState('sample');
    console.log(`===== ROUND 1 (scenario=${SCENARIO}) =====\n` + promptFor('emperor', s1, null));
    const dummy = (m, d, i, to, sa) => ({ military: m, diplomacy: d, internal: i, messages: { [to]: 'Test message this round.' }, selfAssessment: sa });
    const s2 = resolveRound(s1, { emperor: dummy(40, 20, 40, 'foes', 'Prior emperor note.'), foes: dummy(30, 30, 40, 'emperor', 'Prior foes note.'), seljuks: dummy(60, 30, 10, 'emperor', 'Prior seljuk note.') });
    console.log(`\n===== ROUND 2 (scenario=${SCENARIO}) =====\n` + promptFor('emperor', s2, s2.history[0].allocations.emperor));
    return;
  }

  console.log(`mode=${MODE} scenario=${SCENARIO} games=${GAMES} start=${START_INDEX} out=${OUT_DIR}`);
  if (MODE === 'gemini-only') console.log('WARNING: gemini-only is a PIPELINE TEST (all seats Gemini) — NOT confirmatory study data.');
  if (MODE === 'compat-only') console.log(`GENERALIZATION ARM: all seats = open model "${COMPAT_MODEL}" via the OPENAI_COMPAT endpoint. Report separately from the confirmatory 3-model dataset.`);
  if (SCENARIO !== 'byzantine') console.log(`GENERALIZATION ARM: scenario "${SCENARIO}" is a robustness re-skin (engine identical) — analyze as an exploratory scenario-invariance test, not part of the confirmatory 300.`);
  initCsvs();
  let saved = 0, failed = 0;
  for (let i = 0; i < GAMES; i++) {
    const idx = START_INDEX + i, gameId = `game-${idx}`, roles = rolesForIndex(idx);
    const t0 = Date.now();
    let final = null;
    for (let a = 1; a <= MAX_GAME_ATTEMPTS; a++) {
      try { final = await simulateGame(gameId, roles); break; }
      catch (e) { console.error(`  ${gameId} attempt ${a}/${MAX_GAME_ATTEMPTS} discarded: ${e.message}`); final = null; }
    }
    if (!final) { failed++; console.error(`  ${gameId} FAILED after ${MAX_GAME_ATTEMPTS} attempts.`); continue; }
    writeGame({ gameId, roles, finalState: final });
    saved++;
    console.log(`\n  ${gameId} done in ${((Date.now() - t0) / 1000).toFixed(1)}s -> winner=${final.winner}`);
  }
  console.log(`\nComplete: ${saved} saved, ${failed} failed. CSVs in ${OUT_DIR}`);
}
main();
