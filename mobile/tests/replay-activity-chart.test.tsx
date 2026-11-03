import { type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it, vi } from "vitest";
import { ActivityChart } from "../components/replay/activity-chart";

const ACCENT = "#0a84ff";

vi.mock("react-native", () => ({
  Text: ({ children }: { children: ReactNode }) => <span>{children}</span>,
  View: ({
    children,
    style,
  }: {
    children?: ReactNode;
    style?: { backgroundColor?: string; height?: string };
  }) => (
    <div data-bg={style?.backgroundColor} data-h={style?.height}>
      {children}
    </div>
  ),
}));
vi.mock("../components/primitives", () => ({
  Card: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));
vi.mock("../theme/theme", () => ({
  useTheme: () => ({ color: { accent: ACCENT, fgMuted: "#8e8e93" } }),
  withAlpha: (color: string) => `${color}-faint`,
}));

const bucket = (day: number, plays: number) => ({
  bucket_start: `2026-10-${String(day).padStart(2, "0")}T00:00:00Z`,
  plays,
});
const render = (plays: number[]) =>
  renderToStaticMarkup(
    <ActivityChart buckets={plays.map((n, i) => bucket(i + 1, n))} bucket="day" />,
  );
const count = (html: string, needle: string) => html.split(needle).length - 1;

it("lights only the busiest bucket", () => {
  const html = render([3, 12, 5]);
  expect(count(html, `data-bg="${ACCENT}"`)).toBe(1);
  expect(html).toContain(`data-bg="${ACCENT}" data-h="100%"`);
  expect(count(html, 'data-bg="#8e8e93-faint"')).toBe(2);
});

it("lights every bucket tied for busiest", () => {
  expect(count(render([7, 2, 7]), `data-bg="${ACCENT}"`)).toBe(2);
});

it("lights nothing when nothing was played", () => {
  expect(count(render([0, 0]), `data-bg="${ACCENT}"`)).toBe(0);
});
