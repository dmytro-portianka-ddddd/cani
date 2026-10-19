/**
 * Level 3 — PayPal, honestly scoped.
 *
 * What PayPal's APIs can and cannot do for Cani:
 * - CAN: create/capture orders (our checkout + envelope-funding rails),
 *   and — for approved BUSINESS accounts with the Transaction Search
 *   permission — list transactions that moved through PayPal itself.
 * - CANNOT: read a user's bank/card statements, mortgage, daycare, or any
 *   money that never touched PayPal. There is no PayPal API for "get my
 *   typical month" from a personal bank account.
 *
 * So Level 3 is a connection for rails and PayPal-side verification,
 * never a discovery source for the books. Discovery stays Level 2 (CSV)
 * with human confirmation.
 */
export type PayPalStatus = {
  configured: boolean;
  mode: "sandbox" | "live" | null;
  capabilities: string[];
  limits: string[];
};

export type PayPalVerification = {
  verified: boolean | null;
  detail: string;
};

/** Prove the credentials work: a client-credentials token exchange against
 * the real PayPal OAuth endpoint. No token is stored or logged; this only
 * answers "can these credentials talk to PayPal". */
export async function verifyPayPal(fetchFn: typeof fetch = fetch): Promise<PayPalVerification> {
  const id = process.env.CANI_PAYPAL_CLIENT_ID;
  const secret = process.env.CANI_PAYPAL_CLIENT_SECRET;
  if (!id || !secret) return { verified: null, detail: "No credentials configured." };
  const base = process.env.CANI_PAYPAL_MODE === "live" ? "https://api-m.paypal.com" : "https://api-m.sandbox.paypal.com";
  try {
    const res = await fetchFn(`${base}/v1/oauth2/token`, {
      method: "POST",
      headers: {
        authorization: `Basic ${Buffer.from(`${id}:${secret}`).toString("base64")}`,
        "content-type": "application/x-www-form-urlencoded",
      },
      body: "grant_type=client_credentials",
    });
    if (res.ok) return { verified: true, detail: `Credentials accepted by PayPal (${base.includes("sandbox") ? "sandbox" : "live"}).` };
    return { verified: false, detail: `PayPal rejected the credentials (HTTP ${res.status}). Check the client id/secret pair and mode.` };
  } catch (err) {
    return { verified: false, detail: `Could not reach PayPal: ${err instanceof Error ? err.message : "network error"}` };
  }
}

export function paypalStatus(): PayPalStatus {
  const configured = Boolean(process.env.CANI_PAYPAL_CLIENT_ID && process.env.CANI_PAYPAL_CLIENT_SECRET);
  const mode = configured ? (process.env.CANI_PAYPAL_MODE === "live" ? "live" : "sandbox") : null;
  return {
    configured,
    mode,
    capabilities: configured
      ? [
          "Create and capture PayPal orders (checkout + envelope funding rails)",
          "Record PayPal order ids on ledger rows for audit",
          "Transaction Search for PayPal-account activity (business account + granted permission only)",
        ]
      : ["Not connected — set CANI_PAYPAL_CLIENT_ID / CANI_PAYPAL_CLIENT_SECRET (sandbox) to enable rails"],
    limits: [
      "PayPal cannot read bank statements, mortgage, rent, or daycare — Level 2 CSV + your confirmation stays the source of the books",
      "Personal-account transaction history is not exposed as a general API; Transaction Search targets the connected account's own activity",
    ],
  };
}

export function paypalConfigured(): boolean {
  return Boolean(process.env.CANI_PAYPAL_CLIENT_ID && process.env.CANI_PAYPAL_CLIENT_SECRET);
}

function paypalBase(): string {
  return process.env.CANI_PAYPAL_MODE === "live" ? "https://api-m.paypal.com" : "https://api-m.sandbox.paypal.com";
}

