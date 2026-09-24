package tidaldl

import (
	"path/filepath"
	"strings"
	"testing"

	"github.com/githubesson/lumen/internal/tidal"
)

func TestTrackPath(t *testing.T) {
	for _, tc := range []struct {
		name  string
		track tidal.Track
		want  string
	}{
		{
			name:  "album track",
			track: tidal.Track{ID: "1", Title: "Song", TrackNo: 3, AlbumTitle: "Album", AlbumArtist: "Band", Artists: []string{"Singer"}},
			want:  "Band/Album/03 - Song",
		},
		{
			name:  "multi-disc",
			track: tidal.Track{ID: "1", Title: "Song", TrackNo: 3, DiscNo: 2, AlbumTitle: "Album", AlbumArtist: "Band"},
			want:  "Band/Album/2-03 - Song",
		},
		{
			name:  "falls back to first artist and Singles",
			track: tidal.Track{ID: "1", Title: "Song", Artists: []string{"Singer", "Guest"}},
			want:  "Singer/Singles/Song",
		},
		{
			name:  "strips path separators",
			track: tidal.Track{ID: "1", Title: "A/B", AlbumTitle: "../..", AlbumArtist: "AC/DC"},
			want:  "AC_DC/_/A_B",
		},
		{
			name:  "long multi-byte title keeps valid UTF-8",
			track: tidal.Track{ID: "1", Title: strings.Repeat("音", 100), AlbumTitle: "A", AlbumArtist: "B"},
			want:  "B/A/" + strings.Repeat("音", 60),
		},
		{
			name:  "no metadata",
			track: tidal.Track{ID: "42"},
			want:  "Unknown Artist/Singles/TIDAL 42",
		},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if got := TrackPath(tc.track); got != filepath.FromSlash(tc.want) {
				t.Fatalf("TrackPath = %q, want %q", got, tc.want)
			}
		})
	}
}

func TestResolveDestination(t *testing.T) {
	root := t.TempDir()
	for _, tc := range []struct {
		subdir string
		want   string
		ok     bool
	}{
		{"", root, true},
		{".", root, true},
		{"TIDAL", filepath.Join(root, "TIDAL"), true},
		{"a/../b", filepath.Join(root, "b"), true},
		{"../escape", "", false},
		{"/abs", "", false},
	} {
		got, err := ResolveDestination(root, tc.subdir)
		if tc.ok != (err == nil) || got != tc.want {
			t.Errorf("ResolveDestination(%q) = %q, %v; want %q, ok=%v", tc.subdir, got, err, tc.want, tc.ok)
		}
	}
	if _, err := ResolveDestination(" ", "TIDAL"); err == nil {
		t.Error("accepted a blank root")
	}
	if _, err := ResolveDestination(filepath.Join(root, "unmounted"), "TIDAL"); err == nil {
		t.Error("accepted a root that does not exist")
	}
}

func TestKickNeverBlocks(t *testing.T) {
	var nilWorker *Worker
	nilWorker.Kick()

	w := &Worker{}
	for range 3 {
		w.Kick()
	}
	select {
	case <-w.kickCh():
	default:
		t.Fatal("kick was not delivered")
	}
	select {
	case <-w.kickCh():
		t.Fatal("kicks did not coalesce")
	default:
	}
}

func TestCheckFreeSpaceMeasuresNearestExistingDir(t *testing.T) {
	root := t.TempDir()
	dir := filepath.Join(root, "TIDAL", "Artist") // not created yet
	if err := (&Worker{}).checkFreeSpace(dir); err != nil {
		t.Fatalf("floor disabled: %v", err)
	}
	if err := (&Worker{MinFreeBytes: 1}).checkFreeSpace(dir); err != nil {
		t.Fatalf("1 byte floor: %v", err)
	}
	if _, ok := freeBytes(root); !ok {
		t.Skip("free space is not measurable on this platform")
	}
	if err := (&Worker{MinFreeBytes: 1 << 62}).checkFreeSpace(dir); err == nil {
		t.Fatal("impossible floor was satisfied")
	}
}

func TestFromReleaseFillsWhatTrackInfoLacks(t *testing.T) {
	release := tidal.Album{
		ID: "9", Title: "The Album", Artist: "Band", Artists: []string{"Band", "Guest"},
		ReleaseYear: 2021, CoverURL: "https://resources.tidal.com/images/x/640x640.jpg",
		Tracks: []tidal.Track{{ID: "1", TrackNo: 1, DiscNo: 1}, {ID: "2", TrackNo: 7, DiscNo: 2}},
	}
	// What /info/ returns: the album's id and title, no artist or date.
	got := fromRelease(tidal.Track{ID: "2", Title: "Song", AlbumID: "9", AlbumTitle: "The Album"}, release)
	if got.AlbumArtist != "Band" || got.Year != 2021 || got.TrackNo != 7 || got.DiscNo != 2 || got.CoverURL != release.CoverURL {
		t.Fatalf("fromRelease = %+v", got)
	}
	// Numbers the track info already has win.
	if got := fromRelease(tidal.Track{ID: "2", TrackNo: 3, DiscNo: 1}, release); got.TrackNo != 3 || got.DiscNo != 1 {
		t.Fatalf("overrode track numbering: %+v", got)
	}
}
