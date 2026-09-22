package integration

import (
	"context"
	"crypto/sha256"
	"errors"
	"os"
	"testing"

	"github.com/githubesson/lumen/internal/db"
	"github.com/githubesson/lumen/internal/library"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

// Personal uploads share album rows with the global library; these checks pin
// down that one user's upload cannot change what other users see.
func TestPersonalUploadsCannotAlterSharedCatalog(t *testing.T) {
	url := os.Getenv("LUMEN_REVIEW_TEST_DATABASE_URL")
	if url == "" {
		t.Skip("set LUMEN_REVIEW_TEST_DATABASE_URL to an isolated PostgreSQL database")
	}
	if err := db.Migrate(url); err != nil {
		t.Fatal(err)
	}
	ctx := context.Background()
	pool, err := db.Open(ctx, url)
	if err != nil {
		t.Fatal(err)
	}
	defer pool.Close()
	exec := func(t *testing.T, sql string, args ...any) {
		t.Helper()
		if _, err := pool.Exec(ctx, sql, args...); err != nil {
			t.Fatal(err)
		}
	}
	attacker, victim, bystander := uuid.New(), uuid.New(), uuid.New()
	for _, id := range []uuid.UUID{attacker, victim, bystander} {
		exec(t, `INSERT INTO users(id, username, password_hash, role) VALUES($1,$2,'test','user')`, id, "catalog-"+id.String())
		defer pool.Exec(ctx, `DELETE FROM users WHERE id=$1`, id)
	}
	lib := library.NewStore(pool)

	inTx := func(t *testing.T, fn func(pgx.Tx)) {
		t.Helper()
		tx, err := pool.Begin(ctx)
		if err != nil {
			t.Fatal(err)
		}
		defer tx.Rollback(ctx)
		fn(tx)
		if err := tx.Commit(ctx); err != nil {
			t.Fatal(err)
		}
	}
	upsertAlbum := func(t *testing.T, title string, year int, cover string, owner *uuid.UUID) uuid.UUID {
		t.Helper()
		var id uuid.UUID
		inTx(t, func(tx pgx.Tx) {
			id, err = library.UpsertAlbum(ctx, tx, title, nil, year, false, cover, owner)
			if err != nil {
				t.Fatal(err)
			}
		})
		return id
	}
	insertTrack := func(t *testing.T, in library.TrackInsert) (uuid.UUID, bool, string) {
		t.Helper()
		var (
			id       uuid.UUID
			inserted bool
			replaced string
		)
		inTx(t, func(tx pgx.Tx) {
			id, inserted, replaced, err = library.InsertTrack(ctx, tx, in)
			if err != nil {
				t.Fatal(err)
			}
		})
		return id, inserted, replaced
	}
	coverFor := func(t *testing.T, albumID, viewer uuid.UUID) string {
		t.Helper()
		p, err := lib.AlbumCoverPathForViewer(ctx, albumID, viewer)
		if errors.Is(err, library.ErrNotFound) {
			return ""
		}
		if err != nil {
			t.Fatal(err)
		}
		return p
	}

	t.Run("personal covers are per user and never shown to others", func(t *testing.T) {
		title := "catalog-album-" + uuid.NewString()
		albumID := upsertAlbum(t, title, 0, "covers/attacker.jpg", &attacker)
		defer pool.Exec(ctx, `DELETE FROM albums WHERE id=$1`, albumID)
		if again := upsertAlbum(t, title, 0, "covers/victim.jpg", &victim); again != albumID {
			t.Fatalf("same album resolved to %s and %s", albumID, again)
		}
		sha := sha256.Sum256([]byte(title + "global"))
		trackID, _, _ := insertTrack(t, library.TrackInsert{
			AlbumID: &albumID, Title: "Global", DurationMS: 1000,
			FilePath: "/music/" + title + ".mp3", FileSize: 1, Format: "mp3", AudioSHA256: sha[:],
		})
		defer pool.Exec(ctx, `DELETE FROM tracks WHERE id=$1`, trackID)

		for viewer, want := range map[uuid.UUID]string{
			attacker:  "covers/attacker.jpg",
			victim:    "covers/victim.jpg",
			bystander: "",
		} {
			if got := coverFor(t, albumID, viewer); got != want {
				t.Fatalf("viewer %s sees cover %q, want %q", viewer, got, want)
			}
			album, err := lib.GetAlbum(ctx, albumID, viewer)
			if err != nil {
				t.Fatal(err)
			}
			if album.HasCover != (want != "") {
				t.Fatalf("viewer %s HasCover = %v", viewer, album.HasCover)
			}
		}
		for viewer, want := range map[uuid.UUID]string{attacker: "covers/attacker.jpg", bystander: ""} {
			detail, err := lib.GetTrack(ctx, trackID, viewer)
			if err != nil {
				t.Fatal(err)
			}
			if detail.CoverArtPath != want {
				t.Fatalf("GetTrack cover for %s = %q, want %q", viewer, detail.CoverArtPath, want)
			}
		}
		public, err := lib.GetTrackPublic(ctx, trackID)
		if err != nil {
			t.Fatal(err)
		}
		if public.CoverArtPath != "" {
			t.Fatalf("public global track exposes a personal cover %q", public.CoverArtPath)
		}
		if got, err := lib.AlbumCoverPathForUser(ctx, albumID, attacker); err != nil || got != "covers/attacker.jpg" {
			t.Fatalf("signed per-user cover = %q, %v", got, err)
		}
		if _, err := lib.AlbumCoverPath(ctx, albumID); !errors.Is(err, library.ErrNotFound) {
			t.Fatalf("shared cover lookup err = %v, want ErrNotFound", err)
		}

		// A personal upload can no longer fill metadata on an album that
		// has global tracks.
		upsertAlbum(t, title, 1337, "", &attacker)
		var year *int
		if err := pool.QueryRow(ctx, `SELECT release_year FROM albums WHERE id=$1`, albumID).Scan(&year); err != nil {
			t.Fatal(err)
		}
		if year != nil {
			t.Fatalf("personal upload set shared album year to %d", *year)
		}

		upsertAlbum(t, title, 2001, "covers/global.jpg", nil)
		for _, viewer := range []uuid.UUID{attacker, victim, bystander} {
			if got := coverFor(t, albumID, viewer); got != "covers/global.jpg" {
				t.Fatalf("viewer %s sees %q after global art arrived", viewer, got)
			}
		}
	})

	t.Run("global ingest rewrites a promoted personal track", func(t *testing.T) {
		title := "catalog-promote-" + uuid.NewString()
		sha := sha256.Sum256([]byte(title))
		personalPath := "/music/.users/" + attacker.String() + "/evil.mp3"
		personalID, inserted, _ := insertTrack(t, library.TrackInsert{
			OwnerID: &attacker, Title: "Attacker Title", DurationMS: 1000,
			FilePath: personalPath, FileSize: 1, Format: "mp3", AudioSHA256: sha[:],
		})
		defer pool.Exec(ctx, `DELETE FROM tracks WHERE id=$1`, personalID)
		if !inserted {
			t.Fatal("personal insert reported dedup")
		}
		inTx(t, func(tx pgx.Tx) {
			if err := library.RecordAlias(ctx, tx, personalID, library.AliasInput{
				FilePath: "/music/.users/" + attacker.String() + "/dupe.mp3", Title: "Attacker Alias",
			}); err != nil {
				t.Fatal(err)
			}
		})

		globalPath := "/music/uploads/" + title + ".mp3"
		id, inserted, replaced := insertTrack(t, library.TrackInsert{
			Title: "Real Title", DurationMS: 2000,
			FilePath: globalPath, FileSize: 2, Format: "mp3", AudioSHA256: sha[:],
		})
		if id != personalID {
			t.Fatalf("promotion changed track id: %s != %s", id, personalID)
		}
		if !inserted || replaced != personalPath {
			t.Fatalf("promotion = inserted %v replaced %q; want true, %q", inserted, replaced, personalPath)
		}
		var (
			owner        *uuid.UUID
			gotTitle     string
			gotPath      string
			aliasesCount int
		)
		if err := pool.QueryRow(ctx, `SELECT owner_id, title, file_path FROM tracks WHERE id=$1`, id).Scan(&owner, &gotTitle, &gotPath); err != nil {
			t.Fatal(err)
		}
		if owner != nil || gotTitle != "Real Title" || gotPath != globalPath {
			t.Fatalf("promoted row = owner %v title %q path %q", owner, gotTitle, gotPath)
		}
		if err := pool.QueryRow(ctx, `SELECT COUNT(*) FROM track_aliases WHERE track_id=$1`, id).Scan(&aliasesCount); err != nil {
			t.Fatal(err)
		}
		if aliasesCount != 0 {
			t.Fatalf("uploader aliases survived promotion: %d", aliasesCount)
		}
	})

	t.Run("personal upload quota usage", func(t *testing.T) {
		before, err := lib.PersonalUploadBytes(ctx, victim)
		if err != nil {
			t.Fatal(err)
		}
		sha := sha256.Sum256([]byte("quota-" + victim.String()))
		id, _, _ := insertTrack(t, library.TrackInsert{
			OwnerID: &victim, Title: "Mine", DurationMS: 1000,
			FilePath: "/music/.users/" + victim.String() + "/mine.mp3", FileSize: 4096, Format: "mp3", AudioSHA256: sha[:],
		})
		defer pool.Exec(ctx, `DELETE FROM tracks WHERE id=$1`, id)
		after, err := lib.PersonalUploadBytes(ctx, victim)
		if err != nil {
			t.Fatal(err)
		}
		if after-before != 4096 {
			t.Fatalf("usage grew by %d, want 4096", after-before)
		}
	})
}
