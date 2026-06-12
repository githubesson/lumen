package library

import "testing"

// TestTrackVisiblePredicateConsts locks the exact text of the viewer-visibility
// predicate. These consts are concatenated into ~25 queries; if the text drifts
// (or is accidentally rewritten by a bulk edit), every one of those queries
// silently changes, which for this predicate means a potential cross-user
// privacy leak. Pin the value here so such a change fails the build.
func TestTrackVisiblePredicateConsts(t *testing.T) {
	if trackVisibleP1 != "(t.owner_id IS NULL OR t.owner_id = $1)" {
		t.Fatalf("trackVisibleP1 drifted: %q", trackVisibleP1)
	}
	if trackVisibleP2 != "(t.owner_id IS NULL OR t.owner_id = $2)" {
		t.Fatalf("trackVisibleP2 drifted: %q", trackVisibleP2)
	}
}

func TestClampListPage(t *testing.T) {
	if l, o := clampListPage(0, 5, 60); l != 60 || o != 5 {
		t.Fatalf("default not applied: got limit=%d offset=%d", l, o)
	}
	if l, _ := clampListPage(1000, 0, 60); l != 500 {
		t.Fatalf("limit not capped at 500: got %d", l)
	}
	if _, o := clampListPage(10, -3, 60); o != 0 {
		t.Fatalf("negative offset not floored: got %d", o)
	}
	if l, o := clampListPage(50, 100, 60); l != 50 || o != 100 {
		t.Fatalf("in-range values not preserved: got limit=%d offset=%d", l, o)
	}
}
