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
// If adminPassword is empty, a random password is generated and written
// (mode 0600) to the first of passwordFiles that can be created, rather than
// to the logs: logs are routinely readable by more people and systems
// (docker logs, log shippers) than the admin, and whoever reads the password
// first owns the instance. The user is flagged MustResetPassword=true either
// way.
func SeedAdmin(ctx context.Context, logger *slog.Logger, store *users.Store, adminUsername, adminPassword string, passwordFiles []string) error {
	n, err := store.Count(ctx)
	if err != nil {
		return err
	}
	if n > 0 {
		return nil
	}
	generated := false
	passwordFile := ""
	if adminPassword == "" {
		buf := make([]byte, 18)
		if _, err := rand.Read(buf); err != nil {
			return err
		}
		adminPassword = base64.RawURLEncoding.EncodeToString(buf)
		generated = true
		// Write before creating the user so a failure leaves nothing seeded
		// with a password nobody can read.
		var errs []error
		for _, candidate := range passwordFiles {
			err := writePasswordFile(candidate, adminUsername, adminPassword)
			if err == nil {
				passwordFile = candidate
				break
			}
			errs = append(errs, fmt.Errorf("%s: %w", candidate, err))
		}
		if passwordFile == "" {
			if len(errs) == 0 {
				errs = append(errs, errors.New("no password file path configured"))
			}
			return fmt.Errorf("seed admin: write generated password (set ADMIN_PASSWORD or ADMIN_PASSWORD_FILE): %w", errors.Join(errs...))
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

// writePasswordFile creates path exclusively. A file already there is
// removed first only if it is a regular file: the default location sits in
// the music directory, which host users may be able to write, and following a
// planted symlink would overwrite whatever it points at with the credential.
func writePasswordFile(path, username, password string) error {
	if path == "" {
		return errors.New("empty path")
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return err
	}
	if info, err := os.Lstat(path); err == nil {
		if !info.Mode().IsRegular() {
			return errors.New("existing path is not a regular file")
		}
		if err := os.Remove(path); err != nil {
			return err
		}
	} else if !errors.Is(err, os.ErrNotExist) {
		return err
	}
	// O_EXCL also fails on a symlink created between the Remove and here.
	f, err := os.OpenFile(path, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o600)
	if err != nil {
		return err
	}
	if _, err := fmt.Fprintf(f, "username: %s\npassword: %s\n", username, password); err != nil {
		f.Close()
		return err
	}
	return f.Close()
}
