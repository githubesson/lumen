package tidaldl

import (
	"context"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/google/uuid"

	"github.com/githubesson/lumen/internal/downloadfile"
	"github.com/githubesson/lumen/internal/ingest"
	"github.com/githubesson/lumen/internal/library"
	"github.com/githubesson/lumen/internal/mediaembed"
	"github.com/githubesson/lumen/internal/musicroots"
	"github.com/githubesson/lumen/internal/pathsafe"
	"github.com/githubesson/lumen/internal/pinscan"
	"github.com/githubesson/lumen/internal/tidal"
)

const (
	defaultPollInterval = 5 * time.Minute
	defaultFileTimeout  = 30 * time.Minute
	batchSize           = 20
	// maxBatchesPerWake bounds one drain so a stuck candidate (one whose
	// adoption keeps succeeding without leaving the queue) cannot spin.
	maxBatchesPerWake = 50
)

// Worker downloads the TIDAL tracks of opted-in playlists one at a time.
type Worker struct {
	Store   *Store
	TIDAL   *tidal.Client
	Ingest  *ingest.Service
	Library *library.Store
	Roots   *musicroots.Store
	// PrimaryRoot is MUSIC_PATH, the destination root when Settings.RootID is nil.
	PrimaryRoot  string
	Logger       *slog.Logger
	PollInterval time.Duration
	FileTimeout  time.Duration
	// MinFreeBytes pauses downloads while the destination volume has less
	// free space than this, so an opted-in playlist that non-admins can edit
	// cannot fill the music volume. 0 disables the check.
	MinFreeBytes int64

	kickOnce sync.Once
	kick     chan struct{}

	// Test seams; nil means TIDAL, mediaembed.Embed, mediaembed.Available,
	// and freeBytes. saved runs after a download lands on disk.
	source source
	tag    tagFunc
	ffmpeg func() bool
	free   func(path string) (uint64, bool)
	saved  func(path string)
	// beforeIngest runs between the twin check and the worker's own ingest.
	beforeIngest func(path string)
}

// errNoFFmpeg is recorded as a normal failure, so tracks that only need
// linking keep moving while downloads back off until ffmpeg is installed.
var errNoFFmpeg = errors.New("ffmpeg is not installed on the server")

func (w *Worker) tagger() (tagFunc, error) {
	if w.tag != nil {
		return w.tag, nil
	}
	available := w.ffmpeg
	if available == nil {
		available = mediaembed.Available
	}
	if !available() {
		return nil, errNoFFmpeg
	}
	return mediaembed.Embed, nil
}

// source is the part of *tidal.Client the worker uses.
type source interface {
	Track(ctx context.Context, id string) (tidal.Track, error)
	FileResponse(ctx context.Context, id string, incoming *http.Request) (*http.Response, error)
	CoverBytes(ctx context.Context, coverURL string) ([]byte, error)
}

type tagFunc func(ctx context.Context, r io.ReadCloser, cover []byte, meta mediaembed.Metadata, hint mediaembed.FormatHint) (*mediaembed.Result, error)

func (w *Worker) src() source {
	if w.source != nil {
		return w.source
	}
	return w.TIDAL
}

func (w *Worker) kickCh() chan struct{} {
	w.kickOnce.Do(func() { w.kick = make(chan struct{}, 1) })
	return w.kick
}

// Kick wakes the worker early, e.g. after tracks are added to an opted-in
// playlist. It never blocks; wakes that arrive mid-drain coalesce.
func (w *Worker) Kick() {
	if w == nil {
		return
	}
	select {
	case w.kickCh() <- struct{}{}:
	default:
	}
}

func (w *Worker) Run(ctx context.Context) {
	if w == nil || w.Store == nil || (w.TIDAL == nil && w.source == nil) {
		return
	}
	interval := w.PollInterval
	if interval <= 0 {
		interval = defaultPollInterval
	}
	timer := time.NewTimer(pinscan.InitialScanDelay)
	defer timer.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-timer.C:
		case <-w.kickCh():
			if !timer.Stop() {
				select {
				case <-timer.C:
				default:
				}
			}
		}
		w.drain(ctx)
		timer.Reset(interval)
	}
}

func (w *Worker) log() *slog.Logger {
	if w.Logger != nil {
		return w.Logger
	}
	return slog.Default()
}

