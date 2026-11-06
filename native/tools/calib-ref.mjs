import { chromium } from "playwright";
const b = await chromium.launch({ args: ["--font-render-hinting=none"] });
const p = await b.newPage({ viewport: { width: 700, height: 1500 }, deviceScaleFactor: 1 });
await p.goto("http://localhost:4792/__calib/index.html");
await p.evaluate(() => document.fonts.ready);
await p.waitForTimeout(300);
await p.screenshot({ path: process.argv[2] });
await b.close();
