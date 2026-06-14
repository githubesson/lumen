package library

import (
	"context"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/githubesson/lumen/internal/dbtext"
	"github.com/githubesson/lumen/internal/dbutil"
)

var ErrNotFound = errors.New("not found")

type Store struct {
	db *pgxpool.Pool
}

func NewStore(db *pgxpool.Pool) *Store { return &Store{db: db} }

func (s *Store) DB() *pgxpool.Pool { return s.db }

// UpsertArtist returns an existing artist id by name or creates one. Matching
// is case-insensitive — "Juice Wrld", "juice wrld", and "JUICE WRLD" all
// resolve to the same row. The stored name keeps whatever casing the first
// ingest used.
func UpsertArtist(ctx context.Context, q pgx.Tx, name string) (uuid.UUID, error) {
	name = dbtext.Clean(name)
	var id uuid.UUID
	err := q.QueryRow(ctx, `
		INSERT INTO artists (name) VALUES ($1)
		ON CONFLICT (LOWER(name)) DO UPDATE SET updated_at = NOW()
		RETURNING id`, name).Scan(&id)
	return id, err
}

// UpsertAlbum finds or creates an album by (title, album_artist_id). When
// albumArtistID is nil the album is treated as a compilation candidate.
func UpsertAlbum(ctx context.Context, q pgx.Tx, title string, albumArtistID *uuid.UUID, year int, isCompilation bool, coverPath string) (uuid.UUID, error) {
	title = dbtext.Clean(title)
	coverPath = dbtext.Clean(coverPath)
	var id uuid.UUID
	var err error
	if albumArtistID == nil {
		err = q.QueryRow(ctx, `
			SELECT id FROM albums
			WHERE title = $1 AND album_artist_id IS NULL
			LIMIT 1`, title).Scan(&id)
	} else {
		err = q.QueryRow(ctx, `
			SELECT id FROM albums
			WHERE title = $1 AND album_artist_id = $2
			LIMIT 1`, title, *albumArtistID).Scan(&id)
	}
	if err == nil {
		// Opportunistically fill fields we now know.
		_, _ = q.Exec(ctx, `
			UPDATE albums SET
				release_year = COALESCE(NULLIF(release_year, 0), NULLIF($2::int, 0)),
				is_compilation = is_compilation OR $3,
				cover_art_path = COALESCE(cover_art_path, NULLIF($4, '')),
				updated_at = NOW()
			WHERE id = $1`, id, year, isCompilation, coverPath)
		return id, nil
	}
	if !errors.Is(err, pgx.ErrNoRows) {
		return uuid.Nil, err
	}
	var ptrYear *int
	if year > 0 {
		ptrYear = &year
	}
	var ptrCover *string
	if coverPath != "" {
		ptrCover = &coverPath
	}
	err = q.QueryRow(ctx, `
		INSERT INTO albums (title, album_artist_id, release_year, is_compilation, cover_art_path)
		VALUES ($1, $2, $3, $4, $5)
		RETURNING id`, title, albumArtistID, ptrYear, isCompilation, ptrCover).Scan(&id)
	return id, err
}

type TrackInsert struct {
	OwnerID     *uuid.UUID // nil = global (admin-added); otherwise personal
	AlbumID     *uuid.UUID
	Title       string
	TrackNo     int
	DiscNo      int
	DurationMS  int
	Genre       string
	Year        int
	Composer    string
	BPM         int
	ISRC        string
	Comments    string
	FilePath    string
	FileSize    int64
	Format      string
	Bitrate     int
	SampleRate  int
	Channels    int
	AudioSHA256 []byte
}

type RemoteTrackInput struct {
	Source      string
	ExternalID  string
	Title       string
	ArtistNames []string
	AlbumTitle  string
	AlbumArtist string
	DurationMS  int
	TrackNo     int
	DiscNo      int
	Year        int
	ISRC        string
	CoverID     string
	CoverURL    string
	Metadata    map[string]any
}

