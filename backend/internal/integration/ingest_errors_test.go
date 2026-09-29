package integration

import (
	"context"
	"os"
	"testing"

	"github.com/githubesson/lumen/internal/db"
	"github.com/githubesson/lumen/internal/library"
	"github.com/jackc/pgx/v5/pgxpool"
)

func TestListIngestErrorsOnePerFile(t *testing.T) {
	url := os.Getenv("LUMEN_REVIEW_TEST_DATABASE_URL")
	if url == "" {
		t.Skip("set LUMEN_REVIEW_TEST_DATABASE_URL to an isolated PostgreSQL database")
	}
	if err := db.Migrate(url); err != nil {
		t.Fatal(err)
	}
	ctx := context.Background()
	pool, err := pgxpool.New(ctx, url)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)
	const a, b = "/ingest-errors-test/a.flac", "/ingest-errors-test/b.flac"
	t.Cleanup(func() {
		_, _ = pool.Exec(context.Background(), `DELETE FROM ingest_errors WHERE file_path LIKE '/ingest-errors-test/%'`)
	})

	lib := library.NewStore(pool)
	// Each rescan retries a broken file and records another row.
	for _, rec := range []struct{ path, msg string }{
		{a, "first"},
		{b, "only"},
		{a, "second"},
		{a, "third"},
	} {
		if err := lib.RecordIngestError(ctx, rec.path, rec.msg); err != nil {
			t.Fatal(err)
		}
	}

	got, total, err := lib.ListIngestErrors(ctx, 500)
	if err != nil {
		t.Fatal(err)
	}
	var mine []library.IngestError
	for _, e := range got {
		if e.FilePath == a || e.FilePath == b {
			mine = append(mine, e)
		}
	}
	if len(mine) != 2 {
		t.Fatalf("got %d rows for the test files, want one per file: %+v", len(mine), mine)
	}
	// Newest first: a's latest failure was recorded after b's.
	if mine[0].FilePath != a || mine[0].Error != "third" || mine[0].Attempts != 3 {
		t.Errorf("first = %+v, want a's latest error with 3 attempts", mine[0])
	}
	if mine[1].FilePath != b || mine[1].Attempts != 1 {
		t.Errorf("second = %+v, want b with 1 attempt", mine[1])
	}
	if total < 2 {
		t.Errorf("total = %d, want at least the 2 test files", total)
	}

	if _, total, err := lib.ListIngestErrors(ctx, 1); err != nil || total < 2 {
		t.Errorf("limited total = %d, %v; want the full count", total, err)
	}
}
