package auth

import (
	"context"
	"crypto/rand"
	"encoding/base64"
	"errors"
	"fmt"
	"log/slog"
	"os"
	"path/filepath"

	"github.com/githubesson/lumen/internal/models"
	"github.com/githubesson/lumen/internal/users"
)

// SeedAdmin creates the initial admin user on first run if no users exist.
// If adminPassword is empty, a random password is generated and written to
// passwordFile (mode 0600) rather than the logs: logs are routinely readable
// by more people and systems (docker logs, log shippers) than the admin, and
// whoever reads the password first owns the instance. The user is flagged
// MustResetPassword=true either way.
func SeedAdmin(ctx context.Context, logger *slog.Logger, store *users.Store, adminUsername, adminPassword, passwordFile string) error {
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
		// Write before creating the user so a failure leaves nothing seeded
		// with a password nobody can read.
		if err := writePasswordFile(passwordFile, adminUsername, adminPassword); err != nil {
			return fmt.Errorf("seed admin: write generated password (set ADMIN_PASSWORD instead): %w", err)
		}
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
		logger.Warn("seeded initial admin — password written to file; delete it after first login",
			"username", u.Username, "password_file", passwordFile)
	} else {
		logger.Info("seeded initial admin from env", "username", u.Username)
	}
	return nil
}

func writePasswordFile(path, username, password string) error {
	if path == "" {
		return errors.New("no password file path configured")
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return err
	}
	f, err := os.OpenFile(path, os.O_WRONLY|os.O_CREATE|os.O_TRUNC, 0o600)
	if err != nil {
		return err
	}
	// O_CREATE's mode only applies to new files; tighten a pre-existing one.
	if err := f.Chmod(0o600); err != nil {
		f.Close()
		return err
	}
	if _, err := fmt.Fprintf(f, "username: %s\npassword: %s\n", username, password); err != nil {
		f.Close()
		return err
	}
	return f.Close()
}
