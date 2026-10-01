package tidaldl

import (
	"context"
	"errors"
	"log/slog"
	"strings"
	"time"

	"github.com/google/uuid"

	"github.com/githubesson/lumen/internal/ingest"
	"github.com/githubesson/lumen/internal/library"
	"github.com/githubesson/lumen/internal/pinscan"
	"github.com/githubesson/lumen/internal/tidal"
)

const (
	defaultMatchInterval = 30 * time.Minute
	// matchBusyInterval follows a full batch, so a library's backlog is
	// worked through steadily rather than once per poll.
	matchBusyInterval = time.Minute
	// defaultMatchPace spaces the matcher's TIDAL calls, which go through the
	// proxy's catalog account.
	defaultMatchPace = time.Second

	matchAlbumsPerPass  = 5
	matchLoosePerPass   = 20
	matchTracksPerAlbum = 50
	matchSearchLimit    = 10
	// Releases fetched to find an album, and tracks searched for when the
	// album search turns up none.
	maxMatchReleases     = 4
	maxMatchAlbumLookups = 3
	// Consecutive failures that end a pass: TIDAL is having a bad time.
	maxMatchFailures = 3
)

// Matcher files the library's own files by TIDAL's metadata, the way
// auto-download files the tracks it saves. It looks each shared local track
// up on TIDAL and, on a confident match, gives it TIDAL's title, artist
// list and ISRC, and files it under the TIDAL release: album, album artist,
// year, disc and number, the release link that shows the whole release on
// the album page, and the release cover when the album has none.
//
// Tracks are matched album by album, so an album's tracks go to the same
// release, and only when at least half of them are on it. Tracks without an
// album are matched one by one. Metadata someone set on purpose (an admin
// edit, an importer, an earlier match) is never changed, and the files
// themselves are never rewritten.
type Matcher struct {
	Store   *Store
	TIDAL   *tidal.Client
	Library *library.Store
	// Ingest stores album covers; without it covers aren't filled.
	Ingest       *ingest.Service
	Logger       *slog.Logger
	PollInterval time.Duration

	// Test seams; zero values mean TIDAL, defaultMatchPace (negative: no
	// pacing), and ingest.ReadISRC.
	source   matchSource
	pace     time.Duration
	readISRC func(path string) string

	lastCall time.Time
}

// matchSource is the part of *tidal.Client the matcher uses.
type matchSource interface {
	SearchTracks(ctx context.Context, query string, limit, offset int) ([]tidal.Track, error)
	SearchAlbums(ctx context.Context, query string, limit, offset int) ([]tidal.Album, int, error)
	FullAlbum(ctx context.Context, id string) (tidal.Album, error)
	CoverBytes(ctx context.Context, coverURL string) ([]byte, error)
}

func (m *Matcher) src() matchSource {
	if m.source != nil {
		return m.source
	}
	return m.TIDAL
}

func (m *Matcher) log() *slog.Logger {
	if m.Logger != nil {
		return m.Logger
	}
	return slog.Default()
}

func (m *Matcher) Run(ctx context.Context) {
	if m == nil || m.Store == nil || m.Library == nil || (m.TIDAL == nil && m.source == nil) {
		return
	}
	interval := m.PollInterval
	if interval <= 0 {
		interval = defaultMatchInterval
	}
	timer := time.NewTimer(pinscan.InitialScanDelay)
	defer timer.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-timer.C:
		}
		next := interval
		if m.pass(ctx) {
			next = matchBusyInterval
		}
		timer.Reset(next)
	}
}

// pass matches a batch of albums and loose tracks. more reports a full
// batch, so more are likely waiting.
func (m *Matcher) pass(ctx context.Context) (more bool) {
	failures := 0
	// stop reports whether the pass should end after an attempt's error.
	stop := func(err error) bool {
		switch {
		case err == nil:
			failures = 0
			return false
		case ctx.Err() != nil:
			return true
		case errors.Is(err, tidal.ErrNotConfigured):
			m.log().Debug("tidal matching paused: tidal proxy is not configured")
			return true
		}
		m.log().Warn("tidal match failed", "err", err)
		failures++
		return failures >= maxMatchFailures
	}
	albums, err := m.Store.PendingMatchAlbums(ctx, matchAlbumsPerPass)
	if err != nil {
		stop(err)
		return false
	}
	for _, id := range albums {
		if stop(m.matchAlbum(ctx, id)) {
			return false
		}
	}
	loose, err := m.Store.PendingMatchLoose(ctx, matchLoosePerPass)
	if err != nil {
		stop(err)
		return false
	}
	for _, t := range loose {
		if stop(m.matchLoose(ctx, t)) {
			return false
		}
	}
	return len(albums) == matchAlbumsPerPass || len(loose) == matchLoosePerPass
}

