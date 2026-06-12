package ingest

import (
	"bytes"
	"context"
	"encoding/hex"
	"errors"
	"fmt"
	"image"
	"image/jpeg"
	_ "image/png"
	"log/slog"
	"os"
	"path/filepath"
	"runtime"
	"strings"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	xdraw "golang.org/x/image/draw"
	_ "golang.org/x/image/webp"

	"github.com/uncut/lumen/internal/library"
	"github.com/uncut/lumen/internal/pathsafe"
	"github.com/uncut/lumen/internal/storage"
)

const (
	maxStoredCoverDimension = 1024
	storedCoverJPEGQuality  = 82
)

// RootsProvider returns every configured music root: the primary MUSIC_PATH
// followed by any enabled runtime-added roots. The primary root is always
// first and is the destination for uploads and cover storage.
type RootsProvider func(ctx context.Context) []string

// Service ingests audio files into the DB.
type Service struct {
	DB        *pgxpool.Pool
	Library   *library.Store
	Storage   storage.Storage
	MusicRoot string        // primary root (env MUSIC_PATH) — used for uploads + storage
	Roots     RootsProvider // all roots including MusicRoot, in order; used for scan/watch/path validation
	Logger    *slog.Logger
}

// log returns the service logger, falling back to the slog default so call
// sites never need a nil check (rescan.go already assumed a non-nil logger;
// this makes the whole package consistent).
func (s *Service) log() *slog.Logger {
	if s.Logger != nil {
		return s.Logger
	}
	return slog.Default()
}

// AllRoots is a convenience wrapper around Roots that falls back to
// [MusicRoot] only when no provider is configured.
func (s *Service) AllRoots(ctx context.Context) []string {
	if s.Roots != nil {
		if rs := s.Roots(ctx); len(rs) > 0 {
			return rs
		}
	}
	return []string{s.MusicRoot}
}

// Outcome reports what happened to a single file.
type Outcome struct {
	Path     string
	TrackID  uuid.UUID
	Inserted bool // true = new track, false = dedup hit
	Skipped  bool // true = not a supported audio file, or source file gone (hard-deleted)
	Err      error
}

// IngestFile parses a single audio file and upserts everything as a global
// (admin) entry — the fsnotify watcher and admin rescan use this path.
// Use IngestFileAs for per-user ingestion.
func (s *Service) IngestFile(ctx context.Context, path string) Outcome {
	return s.IngestFileAs(ctx, path, nil)
}

