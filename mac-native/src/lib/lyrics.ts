export interface LyricLine {
  /** Seconds from the start of the track. */
  time: number;
  text: string;
}

/**
 * Parse LRC lyrics into timed lines.
 *
 * The format allows several timestamps on one line when a phrase repeats
 * (`[00:12.00][01:04.50] chorus`), so each tag emits its own entry. Lines
 * without a tag are metadata (`[ar: …]`) or blank and are dropped, and the
 * result is sorted because multi-tag lines arrive out of order.
 */
export function parseLrc(lrc: string): LyricLine[] {
  const lines: LyricLine[] = [];
  const tag = /\[(\d{1,3}):(\d{2})(?:[.:](\d{1,3}))?\]/g;

  for (const raw of lrc.split(/\r?\n/)) {
    tag.lastIndex = 0;
    const stamps: number[] = [];
    let match: RegExpExecArray | null;
    while ((match = tag.exec(raw)) !== null) {
      const minutes = Number(match[1]);
      const seconds = Number(match[2]);
      // Fractions may be centiseconds or milliseconds depending on the source.
      const fraction = match[3] ? Number(match[3].padEnd(3, '0')) / 1000 : 0;
      stamps.push(minutes * 60 + seconds + fraction);
    }
    if (stamps.length === 0) continue;

    const text = raw.replace(tag, '').trim();
    if (text.length === 0) continue;
    for (const time of stamps) lines.push({ time, text });
  }

  return lines.sort((a, b) => a.time - b.time);
}

/**
 * Index of the line that should be highlighted at `seconds`, or -1 before the
 * first line. Assumes `lines` is sorted.
 */
export function activeLyricIndex(lines: LyricLine[], seconds: number): number {
  if (lines.length === 0) return -1;
  let low = 0;
  let high = lines.length - 1;
  let found = -1;
  while (low <= high) {
    const mid = (low + high) >> 1;
    if (lines[mid].time <= seconds) {
      found = mid;
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }
  return found;
}
