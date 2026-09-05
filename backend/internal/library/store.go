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

// ErrInvalidInput marks a caller mistake (empty title, unknown target album)
// as distinct from a store failure. Handlers used to render *every* non-
// ErrNotFound error as 400 with the raw error string, so a pgx connection
// reset during PATCH told the client its request was malformed and no retry
// ever fired.
var ErrInvalidInput = errors.New("invalid input")

// MaxTrackArtists bounds the artist list a single track may carry. Names come
// straight from user input (TrackPatch.Artists, RemoteTrackInput.ArtistNames)
// and each one is work inside the caller's transaction.
const MaxTrackArtists = 64

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
//
// Atomic by way of the albums_title_artist_uniq index (migration 0017): the
// previous SELECT-then-INSERT let two concurrent ingests of the same album both
// miss the SELECT and both INSERT, permanently splitting the tracklist across
// two rows. The index COALESCEs a NULL album_artist_id to the nil UUID so
// compilations collide too, and the ON CONFLICT target has to name the same
// expression.
func UpsertAlbum(ctx context.Context, q pgx.Tx, title string, albumArtistID *uuid.UUID, year int, isCompilation bool, coverPath string) (uuid.UUID, error) {
	title = dbtext.Clean(title)
	coverPath = dbtext.Clean(coverPath)
	var ptrYear *int
	if year > 0 {
		ptrYear = &year
	}
	var ptrCover *string
	if coverPath != "" {
		ptrCover = &coverPath
	}
	var id uuid.UUID
	// DO UPDATE rather than DO NOTHING: DO NOTHING suppresses the RETURNING row
	// on conflict, and the SET list is the same opportunistic fill the old
	// read path did — never overwriting a value we already have.
	err := q.QueryRow(ctx, `
		INSERT INTO albums (title, album_artist_id, release_year, is_compilation, cover_art_path)
		VALUES ($1, $2, $3, $4, $5)
		ON CONFLICT (title, COALESCE(album_artist_id, '00000000-0000-0000-0000-000000000000'::uuid))
		DO UPDATE SET
			release_year = COALESCE(NULLIF(albums.release_year, 0), NULLIF(EXCLUDED.release_year, 0)),
			is_compilation = albums.is_compilation OR EXCLUDED.is_compilation,
			cover_art_path = COALESCE(albums.cover_art_path, EXCLUDED.cover_art_path),
			updated_at = NOW()
		RETURNING id`, title, albumArtistID, ptrYear, isCompilation, ptrCover).Scan(&id)
	if err != nil {
		return uuid.Nil, err
	}
	return id, nil
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
		return uuid.Nil, fmt.Errorf("%w: remote source and external id are required", ErrInvalidInput)
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
		// ORDER BY created_at: without it the promoted row was whichever the
		// planner happened to return. The partial indexes in
		// 0013_track_sha_ignore_deleted permit several live personal rows for the
		// same audio, and the ones left behind stay personal — so those users see
		// the track twice, forever.
		err = q.QueryRow(ctx, `
			SELECT id FROM tracks
			WHERE audio_sha256 = $1 AND deleted_at IS NULL
			ORDER BY created_at ASC, id ASC
			LIMIT 1`, t.AudioSHA256).Scan(&personalID)
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
	if len(names) > MaxTrackArtists {
		return fmt.Errorf("%w: at most %d artists per track", ErrInvalidInput, MaxTrackArtists)
	}
	if _, err := q.Exec(ctx, `DELETE FROM track_artists WHERE track_id = $1`, trackID); err != nil {
		return err
	}
	// One statement each for the artist upsert and the link insert, rather than
	// two per name: `names` comes straight from user input, so a 200-name array
	// used to issue 400 sequential statements inside the caller's transaction.
	kept := make([]string, 0, len(names))
	positions := make([]int32, 0, len(names))
	roles := make([]string, 0, len(names))
	for i, name := range names {
		if name == "" {
			continue
		}
		kept = append(kept, dbtext.Clean(name))
		positions = append(positions, int32(i))
		if i == 0 {
			roles = append(roles, "primary")
		} else {
			roles = append(roles, "featured")
		}
	}
	if len(kept) == 0 {
		return nil
	}
	// DISTINCT ON is load-bearing: ON CONFLICT DO UPDATE errors out if one
	// statement tries to touch the same row twice, and two spellings of the
	// same artist ("Drake", "drake") collide on the LOWER(name) index.
	if _, err := q.Exec(ctx, `
		INSERT INTO artists (name)
		SELECT DISTINCT ON (LOWER(n)) n
		FROM unnest($1::text[]) AS n
		ORDER BY LOWER(n), n
		ON CONFLICT (LOWER(name)) DO UPDATE SET updated_at = NOW()`, kept); err != nil {
		return err
	}
	// Likewise deduped on the (track, artist, role) primary key before it
	// reaches the insert.
	_, err := q.Exec(ctx, `
		INSERT INTO track_artists (track_id, artist_id, role, position)
		SELECT DISTINCT ON (a.id, t.role) $1, a.id, t.role, t.position
		FROM unnest($2::text[], $3::text[], $4::int[]) AS t(name, role, position)
		JOIN artists a ON LOWER(a.name) = LOWER(t.name)
		ORDER BY a.id, t.role, t.position
		ON CONFLICT DO NOTHING`, trackID, kept, roles, positions)
	return err
}