// IngestFileAs ingests a file owned by the given user. Pass nil for global
// (admin-added) ingestion. Safe to call concurrently on different paths.
func (s *Service) IngestFileAs(ctx context.Context, path string, ownerID *uuid.UUID) Outcome {
	out := Outcome{Path: path}
	if !IsSupported(path) {
		out.Skipped = true
		return out
	}
	stat, err := os.Stat(path)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			// File is gone (deleted between enumeration and ingest, or a
			// stale debounced event). Purge any DB trace so a future
			// reappearance ingests fresh — don't surface as an error.
			if s.Library != nil {
				if derr := s.Library.HardDeleteByPath(ctx, path); derr != nil {
					s.log().Warn("hard delete of missing file failed", "path", path, "err", derr)
				}
			}
			out.Skipped = true
			return out
		}
		out.Err = err
		s.recordErr(ctx, path, err)
		return out
	}
	md, err := ParseFile(path)
	if err != nil {
		out.Err = err
		s.recordErr(ctx, path, err)
		return out
	}
	shaHex, err := AudioSHA256(ctx, path)
	if err != nil {
		out.Err = err
		s.recordErr(ctx, path, err)
		return out
	}
	shaBytes, err := hex.DecodeString(shaHex)
	if err != nil {
		out.Err = err
		s.recordErr(ctx, path, err)
		return out
	}

	// Probe the audio stream for duration / bitrate / sample rate / channels.
	// A failure here is non-fatal: the track still ingests, we just record
	// zeros and log — users can see the title, play it, etc. ErrProbeUnsupported
	// (formats without a native parser) is silently accepted.
	info, perr := ProbeAudio(ctx, path)
	if info == nil {
		info = &AudioInfo{}
	}
	if perr != nil && !errors.Is(perr, ErrProbeUnsupported) {
		s.log().Debug("probe failed", "path", path, "err", perr)
	}

	tx, err := s.DB.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		out.Err = err
		s.recordErr(ctx, path, err)
		return out
	}
	defer tx.Rollback(ctx)

	artistIDs := make([]uuid.UUID, 0, len(md.Artists))
	artistRoles := make([]string, 0, len(md.Artists))
	for _, a := range md.Artists {
		id, err := library.UpsertArtist(ctx, tx, a.Name)
		if err != nil {
			out.Err = fmt.Errorf("upsert artist %q: %w", a.Name, err)
			s.recordErr(ctx, path, out.Err)
			return out
		}
		artistIDs = append(artistIDs, id)
		artistRoles = append(artistRoles, a.Role)
	}

	// Catch-all: tracks that arrive with no artist metadata AND no album tag
	// get filed under an "Others" album so they don't vanish from the albums
	// view. Users can still re-tag them later via the track edit dialog.
	if len(md.Artists) == 0 && md.Album == "" {
		md.Album = "Others"
	}

	var albumID *uuid.UUID
	if md.Album != "" {
		albumArtistName := md.AlbumArtist
		var albumArtistID *uuid.UUID
		isCompilation := strings.EqualFold(albumArtistName, "Various Artists")
		if albumArtistName != "" && !isCompilation {
			aid, err := library.UpsertArtist(ctx, tx, albumArtistName)
			if err != nil {
				out.Err = fmt.Errorf("upsert album artist: %w", err)
				s.recordErr(ctx, path, out.Err)
				return out
			}
			albumArtistID = &aid
		}
		// If a track's primary artist differs from the album artist, still
		// link the album to the album artist; only flag compilation when
		// the album artist is missing or literally "Various Artists".
		if albumArtistName == "" && len(artistIDs) > 0 {
			isCompilation = true
		}

		coverPath, err := s.saveCover(ctx, md, path)
		if err != nil {
			s.log().Warn("cover save failed", "path", path, "err", err)
			coverPath = ""
		}
		aid, err := library.UpsertAlbum(ctx, tx, md.Album, albumArtistID, md.Year, isCompilation, coverPath)
		if err != nil {
			out.Err = fmt.Errorf("upsert album: %w", err)
			s.recordErr(ctx, path, out.Err)
			return out
		}
		albumID = &aid
	}

	trackID, inserted, err := library.InsertTrack(ctx, tx, library.TrackInsert{
		OwnerID:     ownerID,
		AlbumID:     albumID,
		Title:       md.Title,
		TrackNo:     md.TrackNo,
		DiscNo:      md.DiscNo,
		DurationMS:  info.DurationMS,
		Genre:       md.Genre,
		Year:        md.Year,
		Composer:    md.Composer,
		Comments:    md.Comment,
		FilePath:    path,
		FileSize:    stat.Size(),
		Format:      md.Format,
		Bitrate:     info.Bitrate,
		SampleRate:  info.SampleRate,
		Channels:    info.Channels,
		AudioSHA256: shaBytes,
	})
	if err != nil {
		out.Err = fmt.Errorf("insert track: %w", err)
		s.recordErr(ctx, path, out.Err)
		return out
	}

	canonicalPath := ""
	if inserted && len(artistIDs) > 0 {
		if err := library.LinkTrackArtists(ctx, tx, trackID, artistIDs, artistRoles); err != nil {
			out.Err = fmt.Errorf("link artists: %w", err)
			s.recordErr(ctx, path, out.Err)
			return out
		}
	}

	if !inserted {
		if err := tx.QueryRow(ctx, `SELECT file_path FROM tracks WHERE id = $1`, trackID).Scan(&canonicalPath); err != nil {
			out.Err = fmt.Errorf("lookup canonical track path: %w", err)
			s.recordErr(ctx, path, out.Err)
			return out
		}
		// A dedup hit folded this file into an existing track. Keep the
		// dupe's filename / title / artists / album searchable by recording
		// them as an alias; the canonical row stays untouched.
		if err := library.RecordAlias(ctx, tx, trackID, library.AliasInput{
			FilePath:    path,
			Title:       md.Title,
			ArtistNames: joinArtistNames(md.Artists),
			AlbumTitle:  md.Album,
		}); err != nil {
			out.Err = fmt.Errorf("record alias: %w", err)
			s.recordErr(ctx, path, out.Err)
			return out
		}
		// Backfill audio info on the canonical row if it's still missing
		// (e.g. the row was first written before native probing landed).
		if err := library.UpdateTrackAudioInfoIfMissing(ctx, tx, trackID,
			info.DurationMS, info.Bitrate, info.SampleRate, info.Channels); err != nil {
			out.Err = fmt.Errorf("backfill audio info: %w", err)
			s.recordErr(ctx, path, out.Err)
			return out
		}
	}

	if err := tx.Commit(ctx); err != nil {
		out.Err = err
		s.recordErr(ctx, path, err)
		return out
	}

	if !inserted {
		s.removeDedupFile(ctx, path, canonicalPath, trackID)
	}

	out.TrackID = trackID
	out.Inserted = inserted
	// Successful ingest clears any stale failure rows for this path so the
	// errors list doesn't stay inflated after a fix (or a retry after a
	// transient glitch).
	if s.Library != nil {
		s.Library.ClearIngestErrorsForPath(ctx, path)
	}
	if inserted {
		s.log().Info("ingested", "path", path, "track", trackID, "title", md.Title)
	} else {
		s.log().Debug("dedup hit", "path", path, "track", trackID)
	}
	return out
}