// UpsertRemoteTrack materializes a streamed catalog item as a hidden track row.
// The row is not shown in the local library, but it gives playlists, favorites,
// and play history the same stable FK target that local files already use.
func (s *Store) UpsertRemoteTrack(ctx context.Context, in RemoteTrackInput) (uuid.UUID, error) {
	source := strings.ToLower(dbtext.Clean(in.Source))
	externalID := dbtext.Clean(strings.TrimSpace(in.ExternalID))
	if source == "" || source == "local" || externalID == "" {
		return uuid.Nil, errors.New("remote source and external id are required")
	}
	title := dbtext.Clean(in.Title)
	if title == "" {
		title = source + ":" + externalID
	}
	albumTitle := dbtext.Clean(in.AlbumTitle)
	albumArtist := dbtext.Clean(in.AlbumArtist)
	if albumArtist == "" && len(in.ArtistNames) > 0 {
		albumArtist = dbtext.Clean(in.ArtistNames[0])
	}
	meta := map[string]any{}
	for k, v := range in.Metadata {
		meta[k] = v
	}
	if in.CoverID != "" {
		meta["cover_id"] = in.CoverID
	}
	if in.CoverURL != "" {
		meta["cover_url"] = in.CoverURL
	}
	metaJSON, err := json.Marshal(meta)
	if err != nil {
		return uuid.Nil, fmt.Errorf("marshal remote metadata: %w", err)
	}
	sum := sha256.Sum256([]byte(source + ":" + externalID))

	tx, err := s.db.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return uuid.Nil, err
	}
	defer tx.Rollback(ctx)

	var albumID *uuid.UUID
	if albumTitle != "" {
		var albumArtistID *uuid.UUID
		isCompilation := albumArtist == "" || strings.EqualFold(albumArtist, "Various Artists")
		if albumArtist != "" && !isCompilation {
			aid, err := UpsertArtist(ctx, tx, albumArtist)
			if err != nil {
				return uuid.Nil, fmt.Errorf("upsert remote album artist: %w", err)
			}
			albumArtistID = &aid
		}
		aid, err := UpsertAlbum(ctx, tx, albumTitle, albumArtistID, in.Year, isCompilation, "")
		if err != nil {
			return uuid.Nil, fmt.Errorf("upsert remote album: %w", err)
		}
		albumID = &aid
	}

	var id uuid.UUID
	err = tx.QueryRow(ctx, `
		INSERT INTO tracks (
			album_id, title, track_no, disc_no, duration_ms, year, isrc,
			file_path, file_size, format, audio_sha256,
			source, external_id, external_meta, library_visible
		) VALUES (
			$1, $2, NULLIF($3, 0), NULLIF($4, 0), $5, NULLIF($6, 0), NULLIF($7, ''),
			$8, 0, $9, $10,
			$11, $12, $13::jsonb, FALSE
		)
		ON CONFLICT (source, external_id)
			WHERE source <> 'local' AND external_id <> '' AND deleted_at IS NULL
		DO UPDATE SET
			album_id = EXCLUDED.album_id,
			title = EXCLUDED.title,
			track_no = EXCLUDED.track_no,
			disc_no = EXCLUDED.disc_no,
			duration_ms = EXCLUDED.duration_ms,
			year = EXCLUDED.year,
			isrc = EXCLUDED.isrc,
			external_meta = EXCLUDED.external_meta,
			library_visible = FALSE,
			updated_at = NOW()
		RETURNING id`,
		albumID, title, in.TrackNo, in.DiscNo, in.DurationMS, in.Year, dbtext.Clean(in.ISRC),
		source+":"+externalID, source, sum[:],
		source, externalID, string(metaJSON),
	).Scan(&id)
	if err != nil {
		return uuid.Nil, err
	}
	if len(in.ArtistNames) > 0 {
		if err := ReplaceTrackArtists(ctx, tx, id, in.ArtistNames); err != nil {
			return uuid.Nil, fmt.Errorf("replace remote artists: %w", err)
		}
	}
	if err := tx.Commit(ctx); err != nil {
		return uuid.Nil, err
	}
	return id, nil
}

func (s *Store) TrackIDForExternal(ctx context.Context, source, externalID string) (uuid.UUID, error) {
	source = strings.ToLower(dbtext.Clean(source))
	externalID = dbtext.Clean(strings.TrimSpace(externalID))
	var id uuid.UUID
	err := s.db.QueryRow(ctx, `
		SELECT id FROM tracks
		WHERE source = $1 AND external_id = $2 AND deleted_at IS NULL
		LIMIT 1`, source, externalID).Scan(&id)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return uuid.Nil, ErrNotFound
		}
		return uuid.Nil, err
	}
	return id, nil
}

