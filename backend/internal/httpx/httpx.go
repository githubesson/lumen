// Package httpx holds small helpers shared by the backend's outbound HTTP
// integration clients (artistgrid, lastshare, imgur.gg).
package httpx

// BrowserUserAgent is a desktop-Chrome User-Agent string shared by the outbound
// integration clients so upstreams that gate on a browser-like UA treat every
// request the backend makes consistently. Previously this exact string was
// copy-pasted across the artistgrid and lastshare clients.
const BrowserUserAgent = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) " +
	"AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36"
