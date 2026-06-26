# Mantzikert Simulation — Prompt & Sampling Reference

This document describes every prompt the simulation sends to the language models, how
those prompts are assembled, and how sampling temperature is controlled. It is the
canonical reference for anyone tuning model behaviour or interpreting results.

## Overview

The simulation re-plays the events leading to the 1071 Battle of Mantzikert as a
12-round strategy game between three factions, each driven by a different model
provider:

| Faction   | Description                                              |
| --------- | -------------------------------------------------------- |
| `emperor` | Romanos IV Diogenes (Byzantine Empire)                   |
| `foes`    | The internal opposition (the Doukas family)              |
| `seljuks` | Sultan Alp Arslan (Seljuk Empire)                        |

Which provider plays which faction is set per game in the configuration (`GameConfig.roles`).
The batch runner rotates the three providers across the faction roles so every provider
plays every role an equal number of times (see `netlify/functions/batch-games-background.ts`).

Every round, one prompt is generated **per faction** and sent to that faction's model.
The model replies with a JSON action allocation that the engine resolves into the next
game state.

## Where the prompts live

| Concern                                | File                                  |
| -------------------------------------- | ------------------------------------- |
| Prompt text generation                 | `src/engine/prompts.ts`               |
| Per-provider request shaping & system framing | `src/engine/llmClients.ts`     |
| Model IDs and sampling temperature     | `src/engine/models.ts`                |
| Prompt orchestration (single round)    | `netlify/functions/play-round.ts`     |
| Prompt orchestration (batch of games)  | `netlify/functions/batch-games-background.ts` |

## The user prompt (`generatePrompt`)

A single function, `generatePrompt(faction, state, previousAllocation)`, builds the
full user prompt for a faction on a given round. The prompt is assembled from the
following sections, in order.

### 1. Scenario framing

Every prompt opens with the shared scenario and the in-game date. Rounds 1–12 map to
the months February 1071 through January 1072:

```
You are playing a strategic simulation of the events leading up to the Battle of Mantzikert.
The current date is <Month> <Year> (Round <N> of 12).
```

### 2. Faction role and objective

A faction-specific paragraph defines who the model is and what it is trying to achieve:

- **Emperor** — "You are Emperor Romanos IV Diogenes of the Byzantine Empire. Your goal
  is to secure the eastern frontier against the Seljuk Turks and survive political
  sabotage from the Doukas family."
- **Foes** — "You represent the internal foes of the Emperor (the Doukas Family). Your
  goal is to see Emperor Romanos fail or be overthrown, without destroying the Empire
  entirely if possible. You can secretly coordinate with the Seljuks."
- **Seljuks** — "You are Sultan Alp Arslan of the Seljuk Empire. Your goal is to conquer
  Byzantine territory (Mantzikert) and destroy the Emperor's army."

### 3. Current game state

A snapshot of the live state, identical across factions, giving each model the same
shared board:

```
CURRENT GAME STATE:
- Emperor's Military Strength Base: <n>
- Emperor's Internal Loyalty: <n>/100 (Modifies effective military)
- Emperor's Territory Control (Mantzikert region): <n>/100
- Foes' Sabotage Capability Base: <n>
- Seljuk Military Strength Base: <n>
```

### 4. Last round's events, messages, and prior self-assessment (rounds 2+)

From round 2 onward the prompt appends memory of the previous round:

- **`EVENTS FROM LAST ROUND`** — the engine-generated event log.
- **`RECEIVED DIPLOMATIC MESSAGES`** — any messages other factions addressed to this
  faction in the previous round. This is the channel through which the foes and Seljuks
  can coordinate.
- **`YOUR LAST SELF ASSESSMENT`** — the faction's own `selfAssessment` from the previous
  round, giving the model continuity of strategy.

### 5. Instructions and required output schema

Every prompt closes with the action-budget rules and the strict JSON schema the model
must return:

```
INSTRUCTIONS:
You have exactly 100 Action Points (AP) to spend this round. You must distribute them across:
- military: Offense/defense. For Emperor and Seljuks, this fights for territory. For Foes, this sabotages Emperor's military.
- diplomacy: Used to show commitment when sending messages.
- internal: Propaganda/Politics. Emperor spends this to raise loyalty. Foes spend this to lower Emperor's loyalty.

You may also send messages to the other factions.
You must provide a 2-3 sentence selfAssessment of your strategy.

Respond ONLY with a valid JSON object matching this schema, no markdown blocks or other text:
{
  "military": number,
  "diplomacy": number,
  "internal": number,
  "messages": {
    "emperor"?: string,
    "foes"?: string,
    "seljuks"?: string
  },
  "selfAssessment": string
}
Ensure military + diplomacy + internal exactly equals 100.
```

The client normalises the reply: if `military + diplomacy + internal` does not equal 100,
the values are rescaled to sum to 100; an all-zero allocation falls back to roughly even
(34/33/33). If a model call fails entirely, a per-faction fallback allocation is used
(`FALLBACK_ALLOCATIONS` in `netlify/functions/play-round.ts`).

## Per-provider system framing

`generatePrompt` produces one provider-neutral user prompt. Each provider client then
adds the JSON-only instruction in the way that provider expects:

| Provider | Added framing |
| -------- | ------------- |
| **OpenAI** | System message: *"Return only valid JSON. Do not include markdown or commentary."* plus `response_format: { type: 'json_object' }`. |
| **Gemini** | `generationConfig.responseMimeType: 'application/json'`. |
| **Claude** | The string `\n\nOutput only valid JSON.` appended to the user message. |

## Sampling temperature (tau)

Sampling temperature is fixed at **0.7** for every provider, defined once as
`SAMPLING_TEMPERATURE` in `src/engine/models.ts`:

```ts
export const SAMPLING_TEMPERATURE = 0.7;
```

This single constant is applied to all three providers in `src/engine/llmClients.ts`:

| Provider | Where temperature is set |
| -------- | ------------------------ |
| **OpenAI** | top-level `temperature` field on the chat-completions request |
| **Gemini** | `generationConfig.temperature` |
| **Claude** | top-level `temperature` field on the messages request |

To change the temperature for the entire simulation, edit the one constant — every
provider picks up the new value automatically. Because the value is shared, all three
models always sample at the same temperature, which keeps cross-model comparisons fair.

### Reporting the temperature

The temperature in effect is whatever `SAMPLING_TEMPERATURE` exports. Since it is a
single named constant referenced by every call site, the value documented here (0.7) is
guaranteed to match what is sent on the wire — there are no per-provider overrides.

### Caveat — OpenAI reasoning models

Some OpenAI reasoning-class models only accept their default temperature and will reject
an explicit non-default value. If a future model swap surfaces such an error, remove the
`temperature` field from the OpenAI call (or set it to that model's required default)
while leaving Gemini and Claude on the shared constant.

## Model IDs

The provider/model mapping is defined in `src/engine/models.ts`:

| Provider | Model ID |
| -------- | -------- |
| `openai` | `gpt-5.5` |
| `gemini` | `gemini-3.1-pro-preview` |
| `claude` | `claude-opus-4-8` |

All three are routed through the Netlify AI Gateway, which injects provider credentials
and base URLs server-side. Only models supported by the gateway may be used here.