// wait spaces TIDAL calls by the matcher's pace.
func (m *Matcher) wait(ctx context.Context) error {
	pace := m.pace
	if pace == 0 {
		pace = defaultMatchPace
	}
	if pace > 0 {
		if d := pace - time.Since(m.lastCall); d > 0 {
			t := time.NewTimer(d)
			defer t.Stop()
			select {
			case <-ctx.Done():
				return ctx.Err()
			case <-t.C:
			}
		}
	}
	m.lastCall = time.Now()
	return ctx.Err()
}

// release is a TIDAL release and whether it was fetched from TIDAL rather
// than the store, so it still has to be stored.
type release struct {
	tidal.Album
	fresh bool
}

// lookupRelease returns the full TIDAL release, from the store while it is
// fresh. A stale stored copy still serves when TIDAL can't be reached.
func (m *Matcher) lookupRelease(ctx context.Context, id string) (*release, error) {
	cached, fetchedAt, cacheErr := m.Library.TIDALAlbum(ctx, id)
	if cacheErr == nil && time.Since(fetchedAt) < library.TIDALAlbumMaxAge {
		return &release{Album: cached}, nil
	}
	if cacheErr != nil && !errors.Is(cacheErr, library.ErrNotFound) {
		return nil, cacheErr
	}
	if err := m.wait(ctx); err != nil {
		return nil, err
	}
	fresh, err := m.src().FullAlbum(ctx, id)
	if err != nil {
		if cacheErr == nil {
			return &release{Album: cached}, nil
		}
		return nil, err
	}
	return &release{Album: fresh, fresh: true}, nil
}

// keep stores a release fetched from TIDAL, which the album page of a
// library album linked to it reads.
func (m *Matcher) keep(ctx context.Context, r *release) error {
	if !r.fresh {
		return nil
	}
	if err := m.Library.SaveTIDALAlbum(ctx, r.Album); err != nil {
		return err
	}
	r.fresh = false
	return nil
}

// fillISRCs reads the ISRC tag of tracks the library has none for: files
// ingested before ISRCs were read carry it too.
func (m *Matcher) fillISRCs(tracks []MatchTrack) {
	read := m.readISRC
	if read == nil {
		read = ingest.ReadISRC
	}
	for i := range tracks {
		if tracks[i].ISRC == "" && tracks[i].FilePath != "" {
			tracks[i].ISRC = read(tracks[i].FilePath)
		}
	}
}

// matchAlbum matches the waiting tracks of one library album against a
// single TIDAL release. An album already linked to a release (auto-download
// saved some of it) keeps its tracks and takes their metadata from that
// release. Otherwise it is the release that lists the most of them, found by
// album search or, failing that, by searching for a few of its tracks, and
// it is used only when it lists at least half of them; the rest are then
// filed under it as well, so the album stays together. Otherwise none are
// changed.
func (m *Matcher) matchAlbum(ctx context.Context, albumID uuid.UUID) error {
	album, tracks, err := m.Store.MatchAlbumTracks(ctx, albumID, matchTracksPerAlbum)
	if err != nil || len(tracks) == 0 {
		return err
	}
	m.fillISRCs(tracks)
	r, err := m.albumRelease(ctx, album, tracks)
	if err != nil {
		m.recordAll(ctx, tracks, MatchOutcome{Status: MatchFailed, Error: err.Error()}, err)
		return err
	}
	if r == nil {
		m.recordAll(ctx, tracks, MatchOutcome{Status: MatchUnmatched, Error: "no TIDAL release lists this album's tracks"}, nil)
		return nil
	}
	if err := m.keep(ctx, r); err != nil {
		m.recordAll(ctx, tracks, MatchOutcome{Status: MatchFailed, Error: err.Error()}, err)
		return err
	}
	linked := album.TIDALAlbumID != ""
	fields := releaseFields(r.Album)
	for _, t := range tracks {
		if ctx.Err() != nil {
			return ctx.Err()
		}
		if hit, ok := findInRelease(r.Album, t); ok {
			if err := m.apply(ctx, t, hit, linked); err != nil {
				return err
			}
			continue
		}
		// Not on the release: kept with the rest of its album.
		if !linked {
			if _, err := m.Library.FileUnderTIDALRelease(ctx, t.ID, fields); err != nil {
				m.recordErr(ctx, t, err)
				return err
			}
		}
		m.record(ctx, t, MatchOutcome{Status: MatchUnmatched, TIDALAlbumID: r.ID, Error: "not on the album's TIDAL release"})
	}
	return nil
}