// InsertTrack inserts a track honoring the ownership rules:
//
//   - Ingest with OwnerID=nil (global): if a global row already exists for the
//     SHA, return that row (no-op). If only personal rows exist, promote one
//     of them to global by setting owner_id=NULL (admin is "adopting" the
//     content). Otherwise insert new global.
//   - Ingest with OwnerID=user: if a global row exists for the SHA, return
//     it (user already "sees" it through global). If the user already has a
//     personal row for the SHA, return that. Otherwise insert new personal.
//
// `inserted` is true only when a brand-new row was written.
func InsertTrack(ctx context.Context, q pgx.Tx, t TrackInsert) (id uuid.UUID, inserted bool, err error) {
	t.Title = dbtext.Clean(t.Title)
	t.Genre = dbtext.Clean(t.Genre)
	t.Composer = dbtext.Clean(t.Composer)
	t.ISRC = dbtext.Clean(t.ISRC)
	t.Comments = dbtext.Clean(t.Comments)
	t.Format = dbtext.Clean(t.Format)

	if _, err := q.Exec(ctx, `SELECT pg_advisory_xact_lock(hashtextextended(encode($1::bytea, 'hex'), 0))`, t.AudioSHA256); err != nil {
		return uuid.Nil, false, err
	}

	// 1. Is there already a global row with this SHA?
	var globalID uuid.UUID
	err = q.QueryRow(ctx, `SELECT id FROM tracks WHERE audio_sha256 = $1 AND owner_id IS NULL AND deleted_at IS NULL`, t.AudioSHA256).Scan(&globalID)
	switch {
	case err == nil:
		return globalID, false, nil
	case errors.Is(err, pgx.ErrNoRows):
		// fall through
	default:
		return uuid.Nil, false, err
	}

	// 2a. Admin uploading: promote any personal row to global, else insert new global.
	if t.OwnerID == nil {
		var personalID uuid.UUID
		err = q.QueryRow(ctx, `SELECT id FROM tracks WHERE audio_sha256 = $1 AND deleted_at IS NULL LIMIT 1`, t.AudioSHA256).Scan(&personalID)
		switch {
		case err == nil:
			if _, err := q.Exec(ctx, `UPDATE tracks SET owner_id = NULL, updated_at = NOW() WHERE id = $1`, personalID); err != nil {
				return uuid.Nil, false, err
			}
			return personalID, false, nil
		case errors.Is(err, pgx.ErrNoRows):
			// fall through to insert
		default:
			return uuid.Nil, false, err
		}
	} else {
		// 2b. User uploading: do they already have a personal row for this SHA?
		var existing uuid.UUID
		err = q.QueryRow(ctx, `SELECT id FROM tracks WHERE audio_sha256 = $1 AND owner_id = $2 AND deleted_at IS NULL`, t.AudioSHA256, *t.OwnerID).Scan(&existing)
		switch {
		case err == nil:
			return existing, false, nil
		case errors.Is(err, pgx.ErrNoRows):
			// fall through to insert
		default:
			return uuid.Nil, false, err
		}
	}

	if !dbtext.Valid(t.FilePath) {
		return uuid.Nil, false, fmt.Errorf("file path is not valid UTF-8; rename file: %q", dbtext.Clean(t.FilePath))
	}
	t.FilePath = dbtext.Clean(t.FilePath)

	// 3. Insert fresh row.
	err = q.QueryRow(ctx, `
		INSERT INTO tracks (
			owner_id, album_id, title, track_no, disc_no, duration_ms, genre, year, composer,
			bpm, isrc, comments, file_path, file_size, format, bitrate, sample_rate,
			channels, audio_sha256
		) VALUES (
			$1,$2,$3,NULLIF($4,0),NULLIF($5,0),$6,NULLIF($7,''),NULLIF($8,0),NULLIF($9,''),
			NULLIF($10,0),NULLIF($11,''),NULLIF($12,''),$13,$14,$15,NULLIF($16,0),NULLIF($17,0),
			NULLIF($18,0)::smallint,$19
		)
		RETURNING id`,
		t.OwnerID, t.AlbumID, t.Title, t.TrackNo, t.DiscNo, t.DurationMS, t.Genre, t.Year, t.Composer,
		t.BPM, t.ISRC, t.Comments, t.FilePath, t.FileSize, t.Format, t.Bitrate, t.SampleRate,
		t.Channels, t.AudioSHA256,
	).Scan(&id)
	if err != nil {
		return uuid.Nil, false, err
	}
	return id, true, nil
}

