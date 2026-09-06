package playlists

import (
	"errors"
	"testing"
	"time"

	"github.com/google/uuid"
)

func TestOrderedEntriesPreservesDuplicateOccurrenceMetadata(t *testing.T) {
	trackA := uuid.New()
	trackB := uuid.New()
	user1 := uuid.New()
	user2 := uuid.New()
	t1 := time.Date(2026, 1, 1, 1, 0, 0, 0, time.UTC)
	t2 := t1.Add(time.Hour)
	t3 := t2.Add(time.Hour)
	existing := []TrackEntry{
		{Position: 0, TrackID: trackA, AddedBy: &user1, AddedAt: t1},
		{Position: 1, TrackID: trackB, AddedBy: &user1, AddedAt: t2},
		{Position: 2, TrackID: trackA, AddedBy: &user2, AddedAt: t3},
	}

	got, err := orderedEntries(existing, []uuid.UUID{trackA, trackA, trackB})
	if err != nil {
		t.Fatalf("orderedEntries: %v", err)
	}
	if len(got) != 3 {
		t.Fatalf("got %d entries, want 3", len(got))
	}
	if got[0].TrackID != trackA || got[0].AddedBy == nil || *got[0].AddedBy != user1 || !got[0].AddedAt.Equal(t1) {
		t.Fatalf("first A occurrence did not retain its metadata: %+v", got[0])
	}
	if got[1].TrackID != trackA || got[1].AddedBy == nil || *got[1].AddedBy != user2 || !got[1].AddedAt.Equal(t3) {
		t.Fatalf("second A occurrence did not retain its metadata: %+v", got[1])
	}
	if got[2].TrackID != trackB || got[2].AddedBy == nil || *got[2].AddedBy != user1 || !got[2].AddedAt.Equal(t2) {
		t.Fatalf("B occurrence did not retain its metadata: %+v", got[2])
	}
}

func TestOrderedEntriesRequiresExactMultiset(t *testing.T) {
	trackA := uuid.New()
	trackB := uuid.New()
	existing := []TrackEntry{
		{TrackID: trackA},
		{TrackID: trackA},
		{TrackID: trackB},
	}

	tests := []struct {
		name string
		ids  []uuid.UUID
	}{
		{name: "missing occurrence", ids: []uuid.UUID{trackA, trackB}},
		{name: "extra occurrence", ids: []uuid.UUID{trackA, trackA, trackA, trackB}},
		{name: "wrong duplicate counts", ids: []uuid.UUID{trackA, trackB, trackB}},
		{name: "unknown track", ids: []uuid.UUID{trackA, trackA, uuid.New()}},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			_, err := orderedEntries(existing, tt.ids)
			if !errors.Is(err, ErrInvalidOrder) {
				t.Fatalf("got error %v, want ErrInvalidOrder", err)
			}
		})
	}
}

func TestMergeVisibleOrderPreservesHiddenSlots(t *testing.T) {
	visibleA := TrackEntry{TrackID: uuid.New()}
	hidden := TrackEntry{TrackID: uuid.New()}
	visibleB := TrackEntry{TrackID: uuid.New()}
	all := []reorderEntry{
		{TrackEntry: visibleA, visible: true},
		{TrackEntry: hidden, visible: false},
		{TrackEntry: visibleB, visible: true},
	}

	got := mergeVisibleOrder(all, []TrackEntry{visibleB, visibleA})
	if got[0].TrackID != visibleB.TrackID || got[1].TrackID != hidden.TrackID || got[2].TrackID != visibleA.TrackID {
		t.Fatalf("merged order = [%s %s %s], hidden slot was not preserved",
			got[0].TrackID, got[1].TrackID, got[2].TrackID)
	}
}
