import { z } from "zod";
import { decide, type Decision } from "./decide";
import type { HeadroomReport } from "./headroom";
import { round2 } from "./money";
import { StateCostSchema, type Ask, type Books, type PlannedItem, type Profile, type StateCost } from "./schema";
import statesJson from "./data/us-states.json" with { type: "json" };

/**
 * Deeper mode — the profile layer. This is the ONLY place a profile may move
 * a verdict, and it does so in the open:
 *
 * - the raw books verdict is always computed first and stored alongside;
 * - every adjustment is a named, deterministic line item (no model, no vibes);
 * - the total adjustment is capped, so an archetype can shade a marginal
 *   call, never manufacture money;
 * - the full adjustment breakdown rides in the decision snapshot.
 *
 * Core decide() never imports this file. Deeper mode is opt-in per user.
 */

export const STATES: StateCost[] = z.array(StateCostSchema).parse(statesJson.states);
export const STATES_AS_OF: string = statesJson.meta.asOf;

export function stateByCode(code: string): StateCost | undefined {
  return STATES.find((s) => s.code === code);
}

export type AdjustmentComponent = { label: string; amount: number };

export type ProfileAdjustment = {
  components: AdjustmentComponent[];
  total: number;
  adjustedHeadroom: number;
  rawVerdict: "YES" | "NO";
};

const CAP = 600;

function comp(list: AdjustmentComponent[], label: string, amount: number): void {
  if (amount !== 0) list.push({ label, amount: round2(amount) });
}

/** The adjustment rules, deliberately boring and inspectable. Positive =
 * breathing room the archetype plausibly has; negative = reserve the
 * archetype plausibly needs. Amounts are monthly dollars. */
export function profileAdjustment(
  profile: Profile,
  report: HeadroomReport,
  state: StateCost,
): Omit<ProfileAdjustment, "adjustedHeadroom" | "rawVerdict"> {
  const c: AdjustmentComponent[] = [];
  const committed = report.committed.total;
  const income = report.income;

  if (state.colIndex >= 115) comp(c, `${state.name} is a high-cost state (index ${state.colIndex}) — reserve`, -round2(committed * 0.1));
  else if (state.colIndex <= 90) comp(c, `${state.name} is a low-cost state (index ${state.colIndex}) — breathing room`, round2(income * 0.03));

  switch (profile.dependents) {
    case "kids-daycare": comp(c, "Kids in daycare — surprises are expensive", -250); break;
    case "kids-and-parents": comp(c, "Kids and parents depending on you", -350); break;
    case "supporting-parents": comp(c, "Supporting parents", -150); break;
    case "kids-school": comp(c, "School-age kids", -100); break;
    case "none": break;
  }

  switch (profile.housing) {
    case "mortgage": comp(c, "Mortgage — the house can bill you without warning", -100); break;
    case "renting": comp(c, "Renting — deposits and moves cost money", -75); break;
    case "family-home": comp(c, "Family home — low housing burn", 50); break;
    case "paid-off": comp(c, "Home paid off — housing risk is behind you", 150); break;
  }

  if (
    (profile.ageBand === "50s" || profile.ageBand === "60-plus") &&
    profile.housing === "paid-off" &&
    profile.dependents === "none" &&
    profile.temperament === "live-a-little"
  ) {
    comp(c, "Established, mortgage-free, no dependents — earned flexibility", 200);
  }

  switch (profile.familyStatus) {
    case "married-dual-income": comp(c, "Two incomes — one shock absorber built in", 100); break;
    case "married-stay-home": comp(c, "One income carries the whole household", -150); break;
    case "single-parent": comp(c, "Single parent — every surprise lands on one paycheck", -175); break;
    case "co-parenting": comp(c, "Co-parenting — shared costs, split control", -75); break;
    default: break;
  }

  // The dials the user set with their own hand, stated as line items.
  if (profile.enjoyDial >= 65) comp(c, `Enjoy dial at ${profile.enjoyDial} — you leaned toward living`, 75);
  else if (profile.enjoyDial <= 35) comp(c, `Enjoy dial at ${profile.enjoyDial} — you leaned toward saving`, -75);
  if (profile.securityDial <= 35) comp(c, `Security dial at ${profile.securityDial} — safety first, bigger reserve`, -75);
  else if (profile.securityDial >= 65) comp(c, `Freedom dial at ${profile.securityDial} — flexibility over cushion`, 50);
  if (profile.familyDial <= 35 && profile.dependents !== "none") comp(c, `Family dial at ${profile.familyDial} — family first`, -50);
  else if (profile.familyDial >= 65) comp(c, `Family dial at ${profile.familyDial} — room for your own goals`, 25);

  if ((profile.goal === "debt-free" || profile.goal === "retire-well") && profile.temperament === "live-a-little") {
    comp(c, "Your stated goal asks for restraint", -100);
  }
  if (profile.goal === "buy-home" && profile.housing === "renting") {
    comp(c, "Saving toward a home while renting", -100);
  }

  const rawTotal = c.reduce((s, x) => round2(s + x.amount), 0);
  const total = Math.max(-CAP, Math.min(CAP, rawTotal));
  if (total !== rawTotal) c.push({ label: `Adjustment capped at ±$${CAP}`, amount: round2(total - rawTotal) });
  return { components: c, total };
}

