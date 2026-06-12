package handlers

import (
	"context"
	"fmt"
	"image/png"
	"io"
	"log/slog"
	"net/http"
	"os"
	"path/filepath"
	"strings"

	"github.com/google/uuid"

	"github.com/githubesson/lumen/internal/library"
	"github.com/githubesson/lumen/internal/preview"
)

// replayImageMaxTitle bounds the caller-supplied period label so a hostile
// query string can't push megabytes through the text renderer.
const replayImageMaxTitle = 48

// ReplayImage renders the user's Replay top-songs share card as a 1080x1920
// PNG for the same window the Replay screen is showing.
//
// Query params (all optional):
//
//	from   RFC3339 timestamp (inclusive)
//	to     RFC3339 timestamp (exclusive)
//	title  period label shown on the card, e.g. "This year · 2026"
func (h *Stats) ReplayImage(w http.ResponseWriter, r *http.Request) {
	u, ok := requireUser(w, r)
	if !ok {
		return
	}

	q := r.URL.Query()
	from, ok := parseOptionalTime(q.Get("from"))
	if !ok {
		http.Error(w, "bad from", http.StatusBadRequest)
		return
	}
	to, ok := parseOptionalTime(q.Get("to"))
	if !ok {
		http.Error(w, "bad to", http.StatusBadRequest)
		return
	}
	title := strings.TrimSpace(q.Get("title"))
	if runes := []rune(title); len(runes) > replayImageMaxTitle {
		title = string(runes[:replayImageMaxTitle])
	}

	data, err := h.Library.ReplayStats(r.Context(), library.ReplayStatsParams{
		ViewerID: u.ID,
		From:     from,
		To:       to,
	})
	if err != nil {
		http.Error(w, "internal error", http.StatusInternalServerError)
		return
	}
	if data.Summary.TotalPlays == 0 || len(data.TopTracks) == 0 {
		http.Error(w, "no plays in that window", http.StatusUnprocessableEntity)
		return
	}

	top := data.TopTracks
	if len(top) > 5 {
		top = top[:5]
	}
	in := preview.ReplayCardInput{
		PeriodTitle:    title,
		TotalPlays:     data.Summary.TotalPlays,
		ListeningLabel: formatListeningTime(data.Summary.TotalMs),
		Tracks:         make([]preview.ReplayCardTrack, 0, len(top)),
	}
	for _, t := range top {
		card := preview.ReplayCardTrack{
			Title:  t.Title,
			Artist: t.Artist,
			Plays:  t.Plays,
		}
		if t.AlbumID != nil {
			path, cleanup := h.replayCoverPath(r.Context(), u.ID, *t.AlbumID)
			defer cleanup()
			card.CoverPath = path
		}
		in.Tracks = append(in.Tracks, card)
	}

	img, err := preview.BuildReplayCard(in)
	if err != nil {
		slog.Error("replay image: render failed", "user", u.ID, "err", err)
		http.Error(w, "image generation failed", http.StatusInternalServerError)
		return
	}

	w.Header().Set("Content-Type", "image/png")
	w.Header().Set("Cache-Control", "private, no-store")
	w.Header().Set("Content-Disposition", `inline; filename="replay.png"`)
	if err := png.Encode(w, img); err != nil {
		// Headers are already out; the client sees a truncated body.
		slog.Warn("replay image: encode failed mid-response", "user", u.ID, "err", err)
	}
}

// replayCoverPath materializes an album's cover to a local temp file for the
// renderer (mirrors Share.localCoverPath). Failures are non-fatal: the card
// falls back to a placeholder tile. cleanup is always safe to call.
func (h *Stats) replayCoverPath(ctx context.Context, viewerID, albumID uuid.UUID) (string, func()) {
	noop := func() {}
	key, err := h.Library.AlbumCoverPathForViewer(ctx, albumID, viewerID)
	if err != nil || key == "" {
		return "", noop
	}
	body, _, err := h.Storage.Get(ctx, key)
	if err != nil {
		slog.Warn("replay image: cover fetch failed", "album", albumID, "err", err)
		return "", noop
	}
	defer body.Close()

	tmp, err := os.CreateTemp("", "lumen-replay-cover-*"+filepath.Ext(key))
	if err != nil {
		return "", noop
	}
	cleanup := func() { _ = os.Remove(tmp.Name()) }
	if _, err := io.Copy(tmp, body); err != nil {
		_ = tmp.Close()
		cleanup()
		return "", noop
	}
	if err := tmp.Close(); err != nil {
		cleanup()
		return "", noop
	}
	return tmp.Name(), cleanup
}

// formatListeningTime renders a millisecond total the way the mobile Replay
// screen does: "11d 6h", "3h 12m", or "42m".
func formatListeningTime(ms int64) string {
	if ms <= 0 {
		return "0m"
	}
	totalMinutes := ms / 60_000
	days := totalMinutes / (60 * 24)
	hours := (totalMinutes - days*60*24) / 60
	minutes := totalMinutes - days*60*24 - hours*60
	switch {
	case days >= 1 && hours > 0:
		return fmt.Sprintf("%dd %dh", days, hours)
	case days >= 1:
		return fmt.Sprintf("%dd", days)
	case hours >= 1 && minutes > 0:
		return fmt.Sprintf("%dh %dm", hours, minutes)
	case hours >= 1:
		return fmt.Sprintf("%dh", hours)
	default:
		return fmt.Sprintf("%dm", minutes)
	}
}
