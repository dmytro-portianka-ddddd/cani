# Cani — ask before you buy

A money manager you call from the point of purchase — before the money moves.
Upload statements once, confirm what's genuinely committed, then ask
**"Can I buy this?"** and get a hard, explainable verdict: **YES or NO you can
audit.** Not a budget you check on Sunday.

**Live demo:** <https://cani-tos1.onrender.com> — seeded with a demo month
(income $8,900 · committed $2,400 · headroom $1,900).

Core invariants (see `SPEC.md` for the full product spec):

- **The AI never touches the numbers or the verdict.** A deterministic,
  versioned `decide()` writes every verdict; the AI narration layer only
  classifies, proposes, and coaches — text only.
- **The ledger is append-only.** Corrections are new rows, never edits.
  Envelope balances are derived, never written directly.
- **A wrong YES kills the product.** Committed payments are human-confirmed;
  every decision snapshots its inputs and engine version so any NO (or YES)
  can be reproduced exactly.

Status: D1 + D3 — deterministic core and the installable PWA (see SPEC.md
build plan). Engine `0.2.0`: inputs are runtime-validated (cents-exact,
finite, real ISO dates), windows are computed on instants, duplicate ledger
ids are refused, only human-confirmed committed payments count, and every
verdict is appended to an auditable decisions store with its full inputs
snapshot.

```bash
bun install
bun run validate   # lint + typecheck + test
bun start          # PWA + HTTP API on http://127.0.0.1:8787
```

Open http://127.0.0.1:8787 in a browser and install it (manifest + service
worker included). Ask "Can I buy this?" — a YES can be recorded as spend;
a NO has no override button. Runtime books live in `data/` (gitignored):
`committed.json`, `ledger.jsonl`, `planned.json`, `decisions.jsonl`.

**Deeper mode (engine 0.3.0)** — an optional "Who am I → Who I want to be"
tree (age band, housing, dependents, US state, goal, horizon, temperament)
plus bundled approximate 50-state + DC cost data
([src/data/us-states.json](/home/hefest/personal/cani/src/data/us-states.json),
coaching-grade, not live Numbeo). A saved profile deterministically adjusts
headroom in [src/profile.ts](/home/hefest/personal/cani/src/profile.ts) —
named line items only, capped at ±$600/mo — and can flip a marginal verdict.
The raw books verdict is always computed, shown, and stored next to the
deeper verdict; core `decide()` never reads a profile.

**Know yourself, in levels.** L1 *Feel it* — a five-card money blot
(inkblot-inspired reflection, not a diagnosis) and a free-text profile
draft (AI via `CANI_AI_API_KEY`/`CANI_AI_BASE_URL`/`CANI_AI_MODEL`, or the
built-in deterministic reader with no key) — both propose only; you review
every field and save. L2 *Show a typical month* — upload a bank CSV
(`date,description,amount`); Cani proposes income, spend, and committed
candidates, and only the ones you tick join the books. L3 *Connect PayPal*
— capability-checked rails: PayPal can run checkout/funding and (business
accounts) report PayPal-side activity, but it cannot read bank statements,
so it is never a discovery source.

```bash
bun run test:e2e   # Playwright, real browser, core flows (10 tests)
bun run check-paypal     # prove the PayPal credentials against the real OAuth endpoint
bun run rehearse-mcp     # full MCP client rehearsal: agent refused, then served
bun run register-webhook # after deploying: register /api/paypal/webhook with PayPal
bun run demo:video       # record the demo cut (demo-video/cani-demo.webm)
```

## For judges — the 3-minute path

Live at **https://cani-tos1.onrender.com**, seeded (income $8,900 · committed
$2,400 · headroom $1,900). Nothing to set up — the books are live on load.

1. **The NO.** Ask "Can I buy this?" → *Aeron Deck, $2,800* → a hard **NO** in
   bars (short $900, reasons shown, no buy button).
2. **The essential lane.** Ask *insulin, CVS Pharmacy* → instant **YES** —
   essentials ride free and don't wait for a good month.
3. **Same engine, from an agent (MCP).** Point any MCP client at
   `https://cani-tos1.onrender.com/mcp` (manifest: `/mcp/manifest`):
   - `cani.ask` — an auditable YES/NO (never moves money).
   - `checkout.attempt` — an agent attempts a real purchase: a governed **NO**
     returns a structured decline *with no PayPal order created*; a YES creates
     a real sandbox PayPal order.
4. **PayPal rails.** Envelope funding and checkout create real **sandbox**
   orders (test money only).

The AI narrates and classifies; a deterministic, append-only ledger writes
every verdict. See `SPEC.md` for the architecture boundary.

See [.env.example](/home/hefest/personal/cani/.env.example) for every
environment variable, and [render.yaml](/home/hefest/personal/cani/render.yaml)
for the deploy (persistent disk included — the books must survive redeploys).