// removeDedupFile unlinks a duplicate audio file after the DB transaction has
// safely recorded its alias metadata. The canonical track row's file_path is
// the file we serve, so it is never removed.
func (s *Service) removeDedupFile(ctx context.Context, duplicatePath, canonicalPath string, trackID uuid.UUID) {
	dupAbs, err := filepath.Abs(duplicatePath)
	if err != nil {
		s.log().Warn("dedup cleanup skipped: duplicate path could not be resolved",
			"path", duplicatePath, "track", trackID, "err", err)
		return
	}
	canonAbs, err := filepath.Abs(canonicalPath)
	if err != nil {
		s.log().Warn("dedup cleanup skipped: canonical path could not be resolved",
			"path", canonicalPath, "track", trackID, "err", err)
		return
	}
	if sameCleanPath(dupAbs, canonAbs) {
		return
	}

	allRoots := s.AllRoots(ctx)
	roots := make([]string, 0, len(allRoots))
	for _, root := range allRoots {
		if strings.TrimSpace(root) != "" {
			roots = append(roots, root)
		}
	}
	if !pathsafe.WithinAnyRoot(roots, dupAbs) {
		s.log().Warn("dedup cleanup skipped: duplicate path is outside configured music roots",
			"path", dupAbs, "canonical_path", canonAbs, "track", trackID)
		return
	}

	canonInfo, err := os.Stat(canonAbs)
	if err != nil {
		s.log().Warn("dedup cleanup skipped: canonical file is unavailable",
			"path", dupAbs, "canonical_path", canonAbs, "track", trackID, "err", err)
		return
	}
	if !canonInfo.Mode().IsRegular() {
		s.log().Warn("dedup cleanup skipped: canonical path is not a regular file",
			"path", dupAbs, "canonical_path", canonAbs, "track", trackID)
		return
	}

	info, err := os.Lstat(dupAbs)
	if err != nil {
		if !errors.Is(err, os.ErrNotExist) {
			s.log().Warn("dedup cleanup skipped: duplicate file stat failed",
				"path", dupAbs, "track", trackID, "err", err)
		}
		return
	}
	if info.Mode()&os.ModeSymlink != 0 || !info.Mode().IsRegular() {
		s.log().Warn("dedup cleanup skipped: duplicate path is not a regular file",
			"path", dupAbs, "track", trackID)
		return
	}
	if err := os.Remove(dupAbs); err != nil && !errors.Is(err, os.ErrNotExist) {
		s.log().Warn("dedup cleanup failed",
			"path", dupAbs, "canonical_path", canonAbs, "track", trackID, "err", err)
		return
	}
	s.log().Info("dedup duplicate file removed",
		"path", dupAbs, "canonical_path", canonAbs, "track", trackID)
}

func sameCleanPath(a, b string) bool {
	a = filepath.Clean(a)
	b = filepath.Clean(b)
	if runtime.GOOS == "windows" {
		return strings.EqualFold(a, b)
	}
	return a == b
}

