package library

import (
	"context"
	"errors"
	"strings"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/githubesson/lumen/internal/dbtext"
	"github.com/githubesson/lumen/internal/dbutil"
)

// CatchAllAlbum is the album ingest files a track under when its file has
// neither an artist nor an album tag. It doesn't count as knowing the album.
const CatchAllAlbum = "Others"

// Fullness ranks how well one copy's metadata identifies a track: artists
// first, then a real album. When several files share the same audio, the
// fullest copy's metadata is the one shown, and the others become aliases,
// unless someone set the track's metadata on purpose (metadata_edited_at).
type Fullness struct {
	HasArtists bool
	HasAlbum   bool
}

// FullnessOf ranks metadata as ingest would store it.
func FullnessOf(artists int, album string) Fullness {
	return Fullness{HasArtists: artists > 0, HasAlbum: album != "" && album != CatchAllAlbum}
}

// Fuller reports whether f identifies the track strictly better than other.
// Ties keep the current metadata, so repeated ingests never flip-flop.
func (f Fullness) Fuller(other Fullness) bool {
	if f.HasArtists != other.HasArtists {
		return f.HasArtists
	}
	return f.HasAlbum && !other.HasAlbum
}

// The same ranking in SQL: t is a tracks row, al a track_aliases row. The
// ROW(...) > ROW(...) comparison is Fuller, since false sorts before true.
const (
	trackHasArtists = `EXISTS (SELECT 1 FROM track_artists fa WHERE fa.track_id = t.id AND fa.role <> 'composer')`
	trackHasAlbum   = `EXISTS (SELECT 1 FROM albums fal WHERE fal.id = t.album_id AND fal.title <> '` + CatchAllAlbum + `')`
	aliasHasArtists = `COALESCE(al.artist_names, '') <> ''`
	aliasHasAlbum   = `COALESCE(al.album_title, '') NOT IN ('', '` + CatchAllAlbum + `')`
)

// trackState is a track's current title/artists/album in alias form, how
// full that metadata is, and whether it was edited on purpose.
type trackState struct {
	cur     AliasInput
	full    Fullness
	ownerID *uuid.UUID
	edited  bool
}

// trackMetadata loads a live local track's trackState. Locks the track row.
func trackMetadata(ctx context.Context, q pgx.Tx, trackID uuid.UUID) (trackState, error) {
	var st trackState
	err := q.QueryRow(ctx, `
		SELECT t.file_path, t.title, t.owner_id, t.metadata_edited_at IS NOT NULL,
		       COALESCE((SELECT STRING_AGG(ar.name, ', ' ORDER BY ta.position, ar.name)
		                 FROM track_artists ta JOIN artists ar ON ar.id = ta.artist_id
		                 WHERE ta.track_id = t.id), ''),
		       COALESCE((SELECT a.title FROM albums a WHERE a.id = t.album_id), ''),
		       `+trackHasArtists+`, `+trackHasAlbum+`
		FROM tracks t
		WHERE t.id = $1 AND t.deleted_at IS NULL AND t.source = 'local'
		FOR UPDATE`, trackID).
		Scan(&st.cur.FilePath, &st.cur.Title, &st.ownerID, &st.edited,
			&st.cur.ArtistNames, &st.cur.AlbumTitle, &st.full.HasArtists, &st.full.HasAlbum)
	return st, err
}

