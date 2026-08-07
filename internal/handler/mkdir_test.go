package handler

import (
	"net/http"
	"os"
	"path/filepath"
	"testing"
)

func TestMkdirUniqueSuffixesAndReportsName(t *testing.T) {
	s := localServer(t)
	writeTree(t, s.cfg.RootDir, "Photos/")

	w, out := doJSON(t, s.mkdirHandler, "POST", "/api/files/mkdir",
		map[string]any{"path": "/Photos", "unique": true})
	if w.Code != http.StatusOK {
		t.Fatalf("mkdir status %d: %s", w.Code, w.Body)
	}
	if out["name"] != "Photos (1)" {
		t.Fatalf("name = %v, want Photos (1)", out["name"])
	}
	if fi, err := os.Stat(filepath.Join(s.cfg.RootDir, "Photos (1)")); err != nil || !fi.IsDir() {
		t.Fatalf("Photos (1) not created: %v", err)
	}

	// The original must be untouched, so nothing already there is merged into or overwritten.
	if _, err := os.Stat(filepath.Join(s.cfg.RootDir, "Photos")); err != nil {
		t.Fatalf("original folder disturbed: %v", err)
	}
}

// A folder's dots are part of its name, unlike a file's extension.
func TestMkdirUniqueKeepsDottedName(t *testing.T) {
	s := localServer(t)
	writeTree(t, s.cfg.RootDir, "my.notes/")

	_, out := doJSON(t, s.mkdirHandler, "POST", "/api/files/mkdir",
		map[string]any{"path": "/my.notes", "unique": true})
	if out["name"] != "my.notes (1)" {
		t.Fatalf("name = %v, want my.notes (1)", out["name"])
	}
}

func TestMkdirUniqueOnFreeNameKeepsIt(t *testing.T) {
	s := localServer(t)

	_, out := doJSON(t, s.mkdirHandler, "POST", "/api/files/mkdir",
		map[string]any{"path": "/Photos", "unique": true})
	if out["name"] != "Photos" {
		t.Fatalf("name = %v, want Photos", out["name"])
	}
}

// The suffix is made in the parent, which for the root would be outside the drive entirely.
func TestMkdirUniqueRefusesRoot(t *testing.T) {
	s := localServer(t)

	w, _ := doJSON(t, s.mkdirHandler, "POST", "/api/files/mkdir",
		map[string]any{"path": "/", "unique": true})
	if w.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400", w.Code)
	}
	outside := filepath.Join(filepath.Dir(s.cfg.RootDir), "root (1)")
	if _, err := os.Stat(outside); err == nil {
		t.Fatalf("created %s, outside the root", outside)
	}
}

func TestMkdirUniqueInMount(t *testing.T) {
	fake := newFakeS3("my-bucket")
	defer fake.close()
	fake.put("Photos/a.txt", "1")
	s := mountedServer(t, fake, "")

	w, out := doJSON(t, s.mkdirHandler, "POST", "/api/files/mkdir",
		map[string]any{"path": "/Bucket/Photos", "unique": true})
	if w.Code != http.StatusOK {
		t.Fatalf("mkdir status %d: %s", w.Code, w.Body)
	}
	if out["name"] != "Photos (1)" {
		t.Fatalf("name = %v, want Photos (1)", out["name"])
	}
	if _, ok := fake.get("Photos (1)/"); !ok {
		t.Fatalf("no marker object; keys = %v", fake.keys())
	}
}

// Nested names are only ever made inside a folder that was just created, so they never collide;
// this pins the plain path still reporting what it made.
func TestMkdirReportsNameWithoutUnique(t *testing.T) {
	s := localServer(t)

	_, out := doJSON(t, s.mkdirHandler, "POST", "/api/files/mkdir",
		map[string]any{"path": "/Photos/2024"})
	if out["error"] == nil && out["name"] != "2024" {
		t.Fatalf("name = %v, want 2024", out["name"])
	}
}
