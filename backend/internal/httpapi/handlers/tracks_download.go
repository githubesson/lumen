package handlers

import (
	"context"
	"io"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/google/uuid"

	"github.com/githubesson/lumen/internal/mediaembed"
)

// maxDownloadCoverBytes bounds a stored album cover read for embedding.
// Stored covers are normalized to at most 1024 px, far below this.
const maxDownloadCoverBytes = 16 << 20

// tagSlots bounds concurrent ffmpeg remuxes of local downloads: each holds
// an ffmpeg process and a temp copy of the file.
var tagSlots = make(chan struct{}, 4)

// serveTaggedLocal answers a download of a local track with a copy of its
// file carrying the library's metadata, the way TIDAL downloads carry
// TIDAL's: title, artists, album, album artist, year, numbering, genre,
// composer, comment, ISRC, and the album cover the viewer sees. The audio
// is stream-copied in its own container, and the file's other tags stay.
//
// It reports whether it served the request. It serves nothing when the
// format can't be retagged in place, ffmpeg is missing, or the remux fails;
// the caller then serves the file as stored.
func (h *Tracks) serveTaggedLocal(w http.ResponseWriter, r *http.Request, trackID, viewerID uuid.UUID, path string) bool {
	hint, ok := mediaembed.HintFromPath(path)
	if !ok || !mediaembed.Available() {
		return false
	}
	ctx := r.Context()
	tags, err := h.Library.TrackTags(ctx, trackID, viewerID)
	if err != nil {
		h.log().Warn("download: track tags unavailable; serving the file as stored", "track", trackID, "err", err)
		return false
	}
	cover := h.downloadCover(ctx, trackID, tags.CoverPath)

	select {
	case tagSlots <- struct{}{}:
		defer func() { <-tagSlots }()
	case <-ctx.Done():
		return true // the client left
	}
	tagged, err := mediaembed.EmbedFile(ctx, path, cover, mediaembed.Metadata{
		Title:       tags.Title,
		Artist:      strings.Join(tags.Performers, "; "),
		Album:       tags.Album,
		AlbumArtist: tags.AlbumArtist,
		Year:        tags.Year,
		TrackNo:     tags.TrackNo,
		DiscNo:      tags.DiscNo,
		ISRC:        tags.ISRC,
		Genre:       tags.Genre,
		Composer:    tags.Composer,
		Comment:     tags.Comment,
	}, hint)
	if err != nil {
		if ctx.Err() != nil {
			return true
		}
		h.log().Warn("download: retagging failed; serving the file as stored", "track", trackID, "err", err)
		return false
	}
	defer tagged.Cleanup()
	w.Header().Set("Content-Type", mediaembed.ContentType(hint))
	w.Header().Set("Accept-Ranges", "bytes")
	w.Header().Set("Content-Length", strconv.FormatInt(tagged.Size, 10))
	w.Header().Set("Cache-Control", "private, max-age=0")
	h.log().Info("download: local track served with library metadata",
		"track", trackID, "size", tagged.Size, "format", tagged.Format, "cover", cover != nil)
	// No modification time: the tags follow the library, not the file's.
	http.ServeContent(w, r, "track"+tagged.Ext, time.Time{}, tagged.File)
	return true
}

// downloadCover reads a stored album cover for embedding; nil when there is
// none or it can't be read, and the file's own art stays.
func (h *Tracks) downloadCover(ctx context.Context, trackID uuid.UUID, key string) []byte {
	if key == "" || h.Storage == nil {
		return nil
	}
	rc, _, err := h.Storage.Get(ctx, key)
	if err != nil {
		h.log().Warn("download: album cover unavailable; keeping the file's art", "track", trackID, "err", err)
		return nil
	}
	defer rc.Close()
	data, err := io.ReadAll(io.LimitReader(rc, maxDownloadCoverBytes+1))
	if err != nil || len(data) > maxDownloadCoverBytes {
		h.log().Warn("download: album cover unreadable; keeping the file's art", "track", trackID, "err", err)
		return nil
	}
	return data
}
