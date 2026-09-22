package filen

import (
	"slices"
	"testing"
)

func TestHelperEnvDropsServerSecrets(t *testing.T) {
	got := helperEnv([]string{
		"PATH=/usr/bin",
		"HOME=/home/app",
		"HTTPS_PROXY=http://proxy:3128",
		"DATABASE_URL=postgres://secret",
		"COVER_SIGN_KEY=deadbeef",
		"LASTFM_SHARED_SECRET=shh",
		"FILEN_SHARE_PASSWORD=inherited",
		"malformed",
	})
	want := []string{"PATH=/usr/bin", "HOME=/home/app", "HTTPS_PROXY=http://proxy:3128"}
	if !slices.Equal(got, want) {
		t.Fatalf("helperEnv = %v, want %v", got, want)
	}
}
