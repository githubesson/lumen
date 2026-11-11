package integration

import (
	"errors"
	"testing"

	"github.com/githubesson/lumen/internal/library"
	"github.com/google/uuid"
)

// An uploader can fix their own personal tracks' tags and art; nobody else
// can, and their art stays theirs.
func TestOwnerEditsOwnPersonalTrack(t *testing.T) {
	ctx, pool := openRedteamDB(t)
	lib := library.NewStore(pool)
	owner := redteamUser(t, ctx, pool)
	other := redteamUser(t, ctx, pool)
	track := redteamTrack(t, ctx, pool, &owner, nil)
	global := redteamTrack(t, ctx, pool, nil, nil)

	title := "lol"
	artists := []string{"Baby Smoove"}
	if err := lib.UpdateTrack(ctx, track, library.TrackPatch{Title: &title, Artists: &artists, Owner: &other}); !errors.Is(err, library.ErrNotFound) {
		t.Fatalf("another user's edit: got %v, want ErrNotFound", err)
	}
	if err := lib.UpdateTrack(ctx, global, library.TrackPatch{Title: &title, Owner: &owner}); !errors.Is(err, library.ErrNotFound) {
		t.Fatalf("non-admin edit of a global track: got %v, want ErrNotFound", err)
	}

	// No album yet: nothing to hang a cover on.
	cover := "covers/owner-edit-" + uuid.NewString() + ".jpg"
	if err := lib.SetPersonalTrackCover(ctx, track, owner, cover); !errors.Is(err, library.ErrInvalidInput) {
		t.Fatalf("cover without album: got %v, want ErrInvalidInput", err)
	}

	album := "Owner Edit " + uuid.NewString()
	albumArtist := "Baby Smoove"
	if err := lib.UpdateTrack(ctx, track, library.TrackPatch{Title: &title, Artists: &artists, AlbumTitle: &album, AlbumArtist: &albumArtist, Owner: &owner}); err != nil {
		t.Fatal(err)
	}
	got, err := lib.GetTrack(ctx, track, owner)
	if err != nil {
		t.Fatal(err)
	}
	if got.Title != title || got.AlbumTitle != album {
		t.Fatalf("after edit: title %q album %q", got.Title, got.AlbumTitle)
	}

	if err := lib.SetPersonalTrackCover(ctx, track, other, cover); !errors.Is(err, library.ErrNotFound) {
		t.Fatalf("another user's cover: got %v, want ErrNotFound", err)
	}
	if err := lib.SetPersonalTrackCover(ctx, track, owner, cover); err != nil {
		t.Fatal(err)
	}
	// Replacing it takes the new art.
	cover2 := "covers/owner-edit-" + uuid.NewString() + ".jpg"
	if err := lib.SetPersonalTrackCover(ctx, track, owner, cover2); err != nil {
		t.Fatal(err)
	}
	if got, err = lib.GetTrack(ctx, track, owner); err != nil {
		t.Fatal(err)
	}
	if got.CoverArtPath != cover2 {
		t.Fatalf("owner sees cover %q, want %q", got.CoverArtPath, cover2)
	}
	var shared *string
	if err := pool.QueryRow(ctx, `SELECT cover_art_path FROM albums WHERE id=$1`, got.AlbumID).Scan(&shared); err != nil {
		t.Fatal(err)
	}
	if shared != nil && *shared != "" {
		t.Fatalf("personal cover leaked onto the shared album row: %q", *shared)
	}
}
