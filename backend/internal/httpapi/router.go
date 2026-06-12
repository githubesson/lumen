package httpapi

import (
	"net/http"
	"time"

	"github.com/go-chi/chi/v5"
	chimw "github.com/go-chi/chi/v5/middleware"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/uncut/lumen/internal/apitracker"
	"github.com/uncut/lumen/internal/artistgrid"
	"github.com/uncut/lumen/internal/auth"
	"github.com/uncut/lumen/internal/filen"
	"github.com/uncut/lumen/internal/httpapi/handlers"
	appmw "github.com/uncut/lumen/internal/httpapi/middleware"
	"github.com/uncut/lumen/internal/ingest"
	"github.com/uncut/lumen/internal/invites"
	"github.com/uncut/lumen/internal/library"
	"github.com/uncut/lumen/internal/musicroots"
	"github.com/uncut/lumen/internal/playlists"
	"github.com/uncut/lumen/internal/preview"
	"github.com/uncut/lumen/internal/storage"
	"github.com/uncut/lumen/internal/users"
)

type Deps struct {
	DB             *pgxpool.Pool
	Users          *users.Store
	Invites        *invites.Store
	Sessions       *auth.SessionStore
	Ingest         *ingest.Service
	Library        *library.Store
	Playlists      *playlists.Store
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
	RefreshScan    func()   // invoked after the root set changes (e.g. watcher reload)
	CoverSignKey   []byte   // HMAC secret for public signed cover URLs (Discord RPC) + share/preview URLs
	TrustedProxies []string // CIDR or IP literals; only these peers may set X-Forwarded-For
}

