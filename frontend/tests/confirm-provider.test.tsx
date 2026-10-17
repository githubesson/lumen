import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { ConfirmProvider, useConfirm, type ConfirmOptions } from "../src/context/Confirm";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const question = (title: string, extra: Partial<ConfirmOptions> = {}): ConfirmOptions => ({
  title,
  message: `About ${title}`,
  confirmLabel: "Go",
  ...extra,
});

/** A button per question; each answer is recorded as "title: true|false". */
function Asker({ questions, answers }: { questions: ConfirmOptions[]; answers: string[] }) {
  const confirm = useConfirm();
  return (
    <>
      {questions.map((options) => (
        <button
          key={options.title}
          type="button"
          onClick={() => void confirm(options).then((yes) => answers.push(`${options.title}: ${yes}`))}
        >
          Ask {options.title}
        </button>
      ))}
    </>
  );
}

function renderAsker(...questions: ConfirmOptions[]) {
  const answers: string[] = [];
  const view = render(
    <ConfirmProvider>
      <Asker questions={questions} answers={answers} />
    </ConfirmProvider>,
  );
  return { answers, ...view };
}

const ask = (title: string) => fireEvent.click(screen.getByRole("button", { name: `Ask ${title}` }));
const closed = () => waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());

it("answers yes or no, and describes what it acts on before what happens", async () => {
  const { answers } = renderAsker(
    question("Delete this playlist?", {
      subject: { art: { cover: null, label: "Mix" }, name: "Mix", detail: "7 tracks" },
    }),
  );

  ask("Delete this playlist?");
  let dialog = await screen.findByRole("alertdialog", { name: "Delete this playlist?" });
  const described = dialog.getAttribute("aria-describedby")!.split(" ").map((id) => document.getElementById(id)?.textContent);
  expect(described).toEqual(["Mix7 tracks", "About Delete this playlist?"]);
  await act(async () => { fireEvent.click(within(dialog).getByRole("button", { name: "Go" })); });
  await closed();

  ask("Delete this playlist?");
  dialog = await screen.findByRole("alertdialog");
  await act(async () => { fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" })); });
  await closed();
  expect(answers).toEqual(["Delete this playlist?: true", "Delete this playlist?: false"]);
});

it("answers an open question no when a newer one replaces it", async () => {
  const { answers } = renderAsker(question("First?"), question("Second?"));

  ask("First?");
  await screen.findByRole("alertdialog", { name: "First?" });
  await act(async () => { ask("Second?"); });
  expect(answers).toEqual(["First?: false"]);

  const dialog = await screen.findByRole("alertdialog", { name: "Second?" });
  await act(async () => { fireEvent.click(within(dialog).getByRole("button", { name: "Go" })); });
  expect(answers).toEqual(["First?: false", "Second?: true"]);
});

it("answers no when the app goes with a question open", async () => {
  const { answers, unmount } = renderAsker(question("Leave?"));
  ask("Leave?");
  await screen.findByRole("alertdialog");
  unmount();
  await act(async () => {});
  expect(answers).toEqual(["Leave?: false"]);
});

it("holds while its action runs, keeps a failure in view, and answers yes once it succeeds", async () => {
  let fail!: (err: unknown) => void;
  const action = vi
    .fn()
    .mockImplementationOnce(() => new Promise((_, reject) => { fail = reject; }))
    .mockResolvedValueOnce(undefined);
  const { answers } = renderAsker(
    question("Remove?", { action, busyLabel: "Removing…", errorFallback: "Remove failed." }),
  );

  ask("Remove?");
  const dialog = await screen.findByRole("alertdialog", { name: "Remove?" });
  await act(async () => { fireEvent.click(within(dialog).getByRole("button", { name: "Go" })); });
  const busy = within(dialog).getByRole("button", { name: "Removing…" }) as HTMLButtonElement;
  expect(busy.disabled).toBe(true);
  expect((within(dialog).getByRole("button", { name: "Cancel" }) as HTMLButtonElement).disabled).toBe(true);

  // Escape and a click outside can't answer it while the action is out.
  fireEvent.keyDown(window, { key: "Escape" });
  fireEvent.click(document.querySelector(".dialog-layer > [aria-hidden='true']")!);
  expect(screen.getByRole("alertdialog")).toBe(dialog);
  expect(answers).toEqual([]);

  await act(async () => { fail(new Error("offline")); });
  expect(within(dialog).getByRole("alert").textContent).toBe("Remove failed.");
  expect(answers).toEqual([]);

  await act(async () => { fireEvent.click(within(dialog).getByRole("button", { name: "Go" })); });
  expect(action).toHaveBeenCalledTimes(2);
  expect(answers).toEqual(["Remove?: true"]);
  await closed();
});
