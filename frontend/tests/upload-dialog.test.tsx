import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import UploadDialog from "../src/components/UploadDialog";

const mock = vi.hoisted(() => ({ uploadMusic: vi.fn() }));
vi.mock("../../core/src/api", async (original) => ({
  ...(await original<typeof import("../../core/src/api")>()),
  api: mock,
}));

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const MB = 1 << 20;
function file(name: string, size = 1) {
  const f = new File(["x"], name);
  Object.defineProperty(f, "size", { value: size });
  return f;
}

async function pick(files: File[]) {
  render(<UploadDialog open isAdmin={false} onClose={() => {}} />);
  const input = await screen.findByLabelText(/Drop files here/);
  fireEvent.change(input, { target: { files } });
}

it("offers only the formats the server adds, and names the files it leaves out", async () => {
  await pick([file("a.flac"), file("notes.txt"), file("b.aiff")]);
  expect((document.getElementById("upload-files") as HTMLInputElement).accept).toBe(
    ".mp3,.flac,.m4a,.mp4,.ogg,.opus,.wav,.aac,.webm",
  );
  expect(screen.getByText("1 file selected")).toBeTruthy();
  expect(screen.getByText(/2 files left out, not a format the\s+server can add: notes.txt, b.aiff/)).toBeTruthy();
});

it("sends a big selection in batches under the server's cap, and reports a file too big to send", async () => {
  mock.uploadMusic.mockImplementation(async (files: File[]) =>
    files.map((f) => ({ file: f.name, inserted: true })),
  );
  await pick([file("one.flac", 300 * MB), file("two.flac", 300 * MB), file("huge.wav", 600 * MB)]);
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "Upload 3" }));
  });
  expect(mock.uploadMusic.mock.calls.map(([files]) => files.map((f: File) => f.name))).toEqual([
    ["one.flac"],
    ["two.flac"],
  ]);
  expect(mock.uploadMusic.mock.calls[0][1]).toBe("personal");
  expect(screen.getAllByText("Added")).toHaveLength(2);
  expect(screen.getByText("huge.wav")).toBeTruthy();
  expect(screen.getByText("file too large")).toBeTruthy();
});
