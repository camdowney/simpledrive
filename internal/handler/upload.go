package handler

import (
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"sync"
	"time"
)

// uploadsDirName holds partial uploads. It is server bookkeeping, so listings leave it out.
const uploadsDirName = ".uploads"

// maxChunkBytes bounds one request body; the client sends far less, this only stops a runaway.
const maxChunkBytes = 64 << 20

// partMaxAge purges parts of an upload that was abandoned rather than resumed.
const partMaxAge = 24 * time.Hour

const uploadsGCInterval = time.Hour

var (
	errNoResume    = errors.New("a bucket takes its uploads whole")
	errBadUploadID = errors.New("bad upload id")
	errNoDest      = errors.New("destination folder not found")
)

func (s *server) uploadsDir() string { return filepath.Join(s.cfg.RootDir, uploadsDirName) }

// partPath names the part file. The destination is hashed in, so a part can only ever be resumed
// into the folder it was started for — a client id alone never reaches another folder's upload.
func (s *server) partPath(destAbs, id string) string {
	sum := sha256.Sum256([]byte(destAbs + "\x00" + id))
	return filepath.Join(s.uploadsDir(), hex.EncodeToString(sum[:])+".part")
}

// partSize is how many bytes of this upload have landed; a part that isn't there yet is 0.
func partSize(path string) int64 {
	fi, err := os.Stat(path)
	if err != nil {
		return 0
	}
	return fi.Size()
}

// partLock serializes chunks of one upload; uploads to different parts never wait on each other.
func (s *server) partLock(path string) *sync.Mutex {
	s.partsMu.Lock()
	defer s.partsMu.Unlock()
	if s.parts == nil {
		s.parts = map[string]*sync.Mutex{}
	}
	mu, ok := s.parts[path]
	if !ok {
		mu = &sync.Mutex{}
		s.parts[path] = mu
	}
	return mu
}

func (s *server) dropPartLock(path string) {
	s.partsMu.Lock()
	delete(s.parts, path)
	s.partsMu.Unlock()
}

// resumeTarget resolves the destination folder of a chunked upload and the part backing it.
func (s *server) resumeTarget(r *http.Request) (destDir, part string, err error, code int) {
	res, rErr := s.resolve(r, r.URL.Query().Get("path"))
	if rErr != nil {
		return "", "", rErr, http.StatusBadRequest
	}
	// A bucket takes the whole object in one PUT, so there is no partial state to resume into.
	if res.isS3() {
		return "", "", errNoResume, http.StatusBadRequest
	}
	id := r.URL.Query().Get("id")
	if len(id) < 16 || len(id) > 128 {
		return "", "", errBadUploadID, http.StatusBadRequest
	}
	fi, statErr := os.Stat(res.abs)
	if statErr != nil || !fi.IsDir() {
		return "", "", errNoDest, http.StatusNotFound
	}
	return res.abs, s.partPath(res.abs, id), nil, 0
}

// uploadStatusHandler — GET /api/files/upload/status?path=&id=  says where to resume from.
func (s *server) uploadStatusHandler(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		jsonErr(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	_, part, err, code := s.resumeTarget(r)
	if err != nil {
		jsonErr(w, err.Error(), code)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"offset": partSize(part)})
}

