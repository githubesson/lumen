package ingest

import (
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"sort"
	"strings"

	"github.com/dhowden/tag"
)

// Metadata is the normalized subset of tags we care about.
type Metadata struct {
	Title       string
	Artists     []ArtistRef // ordered; first is primary, rest are featured by default
	AlbumArtist string
	Album       string
	TrackNo     int
	TrackTotal  int
	DiscNo      int
	DiscTotal   int
	Year        int
	Genre       string
	Composer    string
	Comment     string
	Format      string // "MP3", "FLAC", "M4A", "OGG", "WAV", ...
	Picture     *Picture
}

type ArtistRef struct {
	Name string
	Role string // "primary" | "featured" | "composer"
}

type Picture struct {
	MIMEType string
	Data     []byte
}

var supportedExt = map[string]bool{
	".mp3":  true,
	".flac": true,
	".m4a":  true,
	".mp4":  true,
	".ogg":  true,
	".opus": true,
	".wav":  true,
	".aac":  true,
	".webm": true,
}

// IsSupported returns true if the file extension is one we attempt to ingest.
func IsSupported(path string) bool {
	return supportedExt[strings.ToLower(filepath.Ext(path))]
}

// SupportedExtensions returns the ingest whitelist in stable order.
func SupportedExtensions() []string {
	out := make([]string, 0, len(supportedExt))
	for ext := range supportedExt {
		out = append(out, ext)
	}
	sort.Strings(out)
	return out
}

// ParseFile reads metadata from the file at path.
func ParseFile(path string) (*Metadata, error) {
	f, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	return parse(f, path)
}

func parse(rs io.ReadSeeker, path string) (*Metadata, error) {
	m, err := tag.ReadFrom(rs)
	if err != nil {
		// tag.ErrNoTagsFound is fine for WAV and similar — fall back to filename.
		if errors.Is(err, tag.ErrNoTagsFound) || strings.Contains(err.Error(), "no tags") || fallbackOnlyContainer(path) {
			return fallbackFromFilename(path), nil
		}
		return nil, fmt.Errorf("read tags: %w", err)
	}
	tr, trTotal := m.Track()
	dsc, dscTotal := m.Disc()

	md := &Metadata{
		Title:       strings.TrimSpace(m.Title()),
		AlbumArtist: strings.TrimSpace(m.AlbumArtist()),
		Album:       strings.TrimSpace(m.Album()),
		TrackNo:     tr,
		TrackTotal:  trTotal,
		DiscNo:      dsc,
		DiscTotal:   dscTotal,
		Year:        m.Year(),
		Genre:       strings.TrimSpace(m.Genre()),
		Composer:    strings.TrimSpace(m.Composer()),
		Comment:     strings.TrimSpace(m.Comment()),
		Format:      string(m.Format()),
	}
	md.Artists = splitArtists(m.Artist(), md.Composer)

	if p := m.Picture(); p != nil {
		md.Picture = &Picture{MIMEType: p.MIMEType, Data: append([]byte(nil), p.Data...)}
	}
	if md.Title == "" {
		md.Title = strings.TrimSuffix(filepath.Base(path), filepath.Ext(path))
	}
	return md, nil
}

func fallbackFromFilename(path string) *Metadata {
	base := strings.TrimSuffix(filepath.Base(path), filepath.Ext(path))
	return &Metadata{
		Title:  base,
		Format: strings.TrimPrefix(strings.ToUpper(filepath.Ext(path)), "."),
	}
}

func fallbackOnlyContainer(path string) bool {
	switch strings.ToLower(filepath.Ext(path)) {
	case ".webm":
		return true
	}
	return false
}

// splitArtists parses combined artist strings like "Alice feat. Bob & Carol"
// into ordered ArtistRefs. The first entry is the primary; later entries are
// featured. Composer is added separately if set.
func splitArtists(raw, composer string) []ArtistRef {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return nil
	}
	// Normalize common feat. markers to a single splitter.
	replacers := []string{
		" feat. ", "|",
		" feat ", "|",
		" ft. ", "|",
		" ft ", "|",
		" featuring ", "|",
		" vs. ", "|",
		" vs ", "|",
		" & ", "|",
		" x ", "|",
		", ", "|",
	}
	norm := raw
	for i := 0; i < len(replacers); i += 2 {
		norm = strings.ReplaceAll(norm, replacers[i], replacers[i+1])
	}
	parts := strings.Split(norm, "|")
	out := make([]ArtistRef, 0, len(parts))
	seen := map[string]bool{}
	for i, p := range parts {
		name := strings.TrimSpace(p)
		if name == "" {
			continue
		}
		key := strings.ToLower(name)
		if seen[key] {
			continue
		}
		seen[key] = true
		role := "featured"
		if i == 0 {
			role = "primary"
		}
		out = append(out, ArtistRef{Name: name, Role: role})
	}
	if composer != "" && composer != raw {
		key := strings.ToLower(composer)
		if !seen[key] {
			out = append(out, ArtistRef{Name: composer, Role: "composer"})
		}
	}
	return out
}
