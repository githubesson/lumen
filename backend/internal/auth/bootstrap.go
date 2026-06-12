package auth

import (
	"context"
	"crypto/rand"
	"encoding/base64"
	"fmt"
	"log/slog"

	"github.com/uncut/lumen/internal/models"
	"github.com/uncut/lumen/internal/users"
)

// SeedAdmin creates the initial admin user on first run if no users exist.
// If adminPassword is empty, a random password is generated, printed to logs,
// and the user is flagged MustResetPassword=true.
func SeedAdmin(ctx context.Context, logger *slog.Logger, store *users.Store, adminUsername, adminPassword string) error {
	n, err := store.Count(ctx)
	if err != nil {
		return err
	}
	if n > 0 {
		return nil
	}
	generated := false
	if adminPassword == "" {
		buf := make([]byte, 18)
		if _, err := rand.Read(buf); err != nil {
			return err
		}
		adminPassword = base64.RawURLEncoding.EncodeToString(buf)
		generated = true
	}
	hash, err := HashPassword(adminPassword)
	if err != nil {
		return err
	}
	u, err := store.Create(ctx, users.CreateParams{
		Username:          adminUsername,
		PasswordHash:      hash,
		Role:              models.RoleAdmin,
		MustResetPassword: true,
	})
	if err != nil {
		return fmt.Errorf("seed admin: %w", err)
	}
	if generated {
		logger.Warn("seeded initial admin — RESET PASSWORD ON FIRST LOGIN",
			"username", u.Username, "generated_password", adminPassword)
	} else {
		logger.Info("seeded initial admin from env", "username", u.Username)
	}
	return nil
}