// uploadChunkHandler — POST /api/files/upload/chunk?path=&id=&offset=&name=&last=1  appends one
// slice of a file, and on the last one moves the assembled part into place.
func (s *server) uploadChunkHandler(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		jsonErr(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	destDir, part, err, code := s.resumeTarget(r)
	if err != nil {
		jsonErr(w, err.Error(), code)
		return
	}
	q := r.URL.Query()
	name := filepath.Base(q.Get("name"))
	if name == "" || name == "." || name == string(filepath.Separator) {
		jsonErr(w, "bad name", http.StatusBadRequest)
		return
	}
	offset, convErr := strconv.ParseInt(q.Get("offset"), 10, 64)
	if convErr != nil || offset < 0 {
		jsonErr(w, "bad offset", http.StatusBadRequest)
		return
	}

	mu := s.partLock(part)
	mu.Lock()
	defer mu.Unlock()

	if err := os.MkdirAll(s.uploadsDir(), 0755); err != nil {
		jsonErr(w, "write error", http.StatusInternalServerError)
		return
	}
	f, err := os.OpenFile(part, os.O_CREATE|os.O_WRONLY, 0600)
	if err != nil {
		jsonErr(w, "write error", http.StatusInternalServerError)
		return
	}
	have := partSize(part)
	// A resumed client can be behind or ahead of what actually landed; hand back the truth so it
	// re-sends from there rather than stitching a corrupt file together.
	if offset != have {
		f.Close()
		writeJSON(w, http.StatusConflict, map[string]any{"error": "offset mismatch", "offset": have})
		return
	}
	if _, err := f.Seek(offset, io.SeekStart); err != nil {
		f.Close()
		jsonErr(w, "write error", http.StatusInternalServerError)
		return
	}
	written, copyErr := io.Copy(f, http.MaxBytesReader(w, r.Body, maxChunkBytes))
	closeErr := f.Close()
	if copyErr != nil || closeErr != nil {
		// Truncate back to what was whole, so the next attempt resumes from a known-good offset.
		os.Truncate(part, have)
		jsonErr(w, "write error", http.StatusInternalServerError)
		return
	}
	if q.Get("last") != "1" {
		writeJSON(w, http.StatusOK, map[string]any{"offset": have + written})
		return
	}

	final, err := s.finishPart(part, destDir, name, q.Get("lastModified"))
	if err != nil {
		jsonErr(w, "write error", http.StatusInternalServerError)
		return
	}
	s.dropPartLock(part)
	s.thumbs.invalidateFolder(destDir)
	if sh := shareOf(r); sh != nil && sh.Mode == shareDrop {
		// A suffixed name would tell a drop link's holder which names are already taken.
		writeJSON(w, http.StatusOK, map[string]any{"status": "ok"})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"status": "ok", "saved": []string{final}})
}

// finishPart moves a completed part into the destination folder under a free name.
func (s *server) finishPart(part, destDir, name, lastModified string) (string, error) {
	dst, err := createUnique(destDir, name)
	if err != nil {
		return "", err
	}
	dst.Close()
	if err := os.Rename(part, dst.Name()); err != nil {
		os.Remove(dst.Name())
		return "", err
	}
	// The rename carries the part's own restrictive mode over; land on what a plain upload gets.
	os.Chmod(dst.Name(), 0644)
	// Prefer embedded capture time (iOS resets lastModified on export); best-effort.
	if t, ok := mediaTakenTime(dst.Name()); ok {
		os.Chtimes(dst.Name(), t, t)
	} else if ms, err := strconv.ParseInt(lastModified, 10, 64); err == nil && ms > 0 {
		t := time.UnixMilli(ms)
		os.Chtimes(dst.Name(), t, t)
	}
	return filepath.Base(dst.Name()), nil
}

func (s *server) uploadsGCLoop() {
	for {
		s.purgePartsOnce()
		time.Sleep(uploadsGCInterval)
	}
}

func (s *server) purgePartsOnce() {
	dir := s.uploadsDir()
	infos, err := os.ReadDir(dir)
	if err != nil {
		return
	}
	cutoff := time.Now().Add(-partMaxAge)
	for _, info := range infos {
		fi, err := info.Info()
		if err != nil || fi.ModTime().After(cutoff) {
			continue
		}
		path := filepath.Join(dir, info.Name())
		mu := s.partLock(path)
		if !mu.TryLock() {
			continue // a chunk is landing in it right now, so it is anything but abandoned
		}
		os.Remove(path)
		mu.Unlock()
		s.dropPartLock(path)
	}
}
