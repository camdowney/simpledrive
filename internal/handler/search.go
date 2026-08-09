package handler

import (
	"context"
	"io/fs"
	"net/http"
	"path"
	"path/filepath"
	"sort"
	"strings"
	"time"
)

// maxSearchHits caps a result set; past a couple hundred rows the answer is "refine the query".
const maxSearchHits = 200

// searchTimeout bounds one query, so a deep tree or a slow bucket can't hold the request open.
const searchTimeout = 20 * time.Second

// searchHit carries the full path: a result is opened from wherever the search happened to run.
type searchHit struct {
	Name     string    `json:"name"`
	Path     string    `json:"path"`
	Size     int64     `json:"size"`
	Modified time.Time `json:"modified"`
	IsDir    bool      `json:"isDir"`
	IsMount  bool      `json:"isMount,omitempty"`
}

// searchHandler — GET /api/files/search?path=<rel>&q=<text>&hidden=1  matches names in a subtree.
func (s *server) searchHandler(w http.ResponseWriter, r *http.Request) {
	q := strings.ToLower(strings.TrimSpace(r.URL.Query().Get("q")))
	if q == "" {
		jsonErr(w, "no query", http.StatusBadRequest)
		return
	}
	rel := r.URL.Query().Get("path")
	res, ok := s.resolvePath(w, r, rel)
	if !ok {
		return
	}
	hidden := r.URL.Query().Get("hidden") == "1"

	ctx, cancel := context.WithTimeout(r.Context(), searchTimeout)
	defer cancel()

	base := "/" + cleanRel(rel)
	hits := []searchHit{}
	var truncated bool
	var err error
	if res.isS3() {
		truncated, err = s.searchS3(ctx, res, base, q, hidden, &hits)
	} else {
		truncated, err = searchLocal(ctx, res.abs, base, q, hidden, &hits, s.uploadsDir())
		// Buckets hang off the root and live in no directory, so the walk can't reach them.
		if err == nil && !truncated && res.abs == s.cfg.RootDir {
			truncated, err = s.searchMounts(ctx, q, hidden, &hits)
		}
	}
	// A query that ran out of time answers with what it found, which beats failing outright.
	if ctx.Err() != nil {
		truncated, err = true, nil
	}
	if err != nil {
		jsonErr(w, err.Error(), http.StatusBadGateway)
		return
	}

	sortHits(hits)
	writeJSON(w, http.StatusOK, map[string]any{
		"base":      base,
		"hits":      hits,
		"truncated": truncated,
	})
}

// sortHits orders results folders-first then by name, matching how a listing reads.
func sortHits(hits []searchHit) {
	sort.Slice(hits, func(i, j int) bool {
		if hits[i].IsDir != hits[j].IsDir {
			return hits[i].IsDir
		}
		if c := compareFileNames(hits[i].Name, hits[j].Name); c != 0 {
			return c < 0
		}
		return hits[i].Path < hits[j].Path
	})
}

func searchLocal(ctx context.Context, abs, base, q string, hidden bool, hits *[]searchHit, skip string) (bool, error) {
	truncated := false
	err := filepath.WalkDir(abs, func(p string, d fs.DirEntry, err error) error {
		if err != nil {
			return nil // an unreadable directory drops out rather than failing the whole search
		}
		if ctx.Err() != nil {
			return fs.SkipAll
		}
		if p == abs {
			return nil
		}
		if p == skip {
			return fs.SkipDir
		}
		name := d.Name()
		if !hidden && strings.HasPrefix(name, ".") {
			if d.IsDir() {
				return fs.SkipDir
			}
			return nil
		}
		// A vault holds ciphertext under random ids, so only the folder itself is searchable.
		sealed := d.IsDir() && isVaultDir(p)
		if !strings.Contains(strings.ToLower(name), q) {
			if sealed {
				return fs.SkipDir
			}
			return nil
		}
		if len(*hits) >= maxSearchHits {
			truncated = true
			return fs.SkipAll
		}
		rest, relErr := filepath.Rel(abs, p)
		if relErr != nil {
			return nil
		}
		hit := searchHit{Name: name, Path: path.Join(base, filepath.ToSlash(rest)), IsDir: d.IsDir()}
		if fi, statErr := d.Info(); statErr == nil {
			hit.Modified = fi.ModTime().UTC()
			if !d.IsDir() {
				hit.Size = fi.Size()
			}
		}
		*hits = append(*hits, hit)
		if sealed {
			return fs.SkipDir
		}
		return nil
	})
	return truncated, err
}

// searchMounts descends into every connected bucket, and matches the bucket names themselves.
func (s *server) searchMounts(ctx context.Context, q string, hidden bool, hits *[]searchHit) (bool, error) {
	s.mountsMu.Lock()
	mounts, err := s.readMounts()
	s.mountsMu.Unlock()
	if err != nil {
		return false, err
	}
	for i := range mounts {
		if len(*hits) >= maxSearchHits {
			return true, nil
		}
		m := &mounts[i]
		if strings.Contains(strings.ToLower(m.Name), q) {
			*hits = append(*hits, searchHit{Name: m.Name, Path: "/" + m.Name, IsDir: true, IsMount: true})
		}
		cli, err := s.s3Client(m)
		if err != nil {
			continue // a bucket we can't reach drops out of the results, not the whole search
		}
		truncated, err := s.searchS3(ctx, &resolved{mnt: m, cli: cli}, "/"+m.Name, q, hidden, hits)
		if err != nil {
			continue
		}
		if truncated {
			return true, nil
		}
	}
	return false, nil
}

// Folders exist only as key segments, so matching one means recovering it from the keys under it.
func (s *server) searchS3(ctx context.Context, r *resolved, base, q string, hidden bool, hits *[]searchHit) (bool, error) {
	prefix := r.dirKey()
	lst, err := r.cli.List(ctx, prefix, "", maxS3Objects)
	if err != nil {
		return false, err
	}
	seenDir := map[string]bool{}
	for _, o := range lst.Objects {
		rest := strings.TrimPrefix(o.Key, prefix)
		if rest == "" {
			continue
		}
		segs := strings.Split(rest, "/")
		for i, seg := range segs {
			// An empty tail is this prefix's own folder marker; a dot segment hides all below it.
			if seg == "" || (!hidden && strings.HasPrefix(seg, ".")) {
				break
			}
			isDir := i < len(segs)-1
			sub := strings.Join(segs[:i+1], "/")
			if isDir {
				if seenDir[sub] {
					continue
				}
				seenDir[sub] = true
			}
			if !strings.Contains(strings.ToLower(seg), q) {
				continue
			}
			if len(*hits) >= maxSearchHits {
				return true, nil
			}
			hit := searchHit{Name: seg, Path: path.Join(base, sub), IsDir: isDir}
			if !isDir {
				hit.Size = o.Size
				hit.Modified = s3Modified(&o)
			}
			*hits = append(*hits, hit)
		}
	}
	return false, nil
}
