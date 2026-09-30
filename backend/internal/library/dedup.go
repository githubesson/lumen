package library

import (
	"context"
	"errors"
	"regexp"
	"slices"
	"strings"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/githubesson/lumen/internal/dbtext"
	"github.com/githubesson/lumen/internal/dbutil"
)

// CatchAllAlbum is the album ingest files a track under when its file has
// neither an artist nor an album tag. It doesn't count as knowing the album.
// A real album can share the title, so the catch-all is only that title with
// no album artist, on a copy without artists: exactly what ingest assigns.
const CatchAllAlbum = "Others"

// Fullness ranks how well one copy's metadata identifies a track: artists
// first, then a real album. When several files share the same audio, the
// fullest copy's metadata is the one shown, and the others become aliases,
// unless someone set the track's metadata on purpose (metadata_edited_at).
type Fullness struct {
	HasArtists bool
	HasAlbum   bool
}

// IsCatchAll reports whether an album is the catch-all as ingest files it:
// the CatchAllAlbum title without an album artist, on a copy without
// artists. A file tagged just that way lands on the same row, so it counts
// too. trackHasAlbum and aliasHasAlbum are the same test in SQL.
func IsCatchAll(album string, albumArtistID *uuid.UUID, artists int) bool {
	return album == CatchAllAlbum && albumArtistID == nil && artists == 0
}

// aliasFullness ranks an alias's recorded performers and album title. Aliases
// don't keep the album artist, so it's taken to be absent.
func aliasFullness(artists int, album string) Fullness {
	return Fullness{HasArtists: artists > 0, HasAlbum: album != "" && !IsCatchAll(album, nil, artists)}
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
	trackHasAlbum   = `EXISTS (SELECT 1 FROM albums fal WHERE fal.id = t.album_id
		AND NOT (fal.title = '` + CatchAllAlbum + `' AND fal.album_artist_id IS NULL AND NOT ` + trackHasArtists + `))`
	aliasHasArtists = `COALESCE(al.artist_names, '') <> ''`
	aliasHasAlbum   = `COALESCE(al.album_title, '') <> ''
		AND NOT (al.album_title = '` + CatchAllAlbum + `' AND NOT ` + aliasHasArtists + `)`
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
		                 WHERE ta.track_id = t.id AND ta.role <> 'composer'), ''),
		       COALESCE((SELECT a.title FROM albums a WHERE a.id = t.album_id), ''),
		       `+trackHasArtists+`, `+trackHasAlbum+`
		FROM tracks t
		WHERE t.id = $1 AND t.deleted_at IS NULL AND t.source = 'local'
		FOR UPDATE`, trackID).
		Scan(&st.cur.FilePath, &st.cur.Title, &st.ownerID, &st.edited,
			&st.cur.ArtistNames, &st.cur.AlbumTitle, &st.full.HasArtists, &st.full.HasAlbum)
	return st, err
}

// AdoptDuplicate lets a deduplicated copy take a track over when its metadata
// (ranked by full) is fuller than the track's and wasn't edited on purpose:
// the track takes the copy's tags, and its old title/artists/album are kept
// as an alias. Normally the copy becomes the track's file too, and the old
// path is returned for the caller to remove. With keepFile the track keeps
// its file (the caller won't trade a managed copy for one in a read-only
// root): the copy stays an alias, holding the old tags and marked
// tags_swapped. adopted is false when nothing changed.
func AdoptDuplicate(ctx context.Context, q pgx.Tx, trackID uuid.UUID, full Fullness, t TrackInsert,
	artistIDs []uuid.UUID, roles []string, keepFile bool) (oldPath string, adopted bool, err error) {
	if !full.Fuller(Fullness{}) {
		return "", false, nil // nothing is less full
	}
	st, err := trackMetadata(ctx, q, trackID)
	if errors.Is(err, pgx.ErrNoRows) {
		return "", false, nil
	}
	if err != nil {
		return "", false, err
	}
	if st.edited || !full.Fuller(st.full) {
		return "", false, nil
	}
	cur := st.cur

	t.Title = dbtext.Clean(t.Title)
	t.Genre = dbtext.Clean(t.Genre)
	t.Composer = dbtext.Clean(t.Composer)
	t.Comments = dbtext.Clean(t.Comments)
	t.Format = dbtext.Clean(t.Format)
	if err := cleanTrackFilePath(&t); err != nil {
		return "", false, err
	}
	if err := unswapTags(ctx, q, trackID, &cur); err != nil {
		return "", false, err
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
			file_path = CASE WHEN $13 THEN file_path ELSE $10 END,
			file_size = CASE WHEN $13 THEN file_size ELSE $11 END,
			format = CASE WHEN $13 THEN format ELSE $12 END,
			updated_at = NOW()
		WHERE id = $1`,
		trackID, t.AlbumID, t.Title, t.TrackNo, t.DiscNo, t.Genre, t.Year, t.Composer,
		t.Comments, t.FilePath, t.FileSize, t.Format, keepFile); err != nil {
		return "", false, err
	}
	if err := relinkArtists(ctx, q, trackID, artistIDs, roles, t.Composer != ""); err != nil {
		return "", false, err
	}
	if keepFile {
		if _, err := q.Exec(ctx, `
			INSERT INTO track_aliases (track_id, file_path, title, artist_names, album_title, tags_swapped)
			VALUES ($1, $2, NULLIF($3, ''), NULLIF($4, ''), NULLIF($5, ''), TRUE)
			ON CONFLICT (track_id, file_path) DO UPDATE SET
				title = EXCLUDED.title, artist_names = EXCLUDED.artist_names,
				album_title = EXCLUDED.album_title, tags_swapped = TRUE, unranked = FALSE`,
			trackID, t.FilePath, cur.Title, cur.ArtistNames, cur.AlbumTitle); err != nil {
			return "", false, err
		}
		return "", true, nil
	}
	// The new canonical file may have been recorded as an alias by an earlier
	// ingest; the old one becomes an alias now that it no longer is canonical.
	if _, err := q.Exec(ctx, `DELETE FROM track_aliases WHERE track_id = $1 AND file_path = $2`, trackID, t.FilePath); err != nil {
		return "", false, err
	}
	if err := RecordAlias(ctx, q, trackID, cur); err != nil {
		return "", false, err
	}
	return cur.FilePath, true, nil
}

