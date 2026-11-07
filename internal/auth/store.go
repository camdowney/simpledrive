package auth

import (
	"crypto/rand"
	"encoding/hex"
	"sync"
	"time"
)

type session struct {
	expires time.Time
	issued  time.Time // when the cookie last carried expires to the browser
}

type Store struct {
	mu       sync.Mutex
	sessions map[string]*session
	ttl      time.Duration
}

func NewStore(ttl time.Duration) *Store {
	s := &Store{
		sessions: make(map[string]*session),
		ttl:      ttl,
	}
	go s.cleanup()
	return s
}

func (s *Store) Create() (string, error) {
	b := make([]byte, 32)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	token := hex.EncodeToString(b)
	now := time.Now()
	s.mu.Lock()
	s.sessions[token] = &session{expires: now.Add(s.ttl), issued: now}
	s.mu.Unlock()
	return token, nil
}

// A non-zero reissue means the browser's cookie lags enough to be sent again with that expiry.
func (s *Store) Touch(token string) (ok bool, reissue time.Time) {
	now := time.Now()
	s.mu.Lock()
	defer s.mu.Unlock()
	sess, found := s.sessions[token]
	if !found || !now.Before(sess.expires) {
		return false, time.Time{}
	}
	sess.expires = now.Add(s.ttl)
	if now.Sub(sess.issued) >= s.reissueEvery() {
		sess.issued = now
		return true, sess.expires
	}
	return true, time.Time{}
}

// Capped so a short ttl still re-issues the cookie well before it lapses.
func (s *Store) reissueEvery() time.Duration {
	return min(time.Hour, s.ttl/4)
}

func (s *Store) Delete(token string) {
	s.mu.Lock()
	delete(s.sessions, token)
	s.mu.Unlock()
}

func (s *Store) cleanup() {
	t := time.NewTicker(15 * time.Minute)
	for range t.C {
		now := time.Now()
		s.mu.Lock()
		for tok, sess := range s.sessions {
			if now.After(sess.expires) {
				delete(s.sessions, tok)
			}
		}
		s.mu.Unlock()
	}
}
