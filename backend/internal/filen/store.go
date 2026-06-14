// Package filen stores pinned Filen share links and download history.
package filen

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/githubesson/lumen/internal/dbtext"
	"github.com/githubesson/lumen/internal/dbutil"
	"github.com/githubesson/lumen/internal/pinscan"
)

var ErrNotFound = errors.New("filen share pin not found")

// Status values are sourced from pinscan so filen and artistgrid share one
// vocabulary; the package-local names are kept for call-site brevity.
const (
	StatusDownloaded = pinscan.StatusDownloaded
	StatusExisting   = pinscan.StatusExisting
	StatusSkipped    = pinscan.StatusSkipped
	StatusFailed     = pinscan.StatusFailed
)

type Pin struct {
	ID                  uuid.UUID  `json:"id"`
	RootID              *uuid.UUID `json:"root_id,omitempty"`
	RootPath            string     `json:"root_path"`
	DestinationSubdir   string     `json:"destination_subdir"`
	ShareURL            string     `json:"share_url"`
	Password            string     `json:"-"`
	Label               string     `json:"label"`
	Enabled             bool       `json:"enabled"`
	ScanIntervalSeconds int        `json:"scan_interval_seconds"`
	LastScanAt          *time.Time `json:"last_scan_at,omitempty"`
	LastSuccessAt       *time.Time `json:"last_success_at,omitempty"`
	LastError           string     `json:"last_error,omitempty"`
	CreatedAt           time.Time  `json:"created_at"`
	UpdatedAt           time.Time  `json:"updated_at"`
}

type AddPinInput struct {
	RootID              *uuid.UUID
	RootPath            string
	DestinationSubdir   string
	ShareURL            string
	Password            string
	Label               string
	Enabled             bool
	ScanIntervalSeconds int
}

type PatchPinInput struct {
	DestinationSubdir   *string
	Password            *string
	Label               *string
	Enabled             *bool
	ScanIntervalSeconds *int
}

type Download struct {
	ID           int64           `json:"id"`
	PinID        uuid.UUID       `json:"pin_id"`
	SourcePath   string          `json:"source_path"`
	FilePath     string          `json:"file_path,omitempty"`
	SizeBytes    int64           `json:"size_bytes"`
	Status       string          `json:"status"`
	Error        string          `json:"error,omitempty"`
	TrackID      *uuid.UUID      `json:"track_id,omitempty"`
	Metadata     json.RawMessage `json:"metadata,omitempty"`
	FirstSeenAt  time.Time       `json:"first_seen_at"`
	DownloadedAt *time.Time      `json:"downloaded_at,omitempty"`
	UpdatedAt    time.Time       `json:"updated_at"`
}

type DownloadInput struct {
	PinID      uuid.UUID
	SourcePath string
	FilePath   string
	SizeBytes  int64
	Status     string
	Error      string
	TrackID    *uuid.UUID
	Metadata   json.RawMessage
}

type Store struct {
	db *pgxpool.Pool
}

func NewStore(db *pgxpool.Pool) *Store { return &Store{db: db} }

