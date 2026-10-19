/**
 * Fast PayPal connection check. Reads credentials from .env (Bun loads it
 * automatically) or the shell environment, never prints the secret, and
 * proves the pair with a real OAuth token exchange against PayPal.
 *
 * Run: bun run check-paypal
 * Exit 0 = PayPal accepted the credentials. Exit 1 = not connected.
 */
import { paypalStatus, verifyPayPal } from "../src/paypal";

const id = process.env.CANI_PAYPAL_CLIENT_ID ?? "";
const secret = process.env.CANI_PAYPAL_CLIENT_SECRET ?? "";
const status = paypalStatus();

console.log("Cani · PayPal connection check");
console.log(`  client id : ${id ? `${id.slice(0, 6)}… (${id.length} chars)` : "MISSING"}`);
console.log(`  secret    : ${secret ? `set (${secret.length} chars)` : "MISSING"}`);
console.log(`  mode      : ${status.mode ?? "not configured"} (CANI_PAYPAL_MODE=${process.env.CANI_PAYPAL_MODE ?? "sandbox (default)"})`);

for (const [name, value] of [["CANI_PAYPAL_CLIENT_ID", id], ["CANI_PAYPAL_CLIENT_SECRET", secret]] as const) {
  if (value && value !== value.trim()) console.log(`  ! ${name} has leading/trailing whitespace — re-paste it`);
  if (value && (value.startsWith('"') || value.startsWith("'"))) console.log(`  ! ${name} is wrapped in quotes — remove them in .env`);
}

const verification = await verifyPayPal();
if (verification.verified === true) {
  console.log(`  result    : CONNECTED ✓ — ${verification.detail}`);
  process.exit(0);
}
console.log(`  result    : NOT CONNECTED ✗ — ${verification.detail}`);
console.log("  usual causes: Sandbox/Live tab mismatch, id and secret from different apps, or a bad paste.");
process.exit(1);
