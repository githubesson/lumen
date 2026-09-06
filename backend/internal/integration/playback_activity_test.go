package integration

import (
	"context"
	"os"
	"testing"
	"time"

	"github.com/githubesson/lumen/internal/activity"
	"github.com/githubesson/lumen/internal/db"
	"github.com/google/uuid"
)

// Exercise PostgreSQL parameter inference, which an in-memory store cannot test.
func TestPlaybackActivityVolumeRoundTrip(t *testing.T) {
	url := os.Getenv("LUMEN_REVIEW_TEST_DATABASE_URL")
	if url == "" {
		t.Skip("set LUMEN_REVIEW_TEST_DATABASE_URL to an isolated PostgreSQL database")
	}
	if err := db.Migrate(url); err != nil {
		t.Fatal(err)
	}
	ctx := context.Background()
	pool, err := db.Open(ctx, url)
	if err != nil {
		t.Fatal(err)
	}
	defer pool.Close()
	userID := uuid.New()
	if _, err := pool.Exec(ctx, `INSERT INTO users(id,username,password_hash,role) VALUES($1,$2,'test','user')`, userID, "volume-"+userID.String()); err != nil {
		t.Fatal(err)
	}
	defer pool.Exec(ctx, `DELETE FROM users WHERE id=$1`, userID)
	store := activity.NewStore(pool)
	volume := func(value float64) *float64 { return &value }
	muted := func(value bool) *bool { return &value }
	for _, test := range []struct {
		name       string
		device     string
		volume     *float64
		muted      *bool
		wantVolume float64
		wantMuted  bool
	}{
		{"default volume", "desktop", nil, nil, 1, false},
		{"fractional update", "desktop", volume(0.8), muted(false), 0.8, false},
		{"lower volume while muted", "desktop", volume(0.25), muted(true), 0.25, true},
		{"omitted values preserve state", "desktop", nil, nil, 0.25, true},
		{"explicit zero and unmute", "desktop", volume(0), muted(false), 0, false},
		{"omitted volume preserves zero", "desktop", nil, nil, 0, false},
		{"full volume", "desktop", volume(1), nil, 1, false},
		{"quiet fractional volume", "desktop", volume(0.01), nil, 0.01, false},
		{"clamp below zero", "desktop", volume(-0.5), nil, 0, false},
		{"clamp above one", "desktop", volume(1.5), nil, 1, false},
		{"fractional insert", "phone", volume(0.65), muted(true), 0.65, true},
	} {
		t.Run(test.name, func(t *testing.T) {
			row, err := store.Upsert(ctx, activity.UpsertInput{
				UserID: userID, DeviceID: test.device, DeviceName: test.device,
				TrackID: "track", Title: "Song", IsPlaying: true,
				Volume: test.volume, Muted: test.muted,
			})
			if err != nil {
				t.Fatal(err)
			}
			check := func(source string, row *activity.Activity) {
				t.Helper()
				if row == nil || row.Volume != test.wantVolume || row.Muted != test.wantMuted {
					t.Errorf("%s = %+v; want volume %g, muted %t", source, row, test.wantVolume, test.wantMuted)
				}
			}
			check("upsert", row)
			current, err := store.Current(ctx, userID, "", time.Minute)
			if err != nil {
				t.Fatal(err)
			}
			check("current activity", current)
			recent, err := store.ListRecent(ctx, userID, time.Minute)
			if err != nil {
				t.Fatal(err)
			}
			found := false
			for i := range recent {
				if recent[i].DeviceID == test.device {
					check("device snapshot", &recent[i])
					found = true
				}
			}
			if !found {
				t.Fatal("device missing from recent activity")
			}
		})
	}
}