// UpdateTrackAudioInfoIfMissing fills in duration_ms / bitrate / sample_rate
// / channels for a track row when the current value is zero. Used on dedup
// hits during ingest so an older row that was written before native probing
// (or from a re-ingest that couldn't probe) picks up the values without
// overwriting anything the user may already trust.
//
// Each non-zero argument is treated as a candidate replacement. Durations
// use a `WHEN 0 THEN ... ELSE value END` because 0 is the "unknown" marker;
// the nullable columns use COALESCE for the same reason.
func UpdateTrackAudioInfoIfMissing(ctx context.Context, q pgx.Tx, trackID uuid.UUID, durationMS, bitrate, sampleRate, channels int) error {
	if durationMS == 0 && bitrate == 0 && sampleRate == 0 && channels == 0 {
		return nil
	}
	_, err := q.Exec(ctx, `
		UPDATE tracks SET
			duration_ms = CASE WHEN duration_ms = 0 AND $2 > 0 THEN $2 ELSE duration_ms END,
			bitrate     = COALESCE(bitrate, NULLIF($3, 0)),
			sample_rate = COALESCE(sample_rate, NULLIF($4, 0)),
			channels    = COALESCE(channels, NULLIF($5, 0)::smallint),
			updated_at  = NOW()
		WHERE id = $1`, trackID, durationMS, bitrate, sampleRate, channels)
	return err
}

// AliasInput carries the per-file metadata recorded as a track alias when a
// file is deduplicated by audio SHA. Lets search match the dupe's strings
// without inflating the canonical track row.
type AliasInput struct {
	FilePath    string
	Title       string
	ArtistNames string // display-joined list, e.g. "A, B feat. C"
	AlbumTitle  string
}

// RecordAlias stores alternate metadata for a track that was deduplicated by
// audio_sha256. Skips cases where the alias path is already the track's own
// primary file_path (no new information) and deduplicates via the (track_id,
// file_path) UNIQUE index — idempotent across repeated ingests.
func RecordAlias(ctx context.Context, q pgx.Tx, trackID uuid.UUID, a AliasInput) error {
	a.FilePath = dbtext.Clean(a.FilePath)
	a.Title = dbtext.Clean(a.Title)
	a.ArtistNames = dbtext.Clean(a.ArtistNames)
	a.AlbumTitle = dbtext.Clean(a.AlbumTitle)
	_, err := q.Exec(ctx, `
		INSERT INTO track_aliases (track_id, file_path, title, artist_names, album_title)
		SELECT $1, $2, NULLIF($3, ''), NULLIF($4, ''), NULLIF($5, '')
		WHERE NOT EXISTS (SELECT 1 FROM tracks WHERE id = $1 AND file_path = $2)
		ON CONFLICT (track_id, file_path) DO NOTHING`,
		trackID, a.FilePath, a.Title, a.ArtistNames, a.AlbumTitle)
	return err
}

// ReplaceTrackArtists wipes and re-inserts track_artists for a track. Used by
// the edit endpoint when an admin rewrites the artist list.
func ReplaceTrackArtists(ctx context.Context, q pgx.Tx, trackID uuid.UUID, names []string) error {
	if _, err := q.Exec(ctx, `DELETE FROM track_artists WHERE track_id = $1`, trackID); err != nil {
		return err
	}
	for i, name := range names {
		n := name
		if n == "" {
			continue
		}
		aid, err := UpsertArtist(ctx, q, n)
		if err != nil {
			return err
		}
		role := "featured"
		if i == 0 {
			role = "primary"
		}
		if _, err := q.Exec(ctx, `
			INSERT INTO track_artists (track_id, artist_id, role, position)
			VALUES ($1, $2, $3, $4)
			ON CONFLICT DO NOTHING`, trackID, aid, role, i); err != nil {
			return err
		}
	}
	return nil
}

