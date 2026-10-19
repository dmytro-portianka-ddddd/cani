# Cani — Ask before you buy (PayPal AI Hackathon)

**Status:** complete spec, pre-build. **Event:** Build What's Next with PayPal and AI — submissions open Oct 1, **close Nov 12, 2026**, winners Dec 21. $60K+ prizes; real target: **Best Use of Agentic Commerce ($5K)**. **Source:** `.lavish/paypal-hackathon-spec.html` (this file is the standalone-repo copy). **Planned build window:** Nov 5–12 (after Vakula ships Nov 4). **Written:** Oct 17, 2026.

> Copy this file into the new repo as its founding doc (SPEC.md). The repo is standalone, public from day one (Devpost requires a public repo), started from scratch.

## One-line pitch

A money manager you call from the point of purchase — before the money moves. Upload statements once, confirm what's genuinely committed, then ask **"Can I buy this?"** and get a hard, explainable verdict: **YES or NO you can audit**. Not a budget you check on Sunday.

## The concept in five moves

1. **The Oracle Moment** — you don't check a budget; you ask "Can I buy this?" and get an auditable YES/NO before money moves. The product lives at the point of purchase.
2. **Teeth** — an empty envelope isn't a warning you swipe away; it's a hard decline. The app says NO and means it.
3. **Deterministic engine, models on narration duty** — a server-side `decide()` and an append-only ledger control the money. AI classifies transactions and writes the bars; it never touches the numbers or the verdict. That's what makes the NO trustworthy.
4. **Two surfaces, one engine** — installable PWA + an MCP agent interface (`cani.ask`, `checkout.attempt`) — ask from Siri, Claude, wherever. That's the agentic-commerce play.
5. **PayPal-native** — envelope funding and checkouts run through PayPal (sandbox for the hackathon): real orders, real declines, recorded in the ledger.

## The razor's edge — read this before anything else

If the demo leads with envelope UI, judges file this as "another envelope budgeting app" and move on. **The envelopes are plumbing. What wins is the moment the app tells a grown man NO on his wife's $2,800 deck — in bars, with reasons — and he cannot tap through it.**

## The Eminem status flip

Eminem calls his manager before buying the watch. Nobody watching thinks he's broke — they think he's smart enough to have someone guarding the money. That is the whole emotional trick.

- Old model: "You can't afford it" — a screen tells you no, the feeling is shame, budgeting is for broke people, nobody opens the app twice.
- Cani model: "Let me ask my manager" — the user is someone important enough to *have* a manager. The NO lands as **discipline, not shame**; a number you can't argue with.

Same engine, both screens. Only the voice changes — from a rule that judges you, to a manager who works for you.

## The five-step loop

**Ingest → Discover → Ask → Confirm → Oracle.** Onboarding is the app learning your money, not you doing homework. The rule that keeps it honest: **inference discovers, human confirms, code decides** — never the other way around. Cold start is almost free: the statements already know your life.

## Onboarding that learns your money

Statements show what *happened*; questions capture what's *planned*. That gap is what no auto-categorizer can cross alone — and the reason this beats blank-envelope homework.

- The app reads history: mortgage (identical monthly), daycare (weekday cadence), Honda $777/mo, annual insurance (appears once). No envelope setup, no spreadsheet.
- Only ask questions that flip the verdict: "How long is the Honda payment?" ($777/mo means something totally different with 6 months left vs 36); "Extra mortgage payments this year?" (annualized straight into the committed baseline). Everything else is quiz friction.
- Sneaky-good: the extra-payment question isn't just data-gathering — the app is proposing a financial move and folding the answer into the baseline. The user leaves onboarding having been *advised*, not interrogated.

**Never let the model decide what's mandatory.** A silently missed payment → wrong YES → a wrong YES kills the entire product. The teeth only work if the numbers underneath are undisputed.

## The headroom model — the oracle's arithmetic

```
headroom = income − committed − variable spent
```

One number; every purchase asks whether it fits inside it.

