package handlers

import (
	"encoding/json"
	"net/http"
	"time"

	"github.com/githubesson/lumen/internal/httpapi/middleware"
	"github.com/githubesson/lumen/internal/invites"
	"github.com/githubesson/lumen/internal/models"
)

type Invites struct {
	Store *invites.Store
}

type createInviteReq struct {
	TargetRole string `json:"target_role,omitempty"`
	MaxUses    int    `json:"max_uses,omitempty"`
	ExpiresAt  string `json:"expires_at,omitempty"` // RFC3339, optional
}

type inviteResp struct {
	ID         string     `json:"id"`
	Token      string     `json:"token,omitempty"` // plaintext, only on creation
	TargetRole string     `json:"target_role"`
	MaxUses    int        `json:"max_uses"`
	Uses       int        `json:"uses"`
	ExpiresAt  *time.Time `json:"expires_at,omitempty"`
	RevokedAt  *time.Time `json:"revoked_at,omitempty"`
	CreatedAt  time.Time  `json:"created_at"`
}

func (h *Invites) Create(w http.ResponseWriter, r *http.Request) {
	actor, ok := middleware.UserFromContext(r.Context())
	if !ok {
		http.Error(w, "unauthorized", http.StatusUnauthorized)
		return
	}
	var req createInviteReq
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil && err.Error() != "EOF" {
		http.Error(w, "bad request", http.StatusBadRequest)
		return
	}
	role := models.Role(req.TargetRole)
	if role == "" {
		role = models.RoleUser
	}
	if role != models.RoleUser && role != models.RoleAdmin {
		http.Error(w, "invalid target_role", http.StatusBadRequest)
		return
	}
	maxUses := req.MaxUses
	if maxUses <= 0 {
		maxUses = 1
	}
	var expiresAt *time.Time
	if req.ExpiresAt != "" {
		t, err := time.Parse(time.RFC3339, req.ExpiresAt)
		if err != nil {
			http.Error(w, "invalid expires_at", http.StatusBadRequest)
			return
		}
		expiresAt = &t
	}

	created, err := h.Store.Create(r.Context(), invites.CreateParams{
		CreatedBy:  actor.ID,
		TargetRole: role,
		MaxUses:    maxUses,
		ExpiresAt:  expiresAt,
	})
	if err != nil {
		http.Error(w, "internal error", http.StatusInternalServerError)
		return
	}
	writeJSON(w, http.StatusCreated, inviteResp{
		ID:         created.Invite.ID.String(),
		Token:      created.Token,
		TargetRole: string(created.Invite.TargetRole),
		MaxUses:    created.Invite.MaxUses,
		Uses:       created.Invite.Uses,
		ExpiresAt:  created.Invite.ExpiresAt,
		CreatedAt:  created.Invite.CreatedAt,
	})
}

func (h *Invites) List(w http.ResponseWriter, r *http.Request) {
	rows, err := h.Store.List(r.Context())
	if err != nil {
		http.Error(w, "internal error", http.StatusInternalServerError)
		return
	}
	out := make([]inviteResp, 0, len(rows))
	for _, inv := range rows {
		out = append(out, inviteResp{
			ID:         inv.ID.String(),
			TargetRole: string(inv.TargetRole),
			MaxUses:    inv.MaxUses,
			Uses:       inv.Uses,
			ExpiresAt:  inv.ExpiresAt,
			RevokedAt:  inv.RevokedAt,
			CreatedAt:  inv.CreatedAt,
		})
	}
	writeJSON(w, http.StatusOK, out)
}

func (h *Invites) Revoke(w http.ResponseWriter, r *http.Request) {
	id, ok := pathUUID(w, r, "id")
	if !ok {
		return
	}
	if err := h.Store.Revoke(r.Context(), id); err != nil {
		http.Error(w, "internal error", http.StatusInternalServerError)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}
