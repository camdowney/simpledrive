package handler

import (
	"embed"
	"io/fs"
	"net/http"
	"sync"
	"time"

	"simpledrive/internal/auth"
	"simpledrive/internal/config"
	"simpledrive/internal/s3"
)

type server struct {
	cfg      *config.Config
	sessions *auth.Store
	limiter  *auth.RateLimiter
	webFS    fs.FS
	version  string // fingerprint of the embedded assets, which the service worker caches under
	mux      *http.ServeMux
	thumbs   *thumbCache
	jobs     *jobQueue
	prefsMu  sync.Mutex
	tagsMu   sync.Mutex
	mountsMu sync.Mutex
	sharesMu sync.Mutex
	trashMu  sync.Mutex

	// One lock per in-progress upload part, so chunks of one file queue without blocking others.
	partsMu sync.Mutex
	parts   map[string]*sync.Mutex

	s3Mu      sync.Mutex
	s3Clients map[string]*s3.Client
}

func New(cfg *config.Config, webFS embed.FS) http.Handler {
	s := &server{
		cfg:       cfg,
		sessions:  auth.NewStore(time.Duration(cfg.SessionHours) * time.Hour),
		limiter:   auth.NewRateLimiter(cfg.TrustedProxy),
		webFS:     webFS,
		version:   assetVersion(webFS),
		mux:       http.NewServeMux(),
		thumbs:    newThumbCache(cfg.ThumbCacheDir),
		jobs:      newJobQueue(),
		s3Clients: map[string]*s3.Client{},
		parts:     map[string]*sync.Mutex{},
	}
	go s.thumbs.gcLoop()
	go s.trashGCLoop()
	go s.uploadsGCLoop()

	staticFS, _ := fs.Sub(webFS, "web")
	s.mux.Handle("/static/", http.FileServer(http.FS(staticFS)))
	s.mux.HandleFunc("/", s.indexHandler)

	s.mux.HandleFunc("/api/auth/login", s.loginHandler)
	s.mux.HandleFunc("/api/auth/logout", s.requireAuth(s.logoutHandler))
	s.mux.HandleFunc("/api/auth/status", s.requireAuth(s.statusHandler))

	// The level each route is registered at is what a share link is judged against, not a UI hint.
	s.mux.HandleFunc("/api/files", s.requireAccess(s.filesHandler, accessRead))
	s.mux.HandleFunc("/api/files/search", s.requireAccess(s.searchHandler, accessRead))
	s.mux.HandleFunc("/api/files/download", s.requireAccess(s.downloadHandler, accessRead))
	s.mux.HandleFunc("/api/files/upload", s.requireAccess(s.uploadHandler, accessUpload))
	s.mux.HandleFunc("/api/files/upload/chunk", s.requireAccess(s.uploadChunkHandler, accessUpload))
	s.mux.HandleFunc("/api/files/upload/status", s.requireAccess(s.uploadStatusHandler, accessUpload))
	s.mux.HandleFunc("/api/files/read", s.requireAccess(s.readHandler, accessRead))
	s.mux.HandleFunc("/api/files/write", s.requireAccess(s.writeHandler, accessWrite))
	s.mux.HandleFunc("/api/files/mkdir", s.requireAccess(s.mkdirHandler, accessWrite))
	s.mux.HandleFunc("/api/files/rename", s.requireAccess(s.renameHandler, accessWrite))
	s.mux.HandleFunc("/api/files/move", s.requireAccess(s.moveHandler, accessWrite))
	s.mux.HandleFunc("/api/files/copy", s.requireAccess(s.copyHandler, accessWrite))
	s.mux.HandleFunc("/api/files/delete", s.requireAccess(s.deleteHandler, accessWrite))
	s.mux.HandleFunc("/api/files/zip", s.requireAccess(s.zipHandler, accessRead))
	s.mux.HandleFunc("/api/files/thumb", s.requireAccess(s.thumbHandler, accessRead))
	s.mux.HandleFunc("/api/files/preview", s.requireAccess(s.previewHandler, accessRead))
	s.mux.HandleFunc("/api/files/display", s.requireAccess(s.displayHandler, accessRead))
	s.mux.HandleFunc("/api/files/meta", s.requireAccess(s.metaHandler, accessRead))
	s.mux.HandleFunc("/api/files/size", s.requireAccess(s.dirSizeHandler, accessRead))
	s.mux.HandleFunc("/api/files/fixdates", s.requireAccess(s.fixDatesHandler, accessWrite))
	s.mux.HandleFunc("/api/files/loudness", s.requireAccess(s.loudnessHandler, accessRead))

	s.mux.HandleFunc("/api/media/trim-audio", s.requireAccess(s.trimAudioHandler, accessWrite))
	s.mux.HandleFunc("/api/media/resize-image", s.requireAccess(s.resizeImageHandler, accessWrite))
	s.mux.HandleFunc("/api/media/resize-video", s.requireAccess(s.resizeVideoHandler, accessWrite))
	// Owner-only: the queue names paths across the whole drive, not just a share's subtree.
	s.mux.HandleFunc("/api/jobs", s.requireAuth(s.jobsHandler))
	s.mux.HandleFunc("/api/jobs/cancel", s.requireAuth(s.jobCancelHandler))

	// Owner-only: a share link's holder must not put back what the owner deleted.
	s.mux.HandleFunc("/api/trash/restore", s.requireAuth(s.trashRestoreHandler))

	s.mux.HandleFunc("/api/prefs", s.requireAuth(s.prefsHandler))
	// Owner-only: a share link carries no tags, so its holder never reads or writes this.
	s.mux.HandleFunc("/api/tags", s.requireAuth(s.tagsHandler))
	s.mux.HandleFunc("/api/mounts", s.requireAuth(s.mountsHandler))
	s.mux.HandleFunc("/api/shares", s.requireAuth(s.sharesHandler))
	// Owner-only: how full the drive is, and what is filling it, is nothing a link speaks for.
	s.mux.HandleFunc("/api/usage", s.requireAuth(s.usageHandler))
	s.mux.HandleFunc("/api/usage/breakdown", s.requireAuth(s.breakdownHandler))
	s.mux.HandleFunc("/api/share/info", s.requireAccess(s.shareInfoHandler, accessInfo))
	s.mux.HandleFunc("/s/", s.shareEntryHandler)

	// Root scope, so one worker covers the whole app; the version query busts it per build.
	s.mux.HandleFunc("/sw.js", s.serviceWorkerHandler)

	return securityHeaders(s.mux)
}

