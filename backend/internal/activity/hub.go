package activity

import (
	"sync"

	"github.com/google/uuid"
)

// Hub fans playback-state changes out to the currently connected clients for
// a user. The payload remains in PostgreSQL; subscribers receive a coalesced
// signal and load the latest snapshot themselves. That keeps reconnects and
// slow clients from building an unbounded event backlog.
type Hub struct {
	mu          sync.Mutex
	nextID      uint64
	subscribers map[uuid.UUID]map[uint64]chan struct{}
}

func NewHub() *Hub {
	return &Hub{subscribers: make(map[uuid.UUID]map[uint64]chan struct{})}
}

// Subscribe registers a user-scoped change signal. The returned cancel
// function is idempotent and must be called when the connection closes.
func (h *Hub) Subscribe(userID uuid.UUID) (<-chan struct{}, func()) {
	h.mu.Lock()
	h.nextID++
	id := h.nextID
	ch := make(chan struct{}, 1)
	if h.subscribers[userID] == nil {
		h.subscribers[userID] = make(map[uint64]chan struct{})
	}
	h.subscribers[userID][id] = ch
	h.mu.Unlock()

	var once sync.Once
	return ch, func() {
		once.Do(func() {
			h.mu.Lock()
			defer h.mu.Unlock()
			delete(h.subscribers[userID], id)
			if len(h.subscribers[userID]) == 0 {
				delete(h.subscribers, userID)
			}
		})
	}
}

// Notify wakes every connection for userID. Signals are deliberately
// coalesced: each subscriber only needs to fetch the newest durable state.
func (h *Hub) Notify(userID uuid.UUID) {
	h.mu.Lock()
	defer h.mu.Unlock()
	for _, ch := range h.subscribers[userID] {
		select {
		case ch <- struct{}{}:
		default:
		}
	}
}
