import { z } from "zod";

/**
 * Money is dollars; `amount` is always a POSITIVE magnitude — direction is
 * implied by row type (deposit / paypal_funding move money in; the rest move
 * money out). Amounts are cents-exact: a value with more than two decimal
 * places is rejected at the boundary, never silently rounded into a verdict.
 */

/** A finite, positive, cents-exact dollar amount. */
export const MoneySchema = z
  .number()
  .finite()
  .positive()
  .refine((n) => Math.abs(n * 100 - Math.round(n * 100)) < 1e-9, {
    message: "amount must be exact to the cent",
  });

const isoLike = /^\d{4}-\d{2}-\d{2}/;

/** An ISO-8601 date or datetime string that actually parses to an instant. */
export const IsoDateSchema = z
  .string()
  .min(1)
  .refine((v) => isoLike.test(v) && !Number.isNaN(Date.parse(v)), {
    message: "must be a valid ISO date/datetime",
  });
export const IsoDateTimeSchema = IsoDateSchema;

export const CadenceSchema = z.enum(["monthly", "weekly", "annual"]);
export type Cadence = z.infer<typeof CadenceSchema>;

/** The manager's books — the table that gives Cani its teeth. Untouchable by
 * variable spending; confirmed once by the human (confirmedAt is the sign-off,
 * and it must be a real datetime — a placeholder string is not confirmation). */
export const CommittedPaymentSchema = z
  .object({
    id: z.string().min(1),
    label: z.string().min(1),
    /** Fixed amount per cadence. */
    amount: MoneySchema,
    cadence: CadenceSchema,
    /** ISO date — first/next due date; gates whether the obligation has begun. */
    nextDue: IsoDateSchema,
    /** ISO date, null = open-ended. When it passes, the payment auto-releases
     * headroom on its own — the budget widens without anyone touching it. */
    endDate: IsoDateSchema.nullable(),
    source: z.enum(["discovered", "user"]),
    /** ISO datetime — human sign-off. The model never confirms the books. */
    confirmedAt: IsoDateTimeSchema,
    status: z.enum(["active", "ended"]),
  })
  .strict();
export type CommittedPayment = z.infer<typeof CommittedPaymentSchema>;

export const LedgerRowTypeSchema = z.enum([
  "deposit",
  "committed_payment",
  "variable_spend",
  "paypal_funding",
  "checkout",
]);
export type LedgerRowType = z.infer<typeof LedgerRowTypeSchema>;

/** One row = one movement. Append-only; corrections are new rows. */
export const LedgerRowSchema = z
  .object({
    id: z.string().min(1),
    /** ISO datetime. */
    at: IsoDateTimeSchema,
    type: LedgerRowTypeSchema,
    /** Positive magnitude; direction by type. */
    amount: MoneySchema,
    label: z.string().optional(),
    /** Envelope id — paypal_funding / checkout rows only, and required there. */
    envelope: z.string().min(1).optional(),
    /** PayPal order id, when a rail moved the money. */
    orderId: z.string().optional(),
    /** Who classified this row — the AI classifies; the engine and user can too. */
    classifiedBy: z.enum(["ai", "user", "engine"]).optional(),
    /** Checkout attempts only: a declined attempt moved no money and never
     * decrements headroom. Absent = the row moved money. */
    result: z.enum(["executed", "declined"]).optional(),
  })
  .strict()
  .superRefine((row, ctx) => {
    const envelopeKind = row.type === "paypal_funding" || row.type === "checkout";
    if (envelopeKind && row.envelope === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["envelope"],
        message: `${row.type} rows require an envelope`,
      });
    }
    if (!envelopeKind && row.envelope !== undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["envelope"],
        message: `envelope is only valid on paypal_funding/checkout rows`,
      });
    }
    if (row.result !== undefined && row.type !== "checkout") {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["result"],
        message: "result is only valid on checkout rows",
      });
    }
  });
export type LedgerRow = z.infer<typeof LedgerRowSchema>;

