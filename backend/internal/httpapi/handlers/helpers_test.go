package handlers

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestDecodeJSONAcceptsOneValueAndWhitespace(t *testing.T) {
	var dst struct {
		Name string `json:"name"`
	}
	r := httptest.NewRequest(http.MethodPost, "/", strings.NewReader("{\"name\":\"lumen\"} \n\t"))
	w := httptest.NewRecorder()

	if !decodeJSON(w, r, &dst) {
		t.Fatalf("decode failed: status=%d body=%q", w.Code, w.Body.String())
	}
	if dst.Name != "lumen" {
		t.Fatalf("unexpected decoded value: %q", dst.Name)
	}
}

func TestDecodeJSONRejectsTrailingValue(t *testing.T) {
	var dst map[string]any
	r := httptest.NewRequest(http.MethodPost, "/", strings.NewReader(`{"one":1} {"two":2}`))
	w := httptest.NewRecorder()

	if decodeJSON(w, r, &dst) {
		t.Fatal("expected decode to fail")
	}
	if w.Code != http.StatusBadRequest {
		t.Fatalf("expected 400, got %d", w.Code)
	}
}

func TestDecodeJSONRejectsOversizedBody(t *testing.T) {
	var dst any
	body := `"` + strings.Repeat("x", int(maxJSONBodyBytes)) + `"`
	r := httptest.NewRequest(http.MethodPost, "/", strings.NewReader(body))
	w := httptest.NewRecorder()

	if decodeJSON(w, r, &dst) {
		t.Fatal("expected decode to fail")
	}
	if w.Code != http.StatusRequestEntityTooLarge {
		t.Fatalf("expected 413, got %d: %q", w.Code, w.Body.String())
	}
}

func TestDecodeJSONRejectsEmptyBody(t *testing.T) {
	var dst any
	r := httptest.NewRequest(http.MethodPost, "/", http.NoBody)
	w := httptest.NewRecorder()

	if decodeJSON(w, r, &dst) {
		t.Fatal("expected decode to fail")
	}
	if w.Code != http.StatusBadRequest {
		t.Fatalf("expected 400, got %d", w.Code)
	}
}

func TestDecodeJSONRejectsOversizedString(t *testing.T) {
	var dst struct {
		Value string `json:"value"`
	}
	body := `{"value":"` + strings.Repeat("x", maxJSONStringBytes+1) + `"}`
	r := httptest.NewRequest(http.MethodPost, "/", strings.NewReader(body))
	w := httptest.NewRecorder()
	if decodeJSON(w, r, &dst) || w.Code != http.StatusBadRequest {
		t.Fatalf("expected oversized string to return 400, got %d", w.Code)
	}
}