func (w *Worker) drain(ctx context.Context) {
	// Resolved lazily, once per drain: only downloads need it, so a broken
	// destination must not hold up tracks that are just being linked. An
	// admin changing the destination mid-drain takes effect on the next wake.
	dest := sync.OnceValues(func() (string, error) { return w.Destination(ctx) })
	w.sweepRetired(ctx)
	for batch := 0; batch < maxBatchesPerWake; batch++ {
		pending, err := w.Store.Pending(ctx, batchSize)
		if err != nil {
			if !errors.Is(err, context.Canceled) {
				w.log().Warn("tidal auto-download queue fetch failed", "err", err)
			}
			return
		}
		if len(pending) == 0 {
			return
		}
		failed := 0
		for _, c := range pending {
			if ctx.Err() != nil {
				return
			}
			// Turning auto-download off, or removing the track, must stop
			// the rest of this batch too.
			if wanted, err := w.Store.StillWanted(ctx, c.RowID); err == nil && !wanted {
				continue
			}
			if err := w.process(ctx, c, dest); err != nil {
				if errors.Is(err, tidal.ErrNotConfigured) {
					w.log().Warn("tidal auto-download paused: tidal proxy is not configured")
					return
				}
				if ctx.Err() != nil {
					return
				}
				failed++
				w.log().Warn("tidal auto-download failed", "tidal_track", c.TIDALID, "err", err)
			}
		}
		// A batch with no successes means TIDAL or the database is having a
		// bad time, and errors that could not be recorded would hand the same
		// rows straight back. Leave the rest for the next wake.
		if failed == len(pending) {
			return
		}
	}
}

// sweepRetired moves stats and history that landed on a retired TIDAL row
// after its adoption (a request that resolved the old id just before the
// swap committed) onto the saved copy.
func (w *Worker) sweepRetired(ctx context.Context) {
	retired, err := w.Store.RetiredWithHistory(ctx, 100)
	if err != nil {
		if !errors.Is(err, context.Canceled) {
			w.log().Warn("tidal auto-download retired-row sweep failed", "err", err)
		}
		return
	}
	for _, r := range retired {
		if !w.playable(ctx, r.LocalPath) {
			continue
		}
		if err := w.Store.Adopt(ctx, Adoption{RowID: r.RowID, TIDALID: r.TIDALID, LocalID: r.LocalID}); err != nil {
			w.log().Warn("tidal auto-download retired-row sweep failed", "tidal_track", r.TIDALID, "err", err)
		}
	}
}

// Destination is the absolute directory downloads are written under.
func (w *Worker) Destination(ctx context.Context) (string, error) {
	settings, err := w.Store.Settings(ctx)
	if err != nil {
		return "", err
	}
	return w.destinationFor(ctx, settings)
}

func (w *Worker) destinationFor(ctx context.Context, settings Settings) (string, error) {
	root := w.PrimaryRoot
	if settings.RootID != nil {
		if w.Roots == nil {
			return "", errors.New("music roots are not available")
		}
		r, err := w.Roots.Get(ctx, *settings.RootID)
		if err != nil {
			return "", fmt.Errorf("destination root: %w", err)
		}
		// Playback only serves files under enabled roots, so a copy saved
		// here would 403 once the playlist switched to it.
		if !r.Enabled {
			return "", errors.New("destination music root is disabled")
		}
		root = r.Path
	}
	return ResolveDestination(root, settings.Subdir)
}

// ResolveDestination joins a music root and a relative subdirectory,
// refusing any subdirectory that escapes the root.
func ResolveDestination(root, subdir string) (string, error) {
	if strings.TrimSpace(root) == "" {
		return "", errors.New("no music root configured")
	}
	abs, err := filepath.Abs(root)
	if err != nil {
		return "", err
	}
	// An absent root is usually an unmounted volume. Creating the subfolder
	// would recreate the mount point and write onto the wrong filesystem.
	if info, err := os.Stat(abs); err != nil || !info.IsDir() {
		return "", fmt.Errorf("music root %s is not available", abs)
	}
	subdir = strings.TrimSpace(subdir)
	if subdir == "" || filepath.Clean(subdir) == "." {
		return abs, nil
	}
	if filepath.IsAbs(subdir) {
		return "", errors.New("subdir must be relative")
	}
	dest, err := pathsafe.CleanSubdir(abs, subdir)
	if err != nil {
		return "", errors.New("subdir escapes the music root")
	}
	return dest, nil
}

