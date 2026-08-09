package handler

import (
	"crypto/sha256"
	"encoding/hex"
	"io/fs"
	"net/http"
	"sort"
	"strings"
)

// swVersionMark is replaced with the asset fingerprint as the worker is served.
const swVersionMark = "__SD_VERSION__"

// assetVersion fingerprints the embedded assets: the worker caches under it, so a rebuild is new.
func assetVersion(webFS fs.FS) string {
	var paths []string
	fs.WalkDir(webFS, "web", func(p string, d fs.DirEntry, err error) error {
		if err == nil && !d.IsDir() {
			paths = append(paths, p)
		}
		return nil
	})
	sort.Strings(paths)
	h := sha256.New()
	for _, p := range paths {
		h.Write([]byte(p))
		if data, err := fs.ReadFile(webFS, p); err == nil {
			h.Write(data)
		}
	}
	return hex.EncodeToString(h.Sum(nil))[:12]
}

// Served from the root for scope: under /static/ the worker could only ever control /static/.
func (s *server) serviceWorkerHandler(w http.ResponseWriter, r *http.Request) {
	data, err := fs.ReadFile(s.webFS, "web/static/js/sw.js")
	if err != nil {
		http.NotFound(w, r)
		return
	}
	body := strings.ReplaceAll(string(data), swVersionMark, s.version)
	w.Header().Set("Content-Type", "text/javascript; charset=utf-8")
	// The worker is the only thing that can replace itself, so it must never be served from cache.
	w.Header().Set("Cache-Control", "no-cache")
	w.Write([]byte(body))
}