// LinkTrackArtists inserts track_artists rows for all provided artists.
func LinkTrackArtists(ctx context.Context, q pgx.Tx, trackID uuid.UUID, artistIDs []uuid.UUID, roles []string) error {
	for i, aid := range artistIDs {
		role := "primary"
		if i < len(roles) && roles[i] != "" {
			role = roles[i]
		}
		_, err := q.Exec(ctx, `
			INSERT INTO track_artists (track_id, artist_id, role, position)
			VALUES ($1, $2, $3, $4)
			ON CONFLICT DO NOTHING`, trackID, aid, role, i)
		if err != nil {
			return err
		}
	}
	return nil
}

// TrackPatch holds the mutable fields of a track. Any nil pointer means "no
// change" — only provided fields are applied. An empty-string Title is a
// validation error; an empty AlbumTitle means "detach from any album".
type TrackPatch struct {
	Title       *string
	Year        *int
	Genre       *string
	Composer    *string
	Comments    *string
	DiscNo      *int
	TrackNo     *int
	Artists     *[]string  // ordered; first is primary, rest featured
	AlbumID     *uuid.UUID // move the track into this existing album; takes precedence over AlbumTitle
	AlbumTitle  *string    // nil = leave alone; "" = detach; non-empty = attach (upsert)
	AlbumArtist *string    // used alongside AlbumTitle for upsert; "" means compilation
}

// UpdateTrack applies a patch in a single tx. Returns ErrNotFound if the
// track doesn't exist or is soft-deleted.
func (s *Store) UpdateTrack(ctx context.Context, id uuid.UUID, p TrackPatch) error {
	tx, err := s.db.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)

	// Make sure the track exists and is live before touching anything.
	var existing uuid.UUID
	if err := tx.QueryRow(ctx,
		`SELECT id FROM tracks WHERE id = $1 AND deleted_at IS NULL`, id).
		Scan(&existing); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return ErrNotFound
		}
		return err
	}

	// Scalar field updates. Build a dynamic SET list rather than a fixed
	// multi-column update so each column is only written when provided.
	var set dbutil.SetBuilder
	set.AddRaw("updated_at = NOW()")
	if p.Title != nil {
		if *p.Title == "" {
			return errors.New("title cannot be empty")
		}
		set.Add("title = $%d", *p.Title)
	}
	if p.Year != nil {
		set.Add("year = NULLIF($%d::int, 0)", *p.Year)
	}
	if p.Genre != nil {
		set.Add("genre = NULLIF($%d, '')", *p.Genre)
	}
	if p.Composer != nil {
		set.Add("composer = NULLIF($%d, '')", *p.Composer)
	}
	if p.Comments != nil {
		set.Add("comments = NULLIF($%d, '')", *p.Comments)
	}
	if p.DiscNo != nil {
		set.Add("disc_no = NULLIF($%d::int, 0)", *p.DiscNo)
	}
	if p.TrackNo != nil {
		set.Add("track_no = NULLIF($%d::int, 0)", *p.TrackNo)
	}

	// Album change — resolve the target album_id first, then include it in the
	// same UPDATE. AlbumID moves the track into a specific existing album;
	// AlbumTitle upserts by name ("" detaches). They both assign album_id, so
	// at most one branch may run — AlbumID wins when a caller sends both.
	if p.AlbumID != nil {
		var exists uuid.UUID
		err := tx.QueryRow(ctx, `SELECT id FROM albums WHERE id = $1`, *p.AlbumID).Scan(&exists)
		if errors.Is(err, pgx.ErrNoRows) {
			return errors.New("album not found")
		}
		if err != nil {
			return err
		}
		set.Add("album_id = $%d", *p.AlbumID)
	} else if p.AlbumTitle != nil {
		if *p.AlbumTitle == "" {
			set.AddRaw("album_id = NULL")
		} else {
			artistName := ""
			if p.AlbumArtist != nil {
				artistName = *p.AlbumArtist
			}
			var albumArtistID *uuid.UUID
			isComp := strings.EqualFold(artistName, "Various Artists") || artistName == ""
			if artistName != "" && !isComp {
				aid, err := UpsertArtist(ctx, tx, artistName)
				if err != nil {
					return fmt.Errorf("upsert album artist: %w", err)
				}
				albumArtistID = &aid
			}
			aid, err := UpsertAlbum(ctx, tx, *p.AlbumTitle, albumArtistID, 0, isComp, "")
			if err != nil {
				return fmt.Errorf("upsert album: %w", err)
			}
			set.Add("album_id = $%d", aid)
		}
	}

	if set.Count() > 1 { // anything beyond "updated_at = NOW()"
		setClause, args := set.Build()
		args = append(args, id)
		stmt := fmt.Sprintf(
			"UPDATE tracks SET %s WHERE id = $%d",
			setClause, len(args),
		)
		if _, err := tx.Exec(ctx, stmt, args...); err != nil {
			return err
		}
	}

	if p.Artists != nil {
		if err := ReplaceTrackArtists(ctx, tx, id, *p.Artists); err != nil {
			return fmt.Errorf("replace artists: %w", err)
		}
	}

	return tx.Commit(ctx)
}