// process gives one remote row a local copy — reusing one already in the
// library when possible — and moves its references onto it. Failures are
// recorded for backoff; only a missing TIDAL proxy is returned unrecorded so
// the drain can stop without marking every track failed.
func (w *Worker) process(ctx context.Context, c Candidate, dest func() (string, error)) error {
	if localID, err := w.Library.DownloadedTIDALTrack(ctx, c.TIDALID); err == nil {
		// Saved earlier; this row reappeared (e.g. re-added by a stale client).
		// If that copy is no longer playable, fall through and save a new one.
		path, err := w.Store.TrackFilePath(ctx, localID)
		if err != nil {
			return err
		}
		if w.playable(ctx, path) {
			return w.Store.Adopt(ctx, Adoption{RowID: c.RowID, TIDALID: c.TIDALID, LocalID: localID})
		}
	} else if !errors.Is(err, library.ErrNotFound) {
		return err
	}

	meta, err := w.src().Track(ctx, c.TIDALID)
	if err != nil {
		if errors.Is(err, tidal.ErrNotConfigured) {
			return err
		}
		return w.fail(ctx, c, tidal.Track{}, fmt.Errorf("metadata: %w", err))
	}
	artist := strings.Join(meta.Artists, ", ")

	matches, err := w.Store.LocalByISRC(ctx, meta.ISRC)
	if err != nil {
		return err
	}
	for _, m := range matches {
		// Adoption replaces a working TIDAL entry, so the match has to play.
		if !w.playable(ctx, m.FilePath) {
			continue
		}
		w.log().Info("tidal auto-download matched library track by ISRC",
			"tidal_track", c.TIDALID, "track", m.ID, "isrc", meta.ISRC)
		return w.Store.Adopt(ctx, Adoption{
			RowID: c.RowID, TIDALID: c.TIDALID, LocalID: m.ID,
			Status: StatusExisting, Title: meta.Title, Artist: artist,
		})
	}

	dir, err := dest()
	if err != nil {
		return w.fail(ctx, c, meta, fmt.Errorf("destination: %w", err))
	}
	if err := w.checkFreeSpace(dir); err != nil {
		return w.fail(ctx, c, meta, err)
	}
	path, err := w.download(ctx, meta, dir)
	if err != nil {
		if errors.Is(err, tidal.ErrNotConfigured) {
			return err
		}
		return w.fail(ctx, c, meta, err)
	}
	// Ingest folds identical audio into the existing row and, when that row's
	// file still exists, deletes ours — even if the row itself can't play
	// (e.g. under a disabled root). Handle audio twins first.
	if handled, err := w.adoptAudioTwin(ctx, c, meta, path); handled {
		return err
	}
	if w.beforeIngest != nil {
		w.beforeIngest(path)
	}
	out := w.Ingest.IngestFile(ctx, path)
	if out.Err != nil || out.TrackID == uuid.Nil {
		// The file is ours and unused. SaveNew picks a fresh name on every
		// retry, so leaving it would stack up a copy per attempt.
		w.removeFile(out.Path, path)
		if out.Err != nil {
			return w.fail(ctx, c, meta, fmt.Errorf("ingest: %w", out.Err))
		}
		return w.fail(ctx, c, meta, errors.New("ingest skipped the downloaded file"))
	}
	// Ownership, not out.Inserted: the watcher may have ingested our file in
	// the meantime, making this call a dedup hit on a row that is ours.
	status := StatusExisting
	if out.Inserted || w.ownsFile(ctx, out.TrackID, path) {
		status = StatusDownloaded
		w.applyArtists(ctx, out.TrackID, meta)
	}
	return w.adoptPlayable(ctx, c, meta, out.TrackID, status, path)
}

// capBody fails reads with downloadfile.ErrTooLarge once more than max bytes
// have come through.
func capBody(body io.ReadCloser, max int64) io.ReadCloser {
	return &cappedBody{ReadCloser: body, left: max}
}

type cappedBody struct {
	io.ReadCloser
	left int64
}

func (b *cappedBody) Read(p []byte) (int, error) {
	if b.left < 0 {
		return 0, downloadfile.ErrTooLarge
	}
	if int64(len(p)) > b.left+1 {
		p = p[:b.left+1]
	}
	n, err := b.ReadCloser.Read(p)
	b.left -= int64(n)
	if b.left < 0 {
		return n, downloadfile.ErrTooLarge
	}
	return n, err
}

// ownsFile reports whether track plays from path, the file this attempt wrote.
func (w *Worker) ownsFile(ctx context.Context, track uuid.UUID, path string) bool {
	p, err := w.Store.TrackFilePath(ctx, track)
	return err == nil && filepath.Clean(p) == filepath.Clean(path)
}

