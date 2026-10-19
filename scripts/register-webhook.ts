/**
 * Register Cani's webhook with PayPal for the deployed public URL.
 * Idempotent: if a webhook for the URL already exists, it prints that id.
 *
 * Requires: CANI_PAYPAL_CLIENT_ID / CANI_PAYPAL_CLIENT_SECRET /
 * CANI_PAYPAL_MODE in .env, and CANI_PUBLIC_URL set to the deployed
 * https origin (e.g. https://cani.onrender.com).
 *
 * Run: bun run register-webhook
 * Then put the printed id in the server env as CANI_PAYPAL_WEBHOOK_ID.
 */
const id = process.env.CANI_PAYPAL_CLIENT_ID;
const secret = process.env.CANI_PAYPAL_CLIENT_SECRET;
const publicUrl = process.env.CANI_PUBLIC_URL;
if (!id || !secret) {
  console.error("Missing CANI_PAYPAL_CLIENT_ID / CANI_PAYPAL_CLIENT_SECRET (see .env.example).");
  process.exit(1);
}
if (!publicUrl || !publicUrl.startsWith("https://")) {
  console.error("Set CANI_PUBLIC_URL to the deployed https origin first — PayPal will not call localhost.");
  process.exit(1);
}
const base = process.env.CANI_PAYPAL_MODE === "live" ? "https://api-m.paypal.com" : "https://api-m.sandbox.paypal.com";
const webhookUrl = `${publicUrl.replace(/\/$/, "")}/api/paypal/webhook`;
const EVENT_TYPES = [
  "CHECKOUT.ORDER.APPROVED",
  "CHECKOUT.ORDER.COMPLETED",
  "PAYMENT.CAPTURE.COMPLETED",
  "PAYMENT.CAPTURE.DENIED",
];

const tokenRes = await fetch(`${base}/v1/oauth2/token`, {
  method: "POST",
  headers: {
    authorization: `Basic ${Buffer.from(`${id}:${secret}`).toString("base64")}`,
    "content-type": "application/x-www-form-urlencoded",
  },
  body: "grant_type=client_credentials",
});
if (!tokenRes.ok) {
  console.error(`PayPal auth failed (HTTP ${tokenRes.status}) — run: bun run check-paypal`);
  process.exit(1);
}
const { access_token: token } = (await tokenRes.json()) as { access_token: string };
const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" };

type Webhook = { id: string; url: string };
const listRes = await fetch(`${base}/v1/notifications/webhooks`, { headers });
const listed = (await listRes.json()) as { webhooks?: Webhook[] };
const existing = listed.webhooks?.find((w) => w.url === webhookUrl);
if (existing) {
  console.log(`Webhook already registered: ${webhookUrl}`);
  console.log(`CANI_PAYPAL_WEBHOOK_ID=${existing.id}`);
  process.exit(0);
}

const createRes = await fetch(`${base}/v1/notifications/webhooks`, {
  method: "POST",
  headers,
  body: JSON.stringify({ url: webhookUrl, event_types: EVENT_TYPES.map((name) => ({ name })) }),
});
if (!createRes.ok) {
  console.error(`Webhook creation failed (HTTP ${createRes.status}): ${await createRes.text()}`);
  process.exit(1);
}
const created = (await createRes.json()) as Webhook;
console.log(`Webhook registered: ${webhookUrl}`);
console.log(`Events: ${EVENT_TYPES.join(", ")}`);
console.log(`Now set this in the server environment and redeploy:`);
console.log(`CANI_PAYPAL_WEBHOOK_ID=${created.id}`);
