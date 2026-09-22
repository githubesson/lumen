package middleware

import "net/http"

// NoSniff stops browsers from MIME-sniffing responses into a renderable type.
// Several routes stream bytes that originate elsewhere (uploads, stored
// covers, proxied media), so a declared type must be taken at face value.
func NoSniff(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("X-Content-Type-Options", "nosniff")
		next.ServeHTTP(w, r)
	})
}
