package models

import (
	"time"

	"github.com/google/uuid"
)

type Role string

const (
	RoleUser  Role = "user"
	RoleAdmin Role = "admin"
)

type User struct {
	ID                uuid.UUID
	Username          string
	PasswordHash      string
	Role              Role
	Disabled          bool
	MustResetPassword bool
	InviteID          *uuid.UUID
	LastLoginAt       *time.Time
	CreatedAt         time.Time
	UpdatedAt         time.Time
}

type Invite struct {
	ID         uuid.UUID
	TokenHash  []byte
	CreatedBy  *uuid.UUID
	TargetRole Role
	MaxUses    int
	Uses       int
	ExpiresAt  *time.Time
	RevokedAt  *time.Time
	CreatedAt  time.Time
}

func (i *Invite) Usable(now time.Time) bool {
	if i.RevokedAt != nil {
		return false
	}
	if i.ExpiresAt != nil && !i.ExpiresAt.After(now) {
		return false
	}
	return i.Uses < i.MaxUses
}
