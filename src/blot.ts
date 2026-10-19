import { z } from "zod";
import type { Profile } from "./schema";

/**
 * The money blot — an inkblot-inspired reflection, not a diagnosis.
 * Five cards; each answer tags temperament/goal/horizon leanings with
 * deterministic weights. The output is a SUGGESTION for three tree fields,
 * with its reasons printed. It never saves, never scores your worth, and
 * says nothing clinical — it helps you pick answers you'd endorse.
 */

export type BlotCard = {
  id: string;
  prompt: string;
  kind: "scenario" | "image";
  choices: { id: string; label: string; tags: Partial<Record<"temperament" | "goal" | "horizon", string>> }[];
};

export const BLOT_CARDS: BlotCard[] = [
  {
    id: "windfall",
    kind: "scenario",
    prompt: "A surprise $1,000 lands in your account. Your first honest move?",
    choices: [
      { id: "a", label: "Straight into savings — future me says thanks", tags: { temperament: "careful", goal: "retire-well" } },
      { id: "b", label: "Split it: some saved, some enjoyed", tags: { temperament: "balanced" } },
      { id: "c", label: "Book the thing I've been eyeing", tags: { temperament: "live-a-little", goal: "enjoy-now", horizon: "this-year" } },
      { id: "d", label: "Send some to family who needs it", tags: { goal: "support-family", temperament: "balanced" } },
    ],
  },
  {
    id: "blob",
    kind: "image",
    prompt: "Look at the blot. What does it feel like most?",
    choices: [
      { id: "a", label: "A safety net", tags: { temperament: "careful", goal: "retire-well" } },
      { id: "b", label: "A door opening", tags: { temperament: "balanced", goal: "buy-home", horizon: "3-5-years" } },
      { id: "c", label: "A wave to ride", tags: { temperament: "live-a-little", goal: "enjoy-now" } },
      { id: "d", label: "A weight", tags: { temperament: "careful", goal: "debt-free" } },
    ],
  },
  {
    id: "bill",
    kind: "scenario",
    prompt: "A $600 surprise bill arrives the same week as a $550 concert trip with friends.",
    choices: [
      { id: "a", label: "Bill first. Trip can wait — or be cheaper", tags: { temperament: "careful", goal: "debt-free" } },
      { id: "b", label: "Negotiate both down and do a lean version of each", tags: { temperament: "balanced", horizon: "3-5-years" } },
      { id: "c", label: "Life is short — trip now, bill on a plan", tags: { temperament: "live-a-little", goal: "enjoy-now", horizon: "this-year" } },
    ],
  },
  {
    id: "future",
    kind: "scenario",
    prompt: "Ten-years-from-now you opens this app. What do you hope it says?",
    choices: [
      { id: "a", label: "\"Debt-free. Told you so.\"", tags: { goal: "debt-free", horizon: "10-plus-years", temperament: "careful" } },
      { id: "b", label: "\"Welcome home — the mortgage is nearly done.\"", tags: { goal: "buy-home", horizon: "10-plus-years" } },
      { id: "c", label: "\"Retirement is funded. Breathe.\"", tags: { goal: "retire-well", horizon: "10-plus-years" } },
      { id: "d", label: "\"What a decade that was.\" — with photos", tags: { goal: "enjoy-now", temperament: "live-a-little" } },
    ],
  },
  {
    id: "rule",
    kind: "scenario",
    prompt: "Pick the house rule you'd actually keep:",
    choices: [
      { id: "a", label: "Never spend the buffer. Ever.", tags: { temperament: "careful" } },
      { id: "b", label: "Ask before anything over a few hundred", tags: { temperament: "balanced" } },
      { id: "c", label: "Say yes to experiences, no to stuff", tags: { temperament: "live-a-little", goal: "enjoy-now" } },
      { id: "d", label: "Family gets helped first, then me", tags: { goal: "support-family" } },
    ],
  },
];

export const BlotAnswersSchema = z.array(z.object({ cardId: z.string(), choiceId: z.string() })).min(1).max(BLOT_CARDS.length);

export type BlotResult = {
  suggestion: Partial<Pick<Profile, "temperament" | "goal" | "horizon">>;
  reasons: string[];
  answered: number;
};

function winner(tags: Record<string, number>): string | undefined {
  const entries = Object.entries(tags).sort((a, b) => b[1] - a[1]);
  return entries[0]?.[0];
}

export function scoreBlot(answers: { cardId: string; choiceId: string }[]): BlotResult {
  const tally: Record<"temperament" | "goal" | "horizon", Record<string, number>> = {
    temperament: {},
    goal: {},
    horizon: {},
  };
  const reasons: string[] = [];
  let answered = 0;
  for (const answer of answers) {
    const card = BLOT_CARDS.find((c) => c.id === answer.cardId);
    const choice = card?.choices.find((c) => c.id === answer.choiceId);
    if (!card || !choice) continue;
    answered++;
    for (const [field, value] of Object.entries(choice.tags)) {
      const f = field as keyof typeof tally;
      tally[f][value] = (tally[f][value] ?? 0) + 1;
    }
    reasons.push(`“${choice.label}” → ${Object.entries(choice.tags).map(([k, v]) => `${k}: ${v}`).join(", ")}`);
  }
  return {
    suggestion: {
      temperament: winner(tally.temperament) as Profile["temperament"] | undefined,
      goal: winner(tally.goal) as Profile["goal"] | undefined,
      horizon: winner(tally.horizon) as Profile["horizon"] | undefined,
    },
    reasons,
    answered,
  };
}
