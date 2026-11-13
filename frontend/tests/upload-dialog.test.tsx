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
  const input = await screen.findByLabelText(/Drop files or folders here/);
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

it("keeps what earlier batches added when a later one fails", async () => {
  mock.uploadMusic
    .mockImplementationOnce(async (files: File[]) => files.map((f) => ({ file: f.name, inserted: true })))
    .mockRejectedValueOnce(new Error("offline"));
  await pick([file("one.flac", 300 * MB), file("two.flac", 300 * MB)]);
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "Upload 2" }));
  });
  expect(screen.getAllByText("Added")).toHaveLength(1);
  expect(screen.getByText("two.flac")).toBeTruthy();
  expect(screen.getAllByText("Upload failed.").length).toBeGreaterThan(0);
});

it("keeps the selection to try again when the first batch fails", async () => {
  mock.uploadMusic.mockRejectedValueOnce(new Error("offline"));
  await pick([file("one.flac")]);
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "Upload 1" }));
  });
  expect(screen.getByText("Upload failed.")).toBeTruthy();
  expect(screen.getByRole("button", { name: "Upload 1" })).toBeTruthy();
});

it("adds a picked folder to picked files, shows paths, and skips repeats", async () => {
  await pick([file("single.mp3")]);
  const inFolder = (path: string) => {
    const f = file(path.split("/").pop()!);
    Object.defineProperty(f, "webkitRelativePath", { value: path });
    return f;
  };
  const folder = screen.getByLabelText("Choose a folder") as HTMLInputElement;
  expect(folder.hasAttribute("webkitdirectory")).toBe(true);
  const track = inFolder("Album/01.flac");
  fireEvent.change(folder, { target: { files: [track, inFolder("Album/cover.jpg")] } });
  fireEvent.change(folder, { target: { files: [track] } });
  expect(screen.getByText("2 files selected")).toBeTruthy();
  expect(screen.getByText("Album/01.flac")).toBeTruthy();
  expect(screen.getByText(/left out.*Album\/cover.jpg/)).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Clear" }));
  expect(screen.queryByText(/selected/)).toBeNull();
});

it("walks a dropped folder, nested ones included", async () => {
  render(<UploadDialog open isAdmin={false} onClose={() => {}} />);
  await screen.findByLabelText(/Drop files or folders here/);
  const fileEntry = (name: string, fullPath: string) => ({
    isFile: true, isDirectory: false, name, fullPath,
    file: (ok: (f: File) => void) => ok(file(name)),
  });
  const dirEntry = (fullPath: string, children: unknown[]) => ({
    isFile: false, isDirectory: true, fullPath,
    createReader: () => {
      let pages = [children, []];
      return { readEntries: (ok: (e: unknown[]) => void) => { ok(pages[0]); pages = pages.slice(1); } };
    },
  });
  const root = dirEntry("/Mix", [
    fileEntry("a.mp3", "/Mix/a.mp3"),
    dirEntry("/Mix/Disc 2", [fileEntry("b.opus", "/Mix/Disc 2/b.opus")]),
  ]);
  await act(async () => {
    fireEvent.drop(document.querySelector(".fixed")!, {
      dataTransfer: { items: [{ kind: "file", webkitGetAsEntry: () => root }], files: [] },
    });
  });
  expect(await screen.findByText("2 files selected")).toBeTruthy();
  expect(screen.getByText("Mix/Disc 2/b.opus")).toBeTruthy();
});

it("explains a proxy's 413 instead of showing its HTML page", async () => {
  const { ApiError } = await import("../../core/src/api-transport");
  mock.uploadMusic.mockRejectedValueOnce(new ApiError(413, "<html><title>413 Payload Too Large</title></html>"));
  await pick([file("one.flac", 1 * MB)]);
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "Upload 1" }));
  });
  expect(screen.getByText(/proxy in front of it, like Cloudflare/)).toBeTruthy();
  expect(screen.queryByText(/<html>/)).toBeNull();
});

