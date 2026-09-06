export interface SyncedLine {
  time: number;
  text: string;
  section: boolean;
}

export interface PlainLine {
  text: string;
  section: boolean;
}

export function parseSyncedLyrics(text?: string | null): SyncedLine[] {
  if (!text) return [];
  const lines: SyncedLine[] = [];
  for (const rawLine of text.split("\n")) {
    const lyricText = rawLine
      .replace(/\[\d{1,3}:\d{2}(?:\.\d{1,3})?\]/g, "")
      .trim();
    for (const stamp of rawLine.matchAll(
      /\[(\d{1,3}):(\d{2})(?:\.(\d{1,3}))?\]/g,
    )) {
      const time =
        Number(stamp[1]) * 60 +
        Number(stamp[2]) +
        Number(`0.${(stamp[3] ?? "0").padEnd(3, "0")}`);
      if (Number.isFinite(time) && lyricText) {
        lines.push({
          time,
          text: lyricText,
          section: /^\[[^\]]+\]$/.test(lyricText),
        });
      }
    }
  }
  return lines.sort((a, b) => a.time - b.time);
}

export function parsePlainLyrics(text?: string | null): PlainLine[] {
  if (!text) return [];
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => ({ text: line, section: /^\[[^\]]+\]$/.test(line) }));
}

export function activeLineIndex(
  lines: SyncedLine[],
  currentTime: number,
): number {
  let active = -1;
  for (let index = 0; index < lines.length; index += 1) {
    if (lines[index]!.time > currentTime) break;
    active = index;
  }
  return active;
}

export function activeWordIndexForLine(
  line: SyncedLine,
  next: SyncedLine | undefined,
  currentTime: number,
  duration: number,
): number | null {
  const words = line.text.trim().split(/\s+/).filter(Boolean);
  if (!words.length) return null;
  const estimatedTail = Math.min(
    8,
    Math.max(1.2, line.text.replace(/\s+/g, "").length * 0.085),
  );
  const end = next
    ? Math.max(next.time, line.time + 0.2)
    : Math.max(Math.min(duration, line.time + estimatedTail), line.time + 0.2);
  const lineDuration = Math.max(0.2, end - line.time);
  const elapsed = Math.min(lineDuration, Math.max(0, currentTime - line.time));
  const weights = words.map((word) =>
    Math.max(1, word.replace(/[^\p{L}\p{N}]/gu, "").length || word.length),
  );
  const totalWeight = Math.max(
    1,
    weights.reduce((sum, value) => sum + value, 0),
  );
  const minSlice = Math.min(0.14, lineDuration / words.length);
  const distributableDuration = Math.max(
    0,
    lineDuration - minSlice * words.length,
  );
  let cumulative = 0;
  for (let index = 0; index < words.length; index += 1) {
    cumulative +=
      minSlice + (weights[index]! / totalWeight) * distributableDuration;
    if (elapsed <= cumulative || index === words.length - 1) return index;
  }
  return words.length - 1;
}
