package library

import (
	"context"
	"os"
	"path/filepath"
	"strings"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

// IngestFingerprint describes the file observed during a successful ingest.
// It is separate from file_size, which may belong to older deduplicated tags.
type IngestFingerprint struct {
	Size    int64
	MTimeNS int64
}

func SetIngestFingerprint(ctx context.Context, tx pgx.Tx, trackID uuid.UUID, path string, fingerprint *IngestFingerprint) error {
	var size, mtime *int64
	if fingerprint != nil {
		size, mtime = &fingerprint.Size, &fingerprint.MTimeNS
	}
	// Preserve the path representation used by InsertTrack. A duplicate must
	// never overwrite the canonical file's fingerprint.
	_, err := tx.Exec(ctx, `
		UPDATE tracks SET ingested_file_size = $3, ingested_mtime_ns = $4,
		    ingested_file_path = CASE WHEN $3::bigint IS NULL THEN NULL ELSE $2 END
		WHERE id = $1 AND file_path = $2 AND owner_id IS NULL AND source = 'local'`,
		trackID, path, size, mtime)
	return err
}

// IngestFingerprints loads one snapshot per rescan instead of querying once
// per file. Deleted, moved, private and previously failing files are retried.
func (s *Store) IngestFingerprints(ctx context.Context, roots []string) (map[string]IngestFingerprint, error) {
	out := make(map[string]IngestFingerprint)
	if len(roots) == 0 {
		return out, nil
	}
	cwd, err := os.Getwd()
	if err != nil {
		return nil, err
	}
	absolutePrefixes := make([]string, 0, len(roots))
	prefixes := make([]string, 0, 3*len(roots))
	for _, root := range roots {
		abs, err := filepath.Abs(root)
		if err != nil {
			return nil, err
		}
		prefix := strings.TrimSuffix(abs, string(filepath.Separator)) + string(filepath.Separator)
		absolutePrefixes = append(absolutePrefixes, prefix)
		prefixes = append(prefixes, prefix)
		// Ingest preserves relative MUSIC_PATH values in the database, while
		// the scanner compares absolute paths. Load both representations.
		rel, err := filepath.Rel(cwd, abs)
		if err != nil {
			return nil, err
		}
		if rel == "." {
			// Files directly under cwd have no directory prefix. Scope the
			// resulting candidates against absolute roots below.
			prefixes = append(prefixes, "")
		} else {
			rel += string(filepath.Separator)
			prefixes = append(prefixes, rel, "."+string(filepath.Separator)+rel)
		}
	}
	rows, err := s.db.Query(ctx, `
		SELECT t.file_path, t.ingested_file_size, t.ingested_mtime_ns
		FROM tracks t
		WHERE t.deleted_at IS NULL AND t.owner_id IS NULL AND t.source = 'local'
		  AND t.ingested_file_size IS NOT NULL AND t.ingested_mtime_ns IS NOT NULL
		  AND t.ingested_file_path = t.file_path AND t.duration_ms > 0
		  AND EXISTS (SELECT 1 FROM unnest($1::text[]) p WHERE starts_with(t.file_path, p))
		  AND NOT EXISTS (SELECT 1 FROM ingest_errors e WHERE e.file_path = t.file_path)`, prefixes)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	for rows.Next() {
		var path string
		var fingerprint IngestFingerprint
		if err := rows.Scan(&path, &fingerprint.Size, &fingerprint.MTimeNS); err != nil {
			return nil, err
		}
		abs, err := filepath.Abs(path)
		if err != nil {
			return nil, err
		}
		for _, prefix := range absolutePrefixes {
			if strings.HasPrefix(abs, prefix) {
				out[abs] = fingerprint
				break
			}
		}
	}
	return out, rows.Err()
}
