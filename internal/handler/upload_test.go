package handler

import (
	"bytes"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
	"time"
)

// sendChunk posts one slice of a resumable upload the way the browser does.
func sendChunk(t *testing.T, s *server, dir, id, name string, offset int, body []byte,
	last bool) (*httptest.ResponseRecorder, map[string]any) {
	t.Helper()
	target := fmt.Sprintf("/api/files/upload/chunk?path=%s&id=%s&name=%s&offset=%d", dir, id, name, offset)
	if last {
		target += "&last=1"
	}
	r := httptest.NewRequest("POST", target, bytes.NewReader(body))
	w := httptest.NewRecorder()
	s.uploadChunkHandler(w, r)
	var out map[string]any
	json.Unmarshal(w.Body.Bytes(), &out)
	return w, out
}

func chunkStatus(t *testing.T, s *server, dir, id string) int {
	t.Helper()
	r := httptest.NewRequest("GET", "/api/files/upload/status?path="+dir+"&id="+id, nil)
	w := httptest.NewRecorder()
	s.uploadStatusHandler(w, r)
	var out map[string]any
	json.Unmarshal(w.Body.Bytes(), &out)
	off, _ := out["offset"].(float64)
	return int(off)
}

const testUploadID = "0123456789abcdef0123456789abcdef"

func TestChunkedUploadAssemblesFile(t *testing.T) {
	s := localServer(t)
	writeTree(t, s.cfg.RootDir, "Inbox/")

	if got := chunkStatus(t, s, "/Inbox", testUploadID); got != 0 {
		t.Fatalf("fresh offset = %d, want 0", got)
	}
	if w, _ := sendChunk(t, s, "/Inbox", testUploadID, "clip.bin", 0, []byte("hello "), false); w.Code != 200 {
		t.Fatalf("first chunk status %d: %s", w.Code, w.Body)
	}
	if got := chunkStatus(t, s, "/Inbox", testUploadID); got != 6 {
		t.Fatalf("offset after one chunk = %d, want 6", got)
	}
	w, out := sendChunk(t, s, "/Inbox", testUploadID, "clip.bin", 6, []byte("world"), true)
	if w.Code != 200 {
		t.Fatalf("last chunk status %d: %s", w.Code, w.Body)
	}
	saved, _ := out["saved"].([]any)
	if len(saved) != 1 || saved[0] != "clip.bin" {
		t.Fatalf("saved = %v, want [clip.bin]", out["saved"])
	}

	body, err := os.ReadFile(filepath.Join(s.cfg.RootDir, "Inbox/clip.bin"))
	if err != nil {
		t.Fatalf("file not assembled: %v", err)
	}
	if string(body) != "hello world" {
		t.Fatalf("content = %q, want %q", body, "hello world")
	}
	// The part is consumed by the move, so nothing is left behind holding the bytes twice.
	if _, err := os.Stat(s.partPath(filepath.Join(s.cfg.RootDir, "Inbox"), testUploadID)); !os.IsNotExist(err) {
		t.Fatalf("part survived the finish: %v", err)
	}
	// A part is private while it is half-written; the finished file is a file like any other.
	fi, err := os.Stat(filepath.Join(s.cfg.RootDir, "Inbox/clip.bin"))
	if err != nil {
		t.Fatal(err)
	}
	if fi.Mode().Perm() != 0644 {
		t.Fatalf("mode = %v, want 0644 (what a plain upload lands as)", fi.Mode().Perm())
	}
}

