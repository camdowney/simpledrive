package handler

import (
	"archive/zip"
	"encoding/json"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"
)

// zipHandler — POST /api/files/zip body {paths:[...]}; streams a zip of the requested items.
func (s *server) zipHandler(w http.ResponseWriter, r *http.Request) {

	var body struct {
		Paths []string `json:"paths"`
	}
	r.Body = http.MaxBytesReader(w, r.Body, 1<<20)
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil || len(body.Paths) == 0 {
		jsonErr(w, "bad request", http.StatusBadRequest)
		return
	}

	w.Header().Set("Content-Type", "application/zip")
	w.Header().Set("Content-Disposition", `attachment; filename="download.zip"`)

	zw := zip.NewWriter(w)
	defer zw.Close()

	for _, rel := range body.Paths {
		res, err := s.resolve(r, rel)
		if err != nil {
			continue
		}
		if res.isS3() {
			addS3ToZip(r.Context(), zw, res, res.name())
			continue
		}
		abs := res.abs
		fi, err := os.Stat(abs)
		if err != nil {
			continue
		}
		if fi.IsDir() {
			addDirToZip(zw, abs, fi.Name())
		} else {
			addFileToZip(zw, abs, fi.Name(), fi.ModTime())
		}
	}
}

func addFileToZip(zw *zip.Writer, abs, nameInZip string, modified time.Time) {
	f, err := os.Open(abs)
	if err != nil {
		return
	}
	defer f.Close()

	w, err := zw.CreateHeader(&zip.FileHeader{
		Name:     nameInZip,
		Method:   zip.Deflate,
		Modified: modified,
	})
	if err != nil {
		return
	}
	io.Copy(w, f)
}

func addDirToZip(zw *zip.Writer, absDir, prefix string) {
	filepath.Walk(absDir, func(path string, fi os.FileInfo, err error) error {
		// Walk lstats, so a symlink stays one here: following it would zip a file outside the root.
		if err != nil || !fi.Mode().IsRegular() {
			return nil
		}
		rel := strings.TrimPrefix(path, absDir)
		rel = strings.TrimPrefix(rel, string(filepath.Separator))
		addFileToZip(zw, path, prefix+"/"+filepath.ToSlash(rel), fi.ModTime())
		return nil
	})
}