// AdoptDuplicate makes a deduplicated copy the track's canonical file when its
// metadata (ranked by full) is fuller than the track's and wasn't edited on
// purpose: the track takes the copy's path and tags, and its old
// title/artists/album are kept as an alias. Returns the old file path, which
// the caller may remove, or "" when nothing changed.
func AdoptDuplicate(ctx context.Context, q pgx.Tx, trackID uuid.UUID, full Fullness, t TrackInsert, artistIDs []uuid.UUID, roles []string) (string, error) {
	if !full.Fuller(Fullness{}) {
		return "", nil // nothing is less full
	}
	st, err := trackMetadata(ctx, q, trackID)
	if errors.Is(err, pgx.ErrNoRows) {
		return "", nil
	}
	if err != nil {
		return "", err
	}
	if st.edited || !full.Fuller(st.full) {
		return "", nil
	}
	cur := st.cur

	t.Title = dbtext.Clean(t.Title)
	t.Genre = dbtext.Clean(t.Genre)
	t.Composer = dbtext.Clean(t.Composer)
	t.Comments = dbtext.Clean(t.Comments)
	t.Format = dbtext.Clean(t.Format)
	if err := cleanTrackFilePath(&t); err != nil {
		return "", err
	}
	// Same audio, so the probed duration/bitrate/etc. stay as they are. Tags
	// the copy lacks keep the track's values, since the alias can't hold
	// them; track and disc numbers only while the album stays the same.
	if _, err := q.Exec(ctx, `
		UPDATE tracks SET
			album_id = $2, title = $3,
			track_no = CASE WHEN album_id IS NOT DISTINCT FROM $2
				THEN COALESCE(NULLIF($4,0), track_no) ELSE NULLIF($4,0) END,
			disc_no = CASE WHEN album_id IS NOT DISTINCT FROM $2
				THEN COALESCE(NULLIF($5,0), disc_no) ELSE NULLIF($5,0) END,
			genre = COALESCE(NULLIF($6,''), genre), year = COALESCE(NULLIF($7,0), year),
			composer = COALESCE(NULLIF($8,''), composer), comments = COALESCE(NULLIF($9,''), comments),
			file_path = $10, file_size = $11, format = $12,
			updated_at = NOW()
		WHERE id = $1`,
		trackID, t.AlbumID, t.Title, t.TrackNo, t.DiscNo, t.Genre, t.Year, t.Composer,
		t.Comments, t.FilePath, t.FileSize, t.Format); err != nil {
		return "", err
	}
	if _, err := q.Exec(ctx, `DELETE FROM track_artists WHERE track_id = $1`, trackID); err != nil {
		return "", err
	}
	if err := LinkTrackArtists(ctx, q, trackID, artistIDs, roles); err != nil {
		return "", err
	}
	// The new canonical file may have been recorded as an alias by an earlier
	// ingest; the old one becomes an alias now that it no longer is canonical.
	if _, err := q.Exec(ctx, `DELETE FROM track_aliases WHERE track_id = $1 AND file_path = $2`, trackID, t.FilePath); err != nil {
		return "", err
	}
	if err := RecordAlias(ctx, q, trackID, cur); err != nil {
		return "", err
	}
	return cur.FilePath, nil
}

// AdoptFullerAliases repairs tracks deduplicated before ingest compared
// copies, where an untagged original that arrived first kept the track while
// the tagged copy only became an alias. The fullest such alias swaps its
// title, artists and album with the track's. The file stays put: ingest
// normally removed the tagged copy, which is why only what the alias recorded
// can move. Tracks whose metadata was edited on purpose are left alone, so a
// deliberate removal of an artist or album sticks. Returns how many tracks
// changed.
func (s *Store) AdoptFullerAliases(ctx context.Context) (int, error) {
	rows, err := s.db.Query(ctx, `
		SELECT DISTINCT ON (t.id) t.id, al.id
		FROM track_aliases al
		JOIN tracks t ON t.id = al.track_id
		WHERE t.deleted_at IS NULL AND t.source = 'local' AND t.metadata_edited_at IS NULL
		  AND ROW(`+aliasHasArtists+`, `+aliasHasAlbum+`) > ROW(`+trackHasArtists+`, `+trackHasAlbum+`)
		ORDER BY t.id, `+aliasHasArtists+` DESC, `+aliasHasAlbum+` DESC, al.id`)
	if err != nil {
		return 0, err
	}
	type candidate struct {
		trackID uuid.UUID
		aliasID int64
	}
	var candidates []candidate
	for rows.Next() {
		var c candidate
		if err := rows.Scan(&c.trackID, &c.aliasID); err != nil {
			rows.Close()
			return 0, err
		}
		candidates = append(candidates, c)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return 0, err
	}

	adopted := 0
	for _, c := range candidates {
		changed := false
		err := dbutil.WithTx(ctx, s.db, func(tx pgx.Tx) error {
			var err error
			changed, err = adoptAlias(ctx, tx, c.trackID, c.aliasID)
			return err
		})
		if err != nil {
			return adopted, err
		}
		if changed {
			adopted++
		}
	}
	return adopted, nil
}

