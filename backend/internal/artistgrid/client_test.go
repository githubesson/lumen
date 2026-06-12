package artistgrid

import "testing"

func TestExtractTrackerID(t *testing.T) {
	id := "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQR"
	tests := map[string]string{
		"https://artistgrid.cx/view?id=" + id + "&artist=Destroy%20Lonely": id,
		"https://artistgrid.cx/view/" + id:                                 id,
		"https://docs.google.com/spreadsheets/d/" + id + "/edit#gid=0":     id,
		"/view?id=" + id:             id,
		id:                           id,
		"https://artistgrid.cx/view": "",
	}

	for input, want := range tests {
		if got := ExtractTrackerID(input); got != want {
			t.Fatalf("ExtractTrackerID(%q) = %q, want %q", input, got, want)
		}
	}
}
