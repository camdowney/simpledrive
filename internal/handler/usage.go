package handler

import (
	"context"
	"io/fs"
	"net/http"
	"path/filepath"
	"strings"
	"time"
)

// sizeTimeout bounds a recursive measurement; a tree too deep to finish reports what it reached.
const sizeTimeout = 20 * time.Second

// usageHandler — GET /api/usage  reports how full the disk holding the drive is.
func (s *server) usageHandler(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		jsonErr(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	total, free, ok := diskUsage(s.cfg.RootDir)
	if !ok {
		// Every other platform still gets the dialog, just without the meter at the top of it.
		writeJSON(w, http.StatusOK, map[string]any{"available": false})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"available": true,
		"total":     total,
		"free":      free,
		"used":      total - free,
	})
}

// dirSizeHandler — GET /api/files/size?path=<rel>  measures a folder, on either backend.
func (s *server) dirSizeHandler(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		jsonErr(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	res, err := s.resolve(r, r.URL.Query().Get("path"))
	if err != nil {
		jsonErr(w, err.Error(), http.StatusBadRequest)
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), sizeTimeout)
	defer cancel()

	var bytes int64
	var files int
	var partial bool
	if res.isS3() {
		lst, err := res.cli.List(ctx, res.dirKey(), "", maxS3Objects)
		if err != nil {
			s3Fail(w, err)
			return
		}
		for _, o := range lst.Objects {
			if strings.HasSuffix(o.Key, "/") {
				continue // a folder marker is bookkeeping, not a file with a size
			}
			bytes += o.Size
			files++
		}
		partial = len(lst.Objects) >= maxS3Objects
	} else {
		bytes, files, partial = walkSize(ctx, res.abs, s.uploadsDir())
	}
	writeJSON(w, http.StatusOK, map[string]any{"bytes": bytes, "files": files, "partial": partial})
}

// walkSize sums a subtree, reporting partial=true when it ran out of time before finishing.
func walkSize(ctx context.Context, abs, skip string) (bytes int64, files int, partial bool) {
	filepath.WalkDir(abs, func(p string, d fs.DirEntry, err error) error {
		if err != nil {
			return nil
		}
		if ctx.Err() != nil {
			partial = true
			return fs.SkipAll
		}
		if p == skip {
			return fs.SkipDir
		}
		if d.IsDir() {
			return nil
		}
		if fi, err := d.Info(); err == nil {
			bytes += fi.Size()
			files++
		}
		return nil
	})
	return bytes, files, partial
}

// Families the breakdown groups by, in the order they are reported. Anything else lands in other.
var usageCategories = []string{"documents", "photos", "videos", "audio", "archives", "other"}

// Pictures the thumbnailer has no reader for still belong beside the ones it does.
var photoOnlyExts = map[string]bool{
	".svg": true, ".avif": true, ".heic": true, ".heif": true, ".tif": true, ".tiff": true,
	".ico": true,
}

var documentExts = map[string]bool{
	".pdf": true, ".md": true, ".markdown": true, ".txt": true, ".rtf": true, ".csv": true,
	".doc": true, ".docx": true, ".xls": true, ".xlsx": true, ".ppt": true, ".pptx": true,
	".odt": true, ".ods": true, ".odp": true, ".epub": true, ".pages": true, ".numbers": true,
}

var archiveExts = map[string]bool{
	".zip": true, ".tar": true, ".gz": true, ".tgz": true, ".bz2": true, ".xz": true,
	".7z": true, ".rar": true, ".iso": true, ".dmg": true,
}

func usageCategory(name string) string {
	ext := strings.ToLower(filepath.Ext(name))
	switch {
	case imageThumbExts[ext] || rawThumbExts[ext] || photoOnlyExts[ext]:
		return "photos"
	case videoThumbExts[ext]:
		return "videos"
	case audioExts[ext]:
		return "audio"
	case documentExts[ext]:
		return "documents"
	case archiveExts[ext]:
		return "archives"
	}
	return "other"
}

type categoryUse struct {
	Key   string `json:"key"`
	Bytes int64  `json:"bytes"`
	Files int    `json:"files"`
}

// breakdownHandler — GET /api/usage/breakdown?path=<rel>  splits the drive by kind of file.
func (s *server) breakdownHandler(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		jsonErr(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	res, err := s.resolve(r, r.URL.Query().Get("path"))
	if err != nil {
		jsonErr(w, err.Error(), http.StatusBadRequest)
		return
	}
	if res.isS3() {
		jsonErr(w, "a bucket is billed by the provider, not by this disk", http.StatusBadRequest)
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), sizeTimeout)
	defer cancel()

	bytes := map[string]int64{}
	files := map[string]int{}
	partial := false
	skip := s.uploadsDir()
	filepath.WalkDir(res.abs, func(p string, d fs.DirEntry, err error) error {
		if err != nil {
			return nil
		}
		if ctx.Err() != nil {
			partial = true
			return fs.SkipAll
		}
		if p == skip {
			return fs.SkipDir
		}
		if d.IsDir() || !d.Type().IsRegular() {
			return nil
		}
		fi, err := d.Info()
		if err != nil {
			return nil
		}
		c := usageCategory(d.Name())
		bytes[c] += fi.Size()
		files[c]++
		return nil
	})

	// Every family is answered with, empty ones included, so the meter keeps one fixed shape.
	out := make([]categoryUse, 0, len(usageCategories))
	var total int64
	var count int
	for _, c := range usageCategories {
		out = append(out, categoryUse{Key: c, Bytes: bytes[c], Files: files[c]})
		total += bytes[c]
		count += files[c]
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"categories": out,
		"bytes":      total,
		"files":      count,
		"partial":    partial,
	})
}
