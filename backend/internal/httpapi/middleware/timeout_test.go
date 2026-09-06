package middleware

import (
	"io"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

func TestTimeoutWritesGatewayTimeoutWhenHandlerDoesNotRespond(t *testing.T) {
	h := Timeout(time.Millisecond)(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		<-r.Context().Done()
	}))

	rr := httptest.NewRecorder()
	h.ServeHTTP(rr, httptest.NewRequest(http.MethodGet, "/", nil))

	if rr.Code != http.StatusGatewayTimeout {
		t.Fatalf("expected 504, got %d", rr.Code)
	}
}

func TestTimeoutDoesNotOverwriteResponseWrittenAfterDeadline(t *testing.T) {
	h := Timeout(time.Millisecond)(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		<-r.Context().Done()
		http.Error(w, "handler saw timeout", http.StatusInternalServerError)
	}))

	rr := httptest.NewRecorder()
	h.ServeHTTP(rr, httptest.NewRequest(http.MethodGet, "/", nil))

	if rr.Code != http.StatusInternalServerError {
		t.Fatalf("expected handler's 500, got %d", rr.Code)
	}
	if rr.Body.String() != "handler saw timeout\n" {
		t.Fatalf("unexpected body: %q", rr.Body.String())
	}
}

func TestTimeoutDoesNotDetachHandlerThatIgnoresCancellation(t *testing.T) {
	h := Timeout(5 * time.Millisecond)(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		time.Sleep(25 * time.Millisecond)
	}))

	start := time.Now()
	rr := httptest.NewRecorder()
	h.ServeHTTP(rr, httptest.NewRequest(http.MethodGet, "/", nil))
	if elapsed := time.Since(start); elapsed < 20*time.Millisecond {
		t.Fatalf("handler was detached after %s", elapsed)
	}
	if rr.Code != http.StatusGatewayTimeout {
		t.Fatalf("expected 504, got %d", rr.Code)
	}
}

func TestTimeoutForwardsCompletedResponse(t *testing.T) {
	h := Timeout(time.Second)(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("X-Test", "yes")
		w.WriteHeader(http.StatusCreated)
		_, _ = io.WriteString(w, "created")
	}))

	rr := httptest.NewRecorder()
	h.ServeHTTP(rr, httptest.NewRequest(http.MethodPost, "/", nil))
	if rr.Code != http.StatusCreated || rr.Body.String() != "created" {
		t.Fatalf("unexpected response: status=%d body=%q", rr.Code, rr.Body.String())
	}
	if got := rr.Header().Get("X-Test"); got != "yes" {
		t.Fatalf("expected response header, got %q", got)
	}
}

func TestTimeoutPropagatesHandlerPanic(t *testing.T) {
	h := Timeout(time.Second)(http.HandlerFunc(func(http.ResponseWriter, *http.Request) {
		panic("boom")
	}))
	defer func() {
		if got := recover(); got != "boom" {
			t.Fatalf("recovered panic = %v, want boom", got)
		}
	}()
	h.ServeHTTP(httptest.NewRecorder(), httptest.NewRequest(http.MethodGet, "/", nil))
}
