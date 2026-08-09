package handler

import (
	"net/http"
	"os"
	"path/filepath"
	"time"
)

// fixDatesHandler — POST /api/files/fixdates?path=<rel> re-stamps media mtimes from capture time.
func (s *server) fixDatesHandler(w http.ResponseWriter, r *http.Request) {
	res, ok := s.resolveQuery(w, r)
	if !ok {
		return
	}
	if res.isS3() {
		jsonErr(w, "a bucket's dates can't be edited", http.StatusBadRequest)
		return
	}
	entries, err := os.ReadDir(res.abs)
	if err != nil {
		jsonErr(w, "read error", http.StatusInternalServerError)
		return
	}

	changed := 0
	for _, d := range entries {
		if d.IsDir() {
			continue
		}
		abs := filepath.Join(res.abs, d.Name())
		t, ok := mediaTakenTime(abs)
		if !ok {
			continue
		}
		fi, err := d.Info()
		if err != nil {
			continue
		}
		// EXIF has 1s resolution, so equal-to-the-second means already correct.
		if diff := fi.ModTime().Sub(t); diff > -time.Second && diff < time.Second {
			continue
		}
		if err := os.Chtimes(abs, t, t); err == nil {
			changed++
		}
	}
	if changed > 0 {
		s.thumbs.invalidateFolder(res.abs)
	}

	writeJSON(w, http.StatusOK, map[string]any{"status": "ok", "changed": changed})
}