const GOAL_NAMES: Record<Profile["goal"], string> = {
  "debt-free": "your debt-free date",
  "buy-home": "your home down payment",
  "retire-well": "your retirement funding",
  "enjoy-now": "the experiences you planned this year",
  "support-family": "what you set aside for family",
};

/** What a bypass actually costs, in the user's own units: at this month's
 * real pace (headroom), earning the money back takes amount ÷ pace months.
 * Deterministic — the AI narrates this line, it never computes it. */
export function goalImpactText(amount: number, report: HeadroomReport, profile?: Profile): string {
  const goal = profile ? GOAL_NAMES[profile.goal] : "your goals";
  const pace = report.headroom;
  if (pace <= 0) {
    return `There was no slack this month — this $${amount} comes straight out of ${goal}, and then some.`;
  }
  const months = Math.round((amount / pace) * 10) / 10;
  if (months < 0.2) return `A scratch, not a wound: at this month's pace you earn it back in days. ${goal} barely moves.`;
  return `At this month's pace ($${pace} of slack), earning $${amount} back takes about ${months} month${months === 1 ? "" : "s"} — ${goal} moves that far away.`;
}

export type ProfileInsight = {
  archetype: string;
  fixedCostRatio: number | null;
  locationAdjustedHeadroom: number;
  suggestedBufferMonths: number;
  suggestedBuffer: number;
  notes: string[];
};

export function profileInsight(profile: Profile, report: HeadroomReport, state: StateCost): ProfileInsight {
  const fixedCostRatio = report.income > 0 ? round2((report.committed.total / report.income) * 100) / 100 : null;

  let archetype: string;
  if (profile.dependents === "kids-daycare" && profile.housing === "mortgage") archetype = "Family builder under load";
  else if (profile.housing === "paid-off" && profile.dependents === "none" && (profile.ageBand === "50s" || profile.ageBand === "60-plus")) archetype = "Established and mortgage-free";
  else if (profile.ageBand === "20s" && profile.housing === "renting") archetype = "Early builder, renting";
  else if (profile.dependents === "kids-and-parents" || profile.dependents === "supporting-parents") archetype = "Sandwich-generation carrier";
  else if (profile.housing === "paid-off") archetype = "Low-burn owner";
  else archetype = "Household in motion";

  const bufferMonths =
    profile.dependents === "kids-daycare" || profile.dependents === "kids-and-parents" ? 6
    : profile.housing === "mortgage" ? 4
    : profile.housing === "renting" ? 3
    : 2;

  const notes: string[] = [
    `In ${state.name} (cost index ${state.colIndex}), your headroom buys like ${"$"}${round2(report.headroom * (100 / state.colIndex)).toLocaleString("en-US")} in an average US state.`,
    `A ${bufferMonths}-month buffer for someone in your position is about $${round2(report.committed.total * bufferMonths).toLocaleString("en-US")} — committed costs only, not lifestyle.`,
  ];
  if (fixedCostRatio !== null && fixedCostRatio >= 0.5) {
    notes.push(`Committed costs eat ${Math.round(fixedCostRatio * 100)}% of income before any choice is made — verdicts will feel strict, because the month is mostly spoken for.`);
  }
  if (profile.goal === "enjoy-now" && profile.horizon === "this-year") {
    notes.push("You said: enjoy it now, this year. Cani will still say NO when the books do — but the path back to YES becomes the interesting part.");
  }

  return {
    archetype,
    fixedCostRatio,
    locationAdjustedHeadroom: round2(report.headroom * (100 / state.colIndex)),
    suggestedBufferMonths: bufferMonths,
    suggestedBuffer: round2(report.committed.total * bufferMonths),
    notes,
  };
}

/** Deeper-mode decision: raw decide() first, then the open adjustment.
 * The returned Decision's verdict is the deeper verdict; the raw verdict
 * and every adjustment component are preserved in `adjustment`. */
