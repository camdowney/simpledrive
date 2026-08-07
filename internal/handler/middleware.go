package handler

import (
	"context"
	"net/http"
)

const cookieName = "sd_session"

// hintCookie: non-HttpOnly UI signal for boot.js to pick the initial view. No auth weight.
const hintCookie = "sd_authed"

// shareCookie carries the token of the share link this browser last opened.
const shareCookie = "sd_share"

type ctxKey int

const shareCtxKey ctxKey = 0

// shareOf returns the share this request is confined to, or nil for the owner's own session.
func shareOf(r *http.Request) *share {
	sh, _ := r.Context().Value(shareCtxKey).(*share)
	return sh
}

func (s *server) ownerSession(r *http.Request) bool {
	c, err := r.Cookie(cookieName)
	return err == nil && s.sessions.Valid(c.Value)
}

func (s *server) requireAuth(next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if !s.ownerSession(r) {
			http.Error(w, "unauthorized", http.StatusUnauthorized)
			return
		}
		next(w, r)
	}
}

// requireAccess admits the owner, or a share link whose mode reaches the level this route needs.
func (s *server) requireAccess(next http.HandlerFunc, level access) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if s.ownerSession(r) {
			next(w, r)
			return
		}
		c, err := r.Cookie(shareCookie)
		if err != nil {
			http.Error(w, "unauthorized", http.StatusUnauthorized)
			return
		}
		sh, err := s.lookupShare(c.Value)
		if err != nil {
			http.Error(w, "server error", http.StatusInternalServerError)
			return
		}
		if sh == nil {
			http.Error(w, "unauthorized", http.StatusUnauthorized)
			return
		}
		if !sh.allows(level) {
			jsonErr(w, sh.refusal(), http.StatusForbidden)
			return
		}
		next(w, r.WithContext(context.WithValue(r.Context(), shareCtxKey, sh)))
	}
}

func (s *server) sessionToken(r *http.Request) string {
	c, err := r.Cookie(cookieName)
	if err != nil {
		return ""
	}
	return c.Value
}

// secureRequest reports whether the request is HTTPS (direct TLS or trusted-proxy header).
func (s *server) secureRequest(r *http.Request) bool {
	if r.TLS != nil {
		return true
	}
	return s.cfg.TrustedProxy && r.Header.Get("X-Forwarded-Proto") == "https"
}
