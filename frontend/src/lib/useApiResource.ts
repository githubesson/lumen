import { useCallback, useEffect, useRef, useState, type DependencyList } from "react";
import { errorMessage } from "../api";

export interface ApiResource<T> {
  data: T | null;
  error: string | null;
  loading: boolean;
  /** Re-run the fetcher (e.g. after a mutation). */
  reload: () => void;
}

// Object deps are identified by insertion order in a WeakMap rather than by
// value, so the key preserves `Object.is` semantics without retaining anything.
const depIds = new WeakMap<object, number>();
let nextDepId = 0;

function depToken(dep: unknown): string {
  if (dep === null) return "null";
  const kind = typeof dep;
  if (kind === "object" || kind === "function") {
    const obj = dep as object;
    let id = depIds.get(obj);
    if (id === undefined) {
      id = ++nextDepId;
      depIds.set(obj, id);
    }
    return `o${id}`;
  }
  if (kind === "undefined") return "undef";
  if (kind === "symbol") return `y${String(dep as symbol)}`;
  return `${kind[0]}${String(dep)}`;
}

/**
 * Collapse a caller-supplied dependency list into one string.
 *
 * The effect below must have a fixed-length dependency array: spreading `deps`
 * into it made React throw "The final argument passed to useEffect changed size
 * between renders" for any caller whose list length varies (e.g. a conditional
 * dep). One string dep is always one element.
 */
function depsKey(deps: DependencyList): string {
  // Length-prefixed rather than separator-joined: a token can contain any
  // character, so ["a","b"] and ["ab"] must not produce the same key.
  return deps.map((dep) => {
    const token = depToken(dep);
    return `${token.length}:${token}`;
  }).join("");
}

/**
 * Fetch a single resource with loading/error state and automatic cancellation.
 * Owns the AbortController and an aborted-guard so a dependency change or
 * unmount can't set state on a stale resolve. Replaces the hand-rolled
 * useState + useEffect + AbortController + ApiError boilerplate that was
 * copy-pasted across the list pages.
 *
 * `deps` are the values that should trigger a refetch (same contract as
 * useEffect's dependency array). `fetcher` and `fallbackMessage` deliberately
 * do not: they are read through refs, so an inline fetcher does not cause a
 * refetch loop, but it is also never a stale closure — the ref is refreshed
 * before the fetch effect re-runs.
 */
export function useApiResource<T>(
  fetcher: (signal: AbortSignal) => Promise<T>,
  deps: DependencyList,
  fallbackMessage = "Something went wrong.",
): ApiResource<T> {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [nonce, setNonce] = useState(0);

  const fetcherRef = useRef(fetcher);
  const fallbackRef = useRef(fallbackMessage);
  // Writing refs during render is illegal under concurrent React and rejected
  // by the React Compiler. Declared before the fetch effect so it commits
  // first on renders where both change.
  useEffect(() => {
    fetcherRef.current = fetcher;
    fallbackRef.current = fallbackMessage;
  }, [fetcher, fallbackMessage]);

  const reload = useCallback(() => setNonce((n) => n + 1), []);

  const key = depsKey(deps);

  useEffect(() => {
    const controller = new AbortController();
    let active = true;
    // A changed resource key begins a new request lifecycle.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setLoading(true);
    setError(null);
    fetcherRef
      .current(controller.signal)
      .then((result) => {
        if (!active) return;
        setData(result);
        setLoading(false);
      })
      .catch((err) => {
        if (!active || controller.signal.aborted) return;
        setError(errorMessage(err, fallbackRef.current));
        setLoading(false);
      });
    return () => {
      active = false;
      controller.abort();
    };
  }, [key, nonce]);

  return { data, error, loading, reload };
}
