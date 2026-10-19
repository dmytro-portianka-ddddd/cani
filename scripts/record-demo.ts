/**
 * Records the Cani demo as a real browser video (Playwright recordVideo).
 * Tight 3-min-script cut: the flip, the hard NO, the essential lane, the
 * shame bypass, the closing line. Run: bun run demo:video
 * Output: demo-video/cani-demo.webm
 */
import { chromium } from "@playwright/test";
import { mkdtempSync, renameSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../src/server";

const app = createApp(mkdtempSync(join(tmpdir(), "cani-demo-")));
const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: app.fetch });
const base = `http://127.0.0.1:${server.port}`;
console.log(`recording against ${base}`);

const browser = await chromium.launch();
const context = await browser.newContext({
  viewport: { width: 420, height: 900 },
  recordVideo: { dir: "demo-video", size: { width: 420, height: 900 } },
});
const page = await context.newPage();
const tid = (id: string) => page.getByTestId(id);
const pause = (ms = 1100) => page.waitForTimeout(ms);

async function caption(text: string): Promise<void> {
  await page.evaluate((t) => {
    let el = document.getElementById("demo-caption");
    if (!el) {
      el = document.createElement("div");
      el.id = "demo-caption";
      el.style.cssText = "position:fixed;left:10px;right:10px;bottom:12px;z-index:99;background:#111;color:#ffd21f;font:700 15px Arial;padding:12px 14px;border:3px solid #ffd21f;box-shadow:5px 5px 0 #111";
      document.body.appendChild(el);
    }
    el.textContent = t;
  }, text);
  await pause(2800);
}

// --- The flip -------------------------------------------------------------
await page.goto(base);
await caption("You're not Eminem, and you don't have a manager. Now you do.");
await caption("This is Cani — you don't check it on Sunday. You ask it at the register.");
await pause(500);

// --- The NO ---------------------------------------------------------------
await tid("ask-label").fill("Aeron Deck");
await tid("ask-amount").fill("2800");
await tid("ask-submit").click();
await pause(3200);
await caption("Can I buy a $2,800 deck? NO. Short nine hundred — in bars, with reasons. And no button to argue with.");

// --- The essential lane ---------------------------------------------------
await tid("ask-label").fill("Insulin");
await tid("ask-merchant").fill("CVS Pharmacy");
await tid("ask-items").fill("");
await tid("ask-amount").fill("120");
await tid("ask-submit").click();
await pause(1600);
await caption("But insulin at CVS? YES — instantly. Essentials ride free. Treats don't.");

// --- The shame bypass -----------------------------------------------------
await tid("ask-label").fill("Aeron Deck");
await tid("ask-merchant").fill("");
await tid("ask-amount").fill("2800");
await tid("ask-submit").click();
await pause(1400);
await caption("Ask the same thing twice, though, and the manager steps aside — for a price.");
await tid("shame-bypass").click();
await pause(1800);
await caption("The bypass is yours, not the math's. Shame +1 — and the original NO stays in the audit trail forever.");

// --- Closing --------------------------------------------------------------
await page.evaluate(() => window.scrollTo({ top: 0, behavior: "smooth" }));
await caption("A budget app would show you a chart about last month.");
await caption("This isn't a budget. It's a manager.");

const video = page.video();
await context.close();
await browser.close();
server.stop(true);
if (video) {
  const path = await video.path();
  renameSync(path, join("demo-video", "cani-demo.webm"));
  console.log("video saved: demo-video/cani-demo.webm");
}
