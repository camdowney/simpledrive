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
	mu       sync.Mutex
	attempts map[string]*attempt
}

func NewRateLimiter() *RateLimiter {
	r := &RateLimiter{attempts: make(map[string]*attempt)}
	go r.cleanup()
	return r
}

// remoteIP keys the lockout: a forged header would buy a fresh bucket, so only a local proxy is heard.
func (r *RateLimiter) remoteIP(req *http.Request) string {
	host, _, err := net.SplitHostPort(req.RemoteAddr)
	if err != nil {
		host = req.RemoteAddr
	}
	if ip := net.ParseIP(host); ip == nil || !ip.IsLoopback() {
		return host
	}
	return forwardedFor(req, host)
}

// A client sends an X-Forwarded-For of its own that the proxy appends to, so the proxy's entry is
// the last. X-Real-IP is read only when no chain arrived, since a proxy may pass a forged one on.
func forwardedFor(req *http.Request, fallback string) string {
	if chain := req.Header.Get("X-Forwarded-For"); chain != "" {
		last := chain[strings.LastIndexByte(chain, ',')+1:]
		if ip := net.ParseIP(strings.TrimSpace(last)); ip != nil {
			return ip.String()
		}
		return fallback
	}
	if ip := net.ParseIP(strings.TrimSpace(req.Header.Get("X-Real-IP"))); ip != nil {
		return ip.String()
	}
	return fallback
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
