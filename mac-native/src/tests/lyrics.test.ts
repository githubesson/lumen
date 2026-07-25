import { describe, expect, it } from 'vitest';
import { activeLyricIndex, parseLrc } from '../lib/lyrics';

describe('parseLrc', () => {
  it('parses timestamps into seconds', () => {
    expect(parseLrc('[00:12.50]Hello')).toEqual([{ time: 12.5, text: 'Hello' }]);
    expect(parseLrc('[01:05.00]World')).toEqual([{ time: 65, text: 'World' }]);
  });

  it('expands a line carrying several timestamps', () => {
    // Repeated phrases (a chorus) are written once with multiple tags.
    expect(parseLrc('[00:10.00][01:00.00]Chorus')).toEqual([
      { time: 10, text: 'Chorus' },
      { time: 60, text: 'Chorus' },
    ]);
  });

  it('sorts the result, since multi-tag lines arrive out of order', () => {
    const parsed = parseLrc(['[01:00.00]Second', '[00:30.00]First'].join('\n'));
    expect(parsed.map(l => l.text)).toEqual(['First', 'Second']);
  });

  it('accepts both centisecond and millisecond fractions', () => {
    expect(parseLrc('[00:01.5]a')[0].time).toBeCloseTo(1.5);
    expect(parseLrc('[00:01.250]a')[0].time).toBeCloseTo(1.25);
  });

  it('drops metadata tags and blank lines', () => {
    const parsed = parseLrc(
      ['[ar:Artist]', '[00:01.00]', '[00:02.00]Real line', ''].join('\n'),
    );
    expect(parsed).toEqual([{ time: 2, text: 'Real line' }]);
  });

  it('returns nothing for plain text with no timestamps', () => {
    expect(parseLrc('just some words\nmore words')).toEqual([]);
  });
});

describe('activeLyricIndex', () => {
  const lines = [
    { time: 0, text: 'a' },
    { time: 10, text: 'b' },
    { time: 20, text: 'c' },
  ];

  it('returns -1 before the first line starts', () => {
    expect(activeLyricIndex([{ time: 5, text: 'a' }], 1)).toBe(-1);
  });

  it('holds a line until the next one begins', () => {
    expect(activeLyricIndex(lines, 0)).toBe(0);
    expect(activeLyricIndex(lines, 9.9)).toBe(0);
    expect(activeLyricIndex(lines, 10)).toBe(1);
    expect(activeLyricIndex(lines, 19.9)).toBe(1);
  });

  it('stays on the last line past the end', () => {
    expect(activeLyricIndex(lines, 999)).toBe(2);
  });

  it('handles an empty list', () => {
    expect(activeLyricIndex([], 5)).toBe(-1);
  });
});