// LinkTrackArtists inserts track_artists rows for all provided artists.
func LinkTrackArtists(ctx context.Context, q pgx.Tx, trackID uuid.UUID, artistIDs []uuid.UUID, roles []string) error {
	if len(artistIDs) == 0 {
		return nil
	}
	if len(artistIDs) > MaxTrackArtists {
		return fmt.Errorf("%w: at most %d artists per track", ErrInvalidInput, MaxTrackArtists)
	}
	// One multi-row insert rather than one statement per artist.
	roleCol := make([]string, len(artistIDs))
	posCol := make([]int32, len(artistIDs))
	for i := range artistIDs {
		roleCol[i] = "primary"
		if i < len(roles) && roles[i] != "" {
			roleCol[i] = roles[i]
		}
		posCol[i] = int32(i)
	}
	// DISTINCT ON keeps a repeated (artist, role) pair from reaching the insert
	// twice in one statement.
	_, err := q.Exec(ctx, `
		INSERT INTO track_artists (track_id, artist_id, role, position)
		SELECT DISTINCT ON (t.artist_id, t.role) $1, t.artist_id, t.role, t.position
		FROM unnest($2::uuid[], $3::text[], $4::int[]) AS t(artist_id, role, position)
		ORDER BY t.artist_id, t.role, t.position
		ON CONFLICT DO NOTHING`, trackID, artistIDs, roleCol, posCol)
	return err
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
			return fmt.Errorf("%w: title cannot be empty", ErrInvalidInput)
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
			return fmt.Errorf("%w: album not found", ErrInvalidInput)
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
			return fmt.Errorf("%w: title cannot be empty", ErrInvalidInput)
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

// RecordIngestError stores why a file failed to ingest. These rows are the
// *only* record of that failure, so a dropped write is invisible: the rescan
// counters report N errored files while ListIngestErrors shows a clean
// library. Returns the error so the caller can log it.
func (s *Store) RecordIngestError(ctx context.Context, path, msg string) error {
	path = dbtext.Clean(path)
	msg = dbtext.Clean(msg)
	_, err := s.db.Exec(ctx, `INSERT INTO ingest_errors (file_path, error) VALUES ($1, $2)`, path, msg)
	return err
}

// ClearIngestErrorsForPath removes any stale ingest_errors rows for a path —
// used when the file is successfully (re-)ingested so transient failures don't
// accumulate forever.
func (s *Store) ClearIngestErrorsForPath(ctx context.Context, path string) error {
	path = dbtext.Clean(path)
	_, err := s.db.Exec(ctx, `DELETE FROM ingest_errors WHERE file_path = $1`, path)
	return err
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
	// One transaction: run as two independent pool statements, a cancelled
	// rescan or a lock wait between them left the ingest-error row gone while
	// the stale tracks row survived, and the only caller (pruneMissing) just
	// logs a warning — so the inconsistency was permanent.
	return dbutil.WithTx(ctx, s.db, func(tx pgx.Tx) error {
		if _, err := tx.Exec(ctx, `DELETE FROM ingest_errors WHERE file_path = $1`, path); err != nil {
			return err
		}
		_, err := tx.Exec(ctx, `DELETE FROM tracks WHERE file_path = $1`, path)
		return err
	})
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
	// Clean into a copy: rewriting the caller's slice in place is a trap for
	// anyone who reuses it after the call.
	cleaned := make([]string, len(prefixes))
	for i, pfx := range prefixes {
		cleaned[i] = dbtext.Clean(pfx)
	}
	rows, err := s.db.Query(ctx, `
		SELECT DISTINCT file_path FROM (
			SELECT file_path FROM tracks
			UNION ALL
			SELECT file_path FROM ingest_errors
		) p
		WHERE EXISTS (
			SELECT 1 FROM unnest($1::text[]) pfx WHERE starts_with(file_path, pfx)
		)`, cleaned)
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