// AlbumPatch mirrors TrackPatch for albums.
type AlbumPatch struct {
	Title         *string
	AlbumArtist   *string // "" = detach (compilation)
	ReleaseYear   *int
	IsCompilation *bool
}

// UpdateAlbum applies a patch. Returns ErrNotFound when the album is missing.
func (s *Store) UpdateAlbum(ctx context.Context, id uuid.UUID, p AlbumPatch) error {
	tx, err := s.db.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)

	var existing uuid.UUID
	if err := tx.QueryRow(ctx, `SELECT id FROM albums WHERE id = $1`, id).Scan(&existing); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return ErrNotFound
		}
		return err
	}

	var set dbutil.SetBuilder
	set.AddRaw("updated_at = NOW()")

	if p.Title != nil {
		if *p.Title == "" {
			return errors.New("title cannot be empty")
		}
		set.Add("title = $%d", *p.Title)
	}
	if p.ReleaseYear != nil {
		set.Add("release_year = NULLIF($%d::int, 0)", *p.ReleaseYear)
	}
	if p.IsCompilation != nil {
		set.Add("is_compilation = $%d", *p.IsCompilation)
	}
	if p.AlbumArtist != nil {
		if *p.AlbumArtist == "" {
			set.AddRaw("album_artist_id = NULL")
		} else {
			aid, err := UpsertArtist(ctx, tx, *p.AlbumArtist)
			if err != nil {
				return fmt.Errorf("upsert album artist: %w", err)
			}
			set.Add("album_artist_id = $%d", aid)
		}
	}

	if set.Count() == 1 { // only updated_at
		return tx.Commit(ctx)
	}
	setClause, args := set.Build()
	args = append(args, id)
	stmt := fmt.Sprintf(
		"UPDATE albums SET %s WHERE id = $%d",
		setClause, len(args),
	)
	if _, err := tx.Exec(ctx, stmt, args...); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

// SetAlbumCover points an album at a new cover-art storage key. Returns
// ErrNotFound when the album row is missing.
func (s *Store) SetAlbumCover(ctx context.Context, albumID uuid.UUID, coverPath string) error {
	coverPath = dbtext.Clean(coverPath)
	tag, err := s.db.Exec(ctx, `
		UPDATE albums SET cover_art_path = $2, updated_at = NOW()
		WHERE id = $1`, albumID, coverPath)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return ErrNotFound
	}
	return nil
}

// SetTrackAlbumCover points the track's album at coverPath when the album does
// not already have local artwork. It is intentionally opportunistic: tracks
// without albums, or albums that already have covers, simply result in no rows
// updated.
func (s *Store) SetTrackAlbumCover(ctx context.Context, trackID uuid.UUID, coverPath string) error {
	coverPath = dbtext.Clean(coverPath)
	if coverPath == "" {
		return nil
	}
	_, err := s.db.Exec(ctx, `
		UPDATE albums a
		SET cover_art_path = $2, updated_at = NOW()
		FROM tracks t
		WHERE t.id = $1
		  AND t.album_id = a.id
		  AND NULLIF(a.cover_art_path, '') IS NULL`,
		trackID, coverPath)
	return err
}