/** The oracle's question. */
export const AskSchema = z
  .object({
    amount: MoneySchema,
    label: z.string().default("purchase"),
    /** ISO datetime — the moment of asking; decides the headroom window. */
    at: IsoDateTimeSchema,
  })
  .strict();
export type Ask = z.infer<typeof AskSchema>;

/** Planned future spend — the coaching layer's raw material ("skip the March
 * trip → YES"). Human-entered or AI-proposed, never auto-executed. */
export const PlannedItemSchema = z
  .object({
    label: z.string().min(1),
    amount: MoneySchema,
    /** ISO date — when the spend is planned. */
    when: IsoDateSchema,
  })
  .strict();
export type PlannedItem = z.infer<typeof PlannedItemSchema>;

function duplicateIds(ids: string[]): string[] {
  const seen = new Set<string>();
  const dupes = new Set<string>();
  for (const id of ids) {
    if (seen.has(id)) dupes.add(id);
    seen.add(id);
  }
  return [...dupes];
}

/** Everything decide() may read. Pure inputs — the engine is a function of
 * these books, nothing else. Duplicate ids are rejected: a replayed deposit
 * must never double-count into headroom (a wrong YES). */
export const BooksSchema = z
  .object({
    committed: z.array(CommittedPaymentSchema),
    ledger: z.array(LedgerRowSchema),
  })
  .strict()
  .superRefine((books, ctx) => {
    for (const id of duplicateIds(books.ledger.map((r) => r.id))) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["ledger"],
        message: `duplicate ledger row id "${id}"`,
      });
    }
    for (const id of duplicateIds(books.committed.map((p) => p.id))) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["committed"],
        message: `duplicate committed payment id "${id}"`,
      });
    }
  });
export type Books = z.infer<typeof BooksSchema>;

/** The person behind the books — "who am I, who do I want to be". Self-declared,
 * never inferred by a model. Used ONLY by the deeper-mode layer (profile.ts);
 * the core decide() never reads it. */
export const ProfileSchema = z
  .object({
    ageBand: z.enum(["20s", "30s-40s", "50s", "60-plus"]),
    housing: z.enum(["renting", "mortgage", "paid-off", "family-home"]),
    dependents: z.enum(["none", "kids-daycare", "kids-school", "supporting-parents", "kids-and-parents"]),
    // Defaults keep profiles saved by older app versions loadable — a
    // missing field is a profile from before that question existed,
    // never a malformed file worth bricking the books over.
    familyStatus: z
      .enum(["single", "dating", "married-dual-income", "married-stay-home", "single-parent", "co-parenting", "other"])
      .default("other"),
    /** The dials, 0–100. Left ends: security / save / family-first.
     * Right ends: freedom / enjoy / me-first. Set by hand, in the open. */
    /** The user may disarm the deeper adjustment entirely: books decide
     * alone, profile only coaches. Default on for profiles that opt in. */
    adjustmentEnabled: z.boolean().default(true),
    securityDial: z.number().int().min(0).max(100).default(50),
    enjoyDial: z.number().int().min(0).max(100).default(50),
    familyDial: z.number().int().min(0).max(100).default(50),
    goal: z.enum(["debt-free", "buy-home", "retire-well", "enjoy-now", "support-family"]),
    horizon: z.enum(["this-year", "3-5-years", "10-plus-years"]),
    temperament: z.enum(["careful", "balanced", "live-a-little"]),
    /** US state/DC code — key into the bundled cost-of-living data. */
    state: z.string().length(2),
  })
  .strict();
export type Profile = z.infer<typeof ProfileSchema>;

/** One row of the bundled state cost data (src/data/us-states.json). */
export const StateCostSchema = z
  .object({
    code: z.string().length(2),
    name: z.string().min(1),
    colIndex: z.number().finite().positive(),
    medianMonthlyRent: MoneySchema,
    medianHouseholdIncome: MoneySchema,
  })
  .strict();
export type StateCost = z.infer<typeof StateCostSchema>;
