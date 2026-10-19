import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../src/server";

const dir = mkdtempSync(join(tmpdir(), "cani-webhook-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
delete process.env.CANI_PAYPAL_WEBHOOK_ID;
const app = createApp(dir);

const captureEvent = {
  id: "EVT-1",
  event_type: "PAYMENT.CAPTURE.COMPLETED",
  resource: {
    amount: { value: "42.50", currency_code: "USD" },
    supplementary_data: { related_ids: { order_id: "ORDER-9" } },
  },
};

function post(path: string, body: unknown): Promise<Response> {
  return app.fetch(new Request(`http://cani.test${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  }));
}

describe("PayPal webhook receiver", () => {
  test("a capture lands in the ledger exactly once, however often PayPal retries", async () => {
    const first = (await (await post("/api/paypal/webhook", captureEvent)).json()) as { received: boolean; duplicate?: boolean };
    expect(first.received).toBe(true);
    const before = (await (await app.fetch(new Request("http://cani.test/api/state"))).json()) as { report: { headroom: number } };
    const second = (await (await post("/api/paypal/webhook", captureEvent)).json()) as { duplicate?: boolean };
    expect(second.duplicate).toBe(true);
    const after = (await (await app.fetch(new Request("http://cani.test/api/state"))).json()) as { report: { headroom: number } };
    expect(after.report.headroom).toBe(before.report.headroom);
    expect(before.report.headroom).toBe(1900 - 42.5);
    const events = readFileSync(join(dir, "paypal-events.jsonl"), "utf8").trim().split("\n");
    expect(events.length).toBe(1);
  });

  test("other event types are recorded without touching the ledger", async () => {
    const res = await post("/api/paypal/webhook", { id: "EVT-2", event_type: "CHECKOUT.ORDER.APPROVED", resource: {} });
    expect(res.status).toBe(200);
    const state = (await (await app.fetch(new Request("http://cani.test/api/state"))).json()) as { report: { headroom: number } };
    expect(state.report.headroom).toBe(1900 - 42.5);
  });

  test("a malformed event is refused", async () => {
    expect((await post("/api/paypal/webhook", { nope: true })).status).toBe(400);
  });
});
