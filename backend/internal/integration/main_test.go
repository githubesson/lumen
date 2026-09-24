package integration

import (
	"context"
	"fmt"
	"os"
	"testing"

	"github.com/githubesson/lumen/internal/testdb"
)

// TestMain moves this package onto its own database: its tests count visible
// library tracks, which other packages' tests insert concurrently.
func TestMain(m *testing.M) {
	const env = "LUMEN_REVIEW_TEST_DATABASE_URL"
	if base := os.Getenv(env); base != "" {
		if own, err := testdb.Sibling(context.Background(), base, "_integration"); err == nil {
			os.Setenv(env, own)
		} else {
			fmt.Fprintf(os.Stderr, "integration: using the shared test database: %v\n", err)
		}
	}
	os.Exit(m.Run())
}
