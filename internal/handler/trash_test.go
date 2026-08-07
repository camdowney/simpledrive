package handler

import (
	"bytes"
	"encoding/json"
	"image"
	"image/png"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"simpledrive/internal/config"
)

func trashServer(t *testing.T) (*server, string) {
	t.Helper()
	dir := t.TempDir()
	root := filepath.Join(dir, "root")
	if err := os.MkdirAll(root, 0o755); err != nil {
		t.Fatal(err)
	}
	return &server{
		cfg: &config.Config{
			RootDir:        root,
			MountsPath:     filepath.Join(dir, "mounts.json"),
			TrashIndexPath: filepath.Join(dir, "trash.json"),
		},
		thumbs: newThumbCache(t.TempDir()),
		jobs:   newJobQueue(),
	}, root
}

func postJSON(t *testing.T, h http.HandlerFunc, path, body string) *httptest.ResponseRecorder {
	t.Helper()
	req := httptest.NewRequest(http.MethodPost, path, strings.NewReader(body))
	rec := httptest.NewRecorder()
	h(rec, req)
	return rec
}

func TestDeleteMovesToTrashAndRestores(t *testing.T) {
	s, root := trashServer(t)
	if err := os.MkdirAll(filepath.Join(root, "music"), 0o755); err != nil {
		t.Fatal(err)
	}
	src := filepath.Join(root, "music", "song.mp3")
	if err := os.WriteFile(src, []byte("audio"), 0o644); err != nil {
		t.Fatal(err)
	}
	mod := time.Now().Add(-72 * time.Hour).Truncate(time.Second)
	if err := os.Chtimes(src, mod, mod); err != nil {
		t.Fatal(err)
	}

	if rec := postJSON(t, s.deleteHandler, "/api/files/delete", `{"path":"music/song.mp3"}`); rec.Code != 200 {
		t.Fatalf("delete: got %d, want 200 (%s)", rec.Code, rec.Body)
	}
	if _, err := os.Stat(src); !os.IsNotExist(err) {
		t.Fatal("original still present after delete")
	}
	if _, err := os.Stat(filepath.Join(root, trashDirName, "song.mp3")); err != nil {
		t.Fatalf("not in trash: %v", err)
	}

	idx, err := s.readTrashIndex()
	if err != nil {
		t.Fatal(err)
	}
	if idx["song.mp3"].From != "music/song.mp3" {
		t.Fatalf("origin not recorded: %+v", idx)
	}

	if rec := postJSON(t, s.trashRestoreHandler, "/api/trash/restore", `{"name":"song.mp3"}`); rec.Code != 200 {
		t.Fatalf("restore: got %d, want 200 (%s)", rec.Code, rec.Body)
	}
	fi, err := os.Stat(src)
	if err != nil {
		t.Fatalf("not restored: %v", err)
	}
	if !fi.ModTime().Equal(mod) {
		t.Errorf("mtime: got %v, want %v", fi.ModTime(), mod)
	}
}

// A name reused since the delete must not be clobbered when the old one comes back.
func TestRestoreBesideReusedName(t *testing.T) {
	s, root := trashServer(t)
	src := filepath.Join(root, "note.txt")
	if err := os.WriteFile(src, []byte("old"), 0o644); err != nil {
		t.Fatal(err)
	}
	if rec := postJSON(t, s.deleteHandler, "/api/files/delete", `{"path":"note.txt"}`); rec.Code != 200 {
		t.Fatalf("delete: %d", rec.Code)
	}
	if err := os.WriteFile(src, []byte("new"), 0o644); err != nil {
		t.Fatal(err)
	}
	if rec := postJSON(t, s.trashRestoreHandler, "/api/trash/restore", `{"name":"note.txt"}`); rec.Code != 200 {
		t.Fatalf("restore: %d", rec.Code)
	}
	if b, _ := os.ReadFile(src); string(b) != "new" {
		t.Errorf("clobbered the reused name: got %q", b)
	}
	if b, err := os.ReadFile(filepath.Join(root, "note (1).txt")); err != nil || string(b) != "old" {
		t.Errorf("restored copy missing: %q %v", b, err)
	}
}

func TestDeleteInsideTrashIsPermanent(t *testing.T) {
	s, root := trashServer(t)
	if err := os.WriteFile(filepath.Join(root, "a.txt"), []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}
	postJSON(t, s.deleteHandler, "/api/files/delete", `{"path":"a.txt"}`)
	if rec := postJSON(t, s.deleteHandler, "/api/files/delete", `{"path":".trash/a.txt"}`); rec.Code != 200 {
		t.Fatalf("purge via delete: %d", rec.Code)
	}
	if _, err := os.Stat(filepath.Join(root, trashDirName, "a.txt")); !os.IsNotExist(err) {
		t.Error("still in trash after deleting from trash")
	}
	if _, err := os.Stat(filepath.Join(root, trashDirName, trashDirName)); err == nil {
		t.Error("trash nested inside itself")
	}
}