// saveCover writes embedded cover art to the storage backend under
// covers/<sha>.<ext>. Returns a storage key suitable for streaming back.
func (s *Service) saveCover(ctx context.Context, md *Metadata, sourcePath string) (string, error) {
	if md.Picture == nil || len(md.Picture.Data) == 0 {
		return "", nil
	}
	_ = sourcePath
	return s.StoreCoverImage(ctx, md.Picture.Data, md.Picture.MIMEType)
}

// StoreCoverImage normalizes raw image bytes (decode → resize → re-encode as
// JPEG) and writes them to the storage backend under covers/<sha>.<ext>,
// returning the storage key. If the bytes can't be decoded it falls back to
// storing them verbatim with fallbackType. Exported so HTTP handlers can let
// admins replace album artwork with an uploaded image. Returns "" for empty
// input.
func (s *Service) StoreCoverImage(ctx context.Context, data []byte, fallbackType string) (string, error) {
	if len(data) == 0 {
		return "", nil
	}
	coverBytes, coverType, err := normalizeCoverBytes(data)
	if err != nil {
		coverBytes = data
		coverType = fallbackType
	}
	ext := mimeExt(coverType)
	// Key by SHA of the cover bytes so identical art across an album is shared.
	key := "covers/" + coverKey(coverBytes) + ext
	ok, err := s.Storage.Exists(ctx, key)
	if err != nil {
		return "", err
	}
	if !ok {
		if _, err := s.Storage.Put(ctx, key, byteReader(coverBytes), int64(len(coverBytes)), coverType); err != nil {
			return "", err
		}
	}
	return key, nil
}

func normalizeCoverBytes(data []byte) ([]byte, string, error) {
	src, _, err := image.Decode(bytes.NewReader(data))
	if err != nil {
		return nil, "", err
	}
	bounds := src.Bounds()
	dstW, dstH, resized := coverDimensions(bounds.Dx(), bounds.Dy(), maxStoredCoverDimension)
	if !resized {
		dstW = bounds.Dx()
		dstH = bounds.Dy()
	}

	dst := image.NewRGBA(image.Rect(0, 0, dstW, dstH))
	xdraw.CatmullRom.Scale(dst, dst.Bounds(), src, bounds, xdraw.Over, nil)

	var buf bytes.Buffer
	if err := jpeg.Encode(&buf, dst, &jpeg.Options{Quality: storedCoverJPEGQuality}); err != nil {
		return nil, "", err
	}
	return buf.Bytes(), "image/jpeg", nil
}

func coverDimensions(width int, height int, maxSize int) (int, int, bool) {
	if width <= 0 || height <= 0 || maxSize <= 0 {
		return width, height, false
	}
	if width <= maxSize && height <= maxSize {
		return width, height, false
	}
	if width >= height {
		return maxSize, max(1, int(float64(height)*float64(maxSize)/float64(width))), true
	}
	return max(1, int(float64(width)*float64(maxSize)/float64(height))), maxSize, true
}

func mimeExt(m string) string {
	switch strings.ToLower(m) {
	case "image/jpeg", "image/jpg":
		return ".jpg"
	case "image/png":
		return ".png"
	case "image/webp":
		return ".webp"
	}
	return ".bin"
}

func (s *Service) recordErr(ctx context.Context, path string, err error) {
	if s.Library != nil {
		s.Library.RecordIngestError(ctx, path, err.Error())
	}
	s.log().Warn("ingest error", "path", path, "err", err)
}

// joinArtistNames renders the parsed artist list as a single display string
// suitable for full-text search on an alias row. Roles are dropped — search
// only cares about the name substrings.
func joinArtistNames(refs []ArtistRef) string {
	if len(refs) == 0 {
		return ""
	}
	names := make([]string, 0, len(refs))
	for _, r := range refs {
		if r.Name != "" {
			names = append(names, r.Name)
		}
	}
	return strings.Join(names, ", ")
}

// RelativeMusicPath returns a path relative to whichever configured root
// contains it, or the original path if it lies outside every root.
func (s *Service) RelativeMusicPath(p string) string {
	for _, root := range s.AllRoots(context.Background()) {
		if rel, err := filepath.Rel(root, p); err == nil && !strings.HasPrefix(rel, "..") {
			return rel
		}
	}
	return p
}
