package handler

import (
	"crypto/subtle"
	"encoding/json"
	"net/http"
	"time"

	"golang.org/x/crypto/bcrypt"
)

func (s *server) loginHandler(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}

	if !s.limiter.Allow(r) {
		http.Error(w, "too many attempts, try again later", http.StatusTooManyRequests)
		return
	}

	var body struct {
		Username string `json:"username"`
		Password string `json:"password"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		http.Error(w, "bad request", http.StatusBadRequest)
		return
	}

	// Always run bcrypt (even on username mismatch) so timing hides which field was wrong.
	userOK := subtle.ConstantTimeCompare([]byte(body.Username), []byte(s.cfg.Username)) == 1
	passOK := bcrypt.CompareHashAndPassword([]byte(s.cfg.PasswordHash), []byte(body.Password)) == nil
	if !userOK || !passOK {
		s.limiter.RecordFail(r)
		http.Error(w, "invalid username or password", http.StatusUnauthorized)
		return
	}

	s.limiter.Reset(r)
	token, err := s.sessions.Create()
	if err != nil {
		http.Error(w, "internal error", http.StatusInternalServerError)
		return
	}

	expires := time.Now().Add(time.Duration(s.cfg.SessionHours) * time.Hour)
	secure := s.secureRequest(r)
	http.SetCookie(w, &http.Cookie{
		Name:     cookieName,
		Value:    token,
		Path:     "/",
		Expires:  expires,
		HttpOnly: true,
		Secure:   secure,
		SameSite: http.SameSiteStrictMode,
	})
	http.SetCookie(w, &http.Cookie{
		Name:     hintCookie,
		Value:    "1",
		Path:     "/",
		Expires:  expires,
		Secure:   secure,
		SameSite: http.SameSiteStrictMode,
	})
	writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
}

func (s *server) logoutHandler(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	s.sessions.Delete(s.sessionToken(r))
	http.SetCookie(w, &http.Cookie{
		Name:    cookieName,
		Value:   "",
		Path:    "/",
		Expires: time.Unix(0, 0),
		MaxAge:  -1,
	})
	http.SetCookie(w, &http.Cookie{
		Name:    hintCookie,
		Value:   "",
		Path:    "/",
		Expires: time.Unix(0, 0),
		MaxAge:  -1,
	})
	writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
}

func (s *server) statusHandler(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
}
