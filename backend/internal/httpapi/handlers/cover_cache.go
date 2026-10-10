package handlers

import (
	"container/list"
	"context"
	"log/slog"
	"net/url"
	"sync"
	"time"

	"golang.org/x/sync/semaphore"
	"golang.org/x/sync/singleflight"

	"github.com/githubesson/lumen/internal/safego"
)

// Remote covers (TIDAL CDN artwork) are proxied through the backend so the
// browser receives them same-origin: the CDN sends no CORS headers, which
// taints any canvas a client draws the cover on and breaks ambient-accent
// pixel reads. Proxying every request would re-fetch from TIDAL each time,
// so a small in-RAM LRU keeps recently served covers hot.
const (
	coverCacheMaxEntries = 150
	// coverCacheMaxBytes bounds the RAM the cache pins. Entries run from a
	// few KB (row thumbnails) to a few hundred KB (1280px art), so a full
	// cache of real covers stays well under it; without it, 150 entries at
	// the entry cap could pin 600 MB.
	coverCacheMaxBytes = 64 << 20
	coverCacheTTL      = 5 * time.Minute
	// A 640x640 JPEG runs ~100 KB; anything above this cap is an outlier not
	// worth pinning in RAM. Oversized covers are still proxied, just not cached.
	coverCacheMaxEntryBytes = 4 << 20
	coverWarmConcurrency    = 4
	// coverFetchConcurrency bounds upstream fetches in flight, warms and
	// on-demand serves together. Each buffers up to maxRemoteCoverBytes, and
	// a signed-in client can name any path on the CDN host, every distinct
	// one a cache miss. A fetch takes a fraction of a second, so this many
	// still fill a cold page of covers quickly.
	coverFetchConcurrency = 8
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
	bytes   int        // cached image bytes, bounded by coverCacheMaxBytes

	// fetches coalesces concurrent upstream requests for the same URL — an
	// on-demand serve landing while a warm is in flight joins that flight
	// instead of fetching again.
	fetches    singleflight.Group
	fetchSlots *semaphore.Weighted
	warmOnce   sync.Once
	warmQueue  chan string
}

var coverCache = newCoverCacheStore()

func newCoverCacheStore() *coverCacheStore {
	return &coverCacheStore{
		entries:    make(map[string]*list.Element),
		order:      list.New(),
		fetchSlots: semaphore.NewWeighted(coverFetchConcurrency),
		warmQueue:  make(chan string, coverWarmQueueDepth),
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
		c.removeLocked(el)
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
		c.bytes += len(data) - len(el.Value.(*coverCacheEntry).data)
		el.Value = ent
		c.order.MoveToFront(el)
	} else {
		c.entries[url] = c.order.PushFront(ent)
		c.bytes += len(data)
	}
	// The newest entry is never evicted: it is at most
	// coverCacheMaxEntryBytes, well under coverCacheMaxBytes.
	for c.order.Len() > coverCacheMaxEntries || c.bytes > coverCacheMaxBytes {
		c.removeLocked(c.order.Back())
	}
}

func (c *coverCacheStore) removeLocked(el *list.Element) {
	ent := c.order.Remove(el).(*coverCacheEntry)
	delete(c.entries, ent.url)
	c.bytes -= len(ent.data)
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
		// Do re-raises a panic in every caller sharing the flight, and some
		// run inside other singleflight builds or background workers.
		return safego.Call("remote cover fetch", func() (any, error) {
			// Re-check under the flight: a just-completed flight may have
			// populated the cache between our miss and Do() running.
			if data, ct, ok := c.get(key); ok {
				return &coverCacheEntry{data: data, contentType: ct}, nil
			}
			ctx, cancel := context.WithTimeout(context.Background(), coverFetchTimeout)
			defer cancel()
			// Waiting for a slot counts against the fetch timeout.
			if err := c.fetchSlots.Acquire(ctx, 1); err != nil {
				return nil, err
			}
			defer c.fetchSlots.Release(1)
			data, ct, err := fetchRemoteCover(ctx, u)
			if err != nil {
				return nil, err
			}
			c.put(key, data, ct)
			return &coverCacheEntry{data: data, contentType: ct}, nil
		})
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
			// Outside chi's Recoverer. Guard per key so one bad cover cannot
			// kill the worker (let alone the process) and stall the queue.
			for key := range c.warmQueue {
				safego.Run("cover warm worker", func() {
					u, err := url.Parse(key)
					if err != nil {
						return
					}
					if _, _, err := c.fetchCached(u); err != nil {
						slog.Default().Debug("cover warm fetch failed", "host", u.Hostname(), "err", err)
					}
				})
			}
		}()
	}
}
