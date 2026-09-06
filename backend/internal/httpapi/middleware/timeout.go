package middleware

import (
	"context"
	"net/http"
	"time"

	chimw "github.com/go-chi/chi/v5/middleware"
)

// Timeout supplies a deadline to context-aware handlers without detaching them
// into an unbounded goroutine or buffering their response. A 504 is written
// only when the handler returns without having started a response.
func Timeout(timeout time.Duration) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			ctx, cancel := context.WithTimeout(r.Context(), timeout)
			defer cancel()

			ww := chimw.NewWrapResponseWriter(w, r.ProtoMajor)
			next.ServeHTTP(ww, r.WithContext(ctx))
			if ctx.Err() == context.DeadlineExceeded && ww.Status() == 0 && ww.BytesWritten() == 0 {
				http.Error(ww, http.StatusText(http.StatusGatewayTimeout), http.StatusGatewayTimeout)
			}
		})
	}
}
