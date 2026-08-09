package handler

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"

	"simpledrive/internal/s3"
)

// mount is the on-disk record. It carries credentials, so it is never marshalled to a response.
type mount struct {
	ID              string `json:"id"`
	Name            string `json:"name"`
	Bucket          string `json:"bucket"`
	Region          string `json:"region"`
	Prefix          string `json:"prefix,omitempty"`
	Endpoint        string `json:"endpoint,omitempty"`
	AccessKeyID     string `json:"accessKeyId"`
	SecretAccessKey string `json:"secretAccessKey"`
}

// mountPublic is the only shape sent to the client; it has no credential fields to leak.
type mountPublic struct {
	ID       string `json:"id"`
	Name     string `json:"name"`
	Bucket   string `json:"bucket"`
	Region   string `json:"region"`
	Prefix   string `json:"prefix,omitempty"`
	Endpoint string `json:"endpoint,omitempty"`
}

func (m mount) public() mountPublic {
	return mountPublic{m.ID, m.Name, m.Bucket, m.Region, m.Prefix, m.Endpoint}
}

// readMounts returns the stored mounts; a missing file is an empty list, not an error.
// Callers must hold mountsMu.
func (s *server) readMounts() ([]mount, error) {
	return s.mountsCache.load(s.cfg.MountsPath)
}

func (s *server) writeMounts(mounts []mount) error {
	data, err := json.MarshalIndent(mounts, "", "  ")
	if err != nil {
		return err
	}
	s.mountsCache.forget()
	// writeFileAtomic goes through os.CreateTemp, which always creates 0600 — keep it that way.
	return writeFileAtomic(s.cfg.MountsPath, data)
}

// normalizePrefix trims slashes and re-adds a trailing one so it concatenates with object keys.
func normalizePrefix(p string) string {
	p = strings.Trim(strings.TrimSpace(p), "/")
	if p == "" {
		return ""
	}
	return p + "/"
}

// normalizeEndpoint adds the scheme when a bare host was typed; otherwise the host parses as a path.
func normalizeEndpoint(e string) string {
	if e == "" || strings.Contains(e, "://") {
		return e
	}
	return "https://" + e
}

// deriveRegion reads the region out of a known endpoint host so it needn't be typed twice.
func deriveRegion(endpoint string) string {
	u, err := url.Parse(endpoint)
	if err != nil {
		return ""
	}
	host := u.Hostname()
	// Backblaze B2: s3.<region>.backblazeb2.com
	if parts := strings.Split(host, "."); len(parts) == 4 && parts[0] == "s3" &&
		parts[2] == "backblazeb2" && parts[3] == "com" {
		return parts[1]
	}
	// R2 has no real regions; it signs everything against "auto".
	if strings.HasSuffix(host, ".r2.cloudflarestorage.com") {
		return "auto"
	}
	return ""
}

// validateMountName rejects names that can't be a folder; "" means the name is fine.
func validateMountName(name string) string {
	switch {
	case name == "":
		return "name is required"
	case strings.ContainsAny(name, "/\\"):
		return "name must not contain path separators"
	case name == "." || name == "..":
		return "invalid name"
	}
	return ""
}

func validateMount(m *mount, existing []mount) string {
	m.Name = strings.TrimSpace(m.Name)
	m.Bucket = strings.TrimSpace(m.Bucket)
	m.Region = strings.TrimSpace(m.Region)
	m.Endpoint = normalizeEndpoint(strings.TrimSpace(m.Endpoint))
	m.Prefix = normalizePrefix(m.Prefix)
	if m.Region == "" {
		m.Region = deriveRegion(m.Endpoint)
	}

	if msg := validateMountName(m.Name); msg != "" {
		return msg
	}
	switch {
	case m.Bucket == "":
		return "bucket is required"
	case m.Region == "" && m.Endpoint == "":
		return "region is required, or give an endpoint for a non-AWS bucket"
	case m.Region == "":
		return "region is required: it can't be read from that endpoint"
	case m.AccessKeyID == "":
		return "access key ID is required"
	case m.SecretAccessKey == "":
		return "secret access key is required"
	}
	if m.Endpoint != "" {
		u, err := url.Parse(m.Endpoint)
		if err != nil || u.Scheme != "https" || u.Host == "" {
			return "endpoint must be an https URL"
		}
	}
	for _, e := range existing {
		if strings.EqualFold(e.Name, m.Name) {
			return "a mount with that name already exists"
		}
	}
	return ""
}

// probeMount lists one object to confirm the bucket exists and the key can read it.
func (s *server) probeMount(ctx context.Context, m *mount) error {
	cli, err := s3.New(s3.Config{
		Bucket:          m.Bucket,
		Region:          m.Region,
		Endpoint:        m.Endpoint,
		AccessKeyID:     m.AccessKeyID,
		SecretAccessKey: m.SecretAccessKey,
	})
	if err != nil {
		return err
	}
	if _, err := cli.List(ctx, m.Prefix, "/", 1); err != nil {
		return err
	}
	return nil
}

// mountsHandler — GET /api/mounts lists mounts without credentials; POST adds one.
func (s *server) mountsHandler(w http.ResponseWriter, r *http.Request) {
	switch r.Method {
	case http.MethodGet:
		s.mountsMu.Lock()
		mounts, err := s.readMounts()
		s.mountsMu.Unlock()
		if err != nil {
			jsonErr(w, "read error", http.StatusInternalServerError)
			return
		}
		out := make([]mountPublic, 0, len(mounts))
		for _, m := range mounts {
			out = append(out, m.public())
		}
		writeJSON(w, http.StatusOK, map[string]any{"mounts": out})

	case http.MethodPost:
		var m mount
		r.Body = http.MaxBytesReader(w, r.Body, 1<<16)
		if err := json.NewDecoder(r.Body).Decode(&m); err != nil {
			jsonErr(w, "bad request", http.StatusBadRequest)
			return
		}

		s.mountsMu.Lock()
		defer s.mountsMu.Unlock()
		mounts, err := s.readMounts()
		if err != nil {
			jsonErr(w, "read error", http.StatusInternalServerError)
			return
		}
		if msg := validateMount(&m, mounts); msg != "" {
			jsonErr(w, msg, http.StatusBadRequest)
			return
		}
		if _, err := os.Stat(filepath.Join(s.cfg.RootDir, m.Name)); err == nil {
			jsonErr(w, "a folder with that name already exists", http.StatusBadRequest)
			return
		}
		// Probe before storing: a typo'd bucket or key should fail here, not on every listing.
		if err := s.probeMount(r.Context(), &m); err != nil {
			jsonErr(w, err.Error(), http.StatusBadGateway)
			return
		}
		buf := make([]byte, 8)
		if _, err := rand.Read(buf); err != nil {
			jsonErr(w, "server error", http.StatusInternalServerError)
			return
		}
		m.ID = hex.EncodeToString(buf)
		if err := s.writeMounts(append(mounts, m)); err != nil {
			jsonErr(w, "write error", http.StatusInternalServerError)
			return
		}
		writeJSON(w, http.StatusCreated, m.public())

	default:
		jsonErr(w, "method not allowed", http.StatusMethodNotAllowed)
	}
}
