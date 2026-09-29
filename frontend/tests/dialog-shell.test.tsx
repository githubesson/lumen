import { useState } from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { DialogShell } from "../src/components/DialogShell";

// jsdom lays nothing out, so every element reports no client rects and the
// Tab trap would treat all controls as hidden.
beforeEach(() => {
  vi.spyOn(HTMLElement.prototype, "getClientRects").mockReturnValue([
    {} as DOMRect,
  ] as unknown as DOMRectList);
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function Harness({ nested = false }: { nested?: boolean }) {
  const [open, setOpen] = useState(false);
  const [innerOpen, setInnerOpen] = useState(false);
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>
        Open
      </button>
      <DialogShell open={open} title="Outer" onClose={() => setOpen(false)}>
        <div>
          <button type="button">First</button>
          <button type="button" onClick={() => setInnerOpen(true)}>
            Last
          </button>
          {/* Tab skips it, so it mustn't count as the end of the cycle. */}
          <button type="button" tabIndex={-1}>
            Skipped
          </button>
        </div>
      </DialogShell>
      {nested && (
        <DialogShell open={innerOpen} title="Inner" onClose={() => setInnerOpen(false)}>
          <div>
            <button type="button">Inner button</button>
          </div>
        </DialogShell>
      )}
    </>
  );
}

it("takes focus on open, keeps Tab inside, and hands focus back on Escape", async () => {
  render(<Harness />);
  const opener = screen.getByRole("button", { name: "Open" });
  opener.focus();
  fireEvent.click(opener);

  const dialog = await screen.findByRole("dialog");
  await waitFor(() => expect(dialog.contains(document.activeElement)).toBe(true));

  // Tab from the last control wraps to the first (the header's close button).
  screen.getByRole("button", { name: "Last" }).focus();
  fireEvent.keyDown(document.activeElement!, { key: "Tab" });
  expect(document.activeElement).toBe(screen.getByRole("button", { name: "Close" }));

  fireEvent.keyDown(document.activeElement!, { key: "Escape" });
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  expect(document.activeElement).toBe(opener);
});

it("closes only the innermost dialog on Escape", async () => {
  render(<Harness nested />);
  fireEvent.click(screen.getByRole("button", { name: "Open" }));
  await screen.findByRole("dialog");
  const last = screen.getByRole("button", { name: "Last" });
  last.focus();
  fireEvent.click(last);
  await waitFor(() => expect(screen.getAllByRole("dialog")).toHaveLength(2));
  await waitFor(() =>
    expect(document.activeElement?.closest('[role="dialog"]')).toBe(
      screen.getAllByRole("dialog")[1],
    ),
  );

  fireEvent.keyDown(document.activeElement!, { key: "Escape" });
  await waitFor(() => expect(screen.getAllByRole("dialog")).toHaveLength(1));
  expect(screen.getByRole("dialog")).toHaveProperty("textContent", expect.stringContaining("Outer"));
  // Focus goes back to the control in the outer dialog that opened the inner one.
  expect(document.activeElement).toBe(last);
});