Example (the demo's): income $8,900 · committed $2,400 · variable spent $4,600 → **headroom $1,900**. Attempt: wife's deck $2,800 → **over by $900 → hard NO**. The decline is arithmetic, not opinion — the AI only narrates it.

- **Loan end-dates auto-release**: Honda at 0 months remaining → its $777 leaves `committed` automatically; headroom widens on its own.
- **Annual bills annualize in**: once-a-year bill becomes amount ÷ 12 in committed, so the month it lands is already budgeted.
- **Variable spending decrements live**: each classified transaction reduces headroom. AI categorizes; the ledger does the subtraction.

## Data model — the manager's books

- **`committed_payments`** (the table that gives Cani its teeth): `label`, `amount`, `cadence` (monthly/weekly/annual), `next_due`, `end_date` (auto-releases headroom), `source` (discovered/user), `confirmed_at` (human sign-off), `status` (active/ended). Untouchable by variable spending; confirmed once by the human.
- **`ledger`** — append-only. Every movement (deposit, committed payment, variable spend, PayPal funding, checkout) is a row. Single source of truth for headroom.
- **`decisions`** — every verdict stored: query, amount, timestamp, YES/NO, `headroom_at_time`, `reasons[]`, inputs snapshot, `engine_version`. The audit trail that makes a NO defensible.
- **`transactions`** — AI-classified; raw fields immutable.
- **`questions`** — asked, answer, impact on headroom.
- **Funding → envelopes**: PayPal order → envelope balance. Envelope balances are **derived** from the ledger, never edited directly.

## Features

Can-I? oracle (instant, auditable) · fast variable-spend check · auto-discovery of committed · loan end-date awareness · annual-bill annualization · coaching what-if ("skip X → yes by March" — the path back to YES) · life-change re-ask (new salary/bill/loan paid off → the app notices and asks again) · **hard decline teeth** (not a toast — a decline you cannot tap through) · MCP agent surface · PayPal funding & checkout · audit trail (every NO explains itself, permanently) · bars the AI writes, numbers it can't.

## The five flows

1. **Onboard** — ingest statements → AI discovers committed candidates → ask only verdict-flipping questions → human confirms the books once → headroom is live.
2. **Can I buy this?** — user (or agent) asks an amount → `decide()` reads ledger + committed + headroom → verdict with reasons and, on NO, the path back to YES.
3. **`checkout.attempt`** — an agent attempts a real purchase through the MCP tool → engine decides → YES creates a PayPal order, NO returns a structured decline. **The agentic-commerce demo.**
4. **Fund an envelope** — move money into a goal envelope via PayPal → ledger row → derived balance. Real funding, not a mock.
5. **Life change** — engine detects a shift (loan ended, new recurring charge, income change) → AI re-asks the one question that matters → confirm → headroom updates. The app keeps earning its authority.

## Architecture — the AI never touches the numbers

Two surfaces, one deterministic engine; the AI owns the conversation, the ledger stays dumb.

```
PWA (point-of-purchase UI) ─┐
                           ├─→ decide()  [deterministic · versioned · ONLY verdict writer]
MCP server (cani.ask,      │        │
checkout.attempt) ─────────┘        ↓
                          append-only ledger + committed_payments
                                    ↑ reads
                          PayPal rails (funding · checkout orders)
                                    ↓
                          decisions (verdict · reasons · inputs · engine_version snapshot)

AI narration layer (classify · propose · coach) — TEXT ONLY —
  feeds wording/proposals AROUND the engine; the path into numbers/verdict is CLOSED.
```

The dashed red arrow is the safety boundary. One wrong YES and nobody trusts the NO again.

- **Deterministic core**: `decide()` pure and versioned — same inputs, same verdict, forever reproducible.
- **Append-only ledger**: nothing edited in place; corrections are new rows; history auditable.
- **One engine, two surfaces**: PWA and MCP tools call the identical decision path — no drift, no second implementation.

## The deliverable — a hosted web app (confirmed 2026-10-17)

**One deployable behind the live demo URL, three things inside:**

1. **Installable PWA** (phone-first — point-of-purchase means standing in a store with $2,800 on the line; installable = a home-screen icon, not a bookmark). Manifest + service worker required. Hard-NO verdict screen in bars, with reasons, no tap-through.
2. **HTTP API** the PWA calls.
3. **MCP endpoint** over streamable HTTP at the same origin — remote agents (Claude etc.) connect for agentic-commerce judging; MCP manifest + tool schemas are a Devpost submission item.

Hosting: **Render (leaning)** — solves the six-week public HTTPS URL for both surfaces, and is the sponsor-bonus path (Best Use of Render: $1K/$750/$500 credits). Stack: Bun + TS + **zod everywhere** (safeParse all agent/PayPal payloads; no `as`). Ledger storage is a build-time choice (append-only JSONL vs sqlite) — the invariant is append-only, not the engine.

## Demo plan — the three minutes that decide the outcome (open on the NO)

- **0:00 Cold open, no dashboard.** Drop statements in. Mortgage, daycare, Honda discovered in seconds — visibly, on screen.
- **0:40 One question.** "Six months left on the Honda?" Answer it. Headroom tightens in real time.
- **1:00 The wife's $2,800 deck.** "Can I buy this?" → **NO**, in bars, with reasons. Try to tap through — you can't.
- **1:40 The path back.** "Skip the March trip → YES by April 12." Discipline with a door, not a wall.
- **2:20 Same engine, from Claude.** `cani.ask` → NO; then `checkout.attempt` → real PayPal decline. The agentic-commerce moment.
- **2:50 The flip line.** "This isn't a budget. It's a manager."

Show one envelope for two seconds, max, as plumbing. The product is the verdict.

## Hackathon alignment

- **$5K Best Use of Agentic Commerce is the real target**: an agent that can transact on a user's behalf *with guardrails* — `checkout.attempt` is exactly that. Show the agent getting a governed NO — the part nobody else will have.
- **PayPal track**: envelope funding and checkouts both create real sandbox PayPal orders. The decline is a real declined order; funding is a real capture.
- **Requirement**: project must meaningfully use both PayPal and AI — covered (rails + classification/narration).
- **Sponsor bonuses unclaimed by the spec** (each is a small, deliberate integration): APIMatic context plugin ($1K×3), AG Grid ($5K/$2K/$1K×3 — only if a dashboard surface earns it), Bryntum ($1K×3), Channel3 ($1.5K), Render credits. Claim at most what fits the product honestly.

**Devpost checklist**: public repo + README · ≤3-min demo video · live/hosted demo URL · PayPal integration proof (sandbox orders) · MCP manifest + tool schemas · architecture diagram (the AI boundary).

## Risks & the failure that ends everything

- **Wrong YES** — a missed/mis-annualized committed payment green-lights money that wasn't there; one wrong YES and the NO has no authority. Mitigation: human confirmation of the books, versioned engine, audited inputs.
- **AI overriding math** — the moment a model can nudge a verdict by vibes, it's just a chatbot. Mitigation: narration layer physically blocked from `decide()`.
- **Positioning collapse** — judges pattern-match "envelope app". Mitigation: demo opens on the oracle and the hard NO; envelopes shown once.
- **Cold start needs statements** — no statements, no discovery. Mitigation: accept CSV/PDF + a manual committed-list fallback; the first "can I?" still works.
- **PayPal coverage** — mortgage isn't on PayPal. Mitigation: track as committed obligations even when the rail is external; funding/checkout rails used for what PayPal can do.

## Open decisions (each changes the build)

1. **Product name** — *Cani* (matches the `cani.ask` namespace; short, askable) / *The Manager* (leads with the emotional core) / *Can I?*. Leaning: **Cani**.
2. **Headroom window** — per paycheck (tightest, most alive) / per month (simplest, matches most bills) / rolling 14 days (smooths irregular income). Leaning: **per month** for MVP simplicity.
3. **MVP scope** — pick from:
   - M-01 statement ingest + committed discovery
   - M-02 deterministic `decide()` + audit trail *(non-negotiable core)*
   - M-03 hard-NO UI, in bars, can't tap through *(non-negotiable core)*
   - M-04 MCP `cani.ask` + `checkout.attempt` *(the agentic-commerce entry)*
   - M-05 real PayPal funding + checkout orders *(sandbox)*
   - M-06 coaching what-if path back to YES
   - M-07 envelope UI (plumbing only)
   - M-08 loan end-date auto-release

   Recommended MVP for an 8-day build: **M-01..M-05 + M-06 as one coaching line**; M-07 one static screen (two seconds); M-08 stretch.
4. **Hosting** — leaning **Render** (sponsor bonus + one service for PWA/API/MCP + six-week URL).
5. **AI narration provider** (new, 2026-10-17) — no sponsor constraint ("PayPal + AI", any AI). Options: a cheap hosted API, or double-dip the Meta hackathon setup (Spark via the muse pin/auth — one auth, two hackathons). Only needs: classify transactions, propose committed candidates, draft coaching text — never verdicts.

## Build plan (Nov 5–12, 8 days, MVP-scoped)

| Day | Work |
|---|---|
| D1 (Nov 5) | Repo scaffold (public, Bun + TS + zod, lint/typecheck/test gates); ledger + `decide()` + deterministic tests — the core first |
| D2 (Nov 6) | Statement ingest (CSV first, PDF stretch); committed discovery + the confirm flow (inference proposes, human confirms) |
| D3 (Nov 7) | PWA UI: ask screen, verdict screen (bars, hard NO), install bits (manifest + SW) |
| D4 (Nov 8) | PayPal sandbox rails: envelope funding (order capture) + checkout attempts (real decline); zod-parse every webhook/payload |
| D5 (Nov 9) | MCP server: `cani.ask` + `checkout.attempt`, manifest + tool schemas |
| D6 (Nov 10) | Deploy to Render, live URL, secrets via env (never committed), smoke; coaching what-if line |
| D7 (Nov 11) | End-to-end rehearsals of the 3-min script; record the video; README + architecture diagram |
| D8 (Nov 12) | Submit on Devpost + buffer |

## Repo bootstrap notes (standalone, from scratch)

- **Separate repo, public from day one** (Devpost requires public). Push via the **personal SSH key `id_ed25519`** (account admin-quantourapi or the personal identity you choose) — **never the work gh auth** (on hefest, `gh` is work-authed and the global HTTPS helper).
- Bun + TS + zod everywhere; lint + typecheck + tests green before every commit; no `as` on dynamic payloads — `safeParse`.
- **Secrets**: PayPal sandbox creds + model API keys in env/gitignored files, never committed; the live service reads them from Render env config.
- Deterministic core first: `decide()` is pure, versioned, and tested before any UI exists — the NO must be arithmetic before it's a screen.
- The PWA is phone-first: test the verdict screen on a real phone early (installability is a demo claim).
