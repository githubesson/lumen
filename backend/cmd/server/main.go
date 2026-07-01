package main

import (
	"context"
	"errors"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/githubesson/lumen/internal/activity"
	"github.com/githubesson/lumen/internal/apitracker"
	"github.com/githubesson/lumen/internal/artistgrid"
	"github.com/githubesson/lumen/internal/auth"
	"github.com/githubesson/lumen/internal/config"
	"github.com/githubesson/lumen/internal/db"
	"github.com/githubesson/lumen/internal/filen"
	"github.com/githubesson/lumen/internal/httpapi"
	"github.com/githubesson/lumen/internal/ingest"
	"github.com/githubesson/lumen/internal/invites"
	"github.com/githubesson/lumen/internal/library"
	"github.com/githubesson/lumen/internal/musicroots"
	"github.com/githubesson/lumen/internal/playlists"
	"github.com/githubesson/lumen/internal/preview"
	"github.com/githubesson/lumen/internal/storage"
	"github.com/githubesson/lumen/internal/tidal"
	"github.com/githubesson/lumen/internal/users"
)

func main() {
	logger := slog.New(slog.NewJSONHandler(os.Stdout, &slog.HandlerOptions{Level: slog.LevelInfo}))
	slog.SetDefault(logger)

	cfg, err := config.FromEnv()
	if err != nil {
		logger.Error("config load failed", "err", err)
		os.Exit(1)
	}

	if err := db.Migrate(cfg.DatabaseURL); err != nil {
		logger.Error("migrations failed", "err", err)
		os.Exit(1)
	}

	ctx, cancel := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer cancel()

	pool, err := db.Open(ctx, cfg.DatabaseURL)
	if err != nil {
		logger.Error("db open failed", "err", err)
		os.Exit(1)
	}
	defer pool.Close()

	usersStore := users.NewStore(pool)
	invitesStore := invites.NewStore(pool)
	libraryStore := library.NewStore(pool)
	playlistsStore := playlists.NewStore(pool)
	activityStore := activity.NewStore(pool)
	musicRootsStore := musicroots.NewStore(pool)
	apiTrackerStore := apitracker.NewStore(pool)
	artistGridStore := artistgrid.NewStore(pool)
	filenStore := filen.NewStore(pool)
	tidalClient := tidal.NewClient(tidal.Config{
		CountryCode: cfg.TIDALCountryCode,
		Quality:     cfg.TIDALQuality,
		HifiAPIURL:  cfg.TIDALHifiAPIURL,
	})
	sessions := auth.NewSessionStore(pool, cfg.CookieName, cfg.CookieSecure, cfg.SessionTTL)

	if err := auth.SeedAdmin(ctx, logger, usersStore, cfg.AdminUsername, cfg.AdminPassword); err != nil {
		logger.Error("admin seed failed", "err", err)
		os.Exit(1)
	}

	store := storage.NewLocal(cfg.MusicPath)
	ingestSvc := &ingest.Service{
		DB:        pool,
		Library:   libraryStore,
		Storage:   store,
		MusicRoot: cfg.MusicPath,
		Roots: func(ctx context.Context) []string {
			roots := []string{cfg.MusicPath}
			extra, err := musicRootsStore.EnabledPaths(ctx)
			if err != nil {
				if !errors.Is(err, context.Canceled) && !errors.Is(err, context.DeadlineExceeded) {
					logger.Warn("music roots fetch failed", "err", err)
				}
				return roots
			}
			return append(roots, extra...)
		},
		Logger: logger,
	}

	var watcher *ingest.Watcher
	if _, err := os.Stat(cfg.MusicPath); err == nil {
		watcher = ingest.NewWatcher(ingestSvc)
		go func() {
			if err := watcher.Run(ctx); err != nil {
				logger.Warn("watcher stopped", "err", err)
			}
		}()
	} else {
		logger.Warn("music path not found; watcher disabled", "path", cfg.MusicPath)
	}

	refresh := func() {
		if watcher != nil {
			watcher.Refresh(ctx)
		}
	}

	if cfg.CoverSignKeyEphemeral {
		logger.Warn("COVER_SIGN_KEY not set; using an ephemeral key — signed cover URLs will rotate on each restart")
	}

	previewBuilder := &preview.Builder{CacheDir: cfg.PreviewCacheDir}
	apiTrackerScanner := &apitracker.Scanner{
		Store: apiTrackerStore,
		// Blank API_TRACKER_BASE_URL falls back to apitracker.DefaultBaseURL.
		Client:       apitracker.NewClient(cfg.APITrackerBaseURL),
		Ingest:       ingestSvc,
		Library:      libraryStore,
		Logger:       logger,
		PollInterval: cfg.APITrackerScanPollInterval,
		FileTimeout:  cfg.APITrackerFileTimeout,
	}
	go apiTrackerScanner.Run(ctx)
	artistGridScanner := &artistgrid.Scanner{
		Store:        artistGridStore,
		Client:       artistgrid.NewClient(),
		Ingest:       ingestSvc,
		Library:      libraryStore,
		Logger:       logger,
		PollInterval: cfg.ArtistGridScanPollInterval,
		FileTimeout:  cfg.ArtistGridFileTimeout,
	}
	go artistGridScanner.Run(ctx)
	filenScanner := &filen.Scanner{
		Store:        filenStore,
		Ingest:       ingestSvc,
		Library:      libraryStore,
		Logger:       logger,
		PollInterval: cfg.FilenScanPollInterval,
		FileTimeout:  cfg.FilenFileTimeout,
		NodePath:     cfg.FilenDownloaderNode,
		ScriptPath:   cfg.FilenDownloaderScript,
	}
	go filenScanner.Run(ctx)

	handler := httpapi.NewRouter(httpapi.Deps{
		DB:             pool,
		Users:          usersStore,
		Invites:        invitesStore,
		Sessions:       sessions,
		Ingest:         ingestSvc,
		Library:        libraryStore,
		Playlists:      playlistsStore,
		Activity:       activityStore,
		TIDAL:          tidalClient,
		Storage:        store,
		MusicRoots:     musicRootsStore,
		APITracker:     apiTrackerStore,
		APITrackerScan: apiTrackerScanner,
		ArtistGrid:     artistGridStore,
		ArtistGridScan: artistGridScanner,
		Filen:          filenStore,
		FilenScan:      filenScanner,
		Preview:        previewBuilder,
		MusicRoot:      cfg.MusicPath,
		RefreshScan:    refresh,
		CoverSignKey:   cfg.CoverSignKey,
		TrustedProxies: cfg.TrustedProxies,
	})

	srv := &http.Server{
		Addr:              cfg.HTTPAddr,
		Handler:           handler,
		ReadHeaderTimeout: 10 * time.Second,
	}

	go func() {
		logger.Info("http listening", "addr", cfg.HTTPAddr)
		if err := srv.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			logger.Error("http server error", "err", err)
			cancel()
		}
	}()

	<-ctx.Done()
	logger.Info("shutting down")
	shutCtx, shutCancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer shutCancel()
	_ = srv.Shutdown(shutCtx)
}