func NewRouter(d Deps) http.Handler {
	r := chi.NewRouter()
	// Use our own RealIP instead of chimw.RealIP: we only honor proxy headers
	// from peers in TrustedProxies, and strip them otherwise. Without this an
	// attacker can spoof X-Forwarded-For to bypass per-IP rate limits and
	// poison the audit IP recorded in sessions.
	r.Use(appmw.RealIP(appmw.ParseTrustedProxies(d.TrustedProxies)))
	r.Use(chimw.RequestID)
	r.Use(chimw.Recoverer)
	r.Use(appmw.Timeout(30 * time.Second))
	r.Use(appmw.Authenticate(d.Sessions, d.Users))

	authH := &handlers.Auth{
		DB:       d.DB,
		Users:    d.Users,
		Sessions: d.Sessions,
		Invites:  d.Invites,
	}
	invH := &handlers.Invites{Store: d.Invites}
	libH := &handlers.Library{Ingest: d.Ingest, Library: d.Library}
	plH := &handlers.Playlists{Store: d.Playlists, Users: d.Users}
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
	}
	adminArtistGridH := &handlers.AdminArtistGrid{
		Store:       d.ArtistGrid,
		MusicRoots:  d.MusicRoots,
		Scanner:     d.ArtistGridScan,
		PrimaryRoot: d.MusicRoot,
	}
	adminFilenH := &handlers.AdminFilen{
		Store:       d.Filen,
		MusicRoots:  d.MusicRoots,
		Scanner:     d.FilenScan,
		PrimaryRoot: d.MusicRoot,
	}
	tracksH := &handlers.Tracks{
		Library:      d.Library,
		Storage:      d.Storage,
		Ingest:       d.Ingest,
		CoverSignKey: d.CoverSignKey,
	}
	browseH := &handlers.Browse{Library: d.Library}
	statsH := &handlers.Stats{Library: d.Library, Playlists: d.Playlists, Storage: d.Storage}
	shareH := &handlers.Share{
		Library:      d.Library,
		Storage:      d.Storage,
		Ingest:       d.Ingest,
		Preview:      d.Preview,
		ShareSignKey: d.CoverSignKey,
	}

	// Public share landing page — what Discord / chat apps scrape to build
	// a link preview card. Sits outside /api so the URL that users actually
	// copy into chat looks clean (/share/track/{id}?t=…&sig=…).
	r.With(appmw.RateLimitByIP(120, time.Minute)).
		Get("/share/track/{id}", shareH.Page)
	r.With(appmw.RateLimitByIP(120, time.Minute)).
		Get("/embed/track/{id}", shareH.Embed)

	r.Route("/api", func(r chi.Router) {
		r.Get("/health", func(w http.ResponseWriter, req *http.Request) {
			w.WriteHeader(http.StatusOK)
			_, _ = w.Write([]byte(`{"ok":true}`))
		})

		// Public
		r.With(appmw.RateLimitByIP(10, time.Minute)).Post("/auth/login", authH.Login)
		r.With(appmw.RateLimitByIP(5, 10*time.Minute)).Post("/auth/register", authH.Register)
		r.With(appmw.RateLimitByIP(30, time.Minute)).Get("/auth/invite", authH.CheckInvite)
		// Signed, cookie-less cover URLs so Discord's media proxy can fetch
		// album artwork. The HMAC signature + expiry *is* the auth.
		r.Get("/public/covers/album/{id}", tracksH.PublicAlbumCover)
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
		r.With(appmw.RateLimitByIP(120, time.Minute)).
			Get("/public/share/track/{id}", shareH.PublicInfo)

		// Authenticated
		r.Group(func(r chi.Router) {
			r.Use(appmw.RequireUser)
			r.Get("/auth/me", authH.Me)
			r.Post("/auth/logout", authH.Logout)
			r.With(appmw.RateLimitByIP(5, 10*time.Minute)).Post("/auth/reset-password", authH.ResetPassword)

			r.Get("/tracks", tracksH.List)
			r.Get("/tracks/{id}", tracksH.Get)
			r.Delete("/tracks/{id}", tracksH.Delete)
			r.Get("/tracks/{id}/stream", tracksH.Stream)
			r.Get("/tracks/{id}/cover", tracksH.TrackCover)
			r.Post("/tracks/{id}/play", tracksH.RecordPlay)
			r.Post("/tracks/{id}/favorite", tracksH.Favorite)
			r.Delete("/tracks/{id}/favorite", tracksH.Unfavorite)
			r.Post("/tracks/{id}/share", shareH.Create)
			r.Post("/tracks/{id}/story-background", shareH.CustomStoryBackground)
			r.Get("/favorites", tracksH.ListFavorites)
			r.Get("/recent", tracksH.ListRecent)

			r.Get("/stats/replay", statsH.Replay)
			r.Post("/stats/replay/playlist", statsH.GeneratePlaylist)
			// Renders a PNG per request (decode + blur + text); modest limit
			// keeps a misbehaving client from pinning a CPU core.
			r.With(appmw.RateLimitByIP(30, time.Minute)).
				Get("/stats/replay/image", statsH.ReplayImage)

			r.Get("/albums", browseH.ListAlbums)
			r.Get("/albums/{id}", browseH.GetAlbum)
			r.Get("/albums/{id}/tracks", browseH.ListAlbumTracks)
			r.Get("/albums/{id}/cover", tracksH.AlbumCover)
			r.Get("/covers/sign", tracksH.SignCover)
			r.Get("/artists", browseH.ListArtists)
			r.Get("/artists/{id}", browseH.GetArtist)
			r.Get("/artists/{id}/tracks", browseH.ListArtistTracks)

			r.Post("/library/upload", libH.Upload)

			r.Get("/playlists", plH.List)
			r.Post("/playlists", plH.Create)
			r.Get("/playlists/invites", plH.PendingInvites)
			r.Post("/playlists/invites/{id}/accept", plH.AcceptInvite)
			r.Post("/playlists/invites/{id}/decline", plH.DeclineInvite)
			r.Get("/playlists/{id}", plH.Get)
			r.Patch("/playlists/{id}", plH.Update)
			r.Delete("/playlists/{id}", plH.Delete)
			r.Get("/playlists/{id}/tracks", plH.ListTracks)
			r.Post("/playlists/{id}/tracks", plH.AddTracks)
			r.Delete("/playlists/{id}/tracks/{pos}", plH.RemoveTrack)
			r.Put("/playlists/{id}/order", plH.Reorder)
			r.Get("/playlists/{id}/collaborators", plH.ListCollaborators)
			r.Post("/playlists/{id}/collaborators", plH.InviteCollaborator)
			r.Patch("/playlists/{id}/collaborators/{user_id}", plH.SetCollaboratorRole)
			r.Delete("/playlists/{id}/collaborators/{user_id}", plH.RemoveCollaborator)
		})

		// Admin
		r.Group(func(r chi.Router) {
			r.Use(appmw.RequireUser, appmw.RequireAdmin)
			r.Post("/admin/invites", invH.Create)
			r.Get("/admin/invites", invH.List)
			r.Delete("/admin/invites/{id}", invH.Revoke)

			r.Post("/admin/library/rescan", libH.Rescan)
			r.Get("/admin/library/rescan", libH.RescanStatus)
			r.Get("/admin/library/errors", libH.Errors)

			r.Patch("/tracks/{id}", tracksH.Patch)
			r.Delete("/admin/tracks/{id}", tracksH.AdminDelete)
			r.Patch("/albums/{id}", browseH.PatchAlbum)
			r.Put("/albums/{id}/cover", tracksH.PutAlbumCover)
			r.Delete("/albums/{id}/cover", tracksH.DeleteAlbumCover)

			r.Get("/admin/library/roots", adminRootsH.List)
			r.Post("/admin/library/roots", adminRootsH.Add)
			r.Patch("/admin/library/roots/{id}", adminRootsH.Patch)
			r.Delete("/admin/library/roots/{id}", adminRootsH.Delete)
			r.Get("/admin/library/api-trackers/pins", adminAPITrackerH.List)
			r.Post("/admin/library/api-trackers/pins", adminAPITrackerH.Add)
			r.Patch("/admin/library/api-trackers/pins/{id}", adminAPITrackerH.Patch)
			r.Delete("/admin/library/api-trackers/pins/{id}", adminAPITrackerH.Delete)
			r.Post("/admin/library/api-trackers/pins/{id}/scan", adminAPITrackerH.Scan)
			r.Get("/admin/library/api-trackers/pins/{id}/downloads", adminAPITrackerH.Downloads)
			r.Get("/admin/library/artistgrid/pins", adminArtistGridH.List)
			r.Post("/admin/library/artistgrid/pins", adminArtistGridH.Add)
			r.Patch("/admin/library/artistgrid/pins/{id}", adminArtistGridH.Patch)
			r.Delete("/admin/library/artistgrid/pins/{id}", adminArtistGridH.Delete)
			r.Post("/admin/library/artistgrid/pins/{id}/scan", adminArtistGridH.Scan)
			r.Get("/admin/library/artistgrid/pins/{id}/downloads", adminArtistGridH.Downloads)
			r.Get("/admin/library/filen/pins", adminFilenH.List)
			r.Post("/admin/library/filen/pins", adminFilenH.Add)
			r.Patch("/admin/library/filen/pins/{id}", adminFilenH.Patch)
			r.Delete("/admin/library/filen/pins/{id}", adminFilenH.Delete)
			r.Post("/admin/library/filen/pins/{id}/scan", adminFilenH.Scan)
			r.Get("/admin/library/filen/pins/{id}/downloads", adminFilenH.Downloads)

			r.Get("/admin/users", adminUsersH.List)
			r.Get("/admin/users/{id}/departure-preview", adminUsersH.DeparturePreview)
			r.Delete("/admin/users/{id}", adminUsersH.Delete)
			r.Post("/admin/users/{id}/disable", adminUsersH.Disable)
			r.Post("/admin/users/{id}/enable", adminUsersH.Enable)
		})
	})

	return r
}