// albumRelease finds the TIDAL release for an album's tracks, or nil.
func (m *Matcher) albumRelease(ctx context.Context, album MatchAlbum, tracks []MatchTrack) (*release, error) {
	if album.TIDALAlbumID != "" {
		return m.lookupRelease(ctx, album.TIDALAlbumID)
	}
	need := (len(tracks) + 1) / 2
	var (
		best    *release
		bestHit int
	)
	tried := map[string]bool{}
	consider := func(id string) error {
		if id == "" || tried[id] || len(tried) >= maxMatchReleases {
			return nil
		}
		tried[id] = true
		r, err := m.lookupRelease(ctx, id)
		if err != nil {
			return err
		}
		hits := countInRelease(r.Album, tracks)
		if hits > bestHit || (hits == bestHit && hits > 0 && betterRelease(r.Album, best.Album, album, len(tracks))) {
			best, bestHit = r, hits
		}
		return nil
	}

	artist := albumSearchArtist(album, tracks)
	if err := m.wait(ctx); err != nil {
		return nil, err
	}
	found, _, err := m.src().SearchAlbums(ctx, strings.TrimSpace(artist+" "+album.Title), matchSearchLimit, 0)
	if err != nil {
		return nil, err
	}
	want := matchAlbum(album.Title)
	for _, c := range found {
		if bestHit == len(tracks) {
			break
		}
		if want == "" || matchAlbum(c.Title) != want || !releaseByArtist(c, album, tracks) {
			continue
		}
		if err := consider(c.ID); err != nil {
			return nil, err
		}
	}
	// The album search can miss a release a track search finds.
	lookups := 0
	for _, t := range tracks {
		if bestHit >= need || lookups >= maxMatchAlbumLookups {
			break
		}
		if best != nil {
			if _, ok := findInRelease(best.Album, t); ok {
				continue
			}
		}
		if !searchable(t) {
			continue
		}
		lookups++
		c, ok, err := m.searchTrack(ctx, t, album.Title)
		if err != nil {
			return nil, err
		}
		if ok {
			if err := consider(c.AlbumID); err != nil {
				return nil, err
			}
		}
	}
	if bestHit < need || bestHit == 0 {
		return nil, nil
	}
	return best, nil
}

// albumSearchArtist is who an album search names: the album artist, else the
// artist most of its tracks credit first.
func albumSearchArtist(album MatchAlbum, tracks []MatchTrack) string {
	if a := strings.TrimSpace(album.Artist); a != "" && !isVariousArtists(a) {
		return a
	}
	counts := map[string]int{}
	best := ""
	for _, t := range tracks {
		if len(t.Artists) == 0 {
			continue
		}
		a := t.Artists[0]
		counts[a]++
		if counts[a] > counts[best] {
			best = a
		}
	}
	return best
}

// releaseByArtist reports whether a release is by the album's artist: its
// album artist, or for an album without one (ingest treats those as
// compilations) any of its tracks' artists or Various Artists.
func releaseByArtist(c tidal.Album, album MatchAlbum, tracks []MatchTrack) bool {
	names := c.Artists
	if len(names) == 0 && c.Artist != "" {
		names = []string{c.Artist}
	}
	if a := strings.TrimSpace(album.Artist); a != "" && !isVariousArtists(a) {
		return artistsOverlap([]string{a}, names)
	}
	if isVariousArtists(c.Artist) {
		return true
	}
	for _, t := range tracks {
		if artistsOverlap(t.Artists, names) {
			return true
		}
	}
	return false
}

// betterRelease breaks a tie between two releases listing as many of the
// album's tracks: the exact title, then the album's year, then the track
// count closest to the album's.
func betterRelease(a, b tidal.Album, album MatchAlbum, tracks int) bool {
	exact := func(r tidal.Album) bool {
		return strings.EqualFold(strings.TrimSpace(r.Title), strings.TrimSpace(album.Title))
	}
	if exact(a) != exact(b) {
		return exact(a)
	}
	if album.Year > 0 && (a.ReleaseYear == album.Year) != (b.ReleaseYear == album.Year) {
		return a.ReleaseYear == album.Year
	}
	return abs(len(a.Tracks)-tracks) < abs(len(b.Tracks)-tracks)
}

