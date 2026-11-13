/**
 * Every file in a drop, folders walked recursively. `dataTransfer.files`
 * alone lists a dropped folder as one unreadable entry, so walk the entries.
 */
export async function filesFromDrop(dt: DataTransfer): Promise<File[]> {
  const entries = Array.from(dt.items ?? [])
    .map((item) => (item.kind === "file" ? item.webkitGetAsEntry?.() : null))
    .filter((entry): entry is FileSystemEntry => !!entry);
  // No entry API (or nothing it could read): what the browser listed.
  if (entries.length === 0) return Array.from(dt.files);
  const nested = await Promise.all(entries.map(walk));
  return nested.flat();
}

async function walk(entry: FileSystemEntry): Promise<File[]> {
  if (entry.isFile) {
    return new Promise((resolve) =>
      (entry as FileSystemFileEntry).file(
        (file) => resolve([withPath(file, entry.fullPath)]),
        () => resolve([]), // unreadable (permissions, vanished): skip it
      ),
    );
  }
  if (!entry.isDirectory) return [];
  const reader = (entry as FileSystemDirectoryEntry).createReader();
  const children: FileSystemEntry[] = [];
  // readEntries hands back a page at a time (100 in Chromium) until empty.
  for (;;) {
    const page = await new Promise<FileSystemEntry[]>((resolve) => reader.readEntries(resolve, () => resolve([])));
    if (page.length === 0) break;
    children.push(...page);
  }
  const nested = await Promise.all(children.map(walk));
  return nested.flat();
}

/** Keep where in the dropped folder a file came from, as a folder pick does. */
function withPath(file: File, fullPath: string): File {
  const relative = fullPath.replace(/^\//, "");
  if (relative && relative !== file.name && !file.webkitRelativePath) {
    Object.defineProperty(file, "webkitRelativePath", { value: relative });
  }
  return file;
}

/** A file's place in its picked or dropped folder, else its name. */
export function displayPath(file: File): string {
  return file.webkitRelativePath || file.name;
}

/** Add `more` to `current`, leaving out files already there. */
export function mergeFiles(current: File[], more: File[]): File[] {
  const key = (f: File) => `${displayPath(f)}\u0000${f.size}\u0000${f.lastModified}`;
  const seen = new Set(current.map(key));
  const out = [...current];
  for (const file of more) {
    const k = key(file);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(file);
  }
  return out;
}