// adoptAudioTwin handles a download whose audio already has a live shared
// row. A playable twin is adopted and our copy discarded; an unplayable one
// is pointed at our copy, which has the same audio, then adopted. handled is
// false when there is no twin and ingest should take the file.
func (w *Worker) adoptAudioTwin(ctx context.Context, c Candidate, meta tidal.Track, path string) (handled bool, err error) {
	shaHex, err := ingest.AudioSHA256(ctx, path)
	if err != nil {
		return false, nil // ingest will hash it again and report the error
	}
	sha, err := hex.DecodeString(shaHex)
	if err != nil {
		return false, nil
	}
	twin, found, err := w.Store.GlobalByAudioSHA(ctx, sha)
	if err != nil || !found {
		return false, nil
	}
	if filepath.Clean(twin.FilePath) == filepath.Clean(path) {
		// The filesystem watcher ingested our file first; the row is ours
		// and needs the same artist fix-up as a fresh insert.
		w.applyArtists(ctx, twin.ID, meta)
		return true, w.adoptPlayable(ctx, c, meta, twin.ID, StatusDownloaded, path)
	}
	if w.playable(ctx, twin.FilePath) {
		w.removeFile("", path)
		return true, w.adoptPlayable(ctx, c, meta, twin.ID, StatusExisting, "")
	}
	if err := w.Store.RepointFile(ctx, twin.ID, path); err != nil {
		w.removeFile("", path)
		return true, w.fail(ctx, c, meta, fmt.Errorf("repoint library track: %w", err))
	}
	w.log().Info("tidal auto-download moved an unplayable library track to the new copy",
		"tidal_track", c.TIDALID, "track", twin.ID, "old_path", twin.FilePath, "path", path)
	return true, w.adoptPlayable(ctx, c, meta, twin.ID, StatusDownloaded, path)
}

// adoptPlayable is the last gate before a download's track replaces the
// TIDAL entries: it must actually play. ours is the file this attempt wrote,
// removed on failure unless the track now points at it.
func (w *Worker) adoptPlayable(ctx context.Context, c Candidate, meta tidal.Track, localID uuid.UUID, status, ours string) error {
	path, err := w.Store.TrackFilePath(ctx, localID)
	if err != nil {
		return err
	}
	if !w.playable(ctx, path) {
		if ours != "" && ours != path {
			w.removeFile("", ours)
		}
		return w.fail(ctx, c, meta, fmt.Errorf("library track %s is not playable (%s)", localID, path))
	}
	artist := strings.Join(meta.Artists, ", ")
	if status == StatusDownloaded {
		if err := w.Store.RecordSaved(ctx, c.TIDALID, localID, status, path, meta.Title, artist); err != nil {
			return err
		}
	}
	if err := w.Store.Adopt(ctx, Adoption{
		RowID: c.RowID, TIDALID: c.TIDALID, LocalID: localID,
		Status: status, FilePath: path, Title: meta.Title, Artist: artist,
	}); err != nil {
		return err
	}
	w.log().Info("tidal auto-download saved track",
		"tidal_track", c.TIDALID, "track", localID, "path", path, "status", status)
	return nil
}

// checkFreeSpace enforces MinFreeBytes on the volume holding dir. dir may not
// exist yet, so the nearest existing ancestor is measured.
func (w *Worker) checkFreeSpace(dir string) error {
	if w.MinFreeBytes <= 0 {
		return nil
	}
	measure := w.free
	if measure == nil {
		measure = freeBytes
	}
	p := dir
	for {
		if _, err := os.Stat(p); err == nil {
			break
		}
		parent := filepath.Dir(p)
		if parent == p {
			return nil
		}
		p = parent
	}
	free, ok := measure(p)
	if !ok || free >= uint64(w.MinFreeBytes) {
		return nil
	}
	return fmt.Errorf("not enough free space on the music volume (%d MiB left, %d MiB required)",
		free>>20, w.MinFreeBytes>>20)
}

// playable reports whether the stream endpoint would serve path: it must be a
// non-empty file under the primary root or an enabled music root.
func (w *Worker) playable(ctx context.Context, path string) bool {
	if w.Ingest == nil {
		return false
	}
	return library.FilePlayable(w.Ingest.AllRoots(ctx), path)
}

// removeFile deletes a download that never made it into the library. Ingest
// may have renamed it (invalid UTF-8 fix-up), so prefer the path it reports.
func (w *Worker) removeFile(ingested, saved string) {
	p := ingested
	if p == "" {
		p = saved
	}
	if err := os.Remove(p); err != nil && !errors.Is(err, os.ErrNotExist) {
		w.log().Warn("tidal auto-download could not remove unused file", "path", p, "err", err)
	}
}