// ClearAlbumCover removes an album's cover-art reference, reverting it to the
// placeholder. The underlying storage object is intentionally left in place:
// covers are content-addressed and may be shared by other albums, so deleting
// the blob here could orphan another album's artwork. Returns ErrNotFound when
// the album row is missing.
func (s *Store) ClearAlbumCover(ctx context.Context, albumID uuid.UUID) error {
	tag, err := s.db.Exec(ctx, `
		UPDATE albums SET cover_art_path = NULL, updated_at = NOW()
		WHERE id = $1`, albumID)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return ErrNotFound
	}
	return nil
}

func (s *Store) RecordIngestError(ctx context.Context, path, msg string) {
	path = dbtext.Clean(path)
	msg = dbtext.Clean(msg)
	_, _ = s.db.Exec(ctx, `INSERT INTO ingest_errors (file_path, error) VALUES ($1, $2)`, path, msg)
}

// ClearIngestErrorsForPath removes any stale ingest_errors rows for a path —
// used when the file is successfully (re-)ingested so transient failures don't
// accumulate forever.
func (s *Store) ClearIngestErrorsForPath(ctx context.Context, path string) {
	path = dbtext.Clean(path)
	_, _ = s.db.Exec(ctx, `DELETE FROM ingest_errors WHERE file_path = $1`, path)
}

// TrackHasFilePath reports whether a live local track row still points at path.
// Importers use this before applying source-specific metadata to a dedup hit,
// where the returned track id may belong to a different canonical file.
func (s *Store) TrackHasFilePath(ctx context.Context, trackID uuid.UUID, path string) (bool, error) {
	path = dbtext.Clean(path)
	if trackID == uuid.Nil || path == "" {
		return false, nil
	}
	var ok bool
	err := s.db.QueryRow(ctx, `
		SELECT EXISTS (
			SELECT 1 FROM tracks
			WHERE id = $1
			  AND file_path = $2
			  AND deleted_at IS NULL
			  AND source = 'local'
		)`, trackID, path).Scan(&ok)
	return ok, err
}

func (s *Store) SoftDeleteByPath(ctx context.Context, path string) error {
	path = dbtext.Clean(path)
	_, err := s.db.Exec(ctx, `UPDATE tracks SET deleted_at = NOW() WHERE file_path = $1 AND deleted_at IS NULL`, path)
	return err
}

// HardDeleteByPath removes every DB trace of a file: the track row (cascading
// to playlist_tracks, user_track_stats, play_history, track_artists) and any
// ingest_errors for the path. Used when the file is missing from disk so it
// can be cleanly re-ingested if it ever reappears.
func (s *Store) HardDeleteByPath(ctx context.Context, path string) error {
	path = dbtext.Clean(path)
	if _, err := s.db.Exec(ctx, `DELETE FROM ingest_errors WHERE file_path = $1`, path); err != nil {
		return err
	}
	_, err := s.db.Exec(ctx, `DELETE FROM tracks WHERE file_path = $1`, path)
	return err
}

// DeletePersonalTrack hard-deletes a track from a user's personal library.
// Only rows the user personally uploaded (owner_id = userID) can be removed
// this way — global tracks and other users' personal tracks are left untouched
// and report ErrNotFound. The row delete cascades to playlist_tracks,
// user_track_stats, play_history, track_artists, and track_aliases. Returns
// the on-disk file_path so the caller can delete the uploaded file.
func (s *Store) DeletePersonalTrack(ctx context.Context, trackID, userID uuid.UUID) (string, error) {
	var filePath string
	err := s.db.QueryRow(ctx, `
		DELETE FROM tracks
		WHERE id = $1 AND owner_id = $2
		RETURNING file_path`, trackID, userID).Scan(&filePath)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return "", ErrNotFound
		}
		return "", err
	}
	return filePath, nil
}

