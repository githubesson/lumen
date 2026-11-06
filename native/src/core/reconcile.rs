//! The web's `lib/reconcileItems.ts`: keep unchanged rows of a refetched
//! list as they were, so a page can tell nothing changed. Rust has no
//! reference identity to keep, so this answers what React used it for:
//! whether anything changed at all.

/// The refetched list, and whether it differs from the previous one (by
/// value, in order).
pub fn reconcile_items<T: PartialEq>(previous: Vec<T>, next: Vec<T>) -> (Vec<T>, bool) {
    if previous == next { (previous, false) } else { (next, true) }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn says_whether_anything_changed() {
        assert_eq!(reconcile_items(vec![1, 2], vec![1, 2]), (vec![1, 2], false));
        assert_eq!(reconcile_items(vec![1, 2], vec![2, 1]), (vec![2, 1], true));
    }
}