func (w *Worker) fail(ctx context.Context, c Candidate, meta tidal.Track, cause error) error {
	if err := w.Store.RecordFailure(ctx, c.TIDALID, meta.Title, strings.Join(meta.Artists, ", "), cause); err != nil {
		return errors.Join(cause, err)
	}
	return cause
}

// download writes a tagged copy of the track under dest and returns its path.
func (w *Worker) download(ctx context.Context, meta tidal.Track, dest string) (string, error) {
	timeout := w.FileTimeout
	if timeout <= 0 {
		timeout = defaultFileTimeout
	}
	ctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()

	tag, err := w.tagger()
	if err != nil {
		return "", err
	}
	resp, err := w.src().FileResponse(ctx, meta.ID, nil)
	if err != nil {
		return "", err
	}
	// Cap the stream before tagging: the tagger spools it to temp files, which
	// may sit on a different (smaller) filesystem than the destination.
	resp.Body = capBody(resp.Body, downloadfile.MaxFileBytes)
	var cover []byte
	if meta.CoverURL != "" {
		if cover, err = w.src().CoverBytes(ctx, meta.CoverURL); err != nil {
			w.log().Warn("tidal auto-download cover fetch failed; saving without cover",
				"tidal_track", meta.ID, "err", err)
			cover = nil
		}
	}
	// The tagger closes resp.Body.
	tagged, err := tag(ctx, resp.Body, cover, mediaembed.Metadata{
		Title:       meta.Title,
		Artist:      strings.Join(meta.Artists, "; "),
		Album:       meta.AlbumTitle,
		AlbumArtist: meta.AlbumArtist,
		Year:        meta.Year,
		TrackNo:     meta.TrackNo,
		DiscNo:      meta.DiscNo,
		ISRC:        meta.ISRC,
	}, mediaembed.HintFromContentType(resp.Header.Get("Content-Type")))
	if err != nil {
		return "", fmt.Errorf("tag: %w", err)
	}
	defer tagged.Cleanup()

	// Never reuse a file already at the target: two releases can share
	// artist/album/number/title, and adopting the other file would repoint
	// the playlist at different audio.
	target := filepath.Join(dest, TrackPath(meta)+tagged.Ext)
	path, err := downloadfile.SaveNew(tagged.File, target)
	if err != nil {
		return path, fmt.Errorf("save: %w", err)
	}
	if w.saved != nil {
		w.saved(path)
	}
	return path, nil
}

// applyArtists replaces the artists ingest parsed from the tags with TIDAL's
// list: ingest splits on ", " and " & ", which mangles names like
// "Simon & Garfunkel", and does not split the "; " the tag was written with.
func (w *Worker) applyArtists(ctx context.Context, trackID uuid.UUID, meta tidal.Track) {
	if len(meta.Artists) == 0 {
		return
	}
	artists := meta.Artists
	if len(artists) > library.MaxTrackArtists {
		artists = artists[:library.MaxTrackArtists]
	}
	if err := w.Library.UpdateTrack(ctx, trackID, library.TrackPatch{Artists: &artists}); err != nil {
		w.log().Warn("tidal auto-download artist update failed", "track", trackID, "err", err)
	}
}

// TrackPath is the library-relative path, without extension, for a track:
// "Album Artist/Album/01 - Title", with the disc number prefixed on
// multi-disc releases.
func TrackPath(t tidal.Track) string {
	artist := t.AlbumArtist
	if strings.TrimSpace(artist) == "" && len(t.Artists) > 0 {
		artist = t.Artists[0]
	}
	if strings.TrimSpace(artist) == "" {
		artist = "Unknown Artist"
	}
	album := t.AlbumTitle
	if strings.TrimSpace(album) == "" {
		album = "Singles"
	}
	title := t.Title
	if strings.TrimSpace(title) == "" {
		title = "TIDAL " + t.ID
	}
	name := title
	switch {
	case t.TrackNo > 0 && t.DiscNo > 1:
		name = fmt.Sprintf("%d-%02d - %s", t.DiscNo, t.TrackNo, title)
	case t.TrackNo > 0:
		name = fmt.Sprintf("%02d - %s", t.TrackNo, title)
	}
	return filepath.Join(safeName(artist), safeName(album), safeName(name))
}

// safeName sanitizes one path component. SanitizeName truncates by bytes,
// which can split a multi-byte rune, and ingest rejects non-UTF-8 paths.
func safeName(s string) string {
	s = strings.ToValidUTF8(downloadfile.SanitizeName(s), "")
	if s == "" {
		return "unnamed"
	}
	return s
}
