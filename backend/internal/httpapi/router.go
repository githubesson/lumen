package httpapi

import (
	"context"
	"net/http"
	"os"
	"time"

	"github.com/go-chi/chi/v5"
	chimw "github.com/go-chi/chi/v5/middleware"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/githubesson/lumen/internal/activity"
	"github.com/githubesson/lumen/internal/apitracker"
	"github.com/githubesson/lumen/internal/artistgrid"
	"github.com/githubesson/lumen/internal/auth"
	"github.com/githubesson/lumen/internal/filen"
	"github.com/githubesson/lumen/internal/httpapi/handlers"
	appmw "github.com/githubesson/lumen/internal/httpapi/middleware"
	"github.com/githubesson/lumen/internal/ingest"
	"github.com/githubesson/lumen/internal/invites"
	"github.com/githubesson/lumen/internal/lastfm"
	"github.com/githubesson/lumen/internal/library"
	"github.com/githubesson/lumen/internal/musicroots"
	"github.com/githubesson/lumen/internal/playlists"
	"github.com/githubesson/lumen/internal/preview"
	"github.com/githubesson/lumen/internal/storage"
	"github.com/githubesson/lumen/internal/tidal"
	"github.com/githubesson/lumen/internal/users"
)

type Deps struct {
	DB             *pgxpool.Pool
	Users          *users.Store
	Invites        *invites.Store
	Sessions       *auth.SessionStore
	Ingest         *ingest.Service
	Library        *library.Store
	Playlists      *playlists.Store
	Activity       *activity.Store
	TIDAL          *tidal.Client
	LastFM         *lastfm.Service
	Storage        storage.Storage
	MusicRoots     *musicroots.Store
	APITracker     *apitracker.Store
	APITrackerScan *apitracker.Scanner
	ArtistGrid     *artistgrid.Store
	ArtistGridScan *artistgrid.Scanner
	Filen          *filen.Store
	FilenScan      *filen.Scanner
	Preview        *preview.Builder
	MusicRoot      string
	Background     context.Context // application lifecycle for request-detached jobs
	StartJob       func(func())    // registers a request-detached job for graceful shutdown
	RefreshScan    func()          // invoked after the root set changes (e.g. watcher reload)
	CoverSignKey   []byte          // HMAC secret for public signed cover URLs (Discord RPC) + share/preview URLs
	TrustedProxies []string        // CIDR or IP literals; only these peers may set X-Forwarded-For
	PublicHosts    []string        // optional allowlist of hostnames permitted in generated absolute URLs
}

