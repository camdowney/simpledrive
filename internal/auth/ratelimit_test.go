package auth

import (
	"net/http"
	"net/http/httptest"
	"testing"
)

func req(remoteAddr string, headers ...string) *http.Request {
	r := httptest.NewRequest(http.MethodPost, "/api/auth/login", nil)
	r.RemoteAddr = remoteAddr
	for i := 0; i < len(headers); i += 2 {
		r.Header.Set(headers[i], headers[i+1])
	}
	return r
}

// A proxy on this machine is the only thing that may name the client.
func TestRemoteIPTakesProxyHeaderOnlyFromLoopback(t *testing.T) {
	cases := []struct {
		name    string
		request *http.Request
		want    string
	}{
		{"proxy on this machine", req("127.0.0.1:1", "X-Forwarded-For", "203.0.113.7"), "203.0.113.7"},
		{"IPv6 loopback", req("[::1]:1", "X-Forwarded-For", "203.0.113.7"), "203.0.113.7"},
		{"straight off the internet", req("198.51.100.4:1", "X-Forwarded-For", "203.0.113.7"), "198.51.100.4"},
		{"another host on the network", req("192.168.1.9:1", "X-Forwarded-For", "203.0.113.7"), "192.168.1.9"},
		{"loopback, no headers", req("127.0.0.1:1"), "127.0.0.1"},
		{"loopback, junk chain", req("127.0.0.1:1", "X-Forwarded-For", "nonsense"), "127.0.0.1"},
		// nginx names the client here and sets no chain of its own.
		{"only X-Real-IP", req("127.0.0.1:1", "X-Real-IP", "203.0.113.7"), "203.0.113.7"},
	}
	r := NewRateLimiter()
	for _, c := range cases {
		if got := r.remoteIP(c.request); got != c.want {
			t.Errorf("%s: remoteIP = %q, want %q", c.name, got, c.want)
		}
	}
}

// Caddy appends to whatever chain arrives and passes X-Real-IP through untouched, so a client can
// write both. Only the entry the proxy itself added — the last one — may key the lockout.
func TestForgedForwardingHeadersAreIgnored(t *testing.T) {
	cases := []struct {
		name    string
		request *http.Request
	}{
		{"a chain the client started", req("127.0.0.1:1",
			"X-Forwarded-For", "10.9.9.9, 203.0.113.7")},
		{"an X-Real-IP passed through beside a real chain", req("127.0.0.1:1",
			"X-Forwarded-For", "203.0.113.7", "X-Real-IP", "10.9.9.9")},
	}
	r := NewRateLimiter()
	for _, c := range cases {
		if got := r.remoteIP(c.request); got != "203.0.113.7" {
			t.Errorf("%s: remoteIP = %q, want the proxy's own entry 203.0.113.7", c.name, got)
		}
	}
}

// The lockout is worth nothing if a header the sender writes gives them a fresh bucket each try.
func TestSpoofedHeaderCannotOutrunTheLockout(t *testing.T) {
	r := NewRateLimiter()
	for i := 0; i < maxFails; i++ {
		attempt := req("198.51.100.4:44100", "X-Forwarded-For", "203.0.113.7")
		if !r.Allow(attempt) {
			t.Fatalf("attempt %d refused before the limit", i+1)
		}
		r.RecordFail(attempt)
	}
	// A new address on every request, all from the same peer.
	if r.Allow(req("198.51.100.4:44100", "X-Forwarded-For", "203.0.113.99")) {
		t.Fatal("a forged forwarding header bought another round of guesses")
	}
	// Someone else's connection is still their own, so the lockout doesn't spread.
	if !r.Allow(req("198.51.100.5:44100")) {
		t.Fatal("a different peer was locked out too")
	}
}

func TestLockoutFollowsTheClientBehindAProxy(t *testing.T) {
	r := NewRateLimiter()
	for i := 0; i < maxFails; i++ {
		r.RecordFail(req("127.0.0.1:53321", "X-Forwarded-For", "203.0.113.7"))
	}
	if r.Allow(req("127.0.0.1:53321", "X-Forwarded-For", "203.0.113.7")) {
		t.Fatal("the guessing client was not locked out")
	}
	// Every visitor arrives from the proxy, so a lockout must not take the rest of them with it.
	if !r.Allow(req("127.0.0.1:53322", "X-Forwarded-For", "203.0.113.8")) {
		t.Fatal("another visitor behind the same proxy was locked out")
	}
}
