package pinscan

import (
	"fmt"
	"time"

	"github.com/githubesson/lumen/internal/dbutil"
)

const DefaultIntervalSeconds = 3600
const MinIntervalSeconds = 300

func ValidateInterval(seconds int) error {
	if seconds < MinIntervalSeconds {
		return fmt.Errorf("scan_interval_seconds must be at least %d", MinIntervalSeconds)
	}
	return nil
}
func HistoryLimit(limit int) int {
	if limit <= 0 || limit > 500 {
		return 200
	}
	return limit
}
func DownloadedAt(status string) any {
	if status == StatusDownloaded || status == StatusExisting {
		return time.Now().UTC()
	}
	return nil
}

type PatchFields struct {
	DestinationSubdir   *string
	Label               *string
	Enabled             *bool
	ScanIntervalSeconds *int
}

// AddPatch validates the common fields and appends their parameterized SQL.
func AddPatch(set *dbutil.SetBuilder, in PatchFields) error {
	if in.ScanIntervalSeconds != nil {
		if err := ValidateInterval(*in.ScanIntervalSeconds); err != nil {
			return err
		}
	}
	set.AddRaw("updated_at = NOW()")
	if in.DestinationSubdir != nil {
		set.Add("destination_subdir = $%d", *in.DestinationSubdir)
	}
	if in.Label != nil {
		set.Add("label = $%d", *in.Label)
	}
	if in.Enabled != nil {
		set.Add("enabled = $%d", *in.Enabled)
	}
	if in.ScanIntervalSeconds != nil {
		set.Add("scan_interval_seconds = $%d", *in.ScanIntervalSeconds)
	}
	return nil
}
