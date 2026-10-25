package library

import (
	"slices"
	"testing"
	"time"

	"github.com/google/uuid"
)

func TestComparePlaybackPrefersTheBetterFile(t *testing.T) {
	now := time.Now()
	file := func(name string, bitrate, sampleRate int) LinkedFile {
		return LinkedFile{TrackID: uuid.New(), FilePath: "/music/" + name, Bitrate: bitrate, SampleRate: sampleRate, CreatedAt: now}
	}
	cases := []struct {
		name          string
		better, worse LinkedFile
	}{
		{"a 24-bit WAV over the MP3 encoded from it",
			file("calm down gz.wav", 2_116_800, 44_100), file("Calm Down.mp3", 320_000, 44_100)},
		{"lossless over a lossy file of any bitrate",
			file("x.flac", 700_000, 44_100), file("x.mp3", 999_000, 48_000)},
		{"the higher sample rate among lossless files",
			file("x.flac", 2_000_000, 96_000), file("x.wav", 2_116_800, 44_100)},
		{"more bits per sample at the same rate",
			file("x24.wav", 2_116_800, 44_100), file("x16.wav", 1_411_200, 44_100)},
		{"the higher bitrate among lossy files",
			file("x.mp3", 320_000, 44_100), file("x.m4a", 256_000, 44_100)},
		{"an M4A at an ALAC bitrate is lossless",
			file("x.m4a", 900_000, 44_100), file("x.mp3", 320_000, 44_100)},
		{"extensions are matched however the path is written",
			file(`C:\Music\X.WAV`, 1_411_200, 44_100), file("x.mp3", 320_000, 44_100)},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			if comparePlayback(c.better, c.worse) >= 0 || comparePlayback(c.worse, c.better) <= 0 {
				t.Fatalf("%s should play before %s", c.better.FilePath, c.worse.FilePath)
			}
		})
	}

	// Equal files: the shown track's plays, then the older one's, so the
	// choice is stable whatever order the rows come back in.
	a, b, c := file("a.mp3", 320_000, 44_100), file("b.mp3", 320_000, 44_100), file("c.mp3", 320_000, 44_100)
	b.Shown = true
	c.CreatedAt = now.Add(-time.Hour)
	for _, order := range [][]LinkedFile{{a, b, c}, {c, a, b}, {a, c, b}} {
		files := slices.Clone(order)
		slices.SortFunc(files, comparePlayback)
		if files[0].FilePath != b.FilePath || files[1].FilePath != c.FilePath {
			t.Fatalf("tie order = %s, %s, %s", files[0].FilePath, files[1].FilePath, files[2].FilePath)
		}
	}
}
