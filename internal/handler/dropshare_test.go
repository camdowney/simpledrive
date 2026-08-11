package handler

import (
	"bytes"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// A drop link takes files and answers nothing: every way of looking inside has to be refused.
func TestDropShareShowsNothing(t *testing.T) {
	s, sh := sharedServer(t, shareDrop)

	reads := []struct {
		name   string
		h      http.HandlerFunc
		target string
	}{
		{"list the folder it drops into", s.filesHandler, "/api/files?path=/Public"},
		{"list a subfolder", s.filesHandler, "/api/files?path=/Public/Sub"},
		{"download a file inside", s.downloadHandler, "/api/files/download?path=/Public/note.txt"},
		{"read a file inside", s.readHandler, "/api/files/read?path=/Public/note.txt"},
		{"search inside", s.searchHandler, "/api/files/search?path=/Public&q=note"},
		{"thumbnail a file inside", s.thumbHandler, "/api/files/thumb?path=/Public/note.txt"},
		{"zip the folder", s.zipHandler, "/api/files/zip"},
		{"measure the folder", s.dirSizeHandler, "/api/files/size?path=/Public"},
	}
	for _, c := range reads {
		w := asShare(t, s, sh, c.h, accessRead, "GET", c.target, nil)
		if w.Code != http.StatusForbidden {
			t.Errorf("%s = %d, want 403", c.name, w.Code)
		}
	}
}

func TestDropShareRefusesEveryChange(t *testing.T) {
	s, sh := sharedServer(t, shareDrop)

	writes := []struct {
		name   string
		h      http.HandlerFunc
		target string
		body   any
	}{
		{"write", s.writeHandler, "/api/files/write?path=/Public/note.txt", map[string]string{"content": "hacked"}},
		{"delete", s.deleteHandler, "/api/files/delete", map[string]string{"path": "/Public/note.txt"}},
		{"rename", s.renameHandler, "/api/files/rename", map[string]string{"dir": "/Public", "from": "note.txt", "to": "gone.txt"}},
		{"move", s.moveHandler, "/api/files/move", map[string]string{"from": "/Public/note.txt", "to": "/Public/Sub/note.txt"}},
		{"copy", s.copyHandler, "/api/files/copy", map[string]string{"from": "/Public/note.txt", "to": "/Public/two.txt"}},
		{"mkdir", s.mkdirHandler, "/api/files/mkdir", map[string]string{"path": "/Public/new"}},
	}
	for _, c := range writes {
		w := asShare(t, s, sh, c.h, accessWrite, "POST", c.target, c.body)
		if w.Code != http.StatusForbidden {
			t.Errorf("%s through a drop link = %d, want 403", c.name, w.Code)
		}
	}

	data, err := os.ReadFile(filepath.Join(s.cfg.RootDir, "Public/note.txt"))
	if err != nil || string(data) != "x" {
		t.Errorf("note.txt = %q, %v; want untouched", data, err)
	}
}

func TestDropShareAcceptsUploads(t *testing.T) {
	s, sh := sharedServer(t, shareDrop)

	r := uploadReq(t, "/api/files/upload?path=/Public", "handed-over.txt", []byte("from a visitor"))
	r.AddCookie(&http.Cookie{Name: shareCookie, Value: sh.Token})
	w := httptest.NewRecorder()
	s.requireAccess(s.uploadHandler, accessUpload)(w, r)
	if w.Code != http.StatusOK {
		t.Fatalf("upload status %d: %s", w.Code, w.Body)
	}

	body, err := os.ReadFile(filepath.Join(s.cfg.RootDir, "Public/handed-over.txt"))
	if err != nil || string(body) != "from a visitor" {
		t.Fatalf("file not stored: %q %v", body, err)
	}
}

// The suffixed name of a clashing upload would say which names are already in the folder.
func TestDropShareUploadNamesNothing(t *testing.T) {
	s, sh := sharedServer(t, shareDrop)

	r := uploadReq(t, "/api/files/upload?path=/Public", "note.txt", []byte("clashes with what is there"))
	r.AddCookie(&http.Cookie{Name: shareCookie, Value: sh.Token})
	w := httptest.NewRecorder()
	s.requireAccess(s.uploadHandler, accessUpload)(w, r)
	if w.Code != http.StatusOK {
		t.Fatalf("upload status %d: %s", w.Code, w.Body)
	}
	if strings.Contains(w.Body.String(), "note.txt") {
		t.Fatalf("the response named a file in the folder: %s", w.Body)
	}

	// It still lands, under a free name, without disturbing the file already there.
	if _, err := os.Stat(filepath.Join(s.cfg.RootDir, "Public/note (1).txt")); err != nil {
		t.Fatalf("upload not saved under a free name: %v", err)
	}
	if body, _ := os.ReadFile(filepath.Join(s.cfg.RootDir, "Public/note.txt")); string(body) != "x" {
		t.Fatalf("the file already there was overwritten: %q", body)
	}
}

func TestDropShareChunkedUploadNamesNothing(t *testing.T) {
	s, sh := sharedServer(t, shareDrop)

	target := fmt.Sprintf("/api/files/upload/chunk?path=/Public&id=%s&name=note.txt&offset=0&last=1", testUploadID)
	r := httptest.NewRequest("POST", target, bytes.NewReader([]byte("big one")))
	r.AddCookie(&http.Cookie{Name: shareCookie, Value: sh.Token})
	w := httptest.NewRecorder()
	s.requireAccess(s.uploadChunkHandler, accessUpload)(w, r)
	if w.Code != http.StatusOK {
		t.Fatalf("chunk status %d: %s", w.Code, w.Body)
	}
	var out map[string]any
	json.Unmarshal(w.Body.Bytes(), &out)
	if _, named := out["saved"]; named {
		t.Fatalf("the response named a file in the folder: %s", w.Body)
	}
	if _, err := os.Stat(filepath.Join(s.cfg.RootDir, "Public/note (1).txt")); err != nil {
		t.Fatalf("chunked upload not saved: %v", err)
	}
}

// Confinement still applies: a drop link may add files, but only where it points.
func TestDropShareCannotUploadElsewhere(t *testing.T) {
	s, sh := sharedServer(t, shareDrop)

	r := uploadReq(t, "/api/files/upload?path=/Private", "sneaky.txt", []byte("nope"))
	r.AddCookie(&http.Cookie{Name: shareCookie, Value: sh.Token})
	w := httptest.NewRecorder()
	s.requireAccess(s.uploadHandler, accessUpload)(w, r)
	if w.Code == http.StatusOK {
		t.Fatalf("upload outside the link's folder was accepted: %s", w.Body)
	}
	if _, err := os.Stat(filepath.Join(s.cfg.RootDir, "Private/sneaky.txt")); !os.IsNotExist(err) {
		t.Fatal("a file landed outside the link's folder")
	}
}

// A vault inside the folder is the one place an upload may overwrite; a drop link still may not.
func TestDropShareCannotOverwriteInVault(t *testing.T) {
	s, sh := sharedServer(t, shareDrop)
	makeVault(t, s.cfg.RootDir, "Public/Vault")

	r := uploadReq(t, "/api/files/upload?path=/Public/Vault&overwrite=1", vaultKeyName, []byte("clobbered"))
	r.AddCookie(&http.Cookie{Name: shareCookie, Value: sh.Token})
	w := httptest.NewRecorder()
	s.requireAccess(s.uploadHandler, accessUpload)(w, r)
	if w.Code != http.StatusForbidden {
		t.Fatalf("overwrite through a drop link = %d, want 403: %s", w.Code, w.Body)
	}

	key := filepath.Join(s.cfg.RootDir, "Public/Vault", vaultKeyName)
	if body, _ := os.ReadFile(key); string(body) != "age-ciphertext" {
		t.Fatalf("the vault key was overwritten: %q", body)
	}
}

// A visitor has to be told what the link is, or the page can't decide what to show them.
func TestDropShareReportsItsOwnMode(t *testing.T) {
	s, sh := sharedServer(t, shareDrop)

	w, out := doJSONWithCookie(t, s.requireAccess(s.shareInfoHandler, accessInfo),
		"GET", "/api/share/info", nil, sh.Token)
	if w.Code != http.StatusOK {
		t.Fatalf("share info status %d: %s", w.Code, w.Body)
	}
	if out["mode"] != shareDrop {
		t.Fatalf("mode = %v, want %q", out["mode"], shareDrop)
	}
}

func TestCreateDropShareNeedsAFolder(t *testing.T) {
	s, _ := sharedServer(t, shareEdit)

	w, _ := doJSON(t, s.sharesHandler, "POST", "/api/shares",
		map[string]any{"path": "/Public/note.txt", "mode": shareDrop})
	if w.Code != http.StatusBadRequest {
		t.Fatalf("drop link over a file = %d, want 400: %s", w.Code, w.Body)
	}

	w, out := doJSON(t, s.sharesHandler, "POST", "/api/shares",
		map[string]any{"path": "/Public", "mode": shareDrop})
	if w.Code != http.StatusCreated {
		t.Fatalf("drop link over a folder = %d, want 201: %s", w.Code, w.Body)
	}
	if out["mode"] != shareDrop {
		t.Fatalf("mode = %v, want %q", out["mode"], shareDrop)
	}
}
