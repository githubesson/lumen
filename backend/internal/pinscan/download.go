package pinscan

import (
	"context"

	"github.com/githubesson/lumen/internal/downloadfile"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
)

// DownloadPresent also recognizes files removed by ingestion after an audio
// dedup hit. Keep the original download path for source metadata and resolve
// the canonical path afresh so moved or deleted tracks are handled correctly.
func DownloadPresent(ctx context.Context, db *pgxpool.Pool, path string, trackID *uuid.UUID) bool {
	if downloadfile.NonEmpty(path) {
		return true
	}
	if trackID == nil || *trackID == uuid.Nil {
		return false
	}
	var canonical string
	err := db.QueryRow(ctx, `
		SELECT file_path FROM tracks
		WHERE id = $1 AND deleted_at IS NULL AND source = 'local'`, *trackID).Scan(&canonical)
	return err == nil && downloadfile.NonEmpty(canonical)
}