export function decideWithProfile(
  ask: Ask,
  books: Books,
  planned: PlannedItem[],
  profile: Profile,
  state: StateCost,
): Decision {
  const raw = decide(ask, books, planned);
  if (!profile.adjustmentEnabled) {
    return {
      ...raw,
      reasons: [...raw.reasons, "deeper mode: adjustment is OFF for this profile — the books decide alone"],
      adjustment: {
        components: [],
        total: 0,
        adjustedHeadroom: raw.headroomAtTime,
        rawVerdict: raw.verdict,
        profile: { ...profile },
        state: { code: state.code, name: state.name, colIndex: state.colIndex },
      },
    };
  }
  const { components, total } = profileAdjustment(profile, raw.inputs, state);
  const adjustedHeadroom = round2(raw.headroomAtTime + total);
  const verdict = ask.amount <= adjustedHeadroom ? "YES" : "NO";
  const sign = total >= 0 ? "+" : "−";
  return {
    ...raw,
    verdict,
    shortBy: verdict === "NO" ? round2(ask.amount - adjustedHeadroom) : null,
    reasons: [
      ...raw.reasons,
      `deeper mode: books headroom $${raw.headroomAtTime} ${sign} $${Math.abs(total)} profile adjustment = $${adjustedHeadroom}`,
      ...components.map((x) => `  ${x.amount >= 0 ? "+" : "−"}$${Math.abs(x.amount)} ${x.label}`),
      verdict !== raw.verdict
        ? `books alone said ${raw.verdict}; deeper mode says ${verdict} — both are on the record`
        : `books and deeper mode agree: ${verdict}`,
    ],
    adjustment: {
      components,
      total,
      adjustedHeadroom,
      rawVerdict: raw.verdict,
      profile: { ...profile },
      state: { code: state.code, name: state.name, colIndex: state.colIndex },
    },
  };
}

export type GoalHealth = {
  pattern: "one-off" | "occasional" | "systematic";
  bypassesLast90Days: number;
  monthsWithBypasses: number;
  totalBypassed: number;
  cumulativeDelayMonths: number | null;
  verdict: string;
  suggestedHorizon: Profile["horizon"] | null;
};

const NEXT_HORIZON: Record<Profile["horizon"], Profile["horizon"] | null> = {
  "this-year": "3-5-years",
  "3-5-years": "10-plus-years",
  "10-plus-years": null,
};

/** Once is human. A pattern is data. Tracks manual bypasses over the
 * trailing 90 days and across distinct months; when bypassing is
 * systematic, the honest move is not more shame — it's realigning the
 * goal (extend the horizon) so the plan stops being fiction. */
export function analyzeBypasses(
  decisions: { at: string; amount: number; bypass?: { category: string } }[],
  nowIso: string,
  report: HeadroomReport,
  profile?: Profile,
): GoalHealth {
  const now = Date.parse(nowIso);
  const manual = decisions.filter((d) => d.bypass?.category === "manual");
  const recent = manual.filter((d) => now - Date.parse(d.at) <= 90 * 24 * 3600 * 1000);
  const months = new Set(recent.map((d) => d.at.slice(0, 7)));
  const totalBypassed = recent.reduce((s, d) => Math.round((s + d.amount) * 100) / 100, 0);
  const cumulativeDelayMonths = report.headroom > 0
    ? Math.round((totalBypassed / report.headroom) * 10) / 10
    : null;

  const systematic = recent.length >= 4 || months.size >= 3;
  const pattern: GoalHealth["pattern"] = systematic ? "systematic" : recent.length >= 2 ? "occasional" : "one-off";
  const suggestedHorizon = systematic && profile ? NEXT_HORIZON[profile.horizon] : null;

  const verdict = pattern === "one-off"
    ? recent.length === 0
      ? "No bypasses on record. The goal and the behavior agree."
      : "One bypass on record — that's being human, not a pattern. The goal stands."
    : pattern === "occasional"
      ? `${recent.length} bypasses in 90 days ($${totalBypassed}). Worth watching: the goal is slipping, not broken.`
      : `This is systematic: ${recent.length} bypasses across ${months.size} month(s), $${totalBypassed} total${cumulativeDelayMonths !== null ? ` — about ${cumulativeDelayMonths} months of pace` : ""}. Shame won't fix a pattern; the goal has to move.`;

  return {
    pattern,
    bypassesLast90Days: recent.length,
    monthsWithBypasses: months.size,
    totalBypassed,
    cumulativeDelayMonths,
    verdict,
    suggestedHorizon,
  };
}