// The trash is a plain dotfolder: the client's "show hidden files" toggle is what reveals it,
// and searching honours the same rule rather than hiding deleted files outright.
func TestTrashIsAnOrdinaryHiddenFolder(t *testing.T) {
	s, root := trashServer(t)
	if err := os.WriteFile(filepath.Join(root, "secret.txt"), []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}
	postJSON(t, s.deleteHandler, "/api/files/delete", `{"path":"secret.txt"}`)

	rec := httptest.NewRecorder()
	s.filesHandler(rec, httptest.NewRequest(http.MethodGet, "/api/files?path=/", nil))
	if !strings.Contains(rec.Body.String(), trashDirName) {
		t.Errorf("trash missing from the root listing: %s", rec.Body)
	}

	rec = httptest.NewRecorder()
	s.searchHandler(rec, httptest.NewRequest(http.MethodGet, "/api/files/search?path=/&q=secret", nil))
	if strings.Contains(rec.Body.String(), "secret.txt") {
		t.Errorf("a dotfolder's contents must stay out of a default search: %s", rec.Body)
	}

	rec = httptest.NewRecorder()
	s.searchHandler(rec, httptest.NewRequest(http.MethodGet, "/api/files/search?path=/&q=secret&hidden=1", nil))
	if !strings.Contains(rec.Body.String(), "secret.txt") {
		t.Errorf("hidden search should reach the trash: %s", rec.Body)
	}
}

func TestPurgeRespectsRetention(t *testing.T) {
	s, root := trashServer(t)
	for _, name := range []string{"old.txt", "new.txt"} {
		if err := os.WriteFile(filepath.Join(root, name), []byte("x"), 0o644); err != nil {
			t.Fatal(err)
		}
		postJSON(t, s.deleteHandler, "/api/files/delete", `{"path":"`+name+`"}`)
	}

	idx, err := s.readTrashIndex()
	if err != nil {
		t.Fatal(err)
	}
	e := idx["old.txt"]
	e.DeletedAt = time.Now().Add(-8 * 24 * time.Hour)
	idx["old.txt"] = e
	if err := s.writeTrashIndex(idx); err != nil {
		t.Fatal(err)
	}

	s.purgeTrashOnce()
	if _, err := os.Stat(filepath.Join(root, trashDirName, "old.txt")); !os.IsNotExist(err) {
		t.Error("expired entry survived the purge")
	}
	if _, err := os.Stat(filepath.Join(root, trashDirName, "new.txt")); err != nil {
		t.Error("recent entry was purged")
	}

	s.cfg.TrashDays = -1
	idx, _ = s.readTrashIndex()
	e = idx["new.txt"]
	e.DeletedAt = time.Now().Add(-400 * 24 * time.Hour)
	idx["new.txt"] = e
	s.writeTrashIndex(idx)
	s.purgeTrashOnce()
	if _, err := os.Stat(filepath.Join(root, trashDirName, "new.txt")); err != nil {
		t.Error("negative trash_days should keep forever")
	}
}

func TestTrashFolderRejectsRenameAndMove(t *testing.T) {
	s, root := trashServer(t)
	if err := os.WriteFile(filepath.Join(root, "note.txt"), []byte("hi"), 0o644); err != nil {
		t.Fatal(err)
	}
	if rec := postJSON(t, s.deleteHandler, "/api/files/delete", `{"path":"note.txt"}`); rec.Code != 200 {
		t.Fatalf("delete: got %d, want 200 (%s)", rec.Code, rec.Body)
	}

	cases := []struct {
		name string
		h    http.HandlerFunc
		path string
		body string
	}{
		{"rename trash", s.renameHandler, "/api/files/rename", `{"dir":"/","from":".trash","to":"old"}`},
		{"rename onto trash", s.renameHandler, "/api/files/rename", `{"dir":"/","from":"note.txt","to":".trash"}`},
		{"move trash", s.moveHandler, "/api/files/move", `{"from":".trash","to":"stash"}`},
		{"move into trash", s.moveHandler, "/api/files/move", `{"from":"note.txt","to":".trash/note.txt"}`},
	}
	for _, c := range cases {
		if rec := postJSON(t, c.h, c.path, c.body); rec.Code != http.StatusBadRequest {
			t.Errorf("%s: got %d, want 400 (%s)", c.name, rec.Code, rec.Body)
		}
	}
	if _, err := os.Stat(s.trashDir()); err != nil {
		t.Fatalf("trash dir disturbed: %v", err)
	}
}

func pngBytes(t *testing.T) []byte {
	t.Helper()
	var buf bytes.Buffer
	if err := png.Encode(&buf, image.NewRGBA(image.Rect(0, 0, 32, 32))); err != nil {
		t.Fatal(err)
	}
	return buf.Bytes()
}

// The trash reads as the trash: a folder preview of whatever was last deleted is not wanted.
func TestTrashFolderOffersNoThumbnail(t *testing.T) {
	s, root := trashServer(t)
	img := filepath.Join(root, "photo.png")
	if err := os.WriteFile(img, pngBytes(t), 0o644); err != nil {
		t.Fatal(err)
	}
	if rec := postJSON(t, s.deleteHandler, "/api/files/delete", `{"path":"photo.png"}`); rec.Code != 200 {
		t.Fatalf("delete: got %d, want 200 (%s)", rec.Code, rec.Body)
	}

	rec := httptest.NewRecorder()
	s.filesHandler(rec, httptest.NewRequest(http.MethodGet, "/api/files?path=/", nil))
	var out struct {
		Entries []struct {
			Name     string `json:"name"`
			IsTrash  bool   `json:"isTrash"`
			HasThumb bool   `json:"hasThumb"`
		} `json:"entries"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &out); err != nil {
		t.Fatal(err)
	}
	found := false
	for _, e := range out.Entries {
		if e.Name != trashDirName {
			continue
		}
		found = true
		if !e.IsTrash {
			t.Error("trash folder not flagged isTrash")
		}
		if e.HasThumb {
			t.Error("trash folder previews a deleted file")
		}
	}
	if !found {
		t.Fatal("trash folder missing from the root listing")
	}
}