// DeleteGlobalTrack hard-deletes a global track (owner_id IS NULL) and returns
// every on-disk file that fed it: the canonical file_path plus any
// track_aliases paths (duplicate files that were deduplicated into this track).
// The caller must remove those files from disk — otherwise the watcher/rescan
// simply re-ingests them. Personal tracks (owner_id set) and missing or
// soft-deleted rows report ErrNotFound: this is the admin path for shared
// content; users remove their own uploads via DeletePersonalTrack.
//
// The row delete cascades to playlist_tracks, user_track_stats, play_history,
// track_artists, and track_aliases; stale ingest_errors for the same paths are
// cleared so the errors list doesn't keep referencing a removed file.
func (s *Store) DeleteGlobalTrack(ctx context.Context, trackID uuid.UUID) ([]string, error) {
	tx, err := s.db.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return nil, err
	}
	defer tx.Rollback(ctx)

	var filePath string
	err = tx.QueryRow(ctx, `
		SELECT file_path FROM tracks
		WHERE id = $1 AND owner_id IS NULL AND deleted_at IS NULL`, trackID).Scan(&filePath)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, ErrNotFound
		}
		return nil, err
	}

	// Collect alias paths before the cascade drops the track_aliases rows.
	paths := []string{filePath}
	rows, err := tx.Query(ctx, `SELECT file_path FROM track_aliases WHERE track_id = $1`, trackID)
	if err != nil {
		return nil, err
	}
	for rows.Next() {
		var p string
		if err := rows.Scan(&p); err != nil {
			rows.Close()
			return nil, err
		}
		if p != "" && p != filePath {
			paths = append(paths, p)
		}
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return nil, err
	}

	if _, err := tx.Exec(ctx, `DELETE FROM tracks WHERE id = $1`, trackID); err != nil {
		return nil, err
	}
	if _, err := tx.Exec(ctx,
		`DELETE FROM ingest_errors WHERE file_path = ANY($1)`, paths); err != nil {
		return nil, err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return paths, nil
}

// DistinctPathsUnder returns distinct file_paths from tracks and ingest_errors
// that begin with any of the given prefixes. Used by the rescan prune pass so
// we only reconcile paths scoped to currently-live roots.
func (s *Store) DistinctPathsUnder(ctx context.Context, prefixes []string) ([]string, error) {
	if len(prefixes) == 0 {
		return nil, nil
	}
	for i := range prefixes {
		prefixes[i] = dbtext.Clean(prefixes[i])
	}
	rows, err := s.db.Query(ctx, `
		SELECT DISTINCT file_path FROM (
			SELECT file_path FROM tracks
			UNION ALL
			SELECT file_path FROM ingest_errors
		) p
		WHERE EXISTS (
			SELECT 1 FROM unnest($1::text[]) pfx WHERE starts_with(file_path, pfx)
		)`, prefixes)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []string
	for rows.Next() {
		var p string
		if err := rows.Scan(&p); err != nil {
			return nil, err
		}
		out = append(out, p)
	}
	return out, rows.Err()
}

// SoftDeleteTracksUnderPath marks every live track whose file_path starts with
// `prefix` as deleted. Used when an admin removes a music root — the files
// will no longer be watched/scanned, so their tracks shouldn't keep appearing
// in the library.
func (s *Store) SoftDeleteTracksUnderPath(ctx context.Context, prefix string) (int64, error) {
	prefix = dbtext.Clean(prefix)
	tag, err := s.db.Exec(ctx, `
		UPDATE tracks SET deleted_at = NOW()
		WHERE deleted_at IS NULL AND source = 'local' AND starts_with(file_path, $1)`, prefix)
	if err != nil {
		return 0, err
	}
	return tag.RowsAffected(), nil
}

func (s *Store) KnownPaths(ctx context.Context) (map[string]struct{}, error) {
	rows, err := s.db.Query(ctx, `SELECT file_path FROM tracks WHERE deleted_at IS NULL AND source = 'local'`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := map[string]struct{}{}
	for rows.Next() {
		var p string
		if err := rows.Scan(&p); err != nil {
			return nil, err
		}
		out[p] = struct{}{}
	}
	return out, rows.Err()
}

type IngestError struct {
	ID        int64
	FilePath  string
	Error     string
	CreatedAt time.Time
}

func (s *Store) ListIngestErrors(ctx context.Context, limit int) ([]IngestError, error) {
	if limit <= 0 || limit > 500 {
		limit = 100
	}
	rows, err := s.db.Query(ctx, `
		SELECT id, file_path, error, created_at FROM ingest_errors
		ORDER BY created_at DESC LIMIT $1`, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []IngestError
	for rows.Next() {
		var e IngestError
		if err := rows.Scan(&e.ID, &e.FilePath, &e.Error, &e.CreatedAt); err != nil {
			return nil, err
		}
		out = append(out, e)
	}
	return out, rows.Err()
}
