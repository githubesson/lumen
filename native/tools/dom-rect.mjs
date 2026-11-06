import { chromium } from "playwright";
const b = await chromium.launch({ args: ["--font-render-hinting=none"] });
const p = await b.newPage({ viewport: { width: 1280, height: 820 } });
const { mockApi } = await import("../../frontend/tests/ui/mock-api.ts").catch(() => ({}));
await b.close();
