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
	const root = "/ingest-errors-test"
	const a, b = root + "/a.flac", root + "/b.flac"
	// Outside the listed roots: a removed folder, and a sibling that only
	// shares the root's name as a prefix.
	const gone, sibling = "/ingest-errors-gone/c.flac", root + "-archive/d.flac"
	t.Cleanup(func() {
		_, _ = pool.Exec(context.Background(), `DELETE FROM ingest_errors WHERE file_path LIKE '/ingest-errors-%'`)
	})

	lib := library.NewStore(pool)
	// Each rescan retries a broken file and records another row.
	for _, rec := range []struct{ path, msg string }{
		{a, "first"},
		{b, "only"},
		{a, "second"},
		{a, "third"},
		{gone, "removed root"},
		{sibling, "sibling"},
	} {
		if err := lib.RecordIngestError(ctx, rec.path, rec.msg); err != nil {
			t.Fatal(err)
		}
	}

	got, total, err := lib.ListIngestErrors(ctx, []string{root}, 500)
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 2 {
		t.Fatalf("got %d rows, want one per file under the root: %+v", len(got), got)
	}
	// Newest first: a's latest failure was recorded after b's.
	if got[0].FilePath != a || got[0].Error != "third" || got[0].Attempts != 3 {
		t.Errorf("first = %+v, want a's latest error with 3 attempts", got[0])
	}
	if got[1].FilePath != b || got[1].Attempts != 1 {
		t.Errorf("second = %+v, want b with 1 attempt", got[1])
	}
	if total != 2 {
		t.Errorf("total = %d, want the 2 files under the root", total)
	}

	if _, total, err := lib.ListIngestErrors(ctx, []string{root + "/"}, 1); err != nil || total != 2 {
		t.Errorf("limited total = %d, %v; want the full count", total, err)
	}
	if got, total, err := lib.ListIngestErrors(ctx, nil, 10); err != nil || len(got) != 0 || total != 0 {
		t.Errorf("no roots = %+v (total %d), %v; want nothing", got, total, err)
	}
}
