package auth

import (
	"net"
	"net/http"
	"strings"
	"sync"
	"time"
)

const (
	maxFails   = 5
	lockoutDur = 15 * time.Minute
	failWindow = 10 * time.Minute
)

type attempt struct {
	count    int
	first    time.Time
	lockedAt time.Time
}

type RateLimiter struct {
	mu           sync.Mutex
	attempts     map[string]*attempt
	trustedProxy bool
}

func NewRateLimiter(trustedProxy bool) *RateLimiter {
	r := &RateLimiter{
		attempts:     make(map[string]*attempt),
		trustedProxy: trustedProxy,
	}
	go r.cleanup()
	return r
}

// remoteIP returns the client IP, preferring X-Real-IP when behind a trusted proxy.
func (r *RateLimiter) remoteIP(req *http.Request) string {
	if r.trustedProxy {
		if raw := req.Header.Get("X-Real-IP"); raw != "" {
			ip := strings.TrimSpace(raw)
			if net.ParseIP(ip) != nil {
				return ip
			}
		}
	}
	ip, _, err := net.SplitHostPort(req.RemoteAddr)
	if err != nil {
		return req.RemoteAddr
	}
	return ip
}

func (r *RateLimiter) Allow(req *http.Request) bool {
	ip := r.remoteIP(req)
	r.mu.Lock()
	defer r.mu.Unlock()

	a, ok := r.attempts[ip]
	if !ok {
		return true
	}
	now := time.Now()
	if !a.lockedAt.IsZero() && now.Before(a.lockedAt.Add(lockoutDur)) {
		return false
	}
	if now.After(a.first.Add(failWindow)) {
		delete(r.attempts, ip)
		return true
	}
	return a.count < maxFails
}

func (r *RateLimiter) RecordFail(req *http.Request) {
	ip := r.remoteIP(req)
	r.mu.Lock()
	defer r.mu.Unlock()

	a, ok := r.attempts[ip]
	if !ok {
		r.attempts[ip] = &attempt{count: 1, first: time.Now()}
		return
	}
	a.count++
	if a.count >= maxFails {
		a.lockedAt = time.Now()
	}
}

func (r *RateLimiter) Reset(req *http.Request) {
	ip := r.remoteIP(req)
	r.mu.Lock()
	delete(r.attempts, ip)
	r.mu.Unlock()
}

func (r *RateLimiter) cleanup() {
	t := time.NewTicker(30 * time.Minute)
	for range t.C {
		now := time.Now()
		r.mu.Lock()
		for ip, a := range r.attempts {
			if a.lockedAt.IsZero() && now.After(a.first.Add(failWindow)) {
				delete(r.attempts, ip)
			} else if !a.lockedAt.IsZero() && now.After(a.lockedAt.Add(lockoutDur)) {
				delete(r.attempts, ip)
			}
		}
		r.mu.Unlock()
	}
}
