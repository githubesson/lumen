// Package pinscan holds the constants shared by the "pinned download source"
// integrations (filen, artistgrid). These two packages implement the same
// pin -> scan -> download -> ingest pipeline against different upstreams; the
// values here keep their status vocabulary and scheduler tuning in one place so
// the two pipelines cannot silently drift apart (as they previously had).
package pinscan

import "time"

// Download/scan status values, stored on download rows and reported to the
// admin UI. They are a shared vocabulary across every pinned source.
const (
	StatusDownloaded = "downloaded" // newly fetched this scan
	StatusExisting   = "existing"   // already present on disk / in the library
	StatusSkipped    = "skipped"    // intentionally not downloaded (e.g. non-audio)
	StatusFailed     = "failed"     // download or processing failed
)

// DefaultScanBatch is the number of due pins a scheduler tick processes. This
// reconciles a prior drift (filen used 10, artistgrid 20) onto a single value.
const DefaultScanBatch = 20

// InitialScanDelay is how long a scheduler waits after start before its first
// scan, giving the rest of the server time to come up. Reconciles a prior drift
// (filen fired immediately, artistgrid waited 10s) onto the gentler value.
const InitialScanDelay = 10 * time.Second
