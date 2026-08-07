package handler

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"simpledrive/internal/config"
)

// localServer wires a server over an empty local root, with no mounts.
func localServer(t *testing.T) *server {
	t.Helper()
	dir := t.TempDir()
	root := filepath.Join(dir, "root")
	if err := os.Mkdir(root, 0755); err != nil {
		t.Fatal(err)
	}
	return &server{
		cfg:    &config.Config{RootDir: root, MountsPath: filepath.Join(dir, "mounts.json")},
		thumbs: newThumbCache(filepath.Join(dir, "thumbs")),
	}
}

func writeTree(t *testing.T, root string, paths ...string) {
	t.Helper()
	for _, p := range paths {
		abs := filepath.Join(root, filepath.FromSlash(p))
		if strings.HasSuffix(p, "/") {
			if err := os.MkdirAll(abs, 0755); err != nil {
				t.Fatal(err)
			}
			continue
		}
		if err := os.MkdirAll(filepath.Dir(abs), 0755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(abs, []byte("body of "+p), 0644); err != nil {
			t.Fatal(err)
		}
	}
}

// hitPaths returns the result paths in the order the handler sent them.
func hitPaths(out map[string]any) []string {
	paths := []string{}
	list, _ := out["hits"].([]any)
	for _, h := range list {
		paths = append(paths, h.(map[string]any)["path"].(string))
	}
	return paths
}

func search(t *testing.T, s *server, query string) map[string]any {
	t.Helper()
	_, out := doJSON(t, s.searchHandler, "GET", "/api/files/search?"+query, nil)
	return out
}

func TestSearchWalksSubtree(t *testing.T) {
	s := localServer(t)
	writeTree(t, s.cfg.RootDir,
		"Docs/invoice-2024.pdf",
		"Docs/Taxes/invoice-2023.pdf",
		"Docs/notes.txt",
		"Media/holiday.jpg",
	)

	out := search(t, s, "path=/&q=invoice")
	want := []string{"/Docs/Taxes/invoice-2023.pdf", "/Docs/invoice-2024.pdf"}
	if got := hitPaths(out); strings.Join(got, ",") != strings.Join(want, ",") {
		t.Fatalf("root search = %v, want %v", got, want)
	}
	if out["truncated"] != false {
		t.Errorf("truncated = %v, want false", out["truncated"])
	}

	// Scoping to a folder must exclude everything above and beside it.
	out = search(t, s, "path=/Docs/Taxes&q=invoice")
	if got := hitPaths(out); strings.Join(got, ",") != "/Docs/Taxes/invoice-2023.pdf" {
		t.Fatalf("scoped search = %v", got)
	}
}

func TestSearchMatchesFoldersAndIsCaseInsensitive(t *testing.T) {
	s := localServer(t)
	writeTree(t, s.cfg.RootDir, "Photos/Holiday/", "Photos/holiday-list.txt")

	out := search(t, s, "path=/&q=HOLIDAY")
	want := []string{"/Photos/Holiday", "/Photos/holiday-list.txt"}
	if got := hitPaths(out); strings.Join(got, ",") != strings.Join(want, ",") {
		t.Fatalf("hits = %v, want %v (folders first)", got, want)
	}
	hits := out["hits"].([]any)
	if hits[0].(map[string]any)["isDir"] != true {
		t.Errorf("folder hit not flagged isDir: %v", hits[0])
	}
	if hits[1].(map[string]any)["size"].(float64) == 0 {
		t.Errorf("file hit carries no size: %v", hits[1])
	}
}

// The dotfile pref has to reach the walk, or a search would surface what the listing hides.
func TestSearchHonoursHiddenPref(t *testing.T) {
	s := localServer(t)
	writeTree(t, s.cfg.RootDir, ".secret/report.txt", "Docs/.report-draft.txt", "Docs/report.txt")

	out := search(t, s, "path=/&q=report")
	if got := hitPaths(out); strings.Join(got, ",") != "/Docs/report.txt" {
		t.Fatalf("hits = %v, want only /Docs/report.txt", got)
	}

	// Name-first ordering, so the two report.txt sit together and the dotfile leads on its name.
	out = search(t, s, "path=/&q=report&hidden=1")
	want := []string{"/Docs/.report-draft.txt", "/.secret/report.txt", "/Docs/report.txt"}
	if got := hitPaths(out); strings.Join(got, ",") != strings.Join(want, ",") {
		t.Fatalf("hits with hidden=1 = %v, want %v", got, want)
	}
}

func TestSearchCapsResults(t *testing.T) {
	s := localServer(t)
	paths := make([]string, 0, maxSearchHits+10)
	for i := 0; i < maxSearchHits+10; i++ {
		paths = append(paths, fmt.Sprintf("Bulk/match-%03d.txt", i))
	}
	writeTree(t, s.cfg.RootDir, paths...)

	out := search(t, s, "path=/&q=match")
	if got := len(out["hits"].([]any)); got != maxSearchHits {
		t.Fatalf("hits = %d, want %d", got, maxSearchHits)
	}
	if out["truncated"] != true {
		t.Errorf("truncated = %v, want true", out["truncated"])
	}
}

func TestSearchRejectsEmptyQuery(t *testing.T) {
	s := localServer(t)
	w, _ := doJSON(t, s.searchHandler, "GET", "/api/files/search?path=/&q=%20%20", nil)
	if w.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400", w.Code)
	}
}