// The whole point: a connection that dropped mid-file resumes from what actually landed.
func TestChunkedUploadResumesFromServerOffset(t *testing.T) {
	s := localServer(t)
	writeTree(t, s.cfg.RootDir, "Inbox/")

	sendChunk(t, s, "/Inbox", testUploadID, "clip.bin", 0, []byte("part one "), false)

	// A fresh client asks where to pick up, then sends only the rest.
	at := chunkStatus(t, s, "/Inbox", testUploadID)
	if at != 9 {
		t.Fatalf("resume offset = %d, want 9", at)
	}
	sendChunk(t, s, "/Inbox", testUploadID, "clip.bin", at, []byte("part two"), true)

	body, err := os.ReadFile(filepath.Join(s.cfg.RootDir, "Inbox/clip.bin"))
	if err != nil {
		t.Fatal(err)
	}
	if string(body) != "part one part two" {
		t.Fatalf("content = %q", body)
	}
}

// A client that thinks it is further along than the server must be corrected, never stitched to.
func TestChunkedUploadRejectsWrongOffset(t *testing.T) {
	s := localServer(t)
	writeTree(t, s.cfg.RootDir, "Inbox/")

	sendChunk(t, s, "/Inbox", testUploadID, "clip.bin", 0, []byte("abc"), false)

	w, out := sendChunk(t, s, "/Inbox", testUploadID, "clip.bin", 99, []byte("xyz"), false)
	if w.Code != http.StatusConflict {
		t.Fatalf("status = %d, want 409: %s", w.Code, w.Body)
	}
	if off, _ := out["offset"].(float64); int(off) != 3 {
		t.Fatalf("reported offset = %v, want 3", out["offset"])
	}
}

func TestChunkedUploadSuffixesTakenName(t *testing.T) {
	s := localServer(t)
	writeTree(t, s.cfg.RootDir, "Inbox/clip.bin")

	_, out := sendChunk(t, s, "/Inbox", testUploadID, "clip.bin", 0, []byte("new"), true)
	saved, _ := out["saved"].([]any)
	if len(saved) != 1 || saved[0] != "clip (1).bin" {
		t.Fatalf("saved = %v, want [clip (1).bin]", out["saved"])
	}
	// The file already there keeps both its name and its contents.
	body, _ := os.ReadFile(filepath.Join(s.cfg.RootDir, "Inbox/clip.bin"))
	if string(body) != "body of Inbox/clip.bin" {
		t.Fatalf("original overwritten: %q", body)
	}
}

// One upload's id must not reach another folder's part, so the destination is hashed in.
func TestPartPathIsScopedToDestination(t *testing.T) {
	s := localServer(t)
	a := s.partPath(filepath.Join(s.cfg.RootDir, "A"), testUploadID)
	b := s.partPath(filepath.Join(s.cfg.RootDir, "B"), testUploadID)
	if a == b {
		t.Fatal("the same id resolves to one part in two different folders")
	}
}

func TestUploadsDirIsHiddenFromListing(t *testing.T) {
	s := localServer(t)
	writeTree(t, s.cfg.RootDir, "Photos/")
	if err := os.MkdirAll(s.uploadsDir(), 0755); err != nil {
		t.Fatal(err)
	}

	_, out := doJSON(t, s.filesHandler, "GET", "/api/files?path=/", nil)
	for _, name := range entryNames(out) {
		if name == uploadsDirName {
			t.Fatal("the parts folder is listed as if it were the user's own")
		}
	}
}

func TestPurgePartsDropsOnlyStaleOnes(t *testing.T) {
	s := localServer(t)
	writeTree(t, s.cfg.RootDir, "Inbox/")
	sendChunk(t, s, "/Inbox", testUploadID, "clip.bin", 0, []byte("abc"), false)

	part := s.partPath(filepath.Join(s.cfg.RootDir, "Inbox"), testUploadID)
	s.purgePartsOnce()
	if _, err := os.Stat(part); err != nil {
		t.Fatalf("a part still being written was purged: %v", err)
	}

	old := time.Now().Add(-2 * partMaxAge)
	if err := os.Chtimes(part, old, old); err != nil {
		t.Fatal(err)
	}
	s.purgePartsOnce()
	if _, err := os.Stat(part); !os.IsNotExist(err) {
		t.Fatalf("an abandoned part was kept: %v", err)
	}
}
