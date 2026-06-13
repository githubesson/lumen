package trackref

import (
	"fmt"
	"net/url"
	"strings"

	"github.com/google/uuid"
)

const (
	SourceLocal = "local"
	SourceTIDAL = "tidal"
)

type Ref struct {
	Source   string
	ID       string
	LocalID  uuid.UUID
	Original string
}

func Parse(raw string) (Ref, error) {
	orig := strings.TrimSpace(raw)
	if orig == "" {
		return Ref{}, fmt.Errorf("empty track id")
	}
	if decoded, err := url.PathUnescape(orig); err == nil {
		orig = strings.TrimSpace(decoded)
	}
	lower := strings.ToLower(orig)
	if strings.HasPrefix(lower, SourceLocal+":") {
		id, err := uuid.Parse(strings.TrimSpace(orig[len(SourceLocal)+1:]))
		if err != nil {
			return Ref{}, fmt.Errorf("bad local track id")
		}
		return Ref{Source: SourceLocal, ID: id.String(), LocalID: id, Original: raw}, nil
	}
	if strings.HasPrefix(lower, SourceTIDAL+":") {
		id := strings.TrimSpace(orig[len(SourceTIDAL)+1:])
		if id == "" {
			return Ref{}, fmt.Errorf("bad tidal track id")
		}
		if strings.Contains(id, "/") || strings.Contains(id, "\\") {
			return Ref{}, fmt.Errorf("bad tidal track id")
		}
		return Ref{Source: SourceTIDAL, ID: id, Original: raw}, nil
	}
	id, err := uuid.Parse(orig)
	if err != nil {
		return Ref{}, fmt.Errorf("bad track id")
	}
	return Ref{Source: SourceLocal, ID: id.String(), LocalID: id, Original: raw}, nil
}

func Local(id uuid.UUID) string {
	return SourceLocal + ":" + id.String()
}

func Remote(source, id string) string {
	return strings.ToLower(strings.TrimSpace(source)) + ":" + strings.TrimSpace(id)
}

func Canonical(source string, localID uuid.UUID, externalID string) string {
	source = strings.ToLower(strings.TrimSpace(source))
	if source == "" || source == SourceLocal {
		return Local(localID)
	}
	return Remote(source, externalID)
}