async function accessToken(fetchFn: typeof fetch): Promise<string> {
  const res = await fetchFn(`${paypalBase()}/v1/oauth2/token`, {
    method: "POST",
    headers: {
      authorization: `Basic ${Buffer.from(`${process.env.CANI_PAYPAL_CLIENT_ID}:${process.env.CANI_PAYPAL_CLIENT_SECRET}`).toString("base64")}`,
      "content-type": "application/x-www-form-urlencoded",
    },
    body: "grant_type=client_credentials",
  });
  if (!res.ok) throw new Error(`PayPal auth failed (HTTP ${res.status})`);
  const body = (await res.json()) as { access_token?: unknown };
  if (typeof body.access_token !== "string") throw new Error("PayPal auth returned no token");
  return body.access_token;
}

export type PayPalOrder = { id: string; status: string; approveUrl: string | null };

/** Create an order. Callers must only invoke this AFTER a YES — the whole
 * product is that a NO never reaches this function. */
export async function createPayPalOrder(
  input: { amount: number; label: string },
  fetchFn: typeof fetch = fetch,
): Promise<PayPalOrder> {
  const token = await accessToken(fetchFn);
  const publicUrl = process.env.CANI_PUBLIC_URL ?? "http://127.0.0.1:8787";
  const res = await fetchFn(`${paypalBase()}/v2/checkout/orders`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({
      intent: "CAPTURE",
      purchase_units: [{
        amount: { currency_code: "USD", value: input.amount.toFixed(2) },
        description: input.label.slice(0, 127),
        custom_id: "cani-checkout",
      }],
      application_context: {
        return_url: `${publicUrl}/paypal/return`,
        cancel_url: `${publicUrl}/paypal/cancel`,
        brand_name: "Cani",
        user_action: "PAY_NOW",
      },
    }),
  });
  if (!res.ok) throw new Error(`PayPal order creation failed (HTTP ${res.status})`);
  const body = (await res.json()) as { id?: unknown; status?: unknown; links?: { rel?: unknown; href?: unknown }[] };
  if (typeof body.id !== "string") throw new Error("PayPal order response had no id");
  const approve = Array.isArray(body.links) ? body.links.find((l) => l.rel === "approve") : undefined;
  return {
    id: body.id,
    status: typeof body.status === "string" ? body.status : "CREATED",
    approveUrl: typeof approve?.href === "string" ? approve.href : null,
  };
}

export async function capturePayPalOrder(orderId: string, fetchFn: typeof fetch = fetch): Promise<{ id: string; status: string }> {
  const token = await accessToken(fetchFn);
  const res = await fetchFn(`${paypalBase()}/v2/checkout/orders/${encodeURIComponent(orderId)}/capture`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
  });
  if (!res.ok) throw new Error(`PayPal capture failed (HTTP ${res.status})`);
  const body = (await res.json()) as { id?: unknown; status?: unknown };
  return {
    id: typeof body.id === "string" ? body.id : orderId,
    status: typeof body.status === "string" ? body.status : "UNKNOWN",
  };
}

/** Verify a webhook delivery with PayPal before trusting it. Requires
 * CANI_PAYPAL_WEBHOOK_ID (from the app's Webhooks settings in the PayPal
 * dashboard). Returns null when verification isn't configured — callers
 * must treat the event as unverified, never as proof of payment. */
export async function verifyWebhookSignature(
  headers: Record<string, string | null>,
  rawBody: string,
  fetchFn: typeof fetch = fetch,
): Promise<boolean | null> {
  const webhookId = process.env.CANI_PAYPAL_WEBHOOK_ID;
  if (!webhookId || !paypalConfigured()) return null;
  const token = await accessToken(fetchFn);
  const res = await fetchFn(`${paypalBase()}/v1/notifications/verify-webhook-signature`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({
      transmission_id: headers["paypal-transmission-id"],
      transmission_time: headers["paypal-transmission-time"],
      transmission_sig: headers["paypal-transmission-sig"],
      cert_url: headers["paypal-cert-url"],
      auth_algo: headers["paypal-auth-algo"],
      webhook_id: webhookId,
      webhook_event: JSON.parse(rawBody) as unknown,
    }),
  });
  if (!res.ok) return false;
  const body = (await res.json()) as { verification_status?: unknown };
  return body.verification_status === "SUCCESS";
}
