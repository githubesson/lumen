package preview

import "testing"

func TestBuildReplayCardSmoke(t *testing.T) {
	if _, err := storyFontFile(replayRegularFonts); err != nil {
		t.Skipf("story fonts unavailable on this machine: %v", err)
	}

	in := ReplayCardInput{
		PeriodTitle:    "This year · 2026",
		TotalPlays:     4812,
		ListeningLabel: "11d 6h",
		Tracks: []ReplayCardTrack{
			{Title: "Empty", Artist: "Juice WRLD", Plays: 142},
			{Title: "Robbery", Artist: "Juice WRLD", Plays: 118},
			{Title: "Falling Down", Artist: "Lil Peep, XXXTENTACION", Plays: 97},
			{Title: "Moonlight", Artist: "XXXTENTACION", Plays: 86},
			{Title: "Lucid Dreams", Artist: "Juice WRLD", Plays: 79},
		},
	}
	img, err := BuildReplayCard(in)
	if err != nil {
		t.Fatalf("BuildReplayCard: %v", err)
	}
	if got := img.Bounds(); got.Dx() != replayCardW || got.Dy() != replayCardH {
		t.Fatalf("bounds = %dx%d, want %dx%d", got.Dx(), got.Dy(), replayCardW, replayCardH)
	}
}

func TestBuildReplayCardNoTracks(t *testing.T) {
	if _, err := BuildReplayCard(ReplayCardInput{}); err == nil {
		t.Fatal("expected an error for empty input")
	}
}

func TestStripReplayEmoji(t *testing.T) {
	cases := map[string]string{
		"Weapon":                         "Weapon",
		"\U0001F5E1️ Weapon":             "Weapon",
		"Empty \U0001F480":               "Empty",
		"Löwenzahn · 世界":                 "Löwenzahn · 世界", // accents, CJK survive
		"\U0001F525\U0001F525\U0001F525": "",
		"A ❤️ B":                         "A B",
	}
	for in, want := range cases {
		if got := stripReplayEmoji(in); got != want {
			t.Errorf("stripReplayEmoji(%q) = %q, want %q", in, got, want)
		}
	}
}

func TestWrapReplayText(t *testing.T) {
	if _, err := storyFontFile(replayRegularFonts); err != nil {
		t.Skipf("story fonts unavailable on this machine: %v", err)
	}
	face, err := storyFontFace(replayRegularFonts, 72)
	if err != nil {
		t.Fatalf("storyFontFace: %v", err)
	}

	short := wrapReplayText(face, "Empty", 920, 2)
	if len(short) != 1 || short[0] != "Empty" {
		t.Fatalf("short title = %q, want [Empty]", short)
	}

	long := wrapReplayText(face, "LISTEN TO THIS IF YOU'RE STILL AWAKE AT 3AM", 920, 2)
	if len(long) != 2 {
		t.Fatalf("long title wrapped to %d lines, want 2: %q", len(long), long)
	}
	for _, line := range long {
		if w := textWidth(face, line); w > 920 {
			t.Errorf("wrapped line %q is %dpx wide, exceeds 920", line, w)
		}
	}
}

func TestFormatReplayCount(t *testing.T) {
	cases := map[int]string{0: "0", 7: "7", 999: "999", 1000: "1,000", 4812: "4,812", 1234567: "1,234,567"}
	for n, want := range cases {
		if got := formatReplayCount(n); got != want {
			t.Errorf("formatReplayCount(%d) = %q, want %q", n, got, want)
		}
	}
}
