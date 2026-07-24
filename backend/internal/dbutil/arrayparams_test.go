package dbutil

import (
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgtype"
)

// TestArrayParamEncoding pins the Go types the batched multi-row INSERTs bind
// to Postgres array parameters. It needs no database: it asks pgx's default
// type map for an encode plan and runs it, which is where the failure actually
// happens.
//
// This exists because []*uuid.UUID does NOT work: uuid.UUID has a
// value-receiver Value() method, so pgx picks the driver.Valuer path and
// panics dereferencing the nil element. Nullable UUID columns must be bound as
// []pgtype.UUID.
//
// Call sites: playlists.Store.AddTracks / ReplaceOrder,
// library.ReplaceTrackArtists / LinkTrackArtists.
func TestArrayParamEncoding(t *testing.T) {
	m := pgtype.NewMap()
	a, b := uuid.New(), uuid.New()

	cases := []struct {
		name string
		oid  uint32
		val  any
	}{
		{"uuid[] from []uuid.UUID", pgtype.UUIDArrayOID, []uuid.UUID{a, b}},
		{
			"uuid[] with NULLs from []pgtype.UUID",
			pgtype.UUIDArrayOID,
			[]pgtype.UUID{{Bytes: a, Valid: true}, {Valid: false}},
		},
		{"text[] from []string", pgtype.TextArrayOID, []string{"primary", "featured"}},
		{"int4[] from []int32", pgtype.Int4ArrayOID, []int32{0, 1}},
		{"timestamptz[] from []time.Time", pgtype.TimestamptzArrayOID, []time.Time{time.Unix(0, 0).UTC()}},
	}

	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			plan := m.PlanEncode(c.oid, pgtype.BinaryFormatCode, c.val)
			if plan == nil {
				t.Fatalf("no binary encode plan for %T into oid %d", c.val, c.oid)
			}
			// Encode panics rather than erroring for the nil-pointer case, so
			// the panic itself is the assertion.
			if _, err := plan.Encode(c.val, nil); err != nil {
				t.Fatalf("encoding %T into oid %d: %v", c.val, c.oid, err)
			}
		})
	}
}

// TestNullableUUIDSliceIsRejected documents the trap the test above guards
// against, so a future change back to []*uuid.UUID fails here with an
// explanation rather than in production.
func TestNullableUUIDSliceIsRejected(t *testing.T) {
	m := pgtype.NewMap()
	a := uuid.New()
	val := []*uuid.UUID{&a, nil}

	plan := m.PlanEncode(pgtype.UUIDArrayOID, pgtype.BinaryFormatCode, val)
	if plan == nil {
		return // no plan at all is also a rejection
	}
	defer func() {
		if recover() == nil {
			t.Fatal("expected []*uuid.UUID with a nil element to fail to encode; " +
				"if pgx has fixed this, the pgtype.UUID workaround in " +
				"playlists.Store.ReplaceOrder can be simplified")
		}
	}()
	_, _ = plan.Encode(val, nil)
}
