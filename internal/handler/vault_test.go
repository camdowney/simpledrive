package handler

import (
	"bytes"
	"encoding/json"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// makeVault creates a folder the client would have sealed: the key file is what marks it.
func makeVault(t *testing.T, root, name string) string {
	t.Helper()
	dir := filepath.Join(root, name)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	for _, f := range []string{vaultKeyName, vaultIndexName, vaultRecoveryName} {
		if err := os.WriteFile(filepath.Join(dir, f), []byte("age-ciphertext"), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	return dir
}

func uploadReq(t *testing.T, path, name string, body []byte) *http.Request {
	t.Helper()
	var buf bytes.Buffer
	mw := multipart.NewWriter(&buf)
	part, err := mw.CreateFormFile("files", name)
	if err != nil {
		t.Fatal(err)
	}
	part.Write(body)
	mw.Close()
	req := httptest.NewRequest(http.MethodPost, path, &buf)
	req.Header.Set("Content-Type", mw.FormDataContentType())
	return req
}

func TestListingMarksVaultAndSkipsThumbs(t *testing.T) {
	s, root := trashServer(t)
	makeVault(t, root, "Taxes")
	if err := os.MkdirAll(filepath.Join(root, "Photos"), 0o755); err != nil {
		t.Fatal(err)
	}

	rec := httptest.NewRecorder()
	s.filesHandler(rec, httptest.NewRequest(http.MethodGet, "/api/files?path=/", nil))
	var out struct {
		InVault bool `json:"inVault"`
		Entries []struct {
			Name     string `json:"name"`
			IsVault  bool   `json:"isVault"`
			HasThumb bool   `json:"hasThumb"`
		} `json:"entries"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &out); err != nil {
		t.Fatal(err)
	}
	if out.InVault {
		t.Error("root reported as a vault")
	}
	for _, e := range out.Entries {
		switch e.Name {
		case "Taxes":
			if !e.IsVault {
				t.Error("vault folder not marked isVault")
			}
			if e.HasThumb {
				t.Error("vault folder claims a thumbnail")
			}
		case "Photos":
			if e.IsVault {
				t.Error("ordinary folder marked isVault")
			}
		}
	}

	// A deep link lands inside with no parent listing to carry the flag.
	rec = httptest.NewRecorder()
	s.filesHandler(rec, httptest.NewRequest(http.MethodGet, "/api/files?path=/Taxes", nil))
	out.InVault = false
	if err := json.Unmarshal(rec.Body.Bytes(), &out); err != nil {
		t.Fatal(err)
	}
	if !out.InVault {
		t.Error("listing inside a vault did not report inVault")
	}
}

// The recovery doc is written for a desktop that has the folder but not this server, so it lives
// in the folder and nowhere in the app. The listing is the only thing that could give it away.
func TestListingInsideVaultWithholdsContents(t *testing.T) {
	s, root := trashServer(t)
	dir := makeVault(t, root, "Taxes")
	for _, name := range []string{vaultRecoveryDoc, "9f2c1ab4", "notes.txt"} {
		if err := os.WriteFile(filepath.Join(dir, name), []byte("x"), 0o644); err != nil {
			t.Fatal(err)
		}
	}

	rec := httptest.NewRecorder()
	s.filesHandler(rec, httptest.NewRequest(http.MethodGet, "/api/files?path=/Taxes", nil))
	var out struct {
		InVault bool `json:"inVault"`
		Entries []struct {
			Name string `json:"name"`
		} `json:"entries"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &out); err != nil {
		t.Fatal(err)
	}
	if !out.InVault {
		t.Fatal("listing inside a vault did not report inVault")
	}
	for _, e := range out.Entries {
		t.Errorf("vault listing exposed %q", e.Name)
	}
	// It has to still be there on disk: that is the whole point of writing it.
	if _, err := os.Stat(filepath.Join(dir, vaultRecoveryDoc)); err != nil {
		t.Errorf("recovery doc missing from the vault folder: %v", err)
	}
}

func TestSearchSkipsVaultContents(t *testing.T) {
	s, root := trashServer(t)
	dir := makeVault(t, root, "Taxes")
	// A blob is named by a random id, but the metadata files would match a ".age" query.
	if err := os.WriteFile(filepath.Join(dir, "9f2c1ab4"), []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}

	search := func(q string) []string {
		rec := httptest.NewRecorder()
		s.searchHandler(rec, httptest.NewRequest(http.MethodGet, "/api/files/search?q="+q+"&hidden=1", nil))
		var out struct {
			Hits []struct {
				Path string `json:"path"`
			} `json:"hits"`
		}
		if err := json.Unmarshal(rec.Body.Bytes(), &out); err != nil {
			t.Fatal(err)
		}
		paths := make([]string, 0, len(out.Hits))
		for _, h := range out.Hits {
			paths = append(paths, h.Path)
		}
		return paths
	}

	for _, p := range search("age") {
		if strings.HasPrefix(p, "/Taxes/") {
			t.Errorf("search reached inside the vault: %s", p)
		}
	}
	for _, p := range search("9f2c") {
		if strings.HasPrefix(p, "/Taxes/") {
			t.Errorf("search enumerated a vault blob: %s", p)
		}
	}
	found := false
	for _, p := range search("taxes") {
		if p == "/Taxes" {
			found = true
		}
	}
	if !found {
		t.Error("search no longer finds the vault folder itself")
	}
}

func TestUploadOverwriteIsVaultOnly(t *testing.T) {
	s, root := trashServer(t)
	makeVault(t, root, "Taxes")

	rec := httptest.NewRecorder()
	s.uploadHandler(rec, uploadReq(t, "/api/files/upload?path=/&overwrite=1", "a.txt", []byte("x")))
	if rec.Code != http.StatusBadRequest {
		t.Errorf("overwrite outside a vault: got %d, want 400 (%s)", rec.Code, rec.Body)
	}

	// Inside a vault it replaces rather than making "index (1).age", which would strand the vault.
	rec = httptest.NewRecorder()
	s.uploadHandler(rec, uploadReq(t, "/api/files/upload?path=/Taxes&overwrite=1", vaultIndexName, []byte("new")))
	if rec.Code != http.StatusOK {
		t.Fatalf("overwrite inside a vault: got %d, want 200 (%s)", rec.Code, rec.Body)
	}
	got, err := os.ReadFile(filepath.Join(root, "Taxes", vaultIndexName))
	if err != nil || string(got) != "new" {
		t.Fatalf("index not replaced: %q %v", got, err)
	}
	names, _ := os.ReadDir(filepath.Join(root, "Taxes"))
	for _, n := range names {
		if strings.HasPrefix(n.Name(), "index (") || strings.HasSuffix(n.Name(), ".tmp") {
			t.Errorf("overwrite left %s behind", n.Name())
		}
	}

	// Without the flag the old behaviour must survive: never clobber, always rename.
	rec = httptest.NewRecorder()
	s.uploadHandler(rec, uploadReq(t, "/api/files/upload?path=/Taxes", vaultIndexName, []byte("other")))
	if rec.Code != http.StatusOK {
		t.Fatalf("plain upload: got %d, want 200 (%s)", rec.Code, rec.Body)
	}
	if got, _ := os.ReadFile(filepath.Join(root, "Taxes", vaultIndexName)); string(got) != "new" {
		t.Errorf("plain upload clobbered the index: %q", got)
	}
}
