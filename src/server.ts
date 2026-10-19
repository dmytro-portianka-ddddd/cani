import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import type { Decision } from "./decide";
import { appendFileSync } from "node:fs";
import { appendDecision, loadDecisions } from "./decisions";
import { headroomReport } from "./headroom";
import { appendRow, envelopeBalances, loadLedger } from "./ledger";
import { classifyCartWithAi, proposeProfileDraft } from "./ai";
import { decideAsk } from "./essentials";
import { DEFAULT_ESSENTIALS, EssentialsConfigSchema, type EssentialsConfig } from "./essentials";
import { CsvUploadSchema, IngestApplySchema, ingestRowId, parseCsv, proposeMonth } from "./ingest";
import { narrateVerdict } from "./narrate";
import { capturePayPalOrder, createPayPalOrder, paypalConfigured, paypalStatus, verifyPayPal, verifyWebhookSignature } from "./paypal";
import { BLOT_CARDS, BlotAnswersSchema, scoreBlot } from "./blot";
import { analyzeBypasses, goalImpactText, profileInsight, STATES, STATES_AS_OF, stateByCode } from "./profile";
import {
  CommittedPaymentSchema,
  MoneySchema,
  PlannedItemSchema,
  ProfileSchema,
  type Books,
  type CommittedPayment,
  type PlannedItem,
  type Profile,
} from "./schema";

/**
 * One deployable, two surfaces so far: the PWA (static, same origin) and the
 * HTTP API it calls. Every payload is safeParsed — no `as` on anything that
 * arrived over the wire. The engine stays the only verdict writer; this
 * layer only validates, persists, and narrates.
 */

const AskInputSchema = z
  .object({
    amount: MoneySchema,
    label: z.string().min(1).max(120).default("purchase"),
    merchant: z.string().min(1).max(120).optional(),
    items: z.array(z.object({ name: z.string().min(1).max(120), amount: MoneySchema }).strict()).max(50).optional(),
    at: z.string().min(1).optional(),
  })
  .strict();

const SpendInputSchema = z
  .object({
    amount: MoneySchema,
    label: z.string().min(1).max(120).default("spend"),
    at: z.string().min(1).optional(),
  })
  .strict();

const CheckoutInputSchema = z
  .object({
    amount: MoneySchema,
    label: z.string().min(1).max(120).default("purchase"),
    envelope: z.string().min(1).max(60).default("general"),
    at: z.string().min(1).optional(),
  })
  .strict();

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