// countInRelease counts the tracks a release lists.
func countInRelease(r tidal.Album, tracks []MatchTrack) int {
	n := 0
	for _, t := range tracks {
		if _, ok := findInRelease(r, t); ok {
			n++
		}
	}
	return n
}

// findInRelease finds a library track on a release: the same ISRC first,
// then a listed (not removed) track, then the same position, then the
// closest duration. The result carries the release's album metadata.
func findInRelease(r tidal.Album, t MatchTrack) (tidal.Track, bool) {
	best, bestScore := -1, -1
	for i, c := range r.Tracks {
		if !trackMatches(t, c, true) {
			continue
		}
		score := 0
		if sameISRC(t.ISRC, c.ISRC) {
			score += 8
		}
		if !c.Removed {
			score += 4
		}
		if t.TrackNo > 0 && t.TrackNo == c.TrackNo && max(t.DiscNo, 1) == max(c.DiscNo, 1) {
			score += 2
		}
		if score > bestScore || (score == bestScore &&
			abs(t.DurationMS-c.DurationMS) < abs(t.DurationMS-r.Tracks[best].DurationMS)) {
			best, bestScore = i, score
		}
	}
	if best < 0 {
		return tidal.Track{}, false
	}
	hit := r.Tracks[best]
	if hit.AlbumID == "" {
		hit.AlbumID = r.ID
	}
	return fromRelease(hit, r), true
}

// searchable reports whether a track search could confirm a hit: that takes
// an artist or an ISRC.
func searchable(t MatchTrack) bool {
	return len(t.Artists) > 0 || t.ISRC != ""
}

// searchTrack looks a track up by artist and title and picks the hit for its
// recording. With albumTitle set the hit must be on a release of that title.
func (m *Matcher) searchTrack(ctx context.Context, t MatchTrack, albumTitle string) (tidal.Track, bool, error) {
	query := featTailRe.ReplaceAllString(featGroupRe.ReplaceAllString(t.Title, " "), "")
	if len(t.Artists) > 0 {
		query = t.Artists[0] + " " + query
	}
	if err := m.wait(ctx); err != nil {
		return tidal.Track{}, false, err
	}
	found, err := m.src().SearchTracks(ctx, strings.Join(strings.Fields(query), " "), matchSearchLimit, 0)
	if err != nil {
		return tidal.Track{}, false, err
	}
	hit, ok := pickTrack(found, t, albumTitle)
	return hit, ok, nil
}

// pickTrack picks the search hit for a library track's recording: the same
// ISRC first, then (without an album to match) a release of the track's own
// artist over a compilation, then the exact title, then TIDAL's order.
func pickTrack(found []tidal.Track, t MatchTrack, albumTitle string) (tidal.Track, bool) {
	want := matchAlbum(albumTitle)
	best, bestScore := -1, -1
	for i, c := range found {
		if strings.TrimSpace(c.ID) == "" || !trackMatches(t, c, false) {
			continue
		}
		if albumTitle != "" && matchAlbum(c.AlbumTitle) != want {
			continue
		}
		score := 0
		if sameISRC(t.ISRC, c.ISRC) {
			score += 4
		}
		if albumTitle == "" && !isVariousArtists(c.AlbumArtist) {
			score += 2
		}
		if strings.EqualFold(strings.TrimSpace(c.Title), strings.TrimSpace(t.Title)) {
			score++
		}
		if score > bestScore {
			best, bestScore = i, score
		}
	}
	if best < 0 {
		return tidal.Track{}, false
	}
	return found[best], true
}

// matchLoose matches a track that has no album to go by, on its own.
func (m *Matcher) matchLoose(ctx context.Context, t MatchTrack) error {
	ts := []MatchTrack{t}
	m.fillISRCs(ts)
	t = ts[0]
	if !searchable(t) {
		m.record(ctx, t, MatchOutcome{Status: MatchUnmatched, Error: "no artist or ISRC to search by"})
		return nil
	}
	c, ok, err := m.searchTrack(ctx, t, "")
	if err != nil {
		m.recordErr(ctx, t, err)
		return err
	}
	if !ok {
		m.record(ctx, t, MatchOutcome{Status: MatchUnmatched, Error: "no TIDAL track matches"})
		return nil
	}
	hit := c
	if c.AlbumID != "" {
		r, err := m.lookupRelease(ctx, c.AlbumID)
		if err != nil {
			m.recordErr(ctx, t, err)
			return err
		}
		if err := m.keep(ctx, r); err != nil {
			m.recordErr(ctx, t, err)
			return err
		}
		hit = fromRelease(c, r.Album)
		for _, rt := range r.Tracks {
			if rt.ID == c.ID {
				hit = fromRelease(rt, r.Album)
				break
			}
		}
		if hit.AlbumID == "" {
			hit.AlbumID = r.ID
		}
	}
	return m.apply(ctx, t, hit, false)
}

