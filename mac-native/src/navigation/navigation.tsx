import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useReducer,
  type ReactNode,
} from 'react';

/**
 * Sidebar-driven navigation.
 *
 * react-native-screens does not officially support macOS, so there is no
 * react-navigation here. A desktop app needs very little of what a mobile
 * navigator provides anyway: no gestures, no transitions, no header stack —
 * just one push/pop stack per sidebar section, which is what the iOS client
 * already models with a stack per tab.
 */

export type Section = 'home' | 'browse' | 'favorites' | 'playlists' | 'settings';

export const SECTIONS: Section[] = [
  'home',
  'browse',
  'favorites',
  'playlists',
  'settings',
];

export type Route =
  | { screen: 'home' }
  | { screen: 'browse' }
  | { screen: 'favorites' }
  | { screen: 'playlists' }
  | { screen: 'settings' }
  | { screen: 'album'; id: string; title?: string }
  | { screen: 'artist'; id: string; name?: string }
  | { screen: 'playlist'; id: string; name?: string };

const ROOTS: Record<Section, Route> = {
  home: { screen: 'home' },
  browse: { screen: 'browse' },
  favorites: { screen: 'favorites' },
  playlists: { screen: 'playlists' },
  settings: { screen: 'settings' },
};

interface NavState {
  section: Section;
  stacks: Record<Section, Route[]>;
}

type NavAction =
  | { type: 'select'; section: Section }
  | { type: 'push'; route: Route }
  | { type: 'pop' }
  | { type: 'popToRoot' };

const initialState: NavState = {
  section: 'home',
  stacks: {
    home: [ROOTS.home],
    browse: [ROOTS.browse],
    favorites: [ROOTS.favorites],
    playlists: [ROOTS.playlists],
    settings: [ROOTS.settings],
  },
};

export function navReducer(state: NavState, action: NavAction): NavState {
  switch (action.type) {
    case 'select': {
      // Re-selecting the active section pops it to its root, the way clicking
      // the current Finder sidebar item returns you to the top.
      if (action.section === state.section) {
        const stack = state.stacks[action.section];
        if (stack.length === 1) return state;
        return {
          ...state,
          stacks: { ...state.stacks, [action.section]: [stack[0]] },
        };
      }
      return { ...state, section: action.section };
    }
    case 'push': {
      const stack = state.stacks[state.section];
      return {
        ...state,
        stacks: { ...state.stacks, [state.section]: [...stack, action.route] },
      };
    }
    case 'pop': {
      const stack = state.stacks[state.section];
      if (stack.length === 1) return state;
      return {
        ...state,
        stacks: { ...state.stacks, [state.section]: stack.slice(0, -1) },
      };
    }
    case 'popToRoot': {
      const stack = state.stacks[state.section];
      if (stack.length === 1) return state;
      return {
        ...state,
        stacks: { ...state.stacks, [state.section]: [stack[0]] },
      };
    }
  }
}

interface NavContextValue {
  section: Section;
  route: Route;
  canGoBack: boolean;
  selectSection: (section: Section) => void;
  push: (route: Route) => void;
  pop: () => void;
  popToRoot: () => void;
}

const Ctx = createContext<NavContextValue | null>(null);

export function NavigationProvider({ children }: { children: ReactNode }) {
  const [state, dispatch] = useReducer(navReducer, initialState);

  const selectSection = useCallback(
    (section: Section) => dispatch({ type: 'select', section }),
    [],
  );
  const push = useCallback((route: Route) => dispatch({ type: 'push', route }), []);
  const pop = useCallback(() => dispatch({ type: 'pop' }), []);
  const popToRoot = useCallback(() => dispatch({ type: 'popToRoot' }), []);

  const stack = state.stacks[state.section];
  const route = stack[stack.length - 1];

  const value = useMemo<NavContextValue>(
    () => ({
      section: state.section,
      route,
      canGoBack: stack.length > 1,
      selectSection,
      push,
      pop,
      popToRoot,
    }),
    [state.section, route, stack.length, selectSection, push, pop, popToRoot],
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useNavigation(): NavContextValue {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error('useNavigation requires NavigationProvider');
  return ctx;
}
