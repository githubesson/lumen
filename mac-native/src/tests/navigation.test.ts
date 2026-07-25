import { describe, expect, it } from 'vitest';
import { navReducer } from '../navigation/navigation';

const initial = {
  section: 'home' as const,
  stacks: {
    home: [{ screen: 'home' } as const],
    browse: [{ screen: 'browse' } as const],
    favorites: [{ screen: 'favorites' } as const],
    playlists: [{ screen: 'playlists' } as const],
    settings: [{ screen: 'settings' } as const],
  },
};

describe('navReducer', () => {
  it('switches section without touching any stack', () => {
    const next = navReducer(initial, { type: 'select', section: 'browse' });
    expect(next.section).toBe('browse');
    expect(next.stacks).toEqual(initial.stacks);
  });

  it('pushes onto the active section only', () => {
    const browsing = navReducer(initial, { type: 'select', section: 'browse' });
    const next = navReducer(browsing, {
      type: 'push',
      route: { screen: 'album', id: 'a1' },
    });
    expect(next.stacks.browse).toHaveLength(2);
    expect(next.stacks.home).toHaveLength(1);
  });

  it('restores where you were when returning to a section', () => {
    let state = navReducer(initial, { type: 'select', section: 'browse' });
    state = navReducer(state, { type: 'push', route: { screen: 'album', id: 'a1' } });
    state = navReducer(state, { type: 'select', section: 'home' });
    state = navReducer(state, { type: 'select', section: 'browse' });
    // Leaving and coming back is not a re-select, so the album stays open.
    expect(state.stacks.browse).toHaveLength(2);
    expect(state.stacks.browse[1]).toEqual({ screen: 'album', id: 'a1' });
    expect(state.stacks.home).toHaveLength(1);
  });

  it('pops to root when the active section is re-selected', () => {
    let state = navReducer(initial, { type: 'select', section: 'browse' });
    state = navReducer(state, { type: 'push', route: { screen: 'album', id: 'a1' } });
    state = navReducer(state, { type: 'push', route: { screen: 'artist', id: 'r1' } });
    expect(state.stacks.browse).toHaveLength(3);

    state = navReducer(state, { type: 'select', section: 'browse' });
    expect(state.stacks.browse).toEqual([{ screen: 'browse' }]);
  });

  it('returns the same state when re-selecting a section already at its root', () => {
    const next = navReducer(initial, { type: 'select', section: 'home' });
    expect(next).toBe(initial);
  });

  it('pop removes the top route but never the root', () => {
    let state = navReducer(initial, {
      type: 'push',
      route: { screen: 'album', id: 'a1' },
    });
    state = navReducer(state, { type: 'pop' });
    expect(state.stacks.home).toEqual([{ screen: 'home' }]);

    const atRoot = navReducer(state, { type: 'pop' });
    expect(atRoot).toBe(state);
  });
});
