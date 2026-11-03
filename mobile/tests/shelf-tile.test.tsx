import { type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, expect, it, vi } from "vitest";
import { ShelfTile } from "../components/shelf-tile";

interface PressableProps {
  accessibilityLabel?: string;
  accessibilityRole?: string;
  disabled?: boolean;
  onPress?: () => void;
  style: (state: { pressed: boolean }) => { opacity: number }[];
}

const mock = vi.hoisted(() => ({ pressable: undefined as PressableProps | undefined }));

vi.mock("react-native", () => ({
  Pressable: ({ children, ...props }: PressableProps & { children: ReactNode }) => {
    mock.pressable = props;
    return <button>{children}</button>;
  },
  Text: ({ children }: { children: ReactNode }) => <span>{children}</span>,
  View: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));
vi.mock("../theme/theme", () => ({
  useTheme: () => ({ color: { fg: "#fff", fgMuted: "#888" } }),
}));

const render = (onPress?: () => void) => {
  renderToStaticMarkup(
    <ShelfTile
      artwork={null}
      title="Clayco"
      width={128}
      accessibilityLabel="Clayco"
      onPress={onPress}
    />,
  );
  if (!mock.pressable) throw new Error("no pressable");
  return mock.pressable;
};

beforeEach(() => {
  mock.pressable = undefined;
});

it("is a button with press feedback when it does something", () => {
  const tile = render(vi.fn());
  expect(tile.accessibilityRole).toBe("button");
  expect(tile.style({ pressed: true })[0].opacity).toBe(0.7);
});

it("is plain, not dimmed for VoiceOver, when it has nothing to do", () => {
  const tile = render();
  expect(tile.accessibilityRole).toBeUndefined();
  expect(tile.disabled).toBeUndefined();
  expect(tile.accessibilityLabel).toBe("Clayco");
  expect(tile.style({ pressed: true })[0].opacity).toBe(1);
});
