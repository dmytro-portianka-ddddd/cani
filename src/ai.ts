import { z } from "zod";
import { STATES } from "./profile";
import { ProfileSchema, type Profile } from "./schema";

/**
 * The AI narration layer — propose, never decide, never save.
 *
 * proposeProfileDraft() reads free text and returns a DRAFT profile plus a
 * short narrative. The draft is inert: nothing persists it, nothing feeds
 * it to decide()/decideWithProfile(). The human reviews every field in the
 * tree and saves explicitly; only that confirmed profile exists.
 *
 * Provider: any OpenAI-compatible chat endpoint via env
 * (CANI_AI_API_KEY, CANI_AI_BASE_URL, CANI_AI_MODEL). With no key — or on
 * any provider/parse failure — a deterministic keyword reader produces the
 * draft instead, labeled source "rules". AI output is zod-validated against
 * the same enums the tree uses; anything off-enum is dropped, never coerced.
 */

export const ProfileDraftSchema = z
  .object({
    ageBand: ProfileSchema.shape.ageBand.optional(),
    housing: ProfileSchema.shape.housing.optional(),
    dependents: ProfileSchema.shape.dependents.optional(),
    familyStatus: ProfileSchema.shape.familyStatus.optional(),
    securityDial: ProfileSchema.shape.securityDial.optional(),
    enjoyDial: ProfileSchema.shape.enjoyDial.optional(),
    familyDial: ProfileSchema.shape.familyDial.optional(),
    goal: ProfileSchema.shape.goal.optional(),
    horizon: ProfileSchema.shape.horizon.optional(),
    temperament: ProfileSchema.shape.temperament.optional(),
    state: z.string().length(2).optional(),
  })
  .strict();
export type ProfileDraft = z.infer<typeof ProfileDraftSchema>;

export type DraftResult = {
  draft: ProfileDraft;
  narrative: string;
  source: "ai" | "rules";
  note: string;
};

const SYSTEM_PROMPT = `You read a short self-description and extract a financial-life profile.
Reply with ONLY a JSON object, no prose outside it, using exactly these keys and values:
ageBand: "20s"|"30s-40s"|"50s"|"60-plus"
housing: "renting"|"mortgage"|"paid-off"|"family-home"
dependents: "none"|"kids-daycare"|"kids-school"|"supporting-parents"|"kids-and-parents"
familyStatus: "single"|"dating"|"married-dual-income"|"married-stay-home"|"single-parent"|"co-parenting"|"other"
securityDial, enjoyDial, familyDial: integers 0-100 (0 = security/save/family-first, 100 = freedom/enjoy/me-first) when the text implies a lean
goal: "debt-free"|"buy-home"|"retire-well"|"enjoy-now"|"support-family"
horizon: "this-year"|"3-5-years"|"10-plus-years"
temperament: "careful"|"balanced"|"live-a-little"
state: two-letter US state/DC code
narrative: one or two warm sentences summarizing who this person is and who they want to be.
Omit any key you cannot ground in the text. Never invent a state.`;

function findState(text: string): string | undefined {
  // Bare codes count only when the user actually capitalized them —
  // otherwise every "in" would be Indiana.
  for (const token of text.match(/\b[A-Z]{2}\b/g) ?? []) {
    if (STATES.some((s) => s.code === token)) return token;
  }
  const lower = text.toLowerCase();
  for (const s of [...STATES].sort((a, b) => b.name.length - a.name.length)) {
    if (lower.includes(s.name.toLowerCase())) return s.code;
  }
  return undefined;
}

/** Deterministic keyword reader — the offline draft. Deliberately simple
 * and inspectable; it is a starting point for the human, not an oracle. */
