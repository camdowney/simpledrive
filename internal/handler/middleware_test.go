package handler

import (
	"crypto/tls"
	"net/http"
	"net/http/httptest"
	"testing"
)

// Nothing configures this: the Secure flag has to follow from the request itself.
func TestSecureRequestNeedsNoConfiguration(t *testing.T) {
	s := &server{}
	cases := []struct {
		name    string
		prepare func(*http.Request)
		want    bool
	}{
		{"plain HTTP, no proxy", func(*http.Request) {}, false},
		{"TLS straight to us", func(r *http.Request) { r.TLS = &tls.ConnectionState{} }, true},
		{"a proxy that terminates HTTPS", func(r *http.Request) {
			r.Header.Set("X-Forwarded-Proto", "https")
		}, true},
		{"a proxy forwarding plain HTTP", func(r *http.Request) {
			r.Header.Set("X-Forwarded-Proto", "http")
		}, false},
	}
	for _, c := range cases {
		r := httptest.NewRequest(http.MethodPost, "/api/auth/login", nil)
		c.prepare(r)
		if got := s.secureRequest(r); got != c.want {
			t.Errorf("%s: secureRequest = %v, want %v", c.name, got, c.want)
		}
	}
}
