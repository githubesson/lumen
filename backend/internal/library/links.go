package library

import (
	"cmp"
	"context"
	"errors"
	"fmt"
	"path"
	"slices"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/githubesson/lumen/internal/dbutil"
)

// Linked tracks are the same song in different files, say an MP3 and the
// studio WAV it was encoded from, grouped by an admin (migration 0031). The
// group's fullest-tagged track stays in the library and shows its tags; the
// others are hidden behind it with linked_to and keep their own rows, files
// and tags. Whichever file is best plays for the whole group.

// LinkedFile is one file of a linked group, as its own track row has it.
type LinkedFile struct {
	TrackID    uuid.UUID
	Shown      bool // the group's track in the library, whose tags show
	FilePath   string
	Format     string
	Bitrate    int // bits per second
	SampleRate int
	Channels   int
	DurationMS int
	FileSize   int64
	CreatedAt  time.Time
}

// lossless reports whether a file holds its audio without loss: WAV and FLAC
// by extension, and M4A/MP4 at a bitrate beyond what AAC uses, which is ALAC.
func (f LinkedFile) lossless() bool {
	switch strings.ToLower(path.Ext(strings.ReplaceAll(f.FilePath, `\`, "/"))) {
	case ".wav", ".flac":
		return true
	case ".m4a", ".mp4":
		return f.Bitrate >= 500_000
	}
	return false
}

// comparePlayback orders files best first: lossless before lossy, then among
// lossless files the higher sample rate, then the higher bitrate (more bits
// per sample, or a richer lossy encode). Ties go to the shown track, then the
// older file, so the choice doesn't flip between requests.
func comparePlayback(a, b LinkedFile) int {
	if al, bl := a.lossless(), b.lossless(); al != bl {
		if al {
			return -1
		}
		return 1
	} else if al {
		if c := cmp.Compare(b.SampleRate, a.SampleRate); c != 0 {
			return c
		}
	}
	if c := cmp.Compare(b.Bitrate, a.Bitrate); c != 0 {
		return c
	}
	if a.Shown != b.Shown {
		if a.Shown {
			return -1
		}
		return 1
	}
	if c := a.CreatedAt.Compare(b.CreatedAt); c != 0 {
		return c
	}
	return strings.Compare(a.TrackID.String(), b.TrackID.String())
}

// linkedGroupFrom joins f to every live local track in t's linked group, t's
// own row included: the shown track and the tracks linked to it.
const linkedGroupFrom = `
	FROM tracks t
	JOIN tracks f ON f.deleted_at IS NULL AND f.source = 'local'
	 AND (f.id = COALESCE(t.linked_to, t.id) OR f.linked_to = COALESCE(t.linked_to, t.id))
	WHERE t.id = $1 AND t.source = 'local'`

// hasLinkedSQL is true for a track t that is linked with others.
const hasLinkedSQL = `(t.linked_to IS NOT NULL OR EXISTS (
	SELECT 1 FROM tracks lm WHERE lm.linked_to = t.id AND lm.deleted_at IS NULL))`

// linkedFiles lists the files of id's linked group, best for playback first.
// A track that isn't linked gets just its own.
func (s *Store) linkedFiles(ctx context.Context, id uuid.UUID) ([]LinkedFile, error) {
	rows, err := s.db.Query(ctx, `
		SELECT f.id, f.linked_to IS NULL, f.file_path, f.format,
		       COALESCE(f.bitrate, 0), COALESCE(f.sample_rate, 0), COALESCE(f.channels, 0),
		       f.duration_ms, f.file_size, f.created_at`+linkedGroupFrom, id)
	if err != nil {
		return nil, err
	}
	files, err := pgx.CollectRows(rows, func(row pgx.CollectableRow) (LinkedFile, error) {
		var f LinkedFile
		err := row.Scan(&f.TrackID, &f.Shown, &f.FilePath, &f.Format,
			&f.Bitrate, &f.SampleRate, &f.Channels, &f.DurationMS, &f.FileSize, &f.CreatedAt)
		return f, err
	})
	if err != nil {
		return nil, err
	}
	slices.SortFunc(files, comparePlayback)
	return files, nil
}

// LinkedTrack is a track of a linked group, for the versions view.
type LinkedTrack struct {
	LinkedFile
	Title       string
	ArtistNames string // performers, as track aliases record them
	AlbumTitle  string
	Plays       bool // its file is the one the group plays
}

// LinkedTracks lists the tracks linked with trackID, its own included: the
// shown track first, then oldest first, with the one whose file plays
// marked. Nil when the track isn't linked. Callers check the viewer can see
// the track.
func (s *Store) LinkedTracks(ctx context.Context, trackID uuid.UUID) ([]LinkedTrack, error) {
	rows, err := s.db.Query(ctx, `
		SELECT f.id, f.linked_to IS NULL, f.file_path, f.format,
		       COALESCE(f.bitrate, 0), COALESCE(f.sample_rate, 0), COALESCE(f.channels, 0),
		       f.duration_ms, f.file_size, f.created_at, f.title,
		       COALESCE((SELECT STRING_AGG(ar.name, ', ' ORDER BY ta.position, ar.name)
		                 FROM track_artists ta JOIN artists ar ON ar.id = ta.artist_id
		                 WHERE ta.track_id = f.id AND ta.role <> 'composer'), ''),
		       COALESCE((SELECT a.title FROM albums a WHERE a.id = f.album_id), '')`+linkedGroupFrom, trackID)
	if err != nil {
		return nil, err
	}
	tracks, err := pgx.CollectRows(rows, func(row pgx.CollectableRow) (LinkedTrack, error) {
		var l LinkedTrack
		err := row.Scan(&l.TrackID, &l.Shown, &l.FilePath, &l.Format,
			&l.Bitrate, &l.SampleRate, &l.Channels, &l.DurationMS, &l.FileSize, &l.CreatedAt,
			&l.Title, &l.ArtistNames, &l.AlbumTitle)
		return l, err
	})
	if err != nil || len(tracks) < 2 {
		return nil, err
	}
	best := slices.MinFunc(tracks, func(a, b LinkedTrack) int { return comparePlayback(a.LinkedFile, b.LinkedFile) })
	for i := range tracks {
		tracks[i].Plays = tracks[i].TrackID == best.TrackID
	}
	slices.SortFunc(tracks, func(a, b LinkedTrack) int {
		if a.Shown != b.Shown {
			if a.Shown {
				return -1
			}
			return 1
		}
		if c := a.CreatedAt.Compare(b.CreatedAt); c != 0 {
			return c
		}
		return strings.Compare(a.TrackID.String(), b.TrackID.String())
	})
	return tracks, nil
}

// linkShownOrder ranks a group's tracks t for which one shows, fullest
// first: metadata edited on purpose, then with performers, then on a real
// album (Fullness). Migration 0031's linked_heir ranks the same.
const linkShownOrder = `t.metadata_edited_at IS NOT NULL DESC, ` + trackHasArtists + ` DESC, ` + trackHasAlbum + ` DESC`

// errLinkRaced reports that a group changed between reading and locking it.
var errLinkRaced = fmt.Errorf("%w: the tracks changed while linking; try again", ErrInvalidInput)

// linkGroup is the shown track of the group id belongs to, which must be a
// live shared library track.
func linkGroup(ctx context.Context, tx pgx.Tx, id uuid.UUID) (uuid.UUID, error) {
	var (
		linkedTo *uuid.UUID
		ownerID  *uuid.UUID
		source   string
	)
	err := tx.QueryRow(ctx, `
		SELECT linked_to, owner_id, source FROM tracks WHERE id = $1 AND deleted_at IS NULL`, id).
		Scan(&linkedTo, &ownerID, &source)
	switch {
	case errors.Is(err, pgx.ErrNoRows):
		return uuid.Nil, ErrNotFound
	case err != nil:
		return uuid.Nil, err
	case source != "local":
		return uuid.Nil, fmt.Errorf("%w: only library files can be linked", ErrInvalidInput)
	case ownerID != nil:
		return uuid.Nil, fmt.Errorf("%w: personal uploads can't be linked", ErrInvalidInput)
	case linkedTo != nil:
		return *linkedTo, nil
	}
	return id, nil
}

// lockLinkGroups locks every live track of the given groups, in id order,
// and checks each of ids still belongs to the group it was read in.
func lockLinkGroups(ctx context.Context, tx pgx.Tx, groups, ids []uuid.UUID) ([]uuid.UUID, error) {
	rows, err := tx.Query(ctx, `
		SELECT id FROM tracks
		WHERE (id = ANY($1) OR linked_to = ANY($1)) AND deleted_at IS NULL
		ORDER BY id
		FOR UPDATE`, groups)
	if err != nil {
		return nil, err
	}
	locked, err := pgx.CollectRows(rows, pgx.RowTo[uuid.UUID])
	if err != nil {
		return nil, err
	}
	for i, id := range ids {
		g, err := linkGroup(ctx, tx, id)
		if err != nil {
			return nil, err
		}
		if g != groups[i] {
			return nil, errLinkRaced
		}
	}
	return locked, nil
}

// showLinked makes shown the track of the group made of ids that stays in
// the library, and hides the rest behind it.
func showLinked(ctx context.Context, tx pgx.Tx, shown uuid.UUID, ids []uuid.UUID) error {
	_, err := tx.Exec(ctx, `
		UPDATE tracks SET
			linked_to = CASE WHEN id = $1 THEN NULL ELSE $1::uuid END,
			library_visible = (id = $1),
			updated_at = NOW()
		WHERE id = ANY($2) AND linked_to IS DISTINCT FROM CASE WHEN id = $1 THEN NULL ELSE $1::uuid END`,
		shown, ids)
	return err
}

// LinkTracks links two shared library tracks as files of the same song,
// merging their groups. The fullest-tagged track of the lot (linkShownOrder;
// a tie keeps target's group's) stays in the library; the rest are hidden
// behind it, and their playlist entries, listening stats and history move
// onto it. Returns the shown track.
func (s *Store) LinkTracks(ctx context.Context, targetID, otherID uuid.UUID) (uuid.UUID, error) {
	if targetID == otherID {
		return uuid.Nil, fmt.Errorf("%w: a track can't be linked to itself", ErrInvalidInput)
	}
	var shown uuid.UUID
	err := dbutil.WithTx(ctx, s.db, func(tx pgx.Tx) error {
		ids := []uuid.UUID{targetID, otherID}
		groups := make([]uuid.UUID, len(ids))
		for i, id := range ids {
			g, err := linkGroup(ctx, tx, id)
			if err != nil {
				return err
			}
			groups[i] = g
		}
		if groups[0] == groups[1] {
			shown = groups[0]
			return nil
		}
		members, err := lockLinkGroups(ctx, tx, groups, ids)
		if err != nil {
			return err
		}
		if err := tx.QueryRow(ctx, `
			SELECT t.id FROM tracks t WHERE t.id = ANY($1)
			ORDER BY `+linkShownOrder+`, t.id = $2 DESC, t.created_at, t.id
			LIMIT 1`, members, groups[0]).Scan(&shown); err != nil {
			return err
		}
		if err := showLinked(ctx, tx, shown, members); err != nil {
			return err
		}
		_, err = tx.Exec(ctx, `
			SELECT move_track_refs(m, $1) FROM unnest($2::uuid[]) AS m WHERE m <> $1`, shown, members)
		return err
	})
	return shown, err
}

// UnlinkTrack takes a track out of its linked group, back into the library
// as a track of its own that plays its own file. Its playlist entries and
// stats stay where they are. Taking out the shown track hands its place to
// the fullest of the rest. Returns the group's shown track afterwards, or
// trackID itself when it wasn't linked.
func (s *Store) UnlinkTrack(ctx context.Context, trackID uuid.UUID) (uuid.UUID, error) {
	shown := trackID
	err := dbutil.WithTx(ctx, s.db, func(tx pgx.Tx) error {
		group, err := linkGroup(ctx, tx, trackID)
		if err != nil {
			return err
		}
		members, err := lockLinkGroups(ctx, tx, []uuid.UUID{group}, []uuid.UUID{trackID})
		if err != nil || len(members) < 2 {
			return err
		}
		if trackID != group {
			shown = group
			_, err := tx.Exec(ctx, `
				UPDATE tracks SET linked_to = NULL, library_visible = TRUE, updated_at = NOW()
				WHERE id = $1`, trackID)
			return err
		}
		rest := slices.DeleteFunc(members, func(id uuid.UUID) bool { return id == trackID })
		if err := tx.QueryRow(ctx, `
			SELECT t.id FROM tracks t WHERE t.id = ANY($1)
			ORDER BY `+linkShownOrder+`, t.created_at, t.id
			LIMIT 1`, rest).Scan(&shown); err != nil {
			return err
		}
		return showLinked(ctx, tx, shown, rest)
	})
	return shown, err
}
