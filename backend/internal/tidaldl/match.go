package tidaldl

import (
	"context"
	"errors"
	"log/slog"
	"sort"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

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

	matchAlbumsPerPass = 5
	matchLoosePerPass  = 20
	matchCoversPerPass = 10
	// A release is judged against all of an album's waiting tracks at once;
	// an "album" with more tracks than this is a catch-all folder, not a
	// release.
	matchMaxAlbumTracks = 200
	matchSearchLimit    = 10
	// Releases fetched to find an album, and tracks searched for when the
	// album search turns up none.
	maxMatchReleases     = 4
	maxMatchAlbumLookups = 3
	// Releases a loose track's hits are checked against before settling for
	// a compilation.
	maxLooseReleases = 2
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
	// coverMissed holds the albums whose cover failed this pass, so their
	// other tracks wait for the retry rather than fetching it again.
	coverMissed map[uuid.UUID]bool
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
		} else if at, ok, err := m.Store.NextMatchRetry(ctx); err == nil && ok {
			// A failed lookup's backoff can be shorter than the poll.
			next = min(next, max(time.Until(at), matchBusyInterval))
		}
		timer.Reset(next)
	}
}

// pass matches a batch of albums and loose tracks. more reports a full
// batch, so more are likely waiting.
func (m *Matcher) pass(ctx context.Context) (more bool) {
	m.coverMissed = nil
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
	m.backfillCovers(ctx)
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
// changed. The chosen release is noted for the album before any track is
// changed, so an attempt cut short finishes on the same release. An album
// waits while any of its waiting tracks is still settling.
func (m *Matcher) matchAlbum(ctx context.Context, albumID uuid.UUID) error {
	album, tracks, err := m.Store.MatchAlbumTracks(ctx, albumID, matchMaxAlbumTracks)
	if err != nil || len(tracks) == 0 || album.Unsettled {
		return err
	}
	if album.Tracks > matchMaxAlbumTracks {
		if err := m.Store.RecordAlbumUnmatched(ctx, album.ID, "too many tracks for one release"); err != nil {
			return err
		}
		return nil
	}
	if album.Chosen != "" {
		// Only the tracks the choice was judged on finish under it; any
		// added since are judged once it is done.
		judged := map[uuid.UUID]bool{}
		for _, id := range album.ChosenTracks {
			judged[id] = true
		}
		kept := tracks[:0]
		for _, t := range tracks {
			if judged[t.ID] {
				kept = append(kept, t)
			}
		}
		if tracks = kept; len(tracks) == 0 {
			return m.Store.ReleaseDone(ctx, album.ID)
		}
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
	if !linked && album.Chosen != r.ID {
		// Nothing changes unless the choice is noted, and only while the
		// album still holds the tracks it was judged on.
		ids := make([]uuid.UUID, len(tracks))
		for i, t := range tracks {
			ids[i] = t.ID
		}
		noted, err := m.Store.ChooseRelease(ctx, album.ID, r.ID, ids)
		if err != nil || !noted {
			return err
		}
	}
	fields := releaseFields(r.Album)
	hits := assignRelease(r.Album, tracks, linked)
	for i, t := range tracks {
		if ctx.Err() != nil {
			return ctx.Err()
		}
		if hit, ok := hits[i]; ok {
			if err := m.apply(ctx, t, hit, linked); err != nil {
				return err
			}
			continue
		}
		// Not on the release: kept with the rest of its album, the outcome
		// noted in the same transaction.
		o := MatchOutcome{Status: MatchUnmatched, TIDALAlbumID: r.ID, Error: "not on the album's TIDAL release"}
		if linked {
			m.record(ctx, t, o)
			continue
		}
		_, err := m.Library.FileUnderTIDALRelease(ctx, t.ID, t.source(), fields,
			func(ctx context.Context, tx pgx.Tx) error { return recordMatch(ctx, tx, t.ID, o) })
		if errors.Is(err, library.ErrTIDALAlbumConflict) {
			m.record(ctx, t, MatchOutcome{Status: MatchUnmatched, Error: err.Error()})
			continue
		}
		if err != nil {
			m.recordErr(ctx, t, err)
			return err
		}
		// Not filed: moved, edited or changed meanwhile, so judged afresh.
	}
	if !linked {
		if err := m.Store.ReleaseDone(ctx, album.ID); err != nil && ctx.Err() == nil {
			m.log().Warn("tidal match album choice not cleared", "album", album.ID, "err", err)
		}
	}
	return nil
}

// albumRelease finds the TIDAL release for an album's tracks, or nil.
func (m *Matcher) albumRelease(ctx context.Context, album MatchAlbum, tracks []MatchTrack) (*release, error) {
	if album.TIDALAlbumID != "" {
		return m.lookupRelease(ctx, album.TIDALAlbumID)
	}
	if album.Chosen != "" {
		// An attempt cut short chose it with the whole album in view.
		return m.lookupRelease(ctx, album.Chosen)
	}
	need := (len(tracks) + 1) / 2
	var (
		best    *release
		bestHit int
		onBest  map[int]tidal.Track
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
		// Strict: a release isn't vouched for until it is chosen.
		on := assignRelease(r.Album, tracks, false)
		hits := len(on)
		if hits > bestHit || (hits == bestHit && hits > 0 && betterRelease(r.Album, best.Album, album, len(tracks))) {
			best, bestHit, onBest = r, hits, on
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
	// The album search can miss a release a track search finds; tracks the
	// best release so far doesn't list may lead to a fuller one.
	lookups := 0
	for i, t := range tracks {
		if bestHit == len(tracks) || lookups >= maxMatchAlbumLookups {
			break
		}
		if _, ok := onBest[i]; ok {
			continue
		}
		if !searchable(t) {
			continue
		}
		lookups++
		hits, err := m.searchTrack(ctx, t, album.Title)
		if err != nil {
			return nil, err
		}
		// Every release the hits name, best first, while the budget lasts.
		for _, h := range hits {
			if err := consider(h.AlbumID); err != nil {
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

// assignRelease pairs an album's tracks (by index) with a release's
// entries, one to one, so one entry can't stand for several tracks. As many
// tracks as possible are paired; among those pairings, stronger pairs come
// first: the same ISRC, then a listed (not removed) entry, then the same
// position, then the closest duration. relaxed is trackMatches'. The entries
// carry the release's album metadata.
func assignRelease(r tidal.Album, tracks []MatchTrack, relaxed bool) map[int]tidal.Track {
	entryTitles := make([]string, len(r.Tracks))
	for j, c := range r.Tracks {
		entryTitles[j] = matchTitle(c.Title)
	}
	var pairs []assignPair
	for i, t := range tracks {
		title := matchTitle(t.Title)
		for j, c := range r.Tracks {
			if !titledMatch(t, c, title, entryTitles[j], relaxed) {
				continue
			}
			// Tiers, each outweighing everything below it across a whole
			// pairing: the same ISRC, a listed entry, the same position,
			// then the closest duration.
			cost := int64(min(abs(t.DurationMS-c.DurationMS), assignDurationCap))
			if t.TrackNo > 0 && t.TrackNo == c.TrackNo && max(t.DiscNo, 1) == max(c.DiscNo, 1) {
				cost -= assignPositionWeight
			}
			if !c.Removed {
				cost -= assignListedWeight
			}
			if sameISRC(t.ISRC, c.ISRC) {
				cost -= assignISRCWeight
			}
			pairs = append(pairs, assignPair{track: i, entry: j, cost: cost})
		}
	}
	out := map[int]tidal.Track{}
	for track, e := range minCostMatching(len(tracks), pairs) {
		hit := r.Tracks[e]
		if hit.AlbumID == "" {
			hit.AlbumID = r.ID
		}
		out[track] = fromRelease(hit, r)
	}
	return out
}

// Pair cost tiers. A pairing holds at most matchMaxAlbumTracks pairs, so
// each weight exceeds that many of everything below it: no number of
// position matches outweighs one ISRC.
const (
	assignDurationCap    = 999_999                                                   // ms
	assignPositionWeight = int64(matchMaxAlbumTracks+1) * (assignDurationCap + 1)    // > any duration total
	assignListedWeight   = int64(matchMaxAlbumTracks+1) * (assignPositionWeight * 2) // > any position total
	assignISRCWeight     = int64(matchMaxAlbumTracks+1) * (assignListedWeight * 2)   // > any listed total
)

type assignPair struct {
	track, entry int
	cost         int64
}

// minCostMatching pairs tracks with entries one to one: as many pairs as
// possible, and among those the lowest total cost (successive shortest
// paths over the pairs). It maps track → entry.
func minCostMatching(tracks int, pairs []assignPair) map[int]int {
	// Nodes: source, tracks, the entries pairs name, sink.
	entryNode := map[int]int{}
	for _, p := range pairs {
		if _, ok := entryNode[p.entry]; !ok {
			entryNode[p.entry] = 1 + tracks + len(entryNode)
		}
	}
	source, sink := 0, 1+tracks+len(entryNode)
	type edge struct {
		to, rev, capacity int
		cost              int64
	}
	graph := make([][]edge, sink+1)
	addEdge := func(from, to int, cost int64) {
		graph[from] = append(graph[from], edge{to, len(graph[to]), 1, cost})
		graph[to] = append(graph[to], edge{from, len(graph[from]) - 1, 0, -cost})
	}
	for i := 0; i < tracks; i++ {
		addEdge(source, 1+i, 0)
	}
	for _, node := range entryNode {
		addEdge(node, sink, 0)
	}
	for _, p := range pairs {
		addEdge(1+p.track, entryNode[p.entry], p.cost)
	}
	const unreached = int64(^uint64(0) >> 1)
	for {
		// Bellman-Ford (queue-based): costs may be negative.
		dist := make([]int64, len(graph))
		prevNode := make([]int, len(graph))
		prevEdge := make([]int, len(graph))
		queued := make([]bool, len(graph))
		for v := range dist {
			dist[v] = unreached
		}
		dist[source] = 0
		queue := []int{source}
		for len(queue) > 0 {
			v := queue[0]
			queue = queue[1:]
			queued[v] = false
			for k, e := range graph[v] {
				if e.capacity > 0 && dist[v]+e.cost < dist[e.to] {
					dist[e.to] = dist[v] + e.cost
					prevNode[e.to], prevEdge[e.to] = v, k
					if !queued[e.to] {
						queued[e.to] = true
						queue = append(queue, e.to)
					}
				}
			}
		}
		if dist[sink] == unreached {
			break
		}
		for v := sink; v != source; v = prevNode[v] {
			e := &graph[prevNode[v]][prevEdge[v]]
			e.capacity--
			graph[v][e.rev].capacity++
		}
	}
	out := map[int]int{}
	for entry, node := range entryNode {
		for _, e := range graph[node] {
			// A used track → entry edge leaves capacity on its reverse.
			if e.to >= 1 && e.to <= tracks && e.capacity > 0 {
				out[e.to-1] = entry
			}
		}
	}
	return out
}

// searchable reports whether a track search could confirm a hit: that takes
// an artist or an ISRC.
func searchable(t MatchTrack) bool {
	return len(t.Artists) > 0 || t.ISRC != ""
}

// searchTrack looks a track up by artist and title and returns the hits for
// its recording, best first (rankTracks). With albumTitle set they must be
// on a release of that title.
func (m *Matcher) searchTrack(ctx context.Context, t MatchTrack, albumTitle string) ([]tidal.Track, error) {
	query := featTailRe.ReplaceAllString(featGroupRe.ReplaceAllString(t.Title, " "), "")
	if len(t.Artists) > 0 {
		query = t.Artists[0] + " " + query
	}
	if err := m.wait(ctx); err != nil {
		return nil, err
	}
	found, err := m.src().SearchTracks(ctx, strings.Join(strings.Fields(query), " "), matchSearchLimit, 0)
	if err != nil {
		return nil, err
	}
	return rankTracks(found, t, albumTitle), nil
}

// rankTracks keeps the search hits for a library track's recording and
// orders them: the same ISRC first, then (without an album to match) not a
// known compilation, then the exact title, then TIDAL's order. Search hits
// rarely name their album's artist; matchLoose checks the releases.
func rankTracks(found []tidal.Track, t MatchTrack, albumTitle string) []tidal.Track {
	want := matchAlbum(albumTitle)
	type ranked struct {
		hit   tidal.Track
		score int
	}
	var out []ranked
	for _, c := range found {
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
		out = append(out, ranked{c, score})
	}
	sort.SliceStable(out, func(i, j int) bool { return out[i].score > out[j].score })
	hits := make([]tidal.Track, len(out))
	for i, r := range out {
		hits[i] = r.hit
	}
	return hits
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
	hits, err := m.searchTrack(ctx, t, "")
	if err != nil {
		m.recordErr(ctx, t, err)
		return err
	}
	if len(hits) == 0 {
		m.record(ctx, t, MatchOutcome{Status: MatchUnmatched, Error: "no TIDAL track matches"})
		return nil
	}
	// The best hit, unless its release turns out to be a compilation and a
	// hit as strong (both or neither the file's ISRC) is on another release.
	var (
		hit   tidal.Track
		r     *release
		tried int
	)
	checked := map[string]bool{} // releases already looked at
	for _, c := range hits {
		if tried >= maxLooseReleases {
			break
		}
		if tried > 0 && sameISRC(t.ISRC, c.ISRC) != sameISRC(t.ISRC, hits[0].ISRC) {
			continue
		}
		if c.AlbumID != "" {
			if checked[c.AlbumID] {
				continue
			}
			checked[c.AlbumID] = true
		}
		tried++
		var cr *release
		if c.AlbumID != "" {
			if cr, err = m.lookupRelease(ctx, c.AlbumID); err != nil {
				m.recordErr(ctx, t, err)
				return err
			}
		}
		if tried == 1 || cr == nil || !isVariousArtists(cr.Artist) {
			hit, r = c, cr
		}
		if cr == nil || !isVariousArtists(cr.Artist) {
			break
		}
	}
	if r != nil {
		if err := m.keep(ctx, r); err != nil {
			m.recordErr(ctx, t, err)
			return err
		}
		listed := fromRelease(hit, r.Album)
		for _, rt := range r.Tracks {
			if rt.ID == hit.ID {
				listed = fromRelease(rt, r.Album)
				break
			}
		}
		if listed.AlbumID == "" {
			listed.AlbumID = r.ID
		}
		hit = listed
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
		Source:    t.source(),
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
	// The cover is filled after the match commits; until then the match
	// keeps its URL and album, so a failed fetch is retried (backfillCovers).
	cover := CoverTask{TrackID: t.ID}
	if m.Ingest != nil {
		cover.CoverURL = hit.CoverURL
	}
	applied, err := m.Library.ApplyTIDALMatch(ctx, t.ID, fields, func(ctx context.Context, tx pgx.Tx, albumID *uuid.UUID) error {
		cover.AlbumID = albumID
		o := MatchOutcome{Status: MatchMatched, TIDALID: hit.ID, TIDALAlbumID: hit.AlbumID}
		if albumID != nil {
			o.CoverURL, o.CoverAlbum = cover.CoverURL, albumID
		}
		return recordMatch(ctx, tx, t.ID, o)
	})
	if errors.Is(err, library.ErrTIDALAlbumConflict) {
		// Filed there, the track would follow the other release.
		m.record(ctx, t, MatchOutcome{Status: MatchUnmatched, TIDALID: hit.ID, Error: err.Error()})
		return nil
	}
	if err != nil {
		m.recordErr(ctx, t, err)
		return err
	}
	if !applied {
		return nil
	}
	m.log().Info("tidal match applied", "track", t.ID, "tidal_track", hit.ID, "tidal_album", hit.AlbumID,
		"title", hit.Title)
	if cover.CoverURL != "" && cover.AlbumID != nil {
		m.fillCover(ctx, cover)
	}
	return nil
}

// backfillCovers retries release covers that couldn't be filled when their
// tracks were matched.
func (m *Matcher) backfillCovers(ctx context.Context) {
	if m.Ingest == nil {
		return
	}
	tasks, err := m.Store.PendingCovers(ctx, matchCoversPerPass)
	if err != nil {
		if ctx.Err() == nil {
			m.log().Warn("tidal match cover backfill failed", "err", err)
		}
		return
	}
	for _, c := range tasks {
		if ctx.Err() != nil {
			return
		}
		m.fillCover(ctx, c)
	}
}

// fillCover gives the album a match filed its track under the release
// cover when it has no artwork, wherever the track is now. The task is done
// once the album has some (or is gone), and put off for a few hours when
// the cover can't be fetched or stored.
func (m *Matcher) fillCover(ctx context.Context, c CoverTask) {
	if m.Ingest == nil {
		return
	}
	has := true
	if c.AlbumID != nil {
		var err error
		if has, err = m.Store.AlbumHasCover(ctx, *c.AlbumID); err != nil {
			return // due again on the next pass
		}
	}
	if !has {
		putOff := func() {
			if err := m.Store.CoverFailed(ctx, c.TrackID); err != nil {
				m.log().Warn("tidal match cover retry not recorded", "track", c.TrackID, "err", err)
			}
		}
		if m.coverMissed[*c.AlbumID] {
			putOff()
			return
		}
		if err := m.storeCover(ctx, c); err != nil {
			if ctx.Err() != nil {
				return
			}
			m.log().Warn("tidal match cover failed", "track", c.TrackID, "err", err)
			if m.coverMissed == nil {
				m.coverMissed = map[uuid.UUID]bool{}
			}
			m.coverMissed[*c.AlbumID] = true
			putOff()
			return
		}
	}
	if err := m.Store.CoverDone(ctx, c.TrackID); err != nil && ctx.Err() == nil {
		m.log().Warn("tidal match cover not recorded", "track", c.TrackID, "err", err)
	}
}

func (m *Matcher) storeCover(ctx context.Context, c CoverTask) error {
	if err := m.wait(ctx); err != nil {
		return err
	}
	data, err := m.src().CoverBytes(ctx, c.CoverURL)
	if err != nil {
		return err
	}
	key, err := m.Ingest.StoreCoverImage(ctx, data, "")
	if err != nil {
		return err
	}
	return m.Library.SetAlbumCoverIfMissing(ctx, *c.AlbumID, key)
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

// record stores an outcome for a track as it was loaded; one moved or
// changed since is left for a fresh look.
func (m *Matcher) record(ctx context.Context, t MatchTrack, o MatchOutcome) {
	if err := m.Store.RecordOutcome(ctx, []MatchTrack{t}, o); err != nil && ctx.Err() == nil {
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
	if cause != nil {
		if ctx.Err() != nil || errors.Is(cause, tidal.ErrNotConfigured) {
			return
		}
		o = MatchOutcome{Status: MatchFailed, Error: cause.Error()}
	}
	// One statement: an album's outcome lands for all its tracks or none.
	if err := m.Store.RecordOutcome(ctx, tracks, o); err != nil && ctx.Err() == nil {
		m.log().Warn("tidal match outcomes not recorded", "tracks", len(tracks), "err", err)
	}
}
