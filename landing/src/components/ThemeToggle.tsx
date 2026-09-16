import type { JSX } from "solid-js";
import { Button } from "./Button";
import { Icon } from "./Icons";
import { theme, toggleTheme } from "../lib/theme";

export function ThemeToggle(): JSX.Element {
  const label = () =>
    theme() === "dark" ? "Switch to light theme" : "Switch to dark theme";
  return (
    <Button
      variant="ghost"
      iconOnly
      aria-label={label()}
      title={label()}
      onClick={toggleTheme}
    >
      <span class="relative grid size-[18px] place-items-center">
        <Icon
          name="sun"
          class={`icon-swap ${theme() === "dark" ? "icon-swap-on" : ""}`}
        />
        <Icon
          name="moon"
          class={`icon-swap ${theme() === "light" ? "icon-swap-on" : ""}`}
        />
      </span>
    </Button>
  );
}