// apply gives a library track a TIDAL track's metadata and records the
// match; with keepAlbum the track stays in its album, which is linked to the
// hit's release. A track edited or removed meanwhile is left alone.
func (m *Matcher) apply(ctx context.Context, t MatchTrack, hit tidal.Track, keepAlbum bool) error {
	// The file's own ISRC wins: TIDAL may list its audio under another
	// release's code.
	isrc := t.ISRC
	if isrc == "" {
		isrc = hit.ISRC
	}
	fields := library.TIDALTrackFields{
		Title:     hit.Title,
		Artists:   hit.Artists,
		ISRC:      ingest.NormalizeISRC(isrc),
		KeepAlbum: keepAlbum,
	}
	if strings.TrimSpace(hit.AlbumTitle) != "" {
		fields.Album = library.TIDALAlbumFields{
			TIDALAlbumID: hit.AlbumID,
			Title:        hit.AlbumTitle,
			Artist:       hit.AlbumArtist,
			Year:         hit.Year,
			TrackNo:      hit.TrackNo,
			DiscNo:       hit.DiscNo,
		}
	}
	applied, err := m.Library.ApplyTIDALMatch(ctx, t.ID, fields)
	if err != nil {
		m.recordErr(ctx, t, err)
		return err
	}
	if !applied {
		return nil
	}
	m.record(ctx, t, MatchOutcome{Status: MatchMatched, TIDALID: hit.ID, TIDALAlbumID: hit.AlbumID})
	m.log().Info("tidal match applied", "track", t.ID, "tidal_track", hit.ID, "tidal_album", hit.AlbumID,
		"title", hit.Title)
	m.fillCover(ctx, t.ID, hit.CoverURL)
	return nil
}

// fillCover gives a matched track's album the release cover when it has no
// artwork of its own.
func (m *Matcher) fillCover(ctx context.Context, trackID uuid.UUID, coverURL string) {
	if m.Ingest == nil || coverURL == "" {
		return
	}
	if has, err := m.Store.TrackAlbumHasCover(ctx, trackID); err != nil || has {
		return
	}
	if err := m.wait(ctx); err != nil {
		return
	}
	data, err := m.src().CoverBytes(ctx, coverURL)
	if err != nil {
		m.log().Warn("tidal match cover fetch failed", "track", trackID, "err", err)
		return
	}
	key, err := m.Ingest.StoreCoverImage(ctx, data, "")
	if err != nil {
		m.log().Warn("tidal match cover store failed", "track", trackID, "err", err)
		return
	}
	if err := m.Library.SetTrackAlbumCover(ctx, trackID, key); err != nil {
		m.log().Warn("tidal match cover update failed", "track", trackID, "err", err)
	}
}

// releaseFields is a release as album fields, for tracks filed under it
// without a match of their own.
func releaseFields(r tidal.Album) library.TIDALAlbumFields {
	return library.TIDALAlbumFields{
		TIDALAlbumID: r.ID,
		Title:        r.Title,
		Artist:       r.Artist,
		Year:         r.ReleaseYear,
	}
}

func (m *Matcher) record(ctx context.Context, t MatchTrack, o MatchOutcome) {
	if err := m.Store.RecordMatch(ctx, t.ID, o); err != nil && ctx.Err() == nil {
		m.log().Warn("tidal match outcome not recorded", "track", t.ID, "err", err)
	}
}

// recordErr records a failed attempt, unless it failed because TIDAL isn't
// set up or the matcher is stopping: neither says anything about the track.
func (m *Matcher) recordErr(ctx context.Context, t MatchTrack, err error) {
	if ctx.Err() != nil || errors.Is(err, tidal.ErrNotConfigured) {
		return
	}
	m.record(ctx, t, MatchOutcome{Status: MatchFailed, Error: err.Error()})
}

func (m *Matcher) recordAll(ctx context.Context, tracks []MatchTrack, o MatchOutcome, cause error) {
	for _, t := range tracks {
		if cause != nil {
			m.recordErr(ctx, t, cause)
			continue
		}
		m.record(ctx, t, o)
	}
}
