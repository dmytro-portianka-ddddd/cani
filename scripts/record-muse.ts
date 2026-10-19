/**
 * Records the faked Muse session (demo-video/muse-mockup.html) as a video.
 * The mockup auto-animates a scripted conversation where Muse calls the
 * Cani MCP tools: cani.ask → NO, checkout.attempt → declined (no order),
 * checkout.attempt → real sandbox order. Run: bun run demo:muse
 * Output: demo-video/muse-session.webm
 */
import { chromium } from "@playwright/test";
import { renameSync } from "node:fs";
import { join } from "node:path";

const browser = await chromium.launch();
const context = await browser.newContext({
  viewport: { width: 440, height: 920 },
  recordVideo: { dir: "demo-video", size: { width: 440, height: 920 } },
});
const page = await context.newPage();
await page.goto("file://" + join(process.cwd(), "demo-video", "muse-mockup.html"));
await page.waitForTimeout(34000); // full scripted conversation + settle

const video = page.video();
await context.close();
await browser.close();
if (video) {
  const path = await video.path();
  renameSync(path, join("demo-video", "muse-session.webm"));
  console.log("video saved: demo-video/muse-session.webm");
}
