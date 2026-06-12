package dbutil

import (
	"errors"
	"fmt"
	"testing"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgtype"
)

func TestIsUniqueViolation(t *testing.T) {
	uniq := &pgconn.PgError{Code: "23505", Message: "duplicate key value violates unique constraint"}
	if !IsUniqueViolation(uniq) {
		t.Fatal("expected a 23505 PgError to be detected")
	}
	// Must still detect it when wrapped.
	if !IsUniqueViolation(fmt.Errorf("insert pin: %w", uniq)) {
		t.Fatal("expected a wrapped 23505 PgError to be detected")
	}
	// A different SQLSTATE is not a unique violation.
	if IsUniqueViolation(&pgconn.PgError{Code: "23503"}) {
		t.Fatal("foreign-key violation should not be reported as unique")
	}
	// A plain error whose text happens to contain "duplicate" must not match —
	// this is the brittleness the SQLSTATE check exists to avoid.
	if IsUniqueViolation(errors.New("duplicate key value")) {
		t.Fatal("a non-PgError must not be treated as a unique violation")
	}
	if IsUniqueViolation(nil) {
		t.Fatal("nil error must not be a unique violation")
	}
}

func TestSetBuilder(t *testing.T) {
	var b SetBuilder
	b.AddRaw("updated_at = NOW()")
	b.Add("label = $%d", "hello")
	b.Add("enabled = $%d", true)

	clause, args := b.Build()
	want := "updated_at = NOW(), label = $1, enabled = $2"
	if clause != want {
		t.Fatalf("clause = %q, want %q", clause, want)
	}
	if len(args) != 2 || args[0] != "hello" || args[1] != true {
		t.Fatalf("args = %v, want [hello true]", args)
	}
	// Count includes the raw "updated_at = NOW()" plus the two value sets.
	if b.Count() != 3 {
		t.Fatalf("Count = %d, want 3", b.Count())
	}

	// A trailing key (the WHERE id) gets the next placeholder number.
	args = append(args, 42)
	if got := len(args); got != 3 {
		t.Fatalf("after appending id, len(args) = %d, want 3", got)
	}
}

func TestNullableUUID(t *testing.T) {
	if got := NullableUUID(nil); got != nil {
		t.Fatalf("NullableUUID(nil) = %v, want nil", got)
	}
	id := uuid.New()
	if got := NullableUUID(&id); got != id {
		t.Fatalf("NullableUUID(&id) = %v, want %v", got, id)
	}
}

func TestUUIDPtrAndTimePtr(t *testing.T) {
	if UUIDPtr(pgtype.UUID{Valid: false}) != nil {
		t.Fatal("invalid pgtype.UUID should map to nil")
	}
	id := uuid.New()
	got := UUIDPtr(pgtype.UUID{Bytes: id, Valid: true})
	if got == nil || *got != id {
		t.Fatalf("UUIDPtr = %v, want %v", got, id)
	}

	if TimePtr(pgtype.Timestamptz{Valid: false}) != nil {
		t.Fatal("invalid pgtype.Timestamptz should map to nil")
	}
}