func NewRouter(d Deps) http.Handler {
	handlers.SetAllowedPublicHosts(d.PublicHosts)
	r := chi.NewRouter()
	// Use our own RealIP instead of chimw.RealIP: we only honor proxy headers
	// from peers in TrustedProxies, and strip them otherwise. Without this an
	// attacker can spoof X-Forwarded-For to bypass per-IP rate limits and
	// poison the audit IP recorded in sessions.
	r.Use(appmw.RealIP(appmw.ParseTrustedProxies(d.TrustedProxies)))
	r.Use(chimw.RequestID)
	r.Use(chimw.Recoverer)
	r.Use(appmw.Authenticate(d.Sessions))

	authH := &handlers.Auth{
		DB:       d.DB,
		Users:    d.Users,
		Sessions: d.Sessions,
		Invites:  d.Invites,
	}
	invH := &handlers.Invites{Store: d.Invites}
	libH := &handlers.Library{
		Ingest:     d.Ingest,
		Library:    d.Library,
		Background: d.Background,
		StartJob:   d.StartJob,
	}
	plH := &handlers.Playlists{Store: d.Playlists, Users: d.Users, Library: d.Library, TIDAL: d.TIDAL}
	activityH := &handlers.Activity{
		Store:      d.Activity,
		Hub:        activity.NewHub(),
		Sessions:   d.Sessions,
		Background: d.Background,
	}
	searchH := &handlers.Search{Library: d.Library, TIDAL: d.TIDAL}
	tidalH := &handlers.TIDAL{TIDAL: d.TIDAL}
	adminUsersH := &handlers.AdminUsers{DB: d.DB, Users: d.Users, Playlists: d.Playlists}
	adminRootsH := &handlers.AdminRoots{
		Store:       d.MusicRoots,
		Library:     d.Library,
		Ingest:      d.Ingest,
		PrimaryRoot: d.MusicRoot,
		Refresh:     d.RefreshScan,
	}
	adminAPITrackerH := &handlers.AdminAPITracker{
		Store:       d.APITracker,
		MusicRoots:  d.MusicRoots,
		Scanner:     d.APITrackerScan,
		PrimaryRoot: d.MusicRoot,
		Background:  d.Background,
	}
	adminArtistGridH := &handlers.AdminArtistGrid{
		Store:       d.ArtistGrid,
		MusicRoots:  d.MusicRoots,
		Scanner:     d.ArtistGridScan,
		PrimaryRoot: d.MusicRoot,
		Background:  d.Background,
	}
	adminFilenH := &handlers.AdminFilen{
		Store:       d.Filen,
		MusicRoots:  d.MusicRoots,
		Scanner:     d.FilenScan,
		PrimaryRoot: d.MusicRoot,
		Background:  d.Background,
	}
	adminTIDALH := &handlers.AdminTIDAL{TIDAL: d.TIDAL}
	lastFMH := &handlers.LastFM{Service: d.LastFM}
	tracksH := &handlers.Tracks{
		Library:      d.Library,
		Storage:      d.Storage,
		Ingest:       d.Ingest,
		TIDAL:        d.TIDAL,
		CoverSignKey: d.CoverSignKey,
		LastFM:       d.LastFM,
		Background:   d.Background,
		StartJob:     d.StartJob,
	}
	browseH := &handlers.Browse{Library: d.Library}
	statsH := &handlers.Stats{Library: d.Library, Playlists: d.Playlists, Storage: d.Storage}
	shareH := &handlers.Share{
		Library:      d.Library,
		Storage:      d.Storage,
		Ingest:       d.Ingest,
		Preview:      d.Preview,
		TIDAL:        d.TIDAL,
		ShareSignKey: d.CoverSignKey,
		StartJob:     d.StartJob,
	}

	lyricsH := &handlers.Lyrics{
		BaseURL:        os.Getenv("LRCLIB_BASE"),
		GeniusBaseURL:  os.Getenv("GENIUS_BASE"),
		GeniusProxyURL: os.Getenv("GENIUS_PROXY_URL"),
	}

	// Public share landing page — what Discord / chat apps scrape to build
	// a link preview card. Sits outside /api so the URL that users actually
	// copy into chat looks clean (/share/track/{id}?t=…&sig=…).
	r.With(appmw.Timeout(ordinaryRequestTimeout), appmw.RateLimitByIP(120, time.Minute)).
		Get("/share/track/{id}", shareH.Page)
	r.With(appmw.Timeout(ordinaryRequestTimeout), appmw.RateLimitByIP(120, time.Minute)).
		Get("/embed/track/{id}", shareH.Embed)

	r.Route("/api", func(r chi.Router) {
		ordinary := r.With(appmw.Timeout(ordinaryRequestTimeout))
		ordinary.Get("/health", func(w http.ResponseWriter, req *http.Request) {
			w.WriteHeader(http.StatusOK)
			_, _ = w.Write([]byte(`{"ok":true}`))
		})

		// Public
		ordinary.With(appmw.RateLimitByIP(10, time.Minute)).Post("/auth/login", authH.Login)
		ordinary.With(appmw.RateLimitByIP(5, 10*time.Minute)).Post("/auth/register", authH.Register)
		ordinary.With(appmw.RateLimitByIP(30, time.Minute)).Get("/auth/invite", authH.CheckInvite)
		// Signed, cookie-less cover URLs so Discord's media proxy can fetch
		// album artwork. The HMAC signature + expiry *is* the auth. Timed and
		// rate-limited like every sibling: a replayed signature is valid for
		// ~2h, and albums whose art is a remote URL tie up a goroutine on an
		// outbound fetch for the duration.
		ordinary.With(appmw.RateLimitByIP(120, time.Minute)).
			Get("/public/covers/album/{id}", tracksH.PublicAlbumCover)
		// Signed public preview MP4 — the og:video referenced by share pages.
		// Rate-limited because first-fetch invokes ffmpeg.
		r.With(appmw.RateLimitByIP(60, time.Minute)).
			Get("/public/previews/{id}", shareH.PublicPreview)
		// Stable share-signed video URL used in scraper metadata.
		r.With(appmw.RateLimitByIP(120, time.Minute)).
			Get("/public/preview-videos/{id}", shareH.PublicPreviewVideo)
		r.With(appmw.RateLimitByIP(120, time.Minute)).
			Head("/public/preview-videos/{id}", shareH.PublicPreviewVideo)
		// Signed public 9:16 Story MP4. Also lazy-built by ffmpeg.
		r.With(appmw.RateLimitByIP(60, time.Minute)).
			Get("/public/stories/{id}", shareH.PublicStory)
		r.With(appmw.RateLimitByIP(60, time.Minute)).
			Get("/public/story-backgrounds/{id}", shareH.PublicStoryBackground)
		// Signed public share metadata for the browser-facing React preview.
		ordinary.With(appmw.RateLimitByIP(120, time.Minute)).
			Get("/public/share/track/{id}", shareH.PublicInfo)

		// Authenticated
		r.Group(func(r chi.Router) {
			r.Use(appmw.RequireUser)
			ordinary := r.With(appmw.Timeout(ordinaryRequestTimeout))
			ordinary.Get("/auth/me", authH.Me)
			ordinary.Post("/auth/logout", authH.Logout)
			ordinary.Get("/integrations/lastfm", lastFMH.Status)
			ordinary.Post("/integrations/lastfm/connect", lastFMH.Connect)
			ordinary.Post("/integrations/lastfm/complete", lastFMH.Complete)
			ordinary.Delete("/integrations/lastfm", lastFMH.Disconnect)
			ordinary.With(appmw.RateLimitByIP(5, 10*time.Minute)).Post("/auth/reset-password", authH.ResetPassword)

			ordinary.Put("/activity", activityH.Upsert)
			ordinary.Get("/activity/current", activityH.Current)
			ordinary.Delete("/activity/{device_id}", activityH.Delete)
			// Long-lived connection: deliberately bypass the ordinary request
			// timeout. Authentication still runs before the WebSocket upgrade.
			r.Get("/activity/ws", activityH.Socket)

			ordinary.Get("/tracks", tracksH.List)
			ordinary.Get("/search", searchH.Search)
			ordinary.With(appmw.RateLimitByIP(60, time.Minute)).Get("/lyrics", lyricsH.Handle)
			ordinary.Get("/tidal/albums/{id}", tidalH.Album)
			ordinary.Get("/tracks/{id}", tracksH.Get)
			ordinary.Delete("/tracks/{id}", tracksH.Delete)
			r.Get("/tracks/{id}/stream", tracksH.Stream)
			r.Get("/tracks/{id}/hls", tracksH.TIDALHLS)
			r.Get("/tracks/{id}/cover", tracksH.TrackCover)
			ordinary.Post("/tracks/{id}/play", tracksH.RecordPlay)
			ordinary.Post("/tracks/{id}/scrobble", tracksH.Scrobble)
			ordinary.Post("/tracks/{id}/now-playing", tracksH.NowPlaying)
			ordinary.Post("/tracks/{id}/favorite", tracksH.Favorite)
			ordinary.Delete("/tracks/{id}/favorite", tracksH.Unfavorite)
			ordinary.Post("/tracks/{id}/share", shareH.Create)
			r.With(appmw.Timeout(previewRequestTimeout)).
				Post("/tracks/{id}/story-background", shareH.CustomStoryBackground)
			ordinary.Get("/favorites", tracksH.ListFavorites)
			ordinary.Get("/recent", tracksH.ListRecent)

			ordinary.Get("/stats/replay", statsH.Replay)
			ordinary.Post("/stats/replay/playlist", statsH.GeneratePlaylist)
			// Renders a PNG per request (decode + blur + text); modest limit
			// keeps a misbehaving client from pinning a CPU core.
			r.With(appmw.Timeout(imageRequestTimeout), appmw.RateLimitByIP(30, time.Minute)).
				Get("/stats/replay/image", statsH.ReplayImage)

			ordinary.Get("/albums", browseH.ListAlbums)
			ordinary.Get("/albums/{id}", browseH.GetAlbum)
			ordinary.Get("/albums/{id}/tracks", browseH.ListAlbumTracks)
			r.Get("/albums/{id}/cover", tracksH.AlbumCover)
			r.Get("/covers/remote", tracksH.RemoteCoverProxy)
			ordinary.Get("/covers/sign", tracksH.SignCover)
			ordinary.Get("/artists", browseH.ListArtists)
			ordinary.Get("/artists/{id}", browseH.GetArtist)
			ordinary.Get("/artists/{id}/tracks", browseH.ListArtistTracks)

			r.With(appmw.Timeout(uploadRequestTimeout)).Post("/library/upload", libH.Upload)

			ordinary.Get("/playlists", plH.List)
			ordinary.Post("/playlists", plH.Create)
			ordinary.Get("/playlists/invites", plH.PendingInvites)
			ordinary.Post("/playlists/invites/{id}/accept", plH.AcceptInvite)
			ordinary.Post("/playlists/invites/{id}/decline", plH.DeclineInvite)
			ordinary.Get("/playlists/{id}", plH.Get)
			ordinary.Patch("/playlists/{id}", plH.Update)
			ordinary.Delete("/playlists/{id}", plH.Delete)
			ordinary.Get("/playlists/{id}/tracks", plH.ListTracks)
			ordinary.Post("/playlists/{id}/tracks", plH.AddTracks)
			ordinary.Delete("/playlists/{id}/tracks/{pos}", plH.RemoveTrack)
			ordinary.Put("/playlists/{id}/order", plH.Reorder)
			ordinary.Get("/playlists/{id}/collaborators", plH.ListCollaborators)
			ordinary.Post("/playlists/{id}/collaborators", plH.InviteCollaborator)
			ordinary.Patch("/playlists/{id}/collaborators/{user_id}", plH.SetCollaboratorRole)
			ordinary.Delete("/playlists/{id}/collaborators/{user_id}", plH.RemoveCollaborator)
		})

		// Admin
		r.Group(func(r chi.Router) {
			r.Use(appmw.RequireUser, appmw.RequireAdmin)
			ordinary := r.With(appmw.Timeout(ordinaryRequestTimeout))
			ordinary.Post("/admin/invites", invH.Create)
			ordinary.Get("/admin/invites", invH.List)
			ordinary.Delete("/admin/invites/{id}", invH.Revoke)

			ordinary.Post("/admin/library/rescan", libH.Rescan)
			ordinary.Get("/admin/library/rescan", libH.RescanStatus)
			ordinary.Get("/admin/library/errors", libH.Errors)

			ordinary.Patch("/tracks/{id}", tracksH.Patch)
			ordinary.Delete("/admin/tracks/{id}", tracksH.AdminDelete)
			ordinary.Patch("/albums/{id}", browseH.PatchAlbum)
			r.With(appmw.Timeout(imageRequestTimeout)).Put("/albums/{id}/cover", tracksH.PutAlbumCover)
			ordinary.Delete("/albums/{id}/cover", tracksH.DeleteAlbumCover)

			ordinary.Get("/admin/library/roots", adminRootsH.List)
			ordinary.Post("/admin/library/roots", adminRootsH.Add)
			ordinary.Patch("/admin/library/roots/{id}", adminRootsH.Patch)
			ordinary.Delete("/admin/library/roots/{id}", adminRootsH.Delete)
			ordinary.Get("/admin/library/api-trackers/pins", adminAPITrackerH.List)
			ordinary.Post("/admin/library/api-trackers/pins", adminAPITrackerH.Add)
			ordinary.Patch("/admin/library/api-trackers/pins/{id}", adminAPITrackerH.Patch)
			ordinary.Delete("/admin/library/api-trackers/pins/{id}", adminAPITrackerH.Delete)
			ordinary.Post("/admin/library/api-trackers/pins/{id}/scan", adminAPITrackerH.Scan)
			ordinary.Get("/admin/library/api-trackers/pins/{id}/downloads", adminAPITrackerH.Downloads)
			ordinary.Get("/admin/library/artistgrid/pins", adminArtistGridH.List)
			ordinary.Post("/admin/library/artistgrid/pins", adminArtistGridH.Add)
			ordinary.Patch("/admin/library/artistgrid/pins/{id}", adminArtistGridH.Patch)
			ordinary.Delete("/admin/library/artistgrid/pins/{id}", adminArtistGridH.Delete)
			ordinary.Post("/admin/library/artistgrid/pins/{id}/scan", adminArtistGridH.Scan)
			ordinary.Get("/admin/library/artistgrid/pins/{id}/downloads", adminArtistGridH.Downloads)
			ordinary.Get("/admin/library/filen/pins", adminFilenH.List)
			ordinary.Post("/admin/library/filen/pins", adminFilenH.Add)
			ordinary.Patch("/admin/library/filen/pins/{id}", adminFilenH.Patch)
			ordinary.Delete("/admin/library/filen/pins/{id}", adminFilenH.Delete)
			ordinary.Post("/admin/library/filen/pins/{id}/scan", adminFilenH.Scan)
			ordinary.Get("/admin/library/filen/pins/{id}/downloads", adminFilenH.Downloads)

			ordinary.Get("/admin/tidal/status", adminTIDALH.Status)
			ordinary.Post("/admin/tidal/auth", adminTIDALH.StartAuth)
			ordinary.Get("/admin/tidal/auth/{flowID}", adminTIDALH.PollAuth)
			ordinary.Delete("/admin/tidal/accounts/{accountID}", adminTIDALH.RemoveAccount)

			ordinary.Get("/admin/users", adminUsersH.List)
			ordinary.Get("/admin/users/{id}/departure-preview", adminUsersH.DeparturePreview)
			ordinary.Delete("/admin/users/{id}", adminUsersH.Delete)
			ordinary.Post("/admin/users/{id}/disable", adminUsersH.Disable)
			ordinary.Post("/admin/users/{id}/enable", adminUsersH.Enable)
		})
	})

	return r
}

const (
	ordinaryRequestTimeout = 30 * time.Second
	imageRequestTimeout    = 2 * time.Minute
	previewRequestTimeout  = 5 * time.Minute
	uploadRequestTimeout   = 15 * time.Minute
)
