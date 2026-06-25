import type { Faction, GameState, ActionAllocation } from './types';

export function generatePrompt(faction: Faction, state: GameState, previousAllocation?: ActionAllocation): string {
  const currentMonth = ['February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December', 'January'][state.currentRound - 1];
  const year = state.currentRound >= 12 ? 1072 : 1071;

  let basePrompt = `You are playing a strategic simulation of the events leading up to the Battle of Mantzikert.\n`;
  basePrompt += `The current date is ${currentMonth} ${year} (Round ${state.currentRound} of 12).\n\n`;

  if (faction === 'emperor') {
    basePrompt += `You are Emperor Romanos IV Diogenes of the Byzantine Empire. Your goal is to secure the eastern frontier against the Seljuk Turks and survive political sabotage from the Doukas family.\n`;
  } else if (faction === 'foes') {
    basePrompt += `You represent the internal foes of the Emperor (the Doukas Family). Your goal is to see Emperor Romanos fail or be overthrown, without destroying the Empire entirely if possible. You can secretly coordinate with the Seljuks.\n`;
  } else if (faction === 'seljuks') {
    basePrompt += `You are Sultan Alp Arslan of the Seljuk Empire. Your goal is to conquer Byzantine territory (Mantzikert) and destroy the Emperor's army.\n`;
  }

  basePrompt += `\nCURRENT GAME STATE:\n`;
  basePrompt += `- Emperor's Military Strength Base: ${state.factions.emperor.militaryStrength}\n`;
  basePrompt += `- Emperor's Internal Loyalty: ${state.factions.emperor.internalLoyalty.toFixed(1)}/100 (Modifies effective military)\n`;
  basePrompt += `- Emperor's Territory Control (Mantzikert region): ${state.factions.emperor.territoryControl.toFixed(1)}/100\n`;
  basePrompt += `- Foes' Sabotage Capability Base: ${state.factions.foes.militaryStrength}\n`;
  basePrompt += `- Seljuk Military Strength Base: ${state.factions.seljuks.militaryStrength}\n\n`;

  if (state.currentRound > 1) {
    const lastRound = state.history[state.history.length - 1];
    basePrompt += `EVENTS FROM LAST ROUND:\n`;
    lastRound.events.forEach(e => basePrompt += `- ${e}\n`);
    
    // Check if there are messages for this faction
    const receivedMessages: string[] = [];
    if (lastRound.allocations.emperor.messages[faction]) {
      receivedMessages.push(`Message from Emperor: "${lastRound.allocations.emperor.messages[faction]}"`);
    }
    if (lastRound.allocations.foes.messages[faction]) {
      receivedMessages.push(`Message from Internal Foes: "${lastRound.allocations.foes.messages[faction]}"`);
    }
    if (lastRound.allocations.seljuks.messages[faction]) {
      receivedMessages.push(`Message from Seljuks: "${lastRound.allocations.seljuks.messages[faction]}"`);
    }

    if (receivedMessages.length > 0) {
      basePrompt += `\nRECEIVED DIPLOMATIC MESSAGES:\n`;
      receivedMessages.forEach(m => basePrompt += `- ${m}\n`);
    }

    if (previousAllocation) {
      basePrompt += `\nYOUR LAST SELF ASSESSMENT:\n"${previousAllocation.selfAssessment}"\n`;
    }
  }

  basePrompt += `\nINSTRUCTIONS:
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
Ensure military + diplomacy + internal exactly equals 100.`;

  return basePrompt;
}