// unswapTags undoes a tag swap before another: when the track's tags came from
// a tags_swapped alias's file, that alias gets them back (they're cur's) and
// cur takes the tags the track's own file carries, which the alias held.
func unswapTags(ctx context.Context, q pgx.Tx, trackID uuid.UUID, cur *AliasInput) error {
	var id int64
	var own AliasInput
	err := q.QueryRow(ctx, `
		SELECT id, COALESCE(title, ''), COALESCE(artist_names, ''), COALESCE(album_title, '')
		FROM track_aliases WHERE track_id = $1 AND tags_swapped`, trackID).
		Scan(&id, &own.Title, &own.ArtistNames, &own.AlbumTitle)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil
	}
	if err != nil {
		return err
	}
	if _, err := q.Exec(ctx, `
		UPDATE track_aliases
		SET title = NULLIF($2, ''), artist_names = NULLIF($3, ''), album_title = NULLIF($4, ''),
		    tags_swapped = FALSE
		WHERE id = $1`, id, cur.Title, cur.ArtistNames, cur.AlbumTitle); err != nil {
		return err
	}
	cur.Title, cur.ArtistNames, cur.AlbumTitle = own.Title, own.ArtistNames, own.AlbumTitle
	return nil
}

// relinkArtists replaces a track's credits with the given ones. Its composer
// credits stay unless the new tags name a composer, matching how the
// composer column keeps its value when a copy lacks the tag.
func relinkArtists(ctx context.Context, q pgx.Tx, trackID uuid.UUID, artistIDs []uuid.UUID, roles []string, newComposer bool) error {
	if _, err := q.Exec(ctx, `
		DELETE FROM track_artists WHERE track_id = $1 AND ($2 OR role <> 'composer')`, trackID, newComposer); err != nil {
		return err
	}
	return LinkTrackArtists(ctx, q, trackID, artistIDs, roles)
}

