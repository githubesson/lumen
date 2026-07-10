package activity

import (
	"testing"

	"github.com/google/uuid"
)

func TestHubScopesAndCoalescesNotifications(t *testing.T) {
	t.Parallel()

	hub := NewHub()
	userA := uuid.New()
	userB := uuid.New()
	a1, cancelA1 := hub.Subscribe(userA)
	defer cancelA1()
	a2, cancelA2 := hub.Subscribe(userA)
	defer cancelA2()
	b, cancelB := hub.Subscribe(userB)
	defer cancelB()

	hub.Notify(userA)
	hub.Notify(userA)

	assertSignaled(t, a1)
	assertSignaled(t, a2)
	assertNotSignaled(t, b)
	assertNotSignaled(t, a1)
}

func TestHubCancelIsIdempotent(t *testing.T) {
	t.Parallel()

	hub := NewHub()
	userID := uuid.New()
	ch, cancel := hub.Subscribe(userID)
	cancel()
	cancel()
	hub.Notify(userID)
	assertNotSignaled(t, ch)
}

func assertSignaled(t *testing.T, ch <-chan struct{}) {
	t.Helper()
	select {
	case <-ch:
	default:
		t.Fatal("expected notification")
	}
}

func assertNotSignaled(t *testing.T, ch <-chan struct{}) {
	t.Helper()
	select {
	case <-ch:
		t.Fatal("unexpected notification")
	default:
	}
}
