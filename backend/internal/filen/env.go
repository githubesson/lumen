package filen

import "strings"

// helperEnvAllowlist is what the Node helper inherits from the server's
// environment. The helper runs third-party npm code (@filen/sdk and its
// dependencies), so it must not see server secrets such as DATABASE_URL,
// COVER_SIGN_KEY or LASTFM_SHARED_SECRET. Proxy and CA variables stay so the
// helper can reach Filen from the same network setup as the server.
var helperEnvAllowlist = map[string]bool{
	"PATH": true, "HOME": true, "TMPDIR": true, "TZ": true,
	"LANG": true, "LC_ALL": true, "LC_CTYPE": true,
	"NODE_OPTIONS": true, "NODE_EXTRA_CA_CERTS": true,
	"SSL_CERT_FILE": true, "SSL_CERT_DIR": true,
	"HTTP_PROXY": true, "HTTPS_PROXY": true, "NO_PROXY": true,
	"http_proxy": true, "https_proxy": true, "no_proxy": true,
}

// helperEnv filters environ (KEY=VALUE pairs) down to helperEnvAllowlist.
func helperEnv(environ []string) []string {
	out := make([]string, 0, len(helperEnvAllowlist))
	for _, kv := range environ {
		key, _, ok := strings.Cut(kv, "=")
		if ok && helperEnvAllowlist[key] {
			out = append(out, kv)
		}
	}
	return out
}