export function rulesDraft(text: string): DraftResult {
  const t = text.toLowerCase();
  const draft: ProfileDraft = {};
  const said: string[] = [];

  const ageMatch = t.match(/\b(\d{2})\s*(?:years? old|yo|y\.o\.)/) ?? t.match(/\bi(?:'m| am)\s+(\d{2})\b/);
  const age = ageMatch?.[1] ? Number(ageMatch[1]) : undefined;
  if (age !== undefined && age >= 18 && age <= 99) {
    draft.ageBand = age < 30 ? "20s" : age < 50 ? "30s-40s" : age < 60 ? "50s" : "60-plus";
    said.push(`age ${age}`);
  } else if (t.includes("fifties") || t.includes("50s")) { draft.ageBand = "50s"; said.push("fifties"); }
  else if (t.includes("sixties") || t.includes("retired")) { draft.ageBand = "60-plus"; said.push("retirement years"); }
  else if (t.includes("twenties") || t.includes("20s")) { draft.ageBand = "20s"; said.push("twenties"); }
  else if (t.includes("thirties") || t.includes("forties")) { draft.ageBand = "30s-40s"; said.push("thirties/forties"); }

  if (t.includes("paid off") || t.includes("paid-off") || t.includes("own outright") || t.includes("no mortgage")) { draft.housing = "paid-off"; said.push("home paid off"); }
  else if (t.includes("mortgage")) { draft.housing = "mortgage"; said.push("mortgage"); }
  else if (t.includes("rent")) { draft.housing = "renting"; said.push("renting"); }
  else if (t.includes("live with") && (t.includes("parent") || t.includes("family"))) { draft.housing = "family-home"; said.push("family home"); }

  const noKids = t.includes("no kids") || t.includes("no children") || t.includes("kid-free") || t.includes("child-free") || t.includes("no dependents");
  const kids = !noKids && (t.includes("kid") || t.includes("child") || t.includes("son") || t.includes("daughter"));
  if (noKids) draft.dependents = "none";
  const parents = t.includes("my mom") || t.includes("my dad") || t.includes("my parents") || t.includes("supporting my parents");
  if (kids && t.includes("daycare")) { draft.dependents = parents ? "kids-and-parents" : "kids-daycare"; said.push("kids in daycare"); }
  else if (kids) { draft.dependents = parents ? "kids-and-parents" : "kids-school"; said.push("kids"); }
  else if (parents) { draft.dependents = "supporting-parents"; said.push("supporting parents"); }

  if (t.includes("debt-free") || t.includes("debt free") || t.includes("pay off") || t.includes("credit card debt")) { draft.goal = "debt-free"; said.push("debt-free goal"); }
  else if (t.includes("buy a house") || t.includes("buy a home") || t.includes("first home") || t.includes("down payment")) { draft.goal = "buy-home"; said.push("home-buying goal"); }
  else if (t.includes("retire") || t.includes("retirement")) { draft.goal = "retire-well"; said.push("retirement goal"); }
  else if (t.includes("support my") || t.includes("help my family") || t.includes("support family")) { draft.goal = "support-family"; said.push("family-support goal"); }
  else if (t.includes("enjoy") || t.includes("travel") || t.includes("live a little") || t.includes("yolo")) { draft.goal = "enjoy-now"; said.push("enjoy-life goal"); }

  if (t.includes("this year") || t.includes("by next year")) draft.horizon = "this-year";
  else if (t.includes("few years") || t.includes("5 years") || t.includes("five years")) draft.horizon = "3-5-years";
  else if (t.includes("someday") || t.includes("eventually") || t.includes("long term") || t.includes("long-term")) draft.horizon = "10-plus-years";

  if (t.includes("spender") || t.includes("impulsive") || t.includes("live a little") || t.includes("treat myself")) { draft.temperament = "live-a-little"; said.push("self-aware spender"); }
  else if (t.includes("careful") || t.includes("frugal") || t.includes("saver") || t.includes("anxious about money")) { draft.temperament = "careful"; said.push("careful with money"); }
  else if (t.includes("balanced")) draft.temperament = "balanced";

  if (t.includes("stay-at-home") || t.includes("stay at home") || t.includes("one income") || t.includes("single income")) { draft.familyStatus = "married-stay-home"; said.push("one-income household"); }
  else if ((t.includes("married") || t.includes("wife") || t.includes("husband") || t.includes("spouse") || t.includes("partner")) && (t.includes("both work") || t.includes("two incomes") || t.includes("dual income") || t.includes("she works") || t.includes("he works"))) { draft.familyStatus = "married-dual-income"; said.push("dual-income household"); }
  else if (t.includes("single parent") || t.includes("raising") && t.includes("on my own")) { draft.familyStatus = "single-parent"; said.push("single parent"); }
  else if (t.includes("co-parent") || t.includes("shared custody")) { draft.familyStatus = "co-parenting"; said.push("co-parenting"); }
  else if (t.includes("married") || t.includes("wife") || t.includes("husband")) { draft.familyStatus = "married-dual-income"; said.push("married"); }
  else if (t.includes("dating") || t.includes("girlfriend") || t.includes("boyfriend")) { draft.familyStatus = "dating"; said.push("dating"); }
  else if (t.includes("single")) { draft.familyStatus = "single"; said.push("single"); }

  if (t.includes("safety first") || t.includes("peace of mind") || t.includes("emergency fund")) draft.securityDial = 20;
  if (t.includes("freedom") || t.includes("flexibility")) draft.securityDial = 75;
  if (draft.temperament === "live-a-little") draft.enjoyDial = 75;
  if (draft.temperament === "careful") draft.enjoyDial = 25;
  if (draft.dependents && draft.dependents !== "none") draft.familyDial = 25;

  const state = findState(text);
  if (state) { draft.state = state; said.push(state); }

  const narrative = said.length > 0
    ? `Sounds like: ${said.join(", ")}. Review every field below — nothing counts until you save it.`
    : "I couldn't read much structure from that — try mentioning your age, home, family, and what you're aiming for. Or just pick the tree answers yourself.";
  return { draft, narrative, source: "rules", note: "Drafted by the built-in reader (no AI key configured). Propose-only: not saved." };
}

/** Provider-agnostic AI config. Any OpenAI-compatible endpoint works;
 * Gemini works by pointing CANI_AI_BASE_URL at its OpenAI-compatible
 * endpoint (or setting GEMINI_API_KEY, which selects it automatically). */
export function resolveAiConfig(): { apiKey: string; baseUrl: string; model: string } | null {
  if (process.env.CANI_AI_API_KEY) {
    return {
      apiKey: process.env.CANI_AI_API_KEY,
      baseUrl: process.env.CANI_AI_BASE_URL ?? "https://api.openai.com/v1",
      model: process.env.CANI_AI_MODEL ?? "gpt-4o-mini",
    };
  }
  if (process.env.GEMINI_API_KEY) {
    return {
      apiKey: process.env.GEMINI_API_KEY,
      baseUrl: process.env.CANI_AI_BASE_URL ?? "https://generativelanguage.googleapis.com/v1beta/openai/",
      model: process.env.CANI_AI_MODEL ?? "gemini-3.5-flash-lite",
    };
  }
  return null;
}

export async function proposeProfileDraft(text: string): Promise<DraftResult> {
  const config = resolveAiConfig();
  if (!config) return rulesDraft(text);
  const { apiKey, baseUrl, model } = config;
  try {
    const res = await fetch(`${baseUrl.replace(/\/$/, "")}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model,
        temperature: 0,
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: text.slice(0, 2000) },
        ],
      }),
    });
    if (!res.ok) throw new Error(`provider ${res.status}`);
    const payload: unknown = await res.json();
    const content = z
      .object({ choices: z.array(z.object({ message: z.object({ content: z.string() }) })) })
      .parse(payload).choices[0]?.message.content;
    if (!content) throw new Error("empty completion");
    const rawJson: unknown = JSON.parse(content.replace(/^```json?\s*|\s*```$/g, ""));
    const withNarrative = z.object({ narrative: z.string().max(400).optional() }).passthrough().parse(rawJson);
    const { narrative, ...draftFields } = withNarrative;
    const draft = ProfileDraftSchema.parse(draftFields);
    if (draft.state && !STATES.some((s) => s.code === draft.state)) delete draft.state;
    return {
      draft,
      narrative: narrative ?? "Here's my read — review every field before saving.",
      source: "ai",
      note: `Drafted by ${model}. Propose-only: not saved, never a verdict input until you confirm it.`,
    };
  } catch {
    const fallback = rulesDraft(text);
    return { ...fallback, note: "AI provider unavailable or returned unusable output — built-in reader drafted this instead. Propose-only: not saved." };
  }
}

export type { Profile };

/**
 * Cart labeling for the essential lane. A model, when configured, labels
 * each item essential or not (alcohol, sweets/treats, tobacco, and
 * non-groceries are not essential). The model ONLY labels — the lane
 * arithmetic in essentials.ts is deterministic on those labels. Any
 * failure falls back to the built-in keyword reader, labeled as such.
 */
export async function classifyCartWithAi(
  items: { name: string; amount: number }[],
  askAmount: number,
  fetchFn: typeof fetch = fetch,
): Promise<import("./essentials").CartVerdict> {
  const { cartCheck } = await import("./essentials");
  const fallback = cartCheck(items, askAmount);
  const config = resolveAiConfig();
  if (!config || items.length === 0) return fallback;
  try {
    const res = await fetchFn(`${config.baseUrl.replace(/\/$/, "")}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${config.apiKey}` },
      body: JSON.stringify({
        model: config.model,
        temperature: 0,
        messages: [
          {
            role: "system",
            content: `Label grocery cart items. Reply with ONLY a JSON array, one object per item in order: {"essential": true|false, "kind": null|"alcohol"|"sweets & treats"|"tobacco & vape"|"not groceries"}. Essential means staple food, drink, medicine, or household necessity. Alcohol, candy/sweets/soda/chips, tobacco/vapes, gift cards, lottery, toys, and electronics are NOT essential.`,
          },
          { role: "user", content: JSON.stringify(items.map((i) => i.name)) },
        ],
      }),
    });
    if (!res.ok) throw new Error(`provider ${res.status}`);
    const payload: unknown = await res.json();
    const content = z.object({ choices: z.array(z.object({ message: z.object({ content: z.string() }) })) })
      .parse(payload).choices[0]?.message.content;
    if (!content) throw new Error("empty completion");
    const labels = z.array(z.object({ essential: z.boolean(), kind: z.string().nullable() }))
      .parse(JSON.parse(content.replace(/^```json?\s*|\s*```$/g, "")));
    if (labels.length !== items.length) throw new Error("label count mismatch");
    const nonEssential = items
      .map((item, i) => ({ name: item.name, amount: item.amount, kind: labels[i]?.essential === false ? (labels[i]?.kind ?? "not groceries") : null }))
      .filter((i) => i.kind !== null)
      .map((i) => ({ name: i.name, amount: i.amount, kind: i.kind as string }));
    return { nonEssential, totalMatches: fallback.totalMatches, source: `AI (${config.model})` };
  } catch {
    return fallback;
  }
}