// Restrictive CSP: script-src 'self' blocks uploaded-file XSS; 'unsafe-eval' is for the editor.
func securityHeaders(next http.Handler) http.Handler {
	const csp = "default-src 'self'; " +
		"script-src 'self' 'unsafe-eval'; " +
		"style-src 'self' 'unsafe-inline'; " +
		"img-src 'self' data: blob:; " +
		"media-src 'self' blob:; " +
		"font-src 'self' data:; " +
		"object-src 'none'; " +
		// blob: frames render vault PDFs, which are decrypted in the page and never fetched.
		"frame-src 'self' blob:; " +
		"base-uri 'self'; " +
		"form-action 'self'; " +
		"frame-ancestors 'self'"
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		h := w.Header()
		h.Set("Content-Security-Policy", csp)
		h.Set("X-Content-Type-Options", "nosniff")
		h.Set("X-Frame-Options", "SAMEORIGIN")
		h.Set("Referrer-Policy", "no-referrer")
		next.ServeHTTP(w, r)
	})
}

func (s *server) indexHandler(w http.ResponseWriter, r *http.Request) {
	if r.URL.Path != "/" {
		http.NotFound(w, r)
		return
	}
	s.serveIndex(w)
}

func (s *server) serveIndex(w http.ResponseWriter) {
	data, err := fs.ReadFile(s.webFS, "web/index.html")
	if err != nil {
		http.Error(w, "not found", http.StatusNotFound)
		return
	}
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	w.Write(data)
}