function badRequest(error: z.ZodError): Response {
  return json(
    {
      error: "invalid request",
      issues: error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`),
    },
    400,
  );
}

function monthLabel(d: Date): string {
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

function seedBooks(now: Date): { committed: CommittedPayment[]; planned: PlannedItem[] } {
  const label = monthLabel(now);
  const lastDay = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 0)).getUTCDate();
  const plannedDay = String(Math.min(now.getUTCDate() + 7, lastDay)).padStart(2, "0");
  const committed: CommittedPayment[] = [
    { id: "mortgage", label: "Mortgage", amount: 1200, cadence: "monthly", nextDue: `${label}-01`, endDate: null, source: "user", confirmedAt: now.toISOString(), status: "active" },
    { id: "daycare", label: "Daycare", amount: 423, cadence: "monthly", nextDue: `${label}-01`, endDate: null, source: "user", confirmedAt: now.toISOString(), status: "active" },
    { id: "honda", label: "Honda", amount: 777, cadence: "monthly", nextDue: `${label}-01`, endDate: null, source: "discovered", confirmedAt: now.toISOString(), status: "active" },
  ];
  const planned: PlannedItem[] = [
    { label: "Weekend trip", amount: 1200, when: `${label}-${plannedDay}` },
  ];
  return { committed, planned };
}

export type App = { fetch: (req: Request) => Promise<Response>; dataDir: string };

export function createApp(dataDir: string): App {
  mkdirSync(dataDir, { recursive: true });
  const committedPath = join(dataDir, "committed.json");
  const ledgerPath = join(dataDir, "ledger.jsonl");
  const plannedPath = join(dataDir, "planned.json");
  const decisionsPath = join(dataDir, "decisions.jsonl");
  const profilePath = join(dataDir, "profile.json");
  const essentialsPath = join(dataDir, "essentials.json");
  const now = new Date();

  if (!existsSync(committedPath) || !existsSync(plannedPath) || !existsSync(ledgerPath)) {
    const seed = seedBooks(now);
    if (!existsSync(committedPath)) writeFileSync(committedPath, `${JSON.stringify(seed.committed, null, 2)}\n`);
    if (!existsSync(plannedPath)) writeFileSync(plannedPath, `${JSON.stringify(seed.planned, null, 2)}\n`);
    if (!existsSync(ledgerPath)) {
      const label = monthLabel(now);
      appendRow(ledgerPath, { id: "seed-paycheck", at: `${label}-01T09:00:00.000Z`, type: "deposit", amount: 8900, label: "paycheck" });
      appendRow(ledgerPath, { id: "seed-spend-1", at: `${label}-02T12:00:00.000Z`, type: "variable_spend", amount: 3800, label: "renovation" });
      appendRow(ledgerPath, { id: "seed-spend-2", at: `${label}-03T12:00:00.000Z`, type: "variable_spend", amount: 800, label: "groceries" });
    }
  }


  const ordersPath = join(dataDir, "orders.json");
  function loadPendingOrders(): Record<string, { amount: number; label: string }> {
    if (!existsSync(ordersPath)) return {};
    const raw: unknown = JSON.parse(readFileSync(ordersPath, "utf8"));
    const parsed = z.record(z.string(), z.object({ amount: z.number().finite(), label: z.string() })).safeParse(raw);
    return parsed.success ? parsed.data : {};
  }
  function savePendingOrder(id: string, entry: { amount: number; label: string }): void {
    const all = loadPendingOrders();
    all[id] = entry;
    writeFileSync(ordersPath, `${JSON.stringify(all, null, 2)}\n`);
  }

  /** The one ask path every surface shares — REST, PayPal attempt, MCP.
   * A NO is appended as a declined checkout attempt when via attempt. */
  async function executeAsk(data: { amount: number; label: string; merchant?: string; items?: { name: string; amount: number }[]; at?: string }): Promise<Decision> {
    const at = data.at ?? new Date().toISOString();
    const ask = { amount: data.amount, label: data.label, merchant: data.merchant, items: data.items, at };
    const books = loadBooks();
    const planned = loadPlanned();
    const profile = loadProfile();
    const stateCost = profile ? stateByCode(profile.state) : undefined;
    const cart = ask.items && ask.items.length > 0 ? await classifyCartWithAi(ask.items, ask.amount) : undefined;
    const decision: Decision = decideAsk(ask, books, planned, loadEssentials(), profile ?? undefined, stateCost, cart);
    if (decision.verdict === "NO") {
      const priorNos = loadDecisions(decisionsPath).filter(
        (d) => d.verdict === "NO" && !d.bypass && d.label.toLowerCase() === ask.label.toLowerCase()
          && d.amount === ask.amount && d.at.slice(0, 7) === at.slice(0, 7),
      );
      if (priorNos.length >= 1) decision.bypassAvailable = true;
    }
    appendDecision(decisionsPath, decision);
    return decision;
  }

  async function executeAttempt(data: { amount: number; label: string; merchant?: string; items?: { name: string; amount: number }[]; at?: string }) {
    const decision = await executeAsk(data);
    if (decision.verdict === "NO") {
      appendRow(ledgerPath, {
        id: crypto.randomUUID(), at: decision.at, type: "checkout",
        amount: decision.amount, label: decision.label, envelope: "general", result: "declined",
      });
      return { decision, paypal: { outcome: "declined" as const, order: null, note: "No PayPal order was created — the transaction does not exist." } };
    }
    if (!paypalConfigured()) {
      return { decision, paypal: { outcome: "approved-local" as const, order: null, note: "YES, but PayPal is not configured — no order created. Set sandbox credentials to run real rails." } };
    }
    try {
      const order = await createPayPalOrder({ amount: decision.amount, label: decision.label });
      savePendingOrder(order.id, { amount: decision.amount, label: decision.label });
      return { decision, paypal: { outcome: "order-created" as const, order, note: "Order created after a YES. Approve it on PayPal, then capture." } };
    } catch (err) {
      return { decision, paypal: { outcome: "order-failed" as const, order: null, note: err instanceof Error ? err.message : "PayPal order failed" } };
    }
  }

  function loadBooks(): Books {
    const raw: unknown = JSON.parse(readFileSync(committedPath, "utf8"));
    const committed = z.array(CommittedPaymentSchema).safeParse(raw);
    if (!committed.success) throw new Error(`committed.json is malformed: ${committed.error.issues.map((i) => i.message).join("; ")}`);
    return { committed: committed.data, ledger: loadLedger(ledgerPath) };
  }

  function loadPlanned(): PlannedItem[] {
    const raw: unknown = JSON.parse(readFileSync(plannedPath, "utf8"));
    const planned = z.array(PlannedItemSchema).safeParse(raw);
    if (!planned.success) throw new Error(`planned.json is malformed: ${planned.error.issues.map((i) => i.message).join("; ")}`);
    return planned.data;
  }

  function loadProfile(): Profile | null {
    if (!existsSync(profilePath)) return null;
    const raw: unknown = JSON.parse(readFileSync(profilePath, "utf8"));
    const parsed = ProfileSchema.safeParse(raw);
    if (!parsed.success) throw new Error(`profile.json is malformed: ${parsed.error.issues.map((i) => i.message).join("; ")}`);
    return parsed.data;
  }

  function loadEssentials(): EssentialsConfig {
    if (!existsSync(essentialsPath)) return DEFAULT_ESSENTIALS;
    const raw: unknown = JSON.parse(readFileSync(essentialsPath, "utf8"));
    const parsed = EssentialsConfigSchema.safeParse(raw);
    if (!parsed.success) throw new Error(`essentials.json is malformed: ${parsed.error.issues.map((i) => i.message).join("; ")}`);
    return parsed.data;
  }

  function shameForWindow(windowLabel: string): { points: number; count: number } {
    const manual = loadDecisions(decisionsPath).filter(
      (d) => d.bypass?.category === "manual" && d.at.slice(0, 7) === windowLabel,
    );
    return {
      points: manual.reduce((s, d) => s + (d.bypass?.shameAwarded ?? 0), 0),
      count: manual.length,
    };
  }

  function state(atIso: string) {
    const books = loadBooks();
    const report = headroomReport(books, atIso);
    const profile = loadProfile();
    const stateCost = profile ? stateByCode(profile.state) : undefined;
    return {
      report,
      committed: books.committed,
      planned: loadPlanned(),
      envelopes: Object.fromEntries(envelopeBalances(books.ledger)),
      decisions: loadDecisions(decisionsPath).slice(-20).reverse(),
      profile,
      insight: profile && stateCost ? profileInsight(profile, report, stateCost) : null,
      statesAsOf: STATES_AS_OF,
      essentials: loadEssentials(),
      shame: shameForWindow(report.window.label),
      kept: (() => {
        const all = loadDecisions(decisionsPath);
        const bypassed = new Set(all.filter((d) => d.bypass?.category === "manual").map((d) => `${d.label.toLowerCase()}|${d.amount}`));
        const keptDecisions = all.filter((d) => d.verdict === "NO" && !d.bypass && d.at.slice(0, 7) === report.window.label && !bypassed.has(`${d.label.toLowerCase()}|${d.amount}`));
        return { count: keptDecisions.length, amount: keptDecisions.reduce((sum, d) => Math.round((sum + d.amount) * 100) / 100, 0) };
      })(),
      goalHealth: analyzeBypasses(loadDecisions(decisionsPath), atIso, report, profile ?? undefined),
      levels: {
        feel: profile !== null,
        month: books.ledger.some((r) => r.id.startsWith("ingest-")),
        paypal: paypalStatus().configured,
      },
    };
  }

  const publicDir = new URL("../public/", import.meta.url);
  const staticTypes: Record<string, string> = {
    "/": "text/html; charset=utf-8",
    "/index.html": "text/html; charset=utf-8",
    "/app.js": "text/javascript; charset=utf-8",
    "/styles.css": "text/css; charset=utf-8",
    "/manifest.webmanifest": "application/manifest+json; charset=utf-8",
    "/sw.js": "text/javascript; charset=utf-8",
    "/icon.svg": "image/svg+xml",
    "/icon-192.png": "image/png",
    "/icon-512.png": "image/png",
  };

  async function handle(req: Request): Promise<Response> {
    const url = new URL(req.url);
    try {
      // Optional demo guard: when CANI_ACCESS_CODE is set, the API and MCP
      // require it (cookie from /api/login, or x-cani-access header for
      // agents). Static shell and the signature-verified webhook stay open.
      const accessCode = process.env.CANI_ACCESS_CODE;
      if (accessCode && url.pathname !== "/api/login" && url.pathname !== "/api/paypal/webhook"
        && (url.pathname.startsWith("/api/") || url.pathname === "/mcp")) {
        const cookie = req.headers.get("cookie") ?? "";
        const authed = req.headers.get("x-cani-access") === accessCode
          || cookie.split(";").map((c) => c.trim()).includes(`cani_access=${accessCode}`);
        if (!authed) return json({ error: "access code required", code: "ACCESS_CODE_REQUIRED" }, 401);
      }
      if (url.pathname === "/api/login" && req.method === "POST") {
        const raw: unknown = await req.json().catch(() => null);
        const parsed = z.object({ code: z.string() }).strict().safeParse(raw);
        if (!process.env.CANI_ACCESS_CODE) return json({ ok: true, note: "no access code configured" });
        if (!parsed.success || parsed.data.code !== process.env.CANI_ACCESS_CODE) return json({ error: "wrong code" }, 401);
        return new Response(JSON.stringify({ ok: true }), {
          headers: { "content-type": "application/json", "set-cookie": `cani_access=${process.env.CANI_ACCESS_CODE}; HttpOnly; Path=/; SameSite=Lax` },
        });
      }
      if (url.pathname === "/api/state" && req.method === "GET") {
        return json(state(url.searchParams.get("at") ?? new Date().toISOString()));
      }
      if (url.pathname === "/api/decisions" && req.method === "GET") {
        return json({ decisions: loadDecisions(decisionsPath).slice(-50).reverse() });
      }
      if (url.pathname === "/api/paypal/status" && req.method === "GET") {
        return json({ ...paypalStatus(), verification: await verifyPayPal() });
      }
      if (url.pathname === "/api/ingest" && req.method === "POST") {
        const raw: unknown = await req.json().catch(() => null);
        const parsed = CsvUploadSchema.safeParse(raw);
        if (!parsed.success) return badRequest(parsed.error);
        // Propose-only: parsing a month writes nothing.
        return json({ proposal: proposeMonth(parseCsv(parsed.data.csv)) });
      }
      if (url.pathname === "/api/ingest/apply" && req.method === "POST") {
        const raw: unknown = await req.json().catch(() => null);
        const parsed = IngestApplySchema.safeParse(raw);
        if (!parsed.success) return badRequest(parsed.error);
        const proposal = proposeMonth(parsed.data.rows);
        const confirmed = new Set(parsed.data.confirmCandidateIndexes);
        const confirmedKeys = new Set(
          proposal.candidates.filter((_, i) => confirmed.has(i)).map((c) => `${c.label.toLowerCase()}|${c.amount}`),
        );
        let appended = 0;
        let skippedDuplicates = 0;
        for (const row of parsed.data.rows) {
          const isCandidate = row.amount < 0 && confirmedKeys.has(`${row.description.toLowerCase()}|${Math.abs(row.amount)}`);
          if (isCandidate) continue; // becomes a committed book entry, not variable spend
          try {
            appendRow(ledgerPath, {
              id: ingestRowId(row),
              at: row.date,
              type: row.amount > 0 ? "deposit" : "variable_spend",
              amount: Math.abs(row.amount),
              label: row.description,
            });
            appended++;
          } catch (err) {
            if (err instanceof Error && err.message.includes("duplicate")) skippedDuplicates++;
            else throw err;
          }
        }
        // Confirmed candidates join the books — this click IS the human
        // confirmation the spec requires. Unconfirmed ones never land.
        const books = loadBooks();
        const existingLabels = new Set(books.committed.map((p) => p.label.toLowerCase()));
        const nowIso = new Date().toISOString();
        const monthStart = `${nowIso.slice(0, 8)}01`;
        const added: CommittedPayment[] = [];
        for (const candidate of proposal.candidates.filter((_, i) => confirmed.has(i))) {
          if (existingLabels.has(candidate.label.toLowerCase())) continue;
          const entry: CommittedPayment = {
            id: `ingest-${candidate.label.toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 40)}`,
            label: candidate.label,
            amount: candidate.amount,
            cadence: "monthly",
            nextDue: monthStart,
            endDate: null,
            source: "discovered",
            confirmedAt: nowIso,
            status: "active",
          };
          if (!books.committed.some((p) => p.id === entry.id)) added.push(entry);
        }
        if (added.length > 0) {
          writeFileSync(committedPath, `${JSON.stringify([...books.committed, ...added], null, 2)}\n`);
        }
        return json({ appended, skippedDuplicates, committedAdded: added.map((a) => a.label), ...state(nowIso) });
      }
      if (url.pathname === "/api/profile/draft" && req.method === "POST") {
        const raw: unknown = await req.json().catch(() => null);
        const parsed = z.object({ text: z.string().min(1).max(2000) }).strict().safeParse(raw);
        if (!parsed.success) return badRequest(parsed.error);
        // Propose-only: the draft is returned, never written anywhere.
        return json(await proposeProfileDraft(parsed.data.text));
      }
      if (url.pathname === "/api/blot" && req.method === "GET") {
        return json({ cards: BLOT_CARDS });
      }
      if (url.pathname === "/api/blot" && req.method === "POST") {
        const raw: unknown = await req.json().catch(() => null);
        const parsed = z.object({ answers: BlotAnswersSchema }).strict().safeParse(raw);
        if (!parsed.success) return badRequest(parsed.error);
        return json(scoreBlot(parsed.data.answers));
      }
      if (url.pathname === "/api/states" && req.method === "GET") {
        return json({ states: STATES, asOf: STATES_AS_OF });
      }
      if (url.pathname === "/api/profile/realign" && req.method === "POST") {
        const profile = loadProfile();
        if (!profile) return json({ error: "no profile to realign" }, 400);
        const s0 = state(new Date().toISOString());
        const suggested = s0.goalHealth.suggestedHorizon;
        if (!suggested) return json({ error: "goal does not need realignment — the pattern is not systematic", goalHealth: s0.goalHealth }, 409);
        writeFileSync(profilePath, `${JSON.stringify({ ...profile, horizon: suggested }, null, 2)}\n`);
        const s = state(new Date().toISOString());
        return json({ profile: s.profile, goalHealth: s.goalHealth, insight: s.insight });
      }
      if (url.pathname === "/api/profile" && req.method === "GET") {
        const s = state(new Date().toISOString());
        return json({ profile: s.profile, insight: s.insight });
      }
      if (url.pathname === "/api/profile" && req.method === "PUT") {
        const raw: unknown = await req.json().catch(() => null);
        const parsed = ProfileSchema.safeParse(raw);
        if (!parsed.success) return badRequest(parsed.error);
        if (!stateByCode(parsed.data.state)) {
          return json({ error: "invalid request", issues: [`state: unknown US state code "${parsed.data.state}"`] }, 400);
        }
        writeFileSync(profilePath, `${JSON.stringify(parsed.data, null, 2)}\n`);
        const s = state(new Date().toISOString());
        return json({ profile: s.profile, insight: s.insight, report: s.report });
      }
      if (url.pathname === "/api/essentials" && req.method === "GET") {
        return json({ essentials: loadEssentials() });
      }
      if (url.pathname === "/api/essentials" && req.method === "PUT") {
        const raw: unknown = await req.json().catch(() => null);
        const parsed = EssentialsConfigSchema.safeParse(raw);
        if (!parsed.success) return badRequest(parsed.error);
        writeFileSync(essentialsPath, `${JSON.stringify(parsed.data, null, 2)}\n`);
        return json({ essentials: parsed.data });
      }
      if (url.pathname === "/api/ask" && req.method === "POST") {
        const raw: unknown = await req.json().catch(() => null);
        const parsed = AskInputSchema.safeParse(raw);
        if (!parsed.success) return badRequest(parsed.error);
        const decision = await executeAsk(parsed.data);
        return json({ decision, narration: await narrateVerdict(decision) });
      }
      if (url.pathname === "/api/checkout/attempt" && req.method === "POST") {
        const raw: unknown = await req.json().catch(() => null);
        const parsed = AskInputSchema.safeParse(raw);
        if (!parsed.success) return badRequest(parsed.error);
        const result = await executeAttempt(parsed.data);
        return json({ ...result, narration: await narrateVerdict(result.decision) });
      }

      if (url.pathname === "/api/paypal/webhook" && req.method === "POST") {
        const rawBody = await req.text();
        let rawEvent: unknown;
        try { rawEvent = JSON.parse(rawBody); } catch { return json({ error: "not JSON" }, 400); }
        const eventSchema = z.object({
          id: z.string().min(1),
          event_type: z.string().min(1),
          resource: z.record(z.string(), z.unknown()).optional(),
        }).passthrough();
        const parsedEvent = eventSchema.safeParse(rawEvent);
        if (!parsedEvent.success) return badRequest(parsedEvent.error);
        const event = parsedEvent.data;

        // Trust, but verify: with a webhook id configured, a delivery that
        // fails PayPal's signature check is refused, never recorded.
        const headerMap: Record<string, string | null> = {
          "paypal-transmission-id": req.headers.get("paypal-transmission-id"),
          "paypal-transmission-time": req.headers.get("paypal-transmission-time"),
          "paypal-transmission-sig": req.headers.get("paypal-transmission-sig"),
          "paypal-cert-url": req.headers.get("paypal-cert-url"),
          "paypal-auth-algo": req.headers.get("paypal-auth-algo"),
        };
        const verified = await verifyWebhookSignature(headerMap, rawBody);
        if (verified === false) return json({ error: "webhook signature verification failed" }, 400);

        // Idempotent by event id: PayPal retries deliveries, money must not double.
        const eventsPath = join(dataDir, "paypal-events.jsonl");
        const seen = new Set<string>();
        if (existsSync(eventsPath)) {
          for (const line of readFileSync(eventsPath, "utf8").split("\n")) {
            if (!line.trim()) continue;
            try { const e: unknown = JSON.parse(line); if (typeof e === "object" && e !== null && "id" in e && typeof (e as { id: unknown }).id === "string") seen.add((e as { id: string }).id); } catch { /* loud elsewhere */ }
          }
        }
        if (seen.has(event.id)) return json({ received: true, duplicate: true });
        appendFileSync(eventsPath, `${JSON.stringify({ ...event, verified })}\n`, "utf8");

        // A completed capture is money moved: it joins the ledger exactly
        // once, keyed by the PayPal event id.
        if (event.event_type === "PAYMENT.CAPTURE.COMPLETED") {
          const amountObj = typeof event.resource?.amount === "object" && event.resource?.amount !== null ? event.resource.amount as Record<string, unknown> : {};
          const value = typeof amountObj.value === "string" ? Number(amountObj.value) : NaN;
          if (!Number.isNaN(value) && value > 0) {
            const rel = typeof event.resource?.supplementary_data === "object" && event.resource?.supplementary_data !== null
              ? (event.resource.supplementary_data as Record<string, unknown>) : {};
            const related = typeof rel.related_ids === "object" && rel.related_ids !== null ? rel.related_ids as Record<string, unknown> : {};
            appendRow(ledgerPath, {
              id: `paypal-event-${event.id}`,
              at: new Date().toISOString(),
              type: "checkout",
              amount: value,
              label: "PayPal capture",
              envelope: "general",
              orderId: typeof related.order_id === "string" ? related.order_id : undefined,
              result: "executed",
            });
          }
        }
        return json({ received: true, verified });
      }
      if (url.pathname === "/api/paypal/capture" && req.method === "POST") {
        const raw: unknown = await req.json().catch(() => null);
        const parsed = z.object({ orderId: z.string().min(1) }).strict().safeParse(raw);
        if (!parsed.success) return badRequest(parsed.error);
        if (!paypalConfigured()) return json({ error: "PayPal is not configured" }, 400);
        const pending = loadPendingOrders()[parsed.data.orderId];
        if (!pending) return json({ error: "unknown or already-captured order" }, 404);
        const captured = await capturePayPalOrder(parsed.data.orderId);
        if (captured.status !== "COMPLETED") return json({ error: `capture status ${captured.status}` }, 502);
        const row = appendRow(ledgerPath, {
          id: crypto.randomUUID(), at: new Date().toISOString(), type: "checkout",
          amount: pending.amount, label: pending.label, envelope: "general", orderId: parsed.data.orderId, result: "executed",
        });
        const all = loadPendingOrders();
        delete all[parsed.data.orderId];
        writeFileSync(ordersPath, `${JSON.stringify(all, null, 2)}\n`);
        return json({ captured, row, ...state(new Date().toISOString()) });
      }
      if (url.pathname === "/paypal/return" || url.pathname === "/paypal/cancel") {
        const ok = url.pathname.endsWith("return");
        return new Response(`<!doctype html><title>Cani + PayPal</title><body style="font-family:sans-serif;background:#ffd21f;padding:40px"><h1>${ok ? "Approved on PayPal." : "Cancelled on PayPal."}</h1><p>Head back to Cani to ${ok ? "complete the capture" : "ask again"}.</p></body>`, { headers: { "content-type": "text/html; charset=utf-8" } });
      }
      if (url.pathname === "/api/ask/manual-bypass" && req.method === "POST") {
        const raw: unknown = await req.json().catch(() => null);
        const parsed = AskInputSchema.safeParse(raw);
        if (!parsed.success) return badRequest(parsed.error);
        const at = parsed.data.at ?? new Date().toISOString();
        const ask = { amount: parsed.data.amount, label: parsed.data.label, merchant: parsed.data.merchant, items: parsed.data.items, at };
        const history = loadDecisions(decisionsPath);
        const unlocked = history.some(
          (d) => d.bypassAvailable && d.label.toLowerCase() === ask.label.toLowerCase()
            && d.amount === ask.amount && d.at.slice(0, 7) === at.slice(0, 7),
        );
        if (!unlocked) {
          return json({ error: "Manual bypass unlocks after the second NO for the same ask. Ask again first — the manager makes you say it twice." }, 409);
        }
        const books = loadBooks();
        const profile = loadProfile();
        const stateCost = profile ? stateByCode(profile.state) : undefined;
        const baseCart = ask.items && ask.items.length > 0 ? await classifyCartWithAi(ask.items, ask.amount) : undefined;
        const base: Decision = decideAsk(ask, books, loadPlanned(), loadEssentials(), profile ?? undefined, stateCost, baseCart);
        if (base.verdict === "YES") return json({ decision: base, narration: await narrateVerdict(base) });
        const shameAwarded = shameForWindow(at.slice(0, 7)).count + 1;
        const goalImpact = goalImpactText(base.amount, base.inputs, profile ?? undefined);
        const decision: Decision = {
          ...base,
          verdict: "YES",
          shortBy: null,
          pathToYes: null,
          goalImpact,
          reasons: [
            `manual bypass: you asked twice, the manager stepped aside — shame +${shameAwarded}`,
            `books said NO (headroom $${base.headroomAtTime}); this YES is yours, not the math's`,
            `what it costs: ${goalImpact}`,
            ...base.reasons,
          ],
          bypass: { category: "manual", merchant: ask.merchant ?? "", cap: 0, rawVerdict: "NO", shameAwarded },
        };
        appendDecision(decisionsPath, decision);
        return json({ decision, narration: await narrateVerdict(decision), shame: shameForWindow(at.slice(0, 7)) });
      }
      if (url.pathname === "/api/spend" && req.method === "POST") {
        const raw: unknown = await req.json().catch(() => null);
        const parsed = SpendInputSchema.safeParse(raw);
        if (!parsed.success) return badRequest(parsed.error);
        const at = parsed.data.at ?? new Date().toISOString();
        const row = appendRow(ledgerPath, {
          id: crypto.randomUUID(),
          at,
          type: "variable_spend",
          amount: parsed.data.amount,
          label: parsed.data.label,
        });
        return json({ row, ...state(at) });
      }
      if (url.pathname === "/api/checkout" && req.method === "POST") {
        const raw: unknown = await req.json().catch(() => null);
        const parsed = CheckoutInputSchema.safeParse(raw);
        if (!parsed.success) return badRequest(parsed.error);
        const at = parsed.data.at ?? new Date().toISOString();
        const row = appendRow(ledgerPath, {
          id: crypto.randomUUID(),
          at,
          type: "checkout",
          amount: parsed.data.amount,
          label: parsed.data.label,
          envelope: parsed.data.envelope,
          result: "executed",
        });
        return json({ row, ...state(at) });
      }

      // --- MCP surface (streamable HTTP, JSON-RPC) ---------------------
      // The agentic-commerce door: cani.ask and checkout.attempt call the
      // identical executeAsk/executeAttempt path as the PWA. No drift.
      const MCP_TOOLS = [
        {
          name: "cani.ask",
          description: "Ask Cani 'can I buy this?' Returns an auditable YES/NO from the deterministic engine (essential lane, deeper-mode profile adjustment, shame rules included). Never moves money.",
          inputSchema: {
            type: "object",
            properties: {
              amount: { type: "number", description: "Price in USD, exact to the cent" },
              label: { type: "string", description: "What the purchase is" },
              merchant: { type: "string", description: "Merchant name; essential merchants (CVS, Shell, Kroger...) may ride the essential lane" },
              items: { type: "array", items: { type: "object", properties: { name: { type: "string" }, amount: { type: "number" } }, required: ["name", "amount"] } },
            },
            required: ["amount", "label"],
          },
        },
        {
          name: "checkout.attempt",
          description: "Attempt a real purchase through Cani. NO: no PayPal order is created and the attempt is recorded as declined. YES: a PayPal order is created for human approval and capture.",
          inputSchema: {
            type: "object",
            properties: {
              amount: { type: "number" },
              label: { type: "string" },
              merchant: { type: "string" },
              items: { type: "array", items: { type: "object", properties: { name: { type: "string" }, amount: { type: "number" } }, required: ["name", "amount"] } },
            },
            required: ["amount", "label"],
          },
        },
      ];
      if (url.pathname === "/mcp/manifest" && req.method === "GET") {
        return json({ name: "cani", version: "1.0.0", transport: "streamable-http", endpoint: "/mcp", tools: MCP_TOOLS });
      }
      if (url.pathname === "/mcp" && req.method === "POST") {
        const rpc: unknown = await req.json().catch(() => null);
        const parsedRpc = z.object({ jsonrpc: z.string().optional(), id: z.union([z.number(), z.string()]).optional(), method: z.string(), params: z.record(z.string(), z.unknown()).optional() }).safeParse(rpc);
        if (!parsedRpc.success) return json({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "parse error" } }, 400);
        const { id, method, params } = parsedRpc.data;
        if (method.startsWith("notifications/")) return new Response(null, { status: 202 });
        const reply = (result: unknown) => json({ jsonrpc: "2.0", id: id ?? null, result });
        const fail = (code: number, message: string) => json({ jsonrpc: "2.0", id: id ?? null, error: { code, message } });
        if (method === "initialize") {
          return reply({ protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "cani", version: "1.0.0" } });
        }
        if (method === "ping") return reply({});
        if (method === "tools/list") return reply({ tools: MCP_TOOLS });
        if (method === "tools/call") {
          const name = typeof params?.name === "string" ? params.name : "";
          const argsRaw = typeof params?.arguments === "object" && params?.arguments !== null ? params.arguments : {};
          const parsedArgs = AskInputSchema.safeParse(argsRaw);
          if (!parsedArgs.success) {
            return reply({ content: [{ type: "text", text: `invalid arguments: ${parsedArgs.error.issues.map((i) => i.message).join("; ")}` }], isError: true });
          }
          if (name === "cani.ask") {
            const decision = await executeAsk(parsedArgs.data);
            const narration = await narrateVerdict(decision);
            return reply({ content: [{ type: "text", text: JSON.stringify({ decision, narration }) }], structuredContent: { decision, narration } });
          }
          if (name === "checkout.attempt") {
            const result = await executeAttempt(parsedArgs.data);
            const narration = await narrateVerdict(result.decision);
            return reply({
              content: [{ type: "text", text: JSON.stringify({ ...result, narration }) }],
              structuredContent: { ...result, narration },
              isError: result.decision.verdict === "NO",
            });
          }
          return fail(-32602, `unknown tool "${name}"`);
        }
        return fail(-32601, `method not found: ${method}`);
      }
      if (url.pathname.startsWith("/api/")) return json({ error: "not found" }, 404);

      const type = staticTypes[url.pathname];
      if (type !== undefined && req.method === "GET") {
        const file = Bun.file(new URL(url.pathname === "/" ? "./index.html" : `.${url.pathname}`, publicDir));
        if (await file.exists()) {
          return new Response(file, {
            headers: {
              "content-type": type,
              ...(url.pathname === "/sw.js" ? { "cache-control": "no-cache" } : {}),
            },
          });
        }
      }
      return new Response("not found", { status: 404 });
    } catch (err) {
      return json({ error: err instanceof Error ? err.message : "internal error" }, 500);
    }
  }

  return { fetch: handle, dataDir };
}

if (import.meta.main) {
  const port = Number(process.env.PORT ?? 8787);
  const dataDir = process.env.CANI_DATA_DIR ?? join(import.meta.dir, "..", "data");
  const app = createApp(dataDir);
  const server = Bun.serve({ port, hostname: "0.0.0.0", fetch: app.fetch });
  console.log(`Cani listening on http://0.0.0.0:${server.port} (data: ${dataDir})`);
}
