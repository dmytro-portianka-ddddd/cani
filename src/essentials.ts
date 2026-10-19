import { z } from "zod";
import { decide, type Decision } from "./decide";
import { decideWithProfile } from "./profile";
import type { Ask, Books, PlannedItem, Profile, StateCost } from "./schema";

/**
 * The essential lane — the purchases life doesn't negotiate about.
 *
 * Gas, medicine, and groceries at recognizable essential merchants skip
 * the headroom interrogation and are approved automatically, because a
 * manager who makes you beg for insulin has misunderstood the job.
 *
 * Bounded, on purpose:
 * - merchant-level verification only (a store name is not a receipt —
 *   the TV bought at a pharmacy is the known leak, and the cap is what
 *   keeps the leak small);
 * - every lane has a per-purchase cap the user sets; above it, the
 *   normal engine decides as usual;
 * - a bypass is still a Decision: stored, reasoned, and carrying the
 *   verdict the books alone would have given.
 */

export const EssentialCategorySchema = z.enum(["fuel", "pharmacy", "groceries"]);
export type EssentialCategory = z.infer<typeof EssentialCategorySchema>;

const LaneSchema = z.object({ enabled: z.boolean(), cap: z.number().finite().positive() }).strict();
export const EssentialsConfigSchema = z
  .object({
    fuel: LaneSchema,
    pharmacy: LaneSchema,
    groceries: LaneSchema,
  })
  .strict();
export type EssentialsConfig = z.infer<typeof EssentialsConfigSchema>;

export const DEFAULT_ESSENTIALS: EssentialsConfig = {
  fuel: { enabled: true, cap: 150 },
  pharmacy: { enabled: true, cap: 500 },
  groceries: { enabled: true, cap: 300 },
};

const MERCHANTS: { category: EssentialCategory; names: string[] }[] = [
  {
    category: "pharmacy",
    names: ["cvs", "walgreens", "rite aid", "duane reade", "pharmacy", "pharmacie", "drug store", "boots"],
  },
  {
    category: "fuel",
    names: ["shell", "exxon", "chevron", "texaco", "marathon", "speedway", "arco", "sunoco", "gas station", "fuel", "petrol", "bp "],
  },
  {
    category: "groceries",
    names: [
      "kroger", "safeway", "aldi", "whole foods", "trader joe", "publix", "h-e-b", "heb ",
      "stop & shop", "giant eagle", "wegmans", "food lion", "grocery", "groceries", "market basket", "sprouts",
    ],
  },
];

export function classifyMerchant(merchant: string | undefined): EssentialCategory | null {
  if (!merchant) return null;
  const name = ` ${merchant.toLowerCase()} `;
  for (const group of MERCHANTS) {
    if (group.names.some((n) => name.includes(n))) return group.category;
  }
  return null;
}

export type CartItem = { name: string; amount: number };

export type AskWithMerchant = Ask & { merchant?: string; items?: CartItem[] };

const NON_ESSENTIAL: { kind: string; words: string[] }[] = [
  { kind: "alcohol", words: ["beer", "wine", "vodka", "whiskey", "whisky", "tequila", "bourbon", "champagne", "prosecco", "liquor", " lager", " ale ", "cider 6", "seltzer"] },
  { kind: "sweets & treats", words: ["candy", "chocolate", "gummy", "skittles", "cake", "cookies", "cookie", "donut", "doughnut", "ice cream", "soda", "cola", "energy drink", "chips", "cheetos", "doritos"] },
  { kind: "tobacco & vape", words: ["cigarette", "cigar", "vape", "tobacco", "nicotine"] },
  { kind: "not groceries", words: ["gift card", "lottery", "scratch", "toy", "game", "headphones", "electronics", "flowers"] },
];

export function classifyCartItem(name: string): { essential: boolean; kind: string | null } {
  const n = ` ${name.toLowerCase()} `;
  for (const group of NON_ESSENTIAL) {
    if (group.words.some((w) => n.includes(w))) return { essential: false, kind: group.kind };
  }
  return { essential: true, kind: null };
}

export type CartVerdict = {
  nonEssential: { name: string; amount: number; kind: string }[];
  totalMatches: boolean;
  /** Who labeled the cart: a model (by name) or the built-in reader. */
  source: string;
};

export function cartCheck(items: CartItem[] | undefined, askAmount: number): CartVerdict {
  if (!items || items.length === 0) return { nonEssential: [], totalMatches: true, source: "built-in reader" };
  const nonEssential = items
    .map((i) => ({ ...i, kind: classifyCartItem(i.name).kind }))
    .filter((i) => i.kind !== null)
    .map((i) => ({ name: i.name, amount: i.amount, kind: i.kind as string }));
  const sum = items.reduce((s, i) => Math.round((s + i.amount) * 100) / 100, 0);
  return { nonEssential, totalMatches: Math.abs(sum - askAmount) < 0.02, source: "built-in reader" };
}

/** Full ask path: essential lane first (bounded), then the normal engine
 * (deeper mode when a profile is armed). The lane never hides the books'
 * answer — it is stored on the decision as rawVerdict. */
export function decideAsk(
  ask: AskWithMerchant,
  books: Books,
  planned: PlannedItem[],
  config: EssentialsConfig,
  profile?: Profile,
  stateCost?: StateCost,
  cart?: CartVerdict,
): Decision {
  // The core engine's ask is strict ({amount,label,at}); merchant and
  // items are lane-layer data and never cross into it.
  const coreAsk: Ask = { amount: ask.amount, label: ask.label, at: ask.at };
  const base = profile && stateCost
    ? decideWithProfile(coreAsk, books, planned, profile, stateCost)
    : decide(coreAsk, books, planned);

  const category = classifyMerchant(ask.merchant);
  if (!category) return base;
  const lane = config[category];
  if (!lane.enabled || ask.amount > lane.cap) return base;

  // A cart, when provided, is checked item by item (model-labeled when a
  // provider is configured, keyword reader otherwise — see server). Alcohol,
  // sweets, tobacco, and gift cards do not ride the essential lane, and a
  // cart that doesn't add up to the ask doesn't ride either.
  const verdict = cart ?? cartCheck(ask.items, ask.amount);
  if (ask.items && ask.items.length > 0) {
    if (!verdict.totalMatches) {
      return {
        ...base,
        reasons: [
          `essential lane denied: the cart items don't add up to the ask — the lane needs a cart it can check (checked by ${verdict.source})`,
          ...base.reasons,
        ],
      };
    }
    if (verdict.nonEssential.length > 0) {
      const list = verdict.nonEssential.map((i) => `${i.name} $${i.amount} (${i.kind})`).join(", ");
      return {
        ...base,
        reasons: [
          `essential lane denied: non-essential in the cart — ${list} (checked by ${verdict.source}). The whole ask faces the normal check; split the treats out and the essentials ride free.`,
          ...base.reasons,
        ],
      };
    }
  }

  return {
    ...base,
    verdict: "YES",
    shortBy: null,
    reasons: [
      `essential lane: ${category} at ${ask.merchant} — approved without the interrogation`,
      `within your ${category} cap of $${lane.cap} (ask $${ask.amount})`,
      ...(ask.items && ask.items.length > 0 ? [`cart verified all-essential by ${verdict.source}`] : []),
      `books alone would have said ${base.verdict} (headroom $${base.headroomAtTime}) — fuel, medicine, and food don't wait for a good month`,
      ...base.reasons,
    ],
    pathToYes: null,
    bypass: { category, merchant: ask.merchant ?? "", cap: lane.cap, rawVerdict: base.verdict },
  };
}
