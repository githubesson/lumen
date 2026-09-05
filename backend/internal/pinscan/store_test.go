package pinscan

import (
	"reflect"
	"testing"
	"time"

	"github.com/githubesson/lumen/internal/dbutil"
)

func TestPatchValidationAndParameterOrdering(t *testing.T) {
	destination, label, enabled, interval := "folder", "name", false, 300
	var set dbutil.SetBuilder
	if err := AddPatch(&set, PatchFields{&destination, &label, &enabled, &interval}); err != nil {
		t.Fatal(err)
	}
	set.Add("tab = $%d", "Leaks")
	sql, args := set.Build()
	if sql != "updated_at = NOW(), destination_subdir = $1, label = $2, enabled = $3, scan_interval_seconds = $4, tab = $5" {
		t.Fatalf("bad SQL: %s", sql)
	}
	if !reflect.DeepEqual(args, []any{"folder", "name", false, 300, "Leaks"}) {
		t.Fatalf("bad args: %#v", args)
	}
	for _, invalid := range []int{-1, 0, 299} {
		var set dbutil.SetBuilder
		if err := AddPatch(&set, PatchFields{ScanIntervalSeconds: &invalid}); err == nil {
			t.Fatalf("accepted interval %d", invalid)
		}
		if set.Count() != 0 {
			t.Fatal("invalid patch changed builder")
		}
	}
}

func TestHistoryAndDownloadPolicies(t *testing.T) {
	for input, want := range map[int]int{-1: 200, 0: 200, 1: 1, 500: 500, 501: 200} {
		if got := HistoryLimit(input); got != want {
			t.Errorf("HistoryLimit(%d)=%d, want %d", input, got, want)
		}
	}
	for _, status := range []string{StatusFailed, StatusSkipped, ""} {
		if DownloadedAt(status) != nil {
			t.Fatalf("failure %q got a download timestamp", status)
		}
	}
	before := time.Now().UTC()
	for _, status := range []string{StatusDownloaded, StatusExisting} {
		stamp, ok := DownloadedAt(status).(time.Time)
		if !ok || stamp.Before(before) || stamp.After(time.Now().UTC()) {
			t.Fatalf("invalid success timestamp: %v", stamp)
		}
	}
}