// A link's holder may only search their own subtree; a path above it must not resolve at all.
func TestSearchIsConfinedToShare(t *testing.T) {
	s := localServer(t)
	writeTree(t, s.cfg.RootDir, "Shared/report.txt", "Private/report.txt")

	sh := &share{Path: "Shared", Mode: shareView}
	r := httptest.NewRequest("GET", "/api/files/search?path=/Shared&q=report", nil)
	r = r.WithContext(context.WithValue(r.Context(), shareCtxKey, sh))
	w := httptest.NewRecorder()
	s.searchHandler(w, r)
	var out map[string]any
	json.Unmarshal(w.Body.Bytes(), &out)
	if got := hitPaths(out); strings.Join(got, ",") != "/Shared/report.txt" {
		t.Fatalf("in-share hits = %v", got)
	}

	r = httptest.NewRequest("GET", "/api/files/search?path=/&q=report", nil)
	r = r.WithContext(context.WithValue(r.Context(), shareCtxKey, sh))
	w = httptest.NewRecorder()
	s.searchHandler(w, r)
	if w.Code != http.StatusBadRequest {
		t.Fatalf("searching outside the share: status = %d, want 400", w.Code)
	}
}

func TestSearchIncludesMountsFromRoot(t *testing.T) {
	fake := newFakeS3("my-bucket")
	defer fake.close()
	fake.put("photos/invoice-scan.jpg", "aaa")
	fake.put("photos/Invoices/old.pdf", "bbb")
	fake.put("photos/.hidden/invoice.pdf", "ccc")
	fake.put("photos/unrelated.txt", "dd")
	s := mountedServer(t, fake, "photos/")
	writeTree(t, s.cfg.RootDir, "Local/invoice-local.txt")

	// Local and bucket hits interleave: one ordering over both backends, folders first then name.
	out := search(t, s, "path=/&q=invoice")
	want := []string{"/Bucket/Invoices", "/Local/invoice-local.txt", "/Bucket/invoice-scan.jpg"}
	if got := hitPaths(out); strings.Join(got, ",") != strings.Join(want, ",") {
		t.Fatalf("root search = %v, want %v", got, want)
	}

	// The prefix must stay server-side, and a bucket subtree must scope like a local one.
	out = search(t, s, "path=/Bucket/Invoices&q=old")
	if got := hitPaths(out); strings.Join(got, ",") != "/Bucket/Invoices/old.pdf" {
		t.Fatalf("in-bucket search = %v", got)
	}
}

// A bucket's own folder is a name the user sees, so searching has to match it like any folder.
func TestSearchMatchesMountName(t *testing.T) {
	fake := newFakeS3("my-bucket")
	defer fake.close()
	fake.put("a.txt", "aa")
	s := mountedServer(t, fake, "")

	out := search(t, s, "path=/&q=buck")
	if got := hitPaths(out); strings.Join(got, ",") != "/Bucket" {
		t.Fatalf("hits = %v, want [/Bucket]", got)
	}
}