// AdoptFullerAliases repairs tracks deduplicated before ingest compared
// copies, where an untagged original that arrived first kept the track while
// the tagged copy only became an alias. The fullest such alias swaps its
// title, artists and album with the track's, and is marked tags_swapped. The
// file stays put: ingest normally removed the tagged copy, which is why only
// what the alias recorded can move. Tracks whose metadata was edited on
// purpose are left alone.
//
// It runs once per alias recorded before ingest compared copies (unranked):
// later aliases were compared when recorded, and rerunning it would undo
// deliberate edits to merged tracks. Returns how many tracks changed.
func (s *Store) AdoptFullerAliases(ctx context.Context) (int, error) {
	// Every fuller alias, fullest and then oldest first per track: when one's
	// credits are ambiguous, the next may still settle the track.
	rows, err := s.db.Query(ctx, `
		SELECT t.id, al.id
		FROM track_aliases al
		JOIN tracks t ON t.id = al.track_id
		WHERE al.unranked
		  AND t.deleted_at IS NULL AND t.source = 'local' AND t.metadata_edited_at IS NULL
		  AND ROW(`+aliasHasArtists+`, `+aliasHasAlbum+`) > ROW(`+trackHasArtists+`, `+trackHasAlbum+`)
		ORDER BY t.id, `+aliasHasArtists+` DESC, `+aliasHasAlbum+` DESC, al.id`)
	if err != nil {
		return 0, err
	}
	type candidate struct {
		trackID  uuid.UUID
		aliasIDs []int64
	}
	var candidates []candidate
	for rows.Next() {
		var trackID uuid.UUID
		var aliasID int64
		if err := rows.Scan(&trackID, &aliasID); err != nil {
			rows.Close()
			return 0, err
		}
		if n := len(candidates); n > 0 && candidates[n-1].trackID == trackID {
			candidates[n-1].aliasIDs = append(candidates[n-1].aliasIDs, aliasID)
		} else {
			candidates = append(candidates, candidate{trackID, []int64{aliasID}})
		}
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return 0, err
	}

	adopted := 0
	for _, c := range candidates {
		changed := false
		err := dbutil.WithTx(ctx, s.db, func(tx pgx.Tx) error {
			for _, aliasID := range c.aliasIDs {
				var err error
				if changed, err = adoptAlias(ctx, tx, c.trackID, aliasID); err != nil || changed {
					return err
				}
			}
			return nil
		})
		if err != nil {
			return adopted, err
		}
		if changed {
			adopted++
		}
	}
	// Every unranked alias has now been checked; a failure above returns
	// first, so the ones not reached get another chance.
	if _, err := s.db.Exec(ctx, `UPDATE track_aliases SET unranked = FALSE WHERE unranked`); err != nil {
		return adopted, err
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
	// splitting again recovers them.
	var names []string
	for _, name := range strings.Split(alias.ArtistNames, ", ") {
		if name = strings.TrimSpace(name); name != "" {
			names = append(names, name)
		}
	}
	if !aliasFullness(len(names), alias.AlbumTitle).Fuller(curFull) {
		return false, nil
	}

	roles, ok, err := legacyAliasRoles(ctx, tx, alias.Title, names)
	if err != nil || !ok {
		return false, err
	}
	artistIDs := make([]uuid.UUID, len(names))
	for i, name := range names {
		if artistIDs[i], err = UpsertArtist(ctx, tx, name); err != nil {
			return false, err
		}
	}
	if err := relinkArtists(ctx, tx, trackID, artistIDs, roles, slices.Contains(roles, "composer")); err != nil {
		return false, err
	}
	// At most one alias holds swapped tags: undo an earlier swap first.
	if err := unswapTags(ctx, tx, trackID, &cur); err != nil {
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
	// A composer credit replaced above replaces the composer column too.
	composer := ""
	if i := slices.Index(roles, "composer"); i >= 0 {
		composer = dbtext.Clean(names[i])
	}
	if _, err := tx.Exec(ctx, `
		UPDATE tracks SET title = COALESCE(NULLIF($2, ''), title), album_id = $3,
			composer = COALESCE(NULLIF($4, ''), composer), updated_at = NOW()
		WHERE id = $1`, trackID, alias.Title, albumID, composer); err != nil {
		return false, err
	}
	if _, err := tx.Exec(ctx, `
		UPDATE track_aliases
		SET title = NULLIF($2, ''), artist_names = NULLIF($3, ''), album_title = NULLIF($4, ''),
		    tags_swapped = TRUE
		WHERE id = $1`, aliasID, cur.Title, cur.ArtistNames, cur.AlbumTitle); err != nil {
		return false, err
	}
	return true, nil
}

// legacyAliasRoles credits the names of an alias recorded before aliases left
// composers out. The first is the primary artist and any middle ones are
// featured; ingest appended a composer tag last, so the last name is either.
// It's featured when the alias's own title names them ("(with X)"),
// otherwise the library's credits must settle it: only ever a composer, or
// only ever a performer. ok is false when nothing does, and the alias is
// left for someone to resolve by hand.
func legacyAliasRoles(ctx context.Context, tx pgx.Tx, title string, names []string) (roles []string, ok bool, err error) {
	roles = make([]string, len(names))
	for i := range roles {
		roles[i] = "featured"
	}
	if len(names) == 0 {
		return roles, true, nil
	}
	roles[0] = "primary"
	last := names[len(names)-1]
	if len(names) == 1 || titleCredits(title, last) {
		return roles, true, nil
	}
	var composer, performer int
	err = tx.QueryRow(ctx, `
		SELECT COUNT(*) FILTER (WHERE ta.role = 'composer'), COUNT(*) FILTER (WHERE ta.role <> 'composer')
		FROM track_artists ta JOIN artists ar ON ar.id = ta.artist_id
		WHERE LOWER(ar.name) = LOWER($1)`, dbtext.Clean(last)).Scan(&composer, &performer)
	switch {
	case err != nil:
		return nil, false, err
	case composer > 0 && performer == 0:
		roles[len(roles)-1] = "composer"
		return roles, true, nil
	case performer > 0 && composer == 0:
		return roles, true, nil
	}
	return nil, false, nil
}

// creditMarker finds a title's guest credits: what follows "with", "feat.",
// "ft." or "featuring", up to the end of its brackets.
var creditMarker = regexp.MustCompile(`(?i)(?:^|[\s(\[])(?:with|feat\.?|ft\.?|featuring)\s+([^)\]]+)`)

// creditSeparator splits a credit list the way ingest splits artist tags.
var creditSeparator = regexp.MustCompile(`(?i)\s*(?:,|&|\band\b|\bx\b)\s*`)

// titleCredits reports whether a title credits name as a guest, as in
// "Song (with A & B)"; merely containing the name doesn't count.
func titleCredits(title, name string) bool {
	for _, m := range creditMarker.FindAllStringSubmatch(title, -1) {
		for _, credited := range creditSeparator.Split(m[1], -1) {
			if strings.EqualFold(strings.TrimSpace(credited), strings.TrimSpace(name)) {
				return true
			}
		}
	}
	return false
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
