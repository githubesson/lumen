import { test } from "playwright/test";
import { tracks } from "./fixtures";
import { checkUI, ready, signedOut } from "./helpers";

test.beforeEach(async ({ page }) => {
  await signedOut(page);
});

test("login", async ({ page }, testInfo) => {
  await page.goto("/login");
  await ready(page, page.getByRole("heading", { name: "Sign in" }));
  await checkUI(page, testInfo);
});

test("register", async ({ page }, testInfo) => {
  await page.goto("/register?token=lmn_7QxV2pKc9RfT4wZb");
  await ready(page, page.getByRole("heading", { name: "Create account" }));
  await checkUI(page, testInfo);
});

test("shared track", async ({ page }, testInfo) => {
  const track = tracks.find((t) => t.id === "t-al-lanterns-3")!;
  await page.goto(`/shared/track/${track.id}?t=42&d=30&sig=4b1d9e`);
  await ready(page, page.getByRole("heading", { name: track.title }));
  await checkUI(page, testInfo);
});
