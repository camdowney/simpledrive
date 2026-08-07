package handler

import (
	"net/http"
	"os"
	"path/filepath"
	"testing"
)

func TestDirSizeSumsWholeSubtree(t *testing.T) {
	s := localServer(t)
	writeTree(t, s.cfg.RootDir, "Trip/day1/a.txt", "Trip/day2/b.txt")

	var want int64
	for _, p := range []string{"Trip/day1/a.txt", "Trip/day2/b.txt"} {
		fi, err := os.Stat(filepath.Join(s.cfg.RootDir, filepath.FromSlash(p)))
		if err != nil {
			t.Fatal(err)
		}
		want += fi.Size()
	}

	w, out := doJSON(t, s.dirSizeHandler, "GET", "/api/files/size?path=/Trip", nil)
	if w.Code != http.StatusOK {
		t.Fatalf("status %d: %s", w.Code, w.Body)
	}
	if got, _ := out["bytes"].(float64); int64(got) != want {
		t.Fatalf("bytes = %v, want %d", out["bytes"], want)
	}
	if got, _ := out["files"].(float64); int(got) != 2 {
		t.Fatalf("files = %v, want 2", out["files"])
	}
}

// Parts are the server's own scratch space, so they must not be billed to the folder they land in.
func TestDirSizeSkipsUploadParts(t *testing.T) {
	s := localServer(t)
	writeTree(t, s.cfg.RootDir, "a.txt")
	if err := os.MkdirAll(s.uploadsDir(), 0755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(s.uploadsDir(), "x.part"), make([]byte, 4096), 0600); err != nil {
		t.Fatal(err)
	}

	_, out := doJSON(t, s.dirSizeHandler, "GET", "/api/files/size?path=/", nil)
	if got, _ := out["files"].(float64); int(got) != 1 {
		t.Fatalf("files = %v, want 1 (the part was counted)", out["files"])
	}
}

// byKey indexes a breakdown answer so a test can assert on one family at a time.
func byKey(t *testing.T, out map[string]any) map[string]map[string]any {
	t.Helper()
	cats, _ := out["categories"].([]any)
	if len(cats) == 0 {
		t.Fatal("no categories in the answer")
	}
	got := map[string]map[string]any{}
	for _, c := range cats {
		m := c.(map[string]any)
		got[m["key"].(string)] = m
	}
	return got
}

func TestBreakdownGroupsByExtension(t *testing.T) {
	s := localServer(t)
	writeTree(t, s.cfg.RootDir, "Deep/")
	sizes := map[string]int{
		"a.jpg": 100, "b.arw": 200, "Deep/c.mp4": 3000, "d.mp3": 40, "e.pdf": 5, "f.zip": 7,
		"g.bin": 9,
	}
	for name, n := range sizes {
		p := filepath.Join(s.cfg.RootDir, filepath.FromSlash(name))
		if err := os.WriteFile(p, make([]byte, n), 0644); err != nil {
			t.Fatal(err)
		}
	}

	w, out := doJSON(t, s.breakdownHandler, "GET", "/api/usage/breakdown?path=/", nil)
	if w.Code != http.StatusOK {
		t.Fatalf("status %d: %s", w.Code, w.Body)
	}
	got := byKey(t, out)
	want := map[string]int64{
		"photos": 300, "videos": 3000, "audio": 40, "documents": 5, "archives": 7, "other": 9,
	}
	for key, bytes := range want {
		if got[key] == nil {
			t.Fatalf("%s missing from the answer", key)
		}
		if n, _ := got[key]["bytes"].(float64); int64(n) != bytes {
			t.Fatalf("%s bytes = %v, want %d", key, got[key]["bytes"], bytes)
		}
	}
	if n, _ := got["photos"]["files"].(float64); int(n) != 2 {
		t.Fatalf("photos files = %v, want 2", got["photos"]["files"])
	}
	if n, _ := out["bytes"].(float64); int64(n) != 3361 {
		t.Fatalf("total bytes = %v, want 3361", out["bytes"])
	}
}

// The meter draws a fixed set of rows, so a family with nothing in it still has to come back.
func TestBreakdownReportsEmptyCategories(t *testing.T) {
	s := localServer(t)
	writeTree(t, s.cfg.RootDir, "a.txt")

	_, out := doJSON(t, s.breakdownHandler, "GET", "/api/usage/breakdown?path=/", nil)
	got := byKey(t, out)
	for _, key := range usageCategories {
		if got[key] == nil {
			t.Fatalf("%s missing from the answer", key)
		}
	}
	if n, _ := got["videos"]["bytes"].(float64); n != 0 {
		t.Fatalf("videos bytes = %v, want 0", got["videos"]["bytes"])
	}
}

// Parts are the server's own scratch space, so they must not be billed to any family.
func TestBreakdownSkipsUploadParts(t *testing.T) {
	s := localServer(t)
	if err := os.MkdirAll(s.uploadsDir(), 0755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(s.uploadsDir(), "x.part"), make([]byte, 4096), 0600); err != nil {
		t.Fatal(err)
	}

	_, out := doJSON(t, s.breakdownHandler, "GET", "/api/usage/breakdown?path=/", nil)
	if n, _ := out["bytes"].(float64); n != 0 {
		t.Fatalf("total bytes = %v, want 0 (the part was counted)", out["bytes"])
	}
}
