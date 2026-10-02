import { useCallback, useState } from "react";

export interface EditDraft<S, F> {
  /** What the draft was filled from. Diff the draft against this to save. */
  base: S;
  draft: F;
  /** Change one field. The first change pins `base` and the draft. */
  setField: <K extends keyof F>(key: K, value: F[K]) => void;
}

/**
 * Form state for editing loaded data that a refetch can replace while the
 * form is open, such as a track first shown from the persisted cache.
 *
 * A save has to diff against what the form was filled from, not the live
 * query: against newer data, every field the user left alone would count as
 * a change back to the older value the form showed. Until the first edit, a
 * new `source` refills the draft, so fresher values show and nothing typed is
 * lost; after that both stay put.
 *
 * Remount with a `key` to start over for a different item.
 */
export function useEditDraft<S, F extends object>(
  source: S,
  toForm: (source: S) => F,
): EditDraft<S, F> {
  const [base, setBase] = useState(source);
  const [draft, setDraft] = useState(() => toForm(source));
  const [edited, setEdited] = useState(false);
  if (!edited && source !== base) {
    // Adjusted during render, so no commit shows the older draft.
    setBase(source);
    setDraft(toForm(source));
  }
  const setField = useCallback(<K extends keyof F>(key: K, value: F[K]) => {
    setEdited(true);
    setDraft((current) => ({ ...current, [key]: value }));
  }, []);
  return { base, draft, setField };
}