// adoptAlias swaps one alias's metadata with its track's, rechecking under the
// row lock that the alias is still fuller and the track still unedited.
func adoptAlias(ctx context.Context, tx pgx.Tx, trackID uuid.UUID, aliasID int64) (bool, error) {
	st, err := trackMetadata(ctx, tx, trackID)
	if errors.Is(err, pgx.ErrNoRows) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	if st.edited {
		return false, nil
	}
	cur, curFull, ownerID := st.cur, st.full, st.ownerID
	var alias AliasInput
	err = tx.QueryRow(ctx, `
		SELECT COALESCE(title, ''), COALESCE(artist_names, ''), COALESCE(album_title, '')
		FROM track_aliases WHERE id = $1 AND track_id = $2`, aliasID, trackID).
		Scan(&alias.Title, &alias.ArtistNames, &alias.AlbumTitle)
	if errors.Is(err, pgx.ErrNoRows) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	// Ingest splits artist tags on ", " before joining names with it, so
	// splitting again recovers them. Composers come back as featured.
	var names []string
	for _, name := range strings.Split(alias.ArtistNames, ", ") {
		if name = strings.TrimSpace(name); name != "" {
			names = append(names, name)
		}
	}
	if !FullnessOf(len(names), alias.AlbumTitle).Fuller(curFull) {
		return false, nil
	}

	if err := ReplaceTrackArtists(ctx, tx, trackID, names); err != nil {
		return false, err
	}
	var albumID *uuid.UUID
	if alias.AlbumTitle != "" {
		id, err := aliasAlbum(ctx, tx, alias.AlbumTitle, names, ownerID)
		if err != nil {
			return false, err
		}
		albumID = &id
	}
	if _, err := tx.Exec(ctx, `
		UPDATE tracks SET title = COALESCE(NULLIF($2, ''), title), album_id = $3, updated_at = NOW()
		WHERE id = $1`, trackID, alias.Title, albumID); err != nil {
		return false, err
	}
	if _, err := tx.Exec(ctx, `
		UPDATE track_aliases
		SET title = NULLIF($2, ''), artist_names = NULLIF($3, ''), album_title = NULLIF($4, '')
		WHERE id = $1`, aliasID, cur.Title, cur.ArtistNames, cur.AlbumTitle); err != nil {
		return false, err
	}
	return true, nil
}

// aliasAlbum finds the album an alias's file was filed under. Aliases don't
// record the album artist, but ingest created the album when it read the
// file (and albums are never deleted): prefer one by the alias's primary
// artist, then by another of its artists, then one without an album artist.
// The only album with that title must be the one ingest created, whoever its
// album artist is. Creates one by the primary artist if nothing matches.
func aliasAlbum(ctx context.Context, tx pgx.Tx, title string, artists []string, ownerID *uuid.UUID) (uuid.UUID, error) {
	lower := make([]string, len(artists))
	for i, name := range artists {
		lower[i] = strings.ToLower(dbtext.Clean(name))
	}
	primary := ""
	if len(lower) > 0 {
		primary = lower[0]
	}
	var id uuid.UUID
	err := tx.QueryRow(ctx, `
		SELECT al.id FROM albums al
		LEFT JOIN artists ar ON ar.id = al.album_artist_id
		WHERE al.title = $1 AND (al.album_artist_id IS NULL OR LOWER(ar.name) = ANY($2::text[])
		      OR NOT EXISTS (SELECT 1 FROM albums o WHERE o.title = $1 AND o.id <> al.id))
		ORDER BY LOWER(ar.name) = $3 DESC NULLS LAST, ar.id IS NOT NULL DESC, al.created_at, al.id
		LIMIT 1`, dbtext.Clean(title), lower, primary).Scan(&id)
	if err == nil || !errors.Is(err, pgx.ErrNoRows) {
		return id, err
	}
	var artistID *uuid.UUID
	if len(artists) > 0 {
		aid, err := UpsertArtist(ctx, tx, artists[0])
		if err != nil {
			return uuid.Nil, err
		}
		artistID = &aid
	}
	return UpsertAlbum(ctx, tx, title, artistID, 0, false, "", ownerID)
}