it("applies details typed before uploading to what the upload adds", async () => {
  mock.uploadMusic.mockImplementation(async (files: File[]) =>
    files.map((f, i) => ({ file: f.name, inserted: true, track_id: `t${i}` })),
  );
  (mock as Record<string, unknown>).updateTrack = vi.fn(async (id: string) => ({ id, album_id: "al" }));
  await pick([file("Zhnoi - 01 cute girls.flac")]);
  fireEvent.click(screen.getByRole("switch"));
  fireEvent.change(screen.getByLabelText("Title for Zhnoi - 01 cute girls.flac"), { target: { value: "cute girls doing cute things" } });
  fireEvent.change(screen.getByLabelText("Artists for Zhnoi - 01 cute girls.flac"), { target: { value: "Zhnoi" } });
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "Upload 1" }));
  });
  expect((mock as unknown as { updateTrack: ReturnType<typeof vi.fn> }).updateTrack).toHaveBeenCalledWith("t0", {
    title: "cute girls doing cute things",
    artists: ["Zhnoi"],
  }, { signal: expect.any(AbortSignal) });
  expect(screen.getByText("Added")).toBeTruthy();
});

it("cancels mid-upload: stops sending and removes what earlier requests added", async () => {
  const m = mock as unknown as Record<string, ReturnType<typeof vi.fn>>;
  m.deleteTrack = vi.fn(async () => {});
  m.deleteGlobalTrack = vi.fn(async () => {});
  mock.uploadMusic
    .mockImplementationOnce(async (files: File[]) => files.map((f, i) => ({ file: f.name, inserted: true, track_id: `t${i}` })))
    .mockImplementationOnce((_files: File[], _scope: string, { signal }: { signal: AbortSignal }) =>
      new Promise((_, reject) => signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")))),
    );
  await pick([file("one.flac", 60 * MB), file("two.flac", 60 * MB), file("three.flac", 60 * MB)]);
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "Upload 3" }));
  });
  // The first request is done and the second is in flight; Cancel works now.
  const cancelButton = screen.getByRole("button", { name: "Cancel upload" });
  expect((cancelButton as HTMLButtonElement).disabled).toBe(false);
  await act(async () => {
    fireEvent.click(cancelButton);
  });
  expect(m.deleteTrack).toHaveBeenCalledWith("t0");
  expect(mock.uploadMusic).toHaveBeenCalledTimes(2); // the third file never went
  expect(screen.getByText(/Upload cancelled\. Removed the 1 track it had already added\./)).toBeTruthy();
  expect(screen.getByRole("button", { name: "Upload 3" })).toBeTruthy(); // selection kept for a retry
});

it("keeps uploading through Escape and the close button, and a cancel leaves a promoted track", async () => {
  const m = mock as unknown as Record<string, ReturnType<typeof vi.fn>>;
  m.deleteTrack = vi.fn(async () => {});
  m.deleteGlobalTrack = vi.fn(async () => {});
  const onClose = vi.fn();
  mock.uploadMusic
    // The shared upload took over someone's personal copy: inserted, but not new.
    .mockImplementationOnce(async (files: File[]) => files.map((f) => ({ file: f.name, inserted: true, promoted: true, track_id: "t-theirs" })))
    .mockImplementationOnce((_files: File[], _scope: string, { signal }: { signal: AbortSignal }) =>
      new Promise((_, reject) => signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")))),
    );
  render(<UploadDialog open isAdmin onClose={onClose} />);
  fireEvent.change(await screen.findByLabelText(/Drop files or folders here/), {
    target: { files: [file("one.flac", 60 * MB), file("two.flac", 60 * MB)] },
  });
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "Upload 2" }));
  });
  const dialog = screen.getByRole("dialog");
  const close = screen.getByRole("button", { name: "Close" }) as HTMLButtonElement;
  expect(close.disabled).toBe(true);
  screen.getByRole("button", { name: "Cancel upload" }).focus();
  await act(async () => {
    fireEvent.keyDown(document.activeElement!, { key: "Escape" });
    fireEvent.click(close);
  });
  expect(onClose).not.toHaveBeenCalled();
  expect(dialog.isConnected).toBe(true);
  // Still going: the second request was never aborted.
  expect(screen.getByRole("button", { name: "Cancel upload" })).toBeTruthy();

  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "Cancel upload" }));
  });
  expect(m.deleteTrack).not.toHaveBeenCalled();
  expect(m.deleteGlobalTrack).not.toHaveBeenCalled();
  expect(screen.getByText("Upload cancelled. Nothing was added.")).toBeTruthy();
});
