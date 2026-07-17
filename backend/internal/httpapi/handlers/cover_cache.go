package handlers

import (
	"container/list"
	"context"
	"log/slog"
	"net/url"
	"sync"
	"time"

	"golang.org/x/sync/singleflight"
)

// Remote covers (TIDAL CDN artwork) are proxied through the backend so the
// browser receives them same-origin: the CDN sends no CORS headers, which
// taints any canvas a client draws the cover on and breaks ambient-accent
// pixel reads. Proxying every request would re-fetch from TIDAL each time,
// so a small in-RAM LRU keeps recently served covers hot.
const (
	coverCacheMaxEntries = 150
	coverCacheTTL        = 5 * time.Minute
	// A 640x640 JPEG runs ~100 KB; anything above this cap is an outlier not
	// worth pinning in RAM. Oversized covers are still proxied, just not cached.
	coverCacheMaxEntryBytes = 4 << 20
	coverWarmConcurrency    = 4
	// Warms queued beyond this are dropped; queuing more than the cache can
	// hold would only fetch covers that immediately evict each other.
	coverWarmQueueDepth = coverCacheMaxEntries
	coverFetchTimeout   = 10 * time.Second
)

type coverCacheEntry struct {
	url         string
	data        []byte
	contentType string
	fetchedAt   time.Time
}

type coverCacheStore struct {
	mu      sync.Mutex
	entries map[string]*list.Element
	order   *list.List // front = most recently used

	// fetches coalesces concurrent upstream requests for the same URL — an
	// on-demand serve landing while a warm is in flight joins that flight
	// instead of fetching again.
	fetches   singleflight.Group
	warmOnce  sync.Once
	warmQueue chan string
}

var coverCache = newCoverCacheStore()

func newCoverCacheStore() *coverCacheStore {
	return &coverCacheStore{
		entries:   make(map[string]*list.Element),
		order:     list.New(),
		warmQueue: make(chan string, coverWarmQueueDepth),
	}
}

func (c *coverCacheStore) get(url string) ([]byte, string, bool) {
	c.mu.Lock()
	defer c.mu.Unlock()
	el, ok := c.entries[url]
	if !ok {
		return nil, "", false
	}
	ent := el.Value.(*coverCacheEntry)
	if time.Since(ent.fetchedAt) > coverCacheTTL {
		c.order.Remove(el)
		delete(c.entries, url)
		return nil, "", false
	}
	c.order.MoveToFront(el)
	return ent.data, ent.contentType, true
}

func (c *coverCacheStore) put(url string, data []byte, contentType string) {
	if len(data) == 0 || len(data) > coverCacheMaxEntryBytes {
		return
	}
	ent := &coverCacheEntry{url: url, data: data, contentType: contentType, fetchedAt: time.Now()}
	c.mu.Lock()
	defer c.mu.Unlock()
	if el, ok := c.entries[url]; ok {
		el.Value = ent
		c.order.MoveToFront(el)
		return
	}
	c.entries[url] = c.order.PushFront(ent)
	for c.order.Len() > coverCacheMaxEntries {
		oldest := c.order.Back()
		c.order.Remove(oldest)
		delete(c.entries, oldest.Value.(*coverCacheEntry).url)
	}
}

// fetchCached returns the cover from cache, or fetches and caches it.
// Concurrent callers for the same URL share a single upstream request. The
// fetch runs on a detached context so a client disconnecting mid-flight
// doesn't fail the other callers (or waste the warm) sharing it.
func (c *coverCacheStore) fetchCached(u *url.URL) ([]byte, string, error) {
	key := u.String()
	if data, ct, ok := c.get(key); ok {
		return data, ct, nil
	}
	v, err, _ := c.fetches.Do(key, func() (any, error) {
		// Re-check under the flight: a just-completed flight may have
		// populated the cache between our miss and Do() running.
		if data, ct, ok := c.get(key); ok {
			return &coverCacheEntry{data: data, contentType: ct}, nil
		}
		ctx, cancel := context.WithTimeout(context.Background(), coverFetchTimeout)
		defer cancel()
		data, ct, err := fetchRemoteCover(ctx, u)
		if err != nil {
			return nil, err
		}
		c.put(key, data, ct)
		return &coverCacheEntry{data: data, contentType: ct}, nil
	})
	if err != nil {
		return nil, "", err
	}
	ent := v.(*coverCacheEntry)
	return ent.data, ent.contentType, nil
}

// warm queues a background fetch so the cover is hot by the time the client
// asks for it. Fresh URLs are no-ops; when the queue is full the warm is
// dropped and the on-demand path picks the cover up instead.
func (c *coverCacheStore) warm(rawURL string) {
	u, err := allowedRemoteCoverURL(rawURL)
	if err != nil {
		return
	}
	key := u.String()
	if _, _, ok := c.get(key); ok {
		return
	}
	c.warmOnce.Do(c.startWarmWorkers)
	select {
	case c.warmQueue <- key:
	default:
	}
}

func (c *coverCacheStore) startWarmWorkers() {
	for range coverWarmConcurrency {
		go func() {
			for key := range c.warmQueue {
				u, err := url.Parse(key)
				if err != nil {
					continue
				}
				if _, _, err := c.fetchCached(u); err != nil {
					slog.Default().Debug("cover warm fetch failed", "host", u.Hostname(), "err", err)
				}
			}
		}()
	}
}