func (s *Store) ListPins(ctx context.Context) ([]Pin, error) {
	rows, err := s.db.Query(ctx, `
		SELECT id, root_id, root_path, destination_subdir, share_url, password,
		       label, enabled, scan_interval_seconds, last_scan_at, last_success_at,
		       last_error, created_at, updated_at
		FROM filen_share_pins
		ORDER BY created_at ASC`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []Pin{}
	for rows.Next() {
		p, err := scanPin(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, p)
	}
	return out, rows.Err()
}

func (s *Store) DuePins(ctx context.Context, limit int) ([]Pin, error) {
	if limit <= 0 {
		limit = 20
	}
	rows, err := s.db.Query(ctx, `
		SELECT id, root_id, root_path, destination_subdir, share_url, password,
		       label, enabled, scan_interval_seconds, last_scan_at, last_success_at,
		       last_error, created_at, updated_at
		FROM filen_share_pins
		WHERE enabled = TRUE
		  AND (
		      last_scan_at IS NULL
		      OR last_scan_at + (scan_interval_seconds * INTERVAL '1 second') <= NOW()
		  )
		ORDER BY last_scan_at ASC NULLS FIRST
		LIMIT $1`, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []Pin{}
	for rows.Next() {
		p, err := scanPin(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, p)
	}
	return out, rows.Err()
}

func (s *Store) GetPin(ctx context.Context, id uuid.UUID) (Pin, error) {
	p, err := scanPin(s.db.QueryRow(ctx, `
		SELECT id, root_id, root_path, destination_subdir, share_url, password,
		       label, enabled, scan_interval_seconds, last_scan_at, last_success_at,
		       last_error, created_at, updated_at
		FROM filen_share_pins
		WHERE id = $1`, id))
	if errors.Is(err, pgx.ErrNoRows) {
		return Pin{}, ErrNotFound
	}
	return p, err
}

func (s *Store) AddPin(ctx context.Context, in AddPinInput) (Pin, error) {
	if in.ScanIntervalSeconds == 0 {
		in.ScanIntervalSeconds = 3600
	}
	if in.ScanIntervalSeconds < 300 {
		return Pin{}, fmt.Errorf("scan_interval_seconds must be at least 300")
	}
	p, err := scanPin(s.db.QueryRow(ctx, `
		INSERT INTO filen_share_pins (
			root_id, root_path, destination_subdir, share_url, password,
			label, enabled, scan_interval_seconds
		)
		VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
		RETURNING id, root_id, root_path, destination_subdir, share_url, password,
		          label, enabled, scan_interval_seconds, last_scan_at, last_success_at,
		          last_error, created_at, updated_at`,
		dbutil.NullableUUID(in.RootID), in.RootPath, in.DestinationSubdir, in.ShareURL,
		in.Password, in.Label, in.Enabled, in.ScanIntervalSeconds,
	))
	if err != nil && dbutil.IsUniqueViolation(err) {
		return Pin{}, fmt.Errorf("share is already pinned for that destination")
	}
	return p, err
}

func (s *Store) PatchPin(ctx context.Context, id uuid.UUID, in PatchPinInput) (Pin, error) {
	var set dbutil.SetBuilder
	set.AddRaw("updated_at = NOW()")
	if in.DestinationSubdir != nil {
		set.Add("destination_subdir = $%d", *in.DestinationSubdir)
	}
	if in.Password != nil {
		set.Add("password = $%d", *in.Password)
	}
	if in.Label != nil {
		set.Add("label = $%d", *in.Label)
	}
	if in.Enabled != nil {
		set.Add("enabled = $%d", *in.Enabled)
	}
	if in.ScanIntervalSeconds != nil {
		if *in.ScanIntervalSeconds < 300 {
			return Pin{}, fmt.Errorf("scan_interval_seconds must be at least 300")
		}
		set.Add("scan_interval_seconds = $%d", *in.ScanIntervalSeconds)
	}
	setClause, args := set.Build()
	args = append(args, id)
	stmt := fmt.Sprintf(`
		UPDATE filen_share_pins SET %s
		WHERE id = $%d
		RETURNING id, root_id, root_path, destination_subdir, share_url, password,
		          label, enabled, scan_interval_seconds, last_scan_at, last_success_at,
		          last_error, created_at, updated_at`,
		setClause, len(args),
	)
	p, err := scanPin(s.db.QueryRow(ctx, stmt, args...))
	if errors.Is(err, pgx.ErrNoRows) {
		return Pin{}, ErrNotFound
	}
	if err != nil && dbutil.IsUniqueViolation(err) {
		return Pin{}, fmt.Errorf("share is already pinned for that destination")
	}
	return p, err
}

func (s *Store) DeletePin(ctx context.Context, id uuid.UUID) error {
	tag, err := s.db.Exec(ctx, `DELETE FROM filen_share_pins WHERE id = $1`, id)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return ErrNotFound
	}
	return nil
}

func (s *Store) MarkScanStarted(ctx context.Context, id uuid.UUID) error {
	_, err := s.db.Exec(ctx, `
		UPDATE filen_share_pins
		SET last_scan_at = NOW(), last_error = '', updated_at = NOW()
		WHERE id = $1`, id)
	return err
}

func (s *Store) MarkScanFinished(ctx context.Context, id uuid.UUID, scanErr error) error {
	if scanErr != nil {
		_, err := s.db.Exec(ctx, `
			UPDATE filen_share_pins
			SET last_error = $2, updated_at = NOW()
			WHERE id = $1`, id, dbtext.Clean(scanErr.Error()))
		return err
	}
	_, err := s.db.Exec(ctx, `
		UPDATE filen_share_pins
		SET last_success_at = NOW(), last_error = '', updated_at = NOW()
		WHERE id = $1`, id)
	return err
}

func (s *Store) DownloadForSource(ctx context.Context, pinID uuid.UUID, sourcePath string) (Download, error) {
	sourcePath = dbtext.Clean(sourcePath)
	d, err := scanDownload(s.db.QueryRow(ctx, `
		SELECT id, pin_id, source_path, file_path, size_bytes, status, error,
		       track_id, metadata, first_seen_at, downloaded_at, updated_at
		FROM filen_downloads
		WHERE pin_id = $1 AND source_path = $2`, pinID, sourcePath))
	if errors.Is(err, pgx.ErrNoRows) {
		return Download{}, ErrNotFound
	}
	return d, err
}

func (s *Store) RecordDownload(ctx context.Context, in DownloadInput) error {
	if len(in.Metadata) == 0 {
		in.Metadata = json.RawMessage(`{}`)
	}
	in.SourcePath = dbtext.Clean(in.SourcePath)
	in.FilePath = dbtext.Clean(in.FilePath)
	in.Status = dbtext.Clean(in.Status)
	in.Error = dbtext.Clean(in.Error)
	var downloadedAt any
	if in.Status == StatusDownloaded || in.Status == StatusExisting {
		downloadedAt = time.Now().UTC()
	}
	_, err := s.db.Exec(ctx, `
		INSERT INTO filen_downloads (
			pin_id, source_path, file_path, size_bytes, status, error,
			track_id, metadata, downloaded_at
		)
		VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
		ON CONFLICT (pin_id, source_path) DO UPDATE SET
			file_path = CASE
				WHEN EXCLUDED.status IN ('downloaded', 'existing') AND EXCLUDED.file_path <> '' THEN EXCLUDED.file_path
				WHEN EXCLUDED.status IN ('failed', 'skipped') THEN ''
				ELSE filen_downloads.file_path
			END,
			size_bytes = CASE
				WHEN EXCLUDED.size_bytes > 0 THEN EXCLUDED.size_bytes
				ELSE filen_downloads.size_bytes
			END,
			status = EXCLUDED.status,
			error = EXCLUDED.error,
			track_id = COALESCE(EXCLUDED.track_id, filen_downloads.track_id),
			metadata = EXCLUDED.metadata,
			downloaded_at = COALESCE(EXCLUDED.downloaded_at, filen_downloads.downloaded_at),
			updated_at = NOW()`,
		in.PinID, in.SourcePath, in.FilePath, in.SizeBytes, in.Status, in.Error,
		dbutil.NullableUUID(in.TrackID), in.Metadata, downloadedAt,
	)
	return err
}

func (s *Store) ListDownloads(ctx context.Context, pinID uuid.UUID, limit int) ([]Download, error) {
	if limit <= 0 || limit > 500 {
		limit = 200
	}
	rows, err := s.db.Query(ctx, `
		SELECT id, pin_id, source_path, file_path, size_bytes, status, error,
		       track_id, metadata, first_seen_at, downloaded_at, updated_at
		FROM filen_downloads
		WHERE pin_id = $1
		ORDER BY updated_at DESC
		LIMIT $2`, pinID, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []Download{}
	for rows.Next() {
		d, err := scanDownload(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, d)
	}
	return out, rows.Err()
}

type scanner interface {
	Scan(dest ...any) error
}

func scanPin(row scanner) (Pin, error) {
	var (
		p           Pin
		rootID      pgtype.UUID
		lastScan    pgtype.Timestamptz
		lastSuccess pgtype.Timestamptz
	)
	err := row.Scan(
		&p.ID, &rootID, &p.RootPath, &p.DestinationSubdir, &p.ShareURL, &p.Password,
		&p.Label, &p.Enabled, &p.ScanIntervalSeconds, &lastScan, &lastSuccess,
		&p.LastError, &p.CreatedAt, &p.UpdatedAt,
	)
	if err != nil {
		return Pin{}, err
	}
	p.RootID = dbutil.UUIDPtr(rootID)
	p.LastScanAt = dbutil.TimePtr(lastScan)
	p.LastSuccessAt = dbutil.TimePtr(lastSuccess)
	return p, nil
}

func scanDownload(row scanner) (Download, error) {
	var (
		d            Download
		trackID      pgtype.UUID
		downloadedAt pgtype.Timestamptz
	)
	err := row.Scan(
		&d.ID, &d.PinID, &d.SourcePath, &d.FilePath, &d.SizeBytes, &d.Status, &d.Error,
		&trackID, &d.Metadata, &d.FirstSeenAt, &downloadedAt, &d.UpdatedAt,
	)
	if err != nil {
		return Download{}, err
	}
	d.TrackID = dbutil.UUIDPtr(trackID)
	d.DownloadedAt = dbutil.TimePtr(downloadedAt)
	return d, nil
}
