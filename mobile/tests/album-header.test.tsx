import React, { type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it, vi } from "vitest";
import { AlbumHeader } from "../components/album-header";

vi.mock("react-native", () => ({
  View: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  Text: ({ children }: { children?: ReactNode }) => <span>{children}</span>,
  Pressable: ({
    children,
    disabled,
    style,
  }: {
    children?: ReactNode;
    disabled?: boolean;
    style: (state: { pressed: boolean }) => { opacity: number };
  }) => (
    <button disabled={disabled} data-opacity={style({ pressed: false }).opacity}>
      {children}
    </button>
  ),
}));
vi.mock("expo-image", () => ({ Image: () => null }));
vi.mock("expo-symbols", () => ({ SymbolView: () => null }));
vi.mock("expo-haptics", () => ({
  impactAsync: vi.fn(),
  selectionAsync: vi.fn(),
  ImpactFeedbackStyle: { Medium: "medium" },
}));
vi.mock("../theme/theme", () => ({
  useTheme: () => ({
    space: { sm: 8, md: 16, lg: 24, xl: 32 },
    radius: { md: 12, lg: 16 },
    color: {},
  }),
}));

const render = (pending?: boolean) =>
  renderToStaticMarkup(
    <AlbumHeader
      title="Powiedz To"
      coverUri={null}
      metadata="1 track"
      onPlay={() => {}}
      secondaryAction={{ label: "Download album", onPress: () => {} }}
      versions={<nav>Explicit | Clean</nav>}
      pending={pending}
    />,
  );

it("puts the version switcher above Play", () => {
  const html = render();
  expect(html.indexOf("Explicit | Clean")).toBeLessThan(html.indexOf("Play"));
  expect(html).not.toContain("disabled");
});

it("disables Play and the album download while another version loads", () => {
  const html = render(true);
  expect(html.match(/<button disabled="" data-opacity="0.5">/g)).toHaveLength(2);
});
