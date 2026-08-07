package handler

import (
	"net/http"
	"os"
	"path/filepath"
	"testing"
)

func TestCopyFileLeavesSourceInPlace(t *testing.T) {
	s := localServer(t)
	writeTree(t, s.cfg.RootDir, "Photos/shot.jpg", "Backup/")

	w, _ := doJSON(t, s.copyHandler, "POST", "/api/files/copy",
		map[string]any{"from": "/Photos/shot.jpg", "to": "/Backup/shot.jpg"})
	if w.Code != http.StatusOK {
		t.Fatalf("copy status %d: %s", w.Code, w.Body)
	}

	copied, err := os.ReadFile(filepath.Join(s.cfg.RootDir, "Backup/shot.jpg"))
	if err != nil {
		t.Fatalf("copy missing: %v", err)
	}
	orig, err := os.ReadFile(filepath.Join(s.cfg.RootDir, "Photos/shot.jpg"))
	if err != nil {
		t.Fatalf("source gone: %v", err)
	}
	if string(copied) != string(orig) {
		t.Fatalf("copy = %q, want %q", copied, orig)
	}
}

func TestCopyFolderCopiesWholeTree(t *testing.T) {
	s := localServer(t)
	writeTree(t, s.cfg.RootDir, "Trip/day1/a.txt", "Trip/day2/b.txt", "Trip/top.txt")

	w, _ := doJSON(t, s.copyHandler, "POST", "/api/files/copy",
		map[string]any{"from": "/Trip", "to": "/Trip copy"})
	if w.Code != http.StatusOK {
		t.Fatalf("copy status %d: %s", w.Code, w.Body)
	}
	for _, p := range []string{"Trip copy/day1/a.txt", "Trip copy/day2/b.txt", "Trip copy/top.txt"} {
		if _, err := os.Stat(filepath.Join(s.cfg.RootDir, filepath.FromSlash(p))); err != nil {
			t.Fatalf("%s missing from the copy: %v", p, err)
		}
	}
}

// Descending into the copy as it is made would fill the disk before it ever finished.
func TestCopyRefusesFolderIntoItself(t *testing.T) {
	s := localServer(t)
	writeTree(t, s.cfg.RootDir, "Trip/day1/a.txt")

	w, _ := doJSON(t, s.copyHandler, "POST", "/api/files/copy",
		map[string]any{"from": "/Trip", "to": "/Trip/day1/Trip"})
	if w.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400: %s", w.Code, w.Body)
	}
}

func TestCopyRefusesExistingDestination(t *testing.T) {
	s := localServer(t)
	writeTree(t, s.cfg.RootDir, "a.txt", "Backup/a.txt")

	w, _ := doJSON(t, s.copyHandler, "POST", "/api/files/copy",
		map[string]any{"from": "/a.txt", "to": "/Backup/a.txt"})
	if w.Code != http.StatusConflict {
		t.Fatalf("status = %d, want 409: %s", w.Code, w.Body)
	}
	// The file that was already there must still be the one on disk.
	body, _ := os.ReadFile(filepath.Join(s.cfg.RootDir, "Backup/a.txt"))
	if string(body) != "body of Backup/a.txt" {
		t.Fatalf("destination overwritten: %q", body)
	}
}

// The trash index maps a trashed name back to where it came from; a copy has no such row.
func TestCopyRefusesTrashDestination(t *testing.T) {
	s, _ := trashServer(t)
	writeTree(t, s.cfg.RootDir, "a.txt")

	w, _ := doJSON(t, s.copyHandler, "POST", "/api/files/copy",
		map[string]any{"from": "/a.txt", "to": "/" + trashDirName + "/a.txt"})
	if w.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400: %s", w.Code, w.Body)
	}
}

func TestCopyKeepsModTime(t *testing.T) {
	s := localServer(t)
	writeTree(t, s.cfg.RootDir, "a.txt")
	src := filepath.Join(s.cfg.RootDir, "a.txt")
	fi, err := os.Stat(src)
	if err != nil {
		t.Fatal(err)
	}

	doJSON(t, s.copyHandler, "POST", "/api/files/copy",
		map[string]any{"from": "/a.txt", "to": "/b.txt"})

	got, err := os.Stat(filepath.Join(s.cfg.RootDir, "b.txt"))
	if err != nil {
		t.Fatal(err)
	}
	if !got.ModTime().Equal(fi.ModTime()) {
		t.Fatalf("modtime = %v, want %v", got.ModTime(), fi.ModTime())
	}
}
