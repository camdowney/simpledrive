package handler

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"testing/fstest"
	"time"

	"simpledrive/internal/auth"
	"simpledrive/internal/config"
)

// sharedServer builds a root with Public/ and Private/ and one link over Public/ in the given mode.
func sharedServer(t *testing.T, mode string) (*server, *share) {
	t.Helper()
	dir := t.TempDir()
	root := filepath.Join(dir, "root")
	for _, d := range []string{"Public", "Public/Sub", "Private"} {
		if err := os.MkdirAll(filepath.Join(root, d), 0755); err != nil {
			t.Fatal(err)
		}
	}
	for _, f := range []string{"Public/note.txt", "Public/Sub/deep.txt", "Private/secret.txt"} {
		if err := os.WriteFile(filepath.Join(root, f), []byte("x"), 0644); err != nil {
			t.Fatal(err)
		}
	}

	sh := share{ID: "s1", Token: "tok", Path: "Public", Mode: mode}
	data, _ := json.Marshal([]share{sh})
	sharesPath := filepath.Join(dir, "shares.json")
	if err := os.WriteFile(sharesPath, data, 0600); err != nil {
		t.Fatal(err)
	}

	s := &server{
		cfg: &config.Config{RootDir: root, SharesPath: sharesPath, MountsPath: filepath.Join(dir, "mounts.json"),
			TrashIndexPath: filepath.Join(dir, "trash.json"), SessionHours: 1},
		sessions: auth.NewStore(time.Hour),
		thumbs:   newThumbCache(filepath.Join(dir, "thumbs")),
	}
	return s, &sh
}

// asShare runs a request the way requireAccess would for a visitor holding this link.
func asShare(t *testing.T, s *server, sh *share, h http.HandlerFunc, level access,
	method, target string, body any) *httptest.ResponseRecorder {
	t.Helper()
	w, _ := doJSONWithCookie(t, s.requireAccess(h, level), method, target, body, sh.Token)
	return w
}

func doJSONWithCookie(t *testing.T, h http.HandlerFunc, method, target string, body any,
	token string) (*httptest.ResponseRecorder, map[string]any) {
	t.Helper()
	var r *http.Request
	if body != nil {
		b, _ := json.Marshal(body)
		r = httptest.NewRequest(method, target, strings.NewReader(string(b)))
	} else {
		r = httptest.NewRequest(method, target, nil)
	}
	r.AddCookie(&http.Cookie{Name: shareCookie, Value: token})
	w := httptest.NewRecorder()
	h(w, r)
	var out map[string]any
	json.Unmarshal(w.Body.Bytes(), &out)
	return w, out
}

func TestShareConfinesReadsToItsSubtree(t *testing.T) {
	s, sh := sharedServer(t, shareView)

	if w := asShare(t, s, sh, s.filesHandler, accessRead, "GET", "/api/files?path=/Public", nil); w.Code != 200 {
		t.Fatalf("listing the share itself = %d, want 200", w.Code)
	}
	if w := asShare(t, s, sh, s.filesHandler, accessRead, "GET", "/api/files?path=/Public/Sub", nil); w.Code != 200 {
		t.Fatalf("listing inside the share = %d, want 200", w.Code)
	}

	// Everything outside the subtree must look absent, whatever route is used to ask.
	cases := []struct {
		name   string
		h      http.HandlerFunc
		target string
	}{
		{"list root", s.filesHandler, "/api/files?path=/"},
		{"list sibling", s.filesHandler, "/api/files?path=/Private"},
		{"download sibling", s.downloadHandler, "/api/files/download?path=/Private/secret.txt"},
		{"read sibling", s.readHandler, "/api/files/read?path=/Private/secret.txt"},
		{"meta sibling", s.metaHandler, "/api/files/meta?path=/Private/secret.txt"},
		{"thumb sibling", s.thumbHandler, "/api/files/thumb?path=/Private/secret.txt"},
		// A prefix that merely starts with the share's name is a different folder.
		{"prefix lookalike", s.filesHandler, "/api/files?path=/PublicElsewhere"},
		// Traversal is cleaned before the check, so it can't walk out either.
		{"traversal", s.filesHandler, "/api/files?path=/Public/../Private"},
	}
	for _, c := range cases {
		w := asShare(t, s, sh, c.h, accessRead, "GET", c.target, nil)
		if w.Code == http.StatusOK {
			t.Errorf("%s: got 200, want a refusal", c.name)
		}
	}
}

func TestViewShareRefusesEveryWrite(t *testing.T) {
	s, sh := sharedServer(t, shareView)

	writes := []struct {
		name   string
		h      http.HandlerFunc
		level  access
		method string
		target string
		body   any
	}{
		{"write", s.writeHandler, accessWrite, "POST", "/api/files/write?path=/Public/note.txt", map[string]string{"content": "hacked"}},
		{"mkdir", s.mkdirHandler, accessWrite, "POST", "/api/files/mkdir", map[string]string{"path": "/Public/new"}},
		{"delete", s.deleteHandler, accessWrite, "POST", "/api/files/delete", map[string]string{"path": "/Public/note.txt"}},
		{"rename", s.renameHandler, accessWrite, "POST", "/api/files/rename", map[string]string{"dir": "/Public", "from": "note.txt", "to": "other.txt"}},
		{"move", s.moveHandler, accessWrite, "POST", "/api/files/move", map[string]string{"from": "/Public/note.txt", "to": "/Public/Sub/note.txt"}},
		{"copy", s.copyHandler, accessWrite, "POST", "/api/files/copy", map[string]string{"from": "/Public/note.txt", "to": "/Public/Sub/note.txt"}},
		{"upload", s.uploadHandler, accessUpload, "POST", "/api/files/upload?path=/Public", nil},
	}
	for _, c := range writes {
		w := asShare(t, s, sh, c.h, c.level, c.method, c.target, c.body)
		if w.Code != http.StatusForbidden {
			t.Errorf("%s through a view link = %d, want 403", c.name, w.Code)
		}
	}

	// The file the writes aimed at must be exactly as it was.
	data, err := os.ReadFile(filepath.Join(s.cfg.RootDir, "Public/note.txt"))
	if err != nil || string(data) != "x" {
		t.Errorf("note.txt = %q, %v; want untouched", data, err)
	}
}

func TestEditShareWritesInsideButNotOutside(t *testing.T) {
	s, sh := sharedServer(t, shareEdit)

	w := asShare(t, s, sh, s.writeHandler, accessWrite, "POST",
		"/api/files/write?path=/Public/note.txt", map[string]string{"content": "edited"})
	if w.Code != http.StatusOK {
		t.Fatalf("write inside an edit share = %d, want 200", w.Code)
	}
	data, _ := os.ReadFile(filepath.Join(s.cfg.RootDir, "Public/note.txt"))
	if string(data) != "edited" {
		t.Errorf("note.txt = %q, want %q", data, "edited")
	}

	// Edit rights stop at the share boundary; they are not a licence over the whole drive.
	w = asShare(t, s, sh, s.writeHandler, accessWrite, "POST",
		"/api/files/write?path=/Private/secret.txt", map[string]string{"content": "hacked"})
	if w.Code == http.StatusOK {
		t.Fatalf("write outside an edit share = 200, want a refusal")
	}
	data, _ = os.ReadFile(filepath.Join(s.cfg.RootDir, "Private/secret.txt"))
	if string(data) != "x" {
		t.Errorf("secret.txt = %q; want untouched", data)
	}

	// Moving out of the subtree is the same escape wearing a different hat.
	w = asShare(t, s, sh, s.moveHandler, accessWrite, "POST", "/api/files/move",
		map[string]string{"from": "/Public/note.txt", "to": "/Private/note.txt"})
	if w.Code == http.StatusOK {
		t.Errorf("move out of an edit share = 200, want a refusal")
	}
}

func TestShareRequiresAValidToken(t *testing.T) {
	s, _ := sharedServer(t, shareView)
	h := s.requireAccess(s.filesHandler, accessRead)

	// No cookie at all.
	r := httptest.NewRequest("GET", "/api/files?path=/Public", nil)
	w := httptest.NewRecorder()
	h(w, r)
	if w.Code != http.StatusUnauthorized {
		t.Errorf("no cookie = %d, want 401", w.Code)
	}

	// A revoked or made-up token is not a lesser credential; it is none.
	w, _ = doJSONWithCookie(t, h, "GET", "/api/files?path=/Public", nil, "wrong")
	if w.Code != http.StatusUnauthorized {
		t.Errorf("unknown token = %d, want 401", w.Code)
	}
}

func TestShareInfoDescribesTheLink(t *testing.T) {
	s, sh := sharedServer(t, shareEdit)
	_, out := doJSONWithCookie(t, s.requireAccess(s.shareInfoHandler, accessInfo), "GET", "/api/share/info", nil, sh.Token)
	if out["path"] != "/Public" || out["mode"] != shareEdit || out["isDir"] != true {
		t.Errorf("share info = %v", out)
	}
}

func TestShareInfoWorksWhileSignedIn(t *testing.T) {
	s, sh := sharedServer(t, shareView)
	token, err := s.sessions.Create()
	if err != nil {
		t.Fatal(err)
	}

	r := httptest.NewRequest("GET", "/api/share/info", nil)
	r.AddCookie(&http.Cookie{Name: cookieName, Value: token})
	r.AddCookie(&http.Cookie{Name: shareCookie, Value: sh.Token})
	w := httptest.NewRecorder()
	s.requireAccess(s.shareInfoHandler, accessInfo)(w, r)
	if w.Code != http.StatusOK {
		t.Fatalf("owner opening a link = %d, want 200", w.Code)
	}
	var out map[string]any
	json.Unmarshal(w.Body.Bytes(), &out)
	if out["path"] != "/Public" || out["mode"] != shareView {
		t.Errorf("share info = %v", out)
	}
}

func TestSharesAPICreatesListsAndRevokes(t *testing.T) {
	s, _ := sharedServer(t, shareView)

	w, out := doJSON(t, s.sharesHandler, "POST", "/api/shares",
		map[string]string{"path": "/Private", "mode": shareEdit, "label": " Dana  "})
	if w.Code != http.StatusCreated {
		t.Fatalf("create = %d: %v", w.Code, out)
	}
	token, _ := out["token"].(string)
	if token == "" {
		t.Fatal("created share has no token")
	}
	if out["label"] != "Dana" {
		t.Errorf("label = %v, want %q", out["label"], "Dana")
	}

	// A label per recipient is only useful if the same path and mode can be handed out twice.
	_, again := doJSON(t, s.sharesHandler, "POST", "/api/shares",
		map[string]string{"path": "/Private", "mode": shareEdit, "label": "Kim"})
	if again["token"] == token || again["token"] == "" {
		t.Errorf("second create reused the first token: %v", again["token"])
	}

	_, list := doJSON(t, s.sharesHandler, "GET", "/api/shares", nil)
	if n := len(list["shares"].([]any)); n != 3 {
		t.Errorf("shares listed = %d, want 3", n)
	}

	if w, _ := doJSON(t, s.sharesHandler, "POST", "/api/shares", map[string]string{"path": "/nope", "mode": shareView}); w.Code != http.StatusNotFound {
		t.Errorf("sharing a missing path = %d, want 404", w.Code)
	}
	if w, _ := doJSON(t, s.sharesHandler, "POST", "/api/shares", map[string]string{"path": "/Private", "mode": "admin"}); w.Code != http.StatusBadRequest {
		t.Errorf("bogus mode = %d, want 400", w.Code)
	}
	// The whole drive is not shareable: a link is meant to be narrower than the account.
	if w, _ := doJSON(t, s.sharesHandler, "POST", "/api/shares", map[string]string{"path": "/", "mode": shareView}); w.Code != http.StatusBadRequest {
		t.Errorf("sharing the root = %d, want 400", w.Code)
	}

	id, _ := out["id"].(string)
	_, relabelled := doJSON(t, s.sharesHandler, "PATCH", "/api/shares",
		map[string]string{"id": id, "label": "Dana\n(work)" + strings.Repeat("!", maxLabelRunes)})
	want := cleanLabel("Dana (work)" + strings.Repeat("!", maxLabelRunes))
	if relabelled["label"] != want {
		t.Errorf("relabelled = %v, want %q", relabelled["label"], want)
	}
	_, list = doJSON(t, s.sharesHandler, "GET", "/api/shares", nil)
	for _, entry := range list["shares"].([]any) {
		if m := entry.(map[string]any); m["id"] == id && m["label"] != want {
			t.Errorf("label did not persist: %v", m["label"])
		}
	}
	if w, _ := doJSON(t, s.sharesHandler, "PATCH", "/api/shares",
		map[string]string{"id": "nope", "label": "x"}); w.Code != http.StatusNotFound {
		t.Errorf("relabelling a missing link = %d, want 404", w.Code)
	}

	if w, _ := doJSON(t, s.sharesHandler, "DELETE", "/api/shares?id="+id, nil); w.Code != http.StatusOK {
		t.Fatalf("revoke = %d", w.Code)
	}
	// Revoking must actually close the door, not just hide the link.
	if sh, _ := s.lookupShare(token); sh != nil {
		t.Error("revoked token still resolves")
	}
}

func TestShareEntrySetsCookieAndRejectsBadToken(t *testing.T) {
	s, sh := sharedServer(t, shareView)
	s.webFS = fstest.MapFS{"web/index.html": &fstest.MapFile{Data: []byte("<!doctype html>")}}

	r := httptest.NewRequest("GET", "/s/"+sh.Token, nil)
	w := httptest.NewRecorder()
	s.shareEntryHandler(w, r)
	if w.Code != http.StatusOK {
		t.Fatalf("share entry = %d", w.Code)
	}
	var got string
	for _, c := range w.Result().Cookies() {
		if c.Name == shareCookie {
			got = c.Value
			if !c.HttpOnly {
				t.Error("share cookie is readable from JS")
			}
		}
	}
	if got != sh.Token {
		t.Errorf("cookie = %q, want the token", got)
	}

	r = httptest.NewRequest("GET", "/s/made-up", nil)
	w = httptest.NewRecorder()
	s.shareEntryHandler(w, r)
	if w.Code != http.StatusNotFound {
		t.Errorf("unknown link = %d, want 404", w.Code)
	}
	if len(w.Result().Cookies()) != 0 {
		t.Error("unknown link still set a cookie")
	}
}

func TestOwnerSessionIgnoresShareScope(t *testing.T) {
	s, _ := sharedServer(t, shareView)
	token, err := s.sessions.Create()
	if err != nil {
		t.Fatal(err)
	}

	r := httptest.NewRequest("GET", "/api/files?path=/Private", nil)
	r.AddCookie(&http.Cookie{Name: cookieName, Value: token})
	r.AddCookie(&http.Cookie{Name: shareCookie, Value: "tok"})
	w := httptest.NewRecorder()
	s.requireAccess(s.filesHandler, accessRead)(w, r)
	if w.Code != http.StatusOK {
		t.Errorf("owner holding a share cookie = %d, want 200", w.Code)
	}
	if shareOf(r) != nil {
		t.Error("owner request carried a share scope")
	}
}

func TestCoversMatchesOnlyTheSubtree(t *testing.T) {
	sh := &share{Path: "Photos/Trip"}
	in := []string{"Photos/Trip", "Photos/Trip/a.jpg", "Photos/Trip/Sub/b.jpg"}
	out := []string{"", "Photos", "Photos/Trips", "Photos/TripOther/a.jpg", "Other"}
	for _, p := range in {
		if !sh.covers(p) {
			t.Errorf("covers(%q) = false, want true", p)
		}
	}
	for _, p := range out {
		if sh.covers(p) {
			t.Errorf("covers(%q) = true, want false", p)
		}
	}
}

// sharedOn replaces the stock link with one over p, for the tests about links following it.
func sharedOn(t *testing.T, p string) (*server, *share) {
	t.Helper()
	s, _ := sharedServer(t, shareView)
	sh := share{ID: "s1", Token: "tok", Path: p, Mode: shareView}
	data, _ := json.Marshal([]share{sh})
	if err := os.WriteFile(s.cfg.SharesPath, data, 0600); err != nil {
		t.Fatal(err)
	}
	return s, &sh
}

// storedPath reports where the one stored link points, or "" once it is gone.
func storedPath(t *testing.T, s *server) string {
	t.Helper()
	shares, err := s.readShares()
	if err != nil {
		t.Fatal(err)
	}
	if len(shares) == 0 {
		return ""
	}
	return shares[0].Path
}

func TestRenameCarriesItsShareAlong(t *testing.T) {
	s, sh := sharedOn(t, "Public/note.txt")

	w, _ := doJSON(t, s.renameHandler, "POST", "/api/files/rename",
		map[string]string{"dir": "/Public", "from": "note.txt", "to": "renamed.txt"})
	if w.Code != http.StatusOK {
		t.Fatalf("rename = %d, want 200", w.Code)
	}
	if got := storedPath(t, s); got != "Public/renamed.txt" {
		t.Errorf("share path after rename = %q, want Public/renamed.txt", got)
	}
	w = asShare(t, s, sh, s.downloadHandler, accessRead, "GET",
		"/api/files/download?path=/Public/renamed.txt", nil)
	if w.Code != http.StatusOK {
		t.Errorf("downloading through the link after rename = %d, want 200", w.Code)
	}
}

// A link deep inside a renamed folder has to move with it, not just one named for the folder.
func TestRenamingAFolderCarriesTheLinksInsideIt(t *testing.T) {
	s, sh := sharedOn(t, "Public/Sub/deep.txt")

	w, _ := doJSON(t, s.renameHandler, "POST", "/api/files/rename",
		map[string]string{"dir": "/Public", "from": "Sub", "to": "Moved"})
	if w.Code != http.StatusOK {
		t.Fatalf("rename = %d, want 200", w.Code)
	}
	if got := storedPath(t, s); got != "Public/Moved/deep.txt" {
		t.Errorf("share path after folder rename = %q, want Public/Moved/deep.txt", got)
	}
	w = asShare(t, s, sh, s.downloadHandler, accessRead, "GET",
		"/api/files/download?path=/Public/Moved/deep.txt", nil)
	if w.Code != http.StatusOK {
		t.Errorf("downloading through the link after folder rename = %d, want 200", w.Code)
	}
}

func TestMoveCarriesItsShareAlong(t *testing.T) {
	s, _ := sharedOn(t, "Public/note.txt")

	w, _ := doJSON(t, s.moveHandler, "POST", "/api/files/move",
		map[string]string{"from": "/Public/note.txt", "to": "/Private/note.txt"})
	if w.Code != http.StatusOK {
		t.Fatalf("move = %d, want 200", w.Code)
	}
	if got := storedPath(t, s); got != "Private/note.txt" {
		t.Errorf("share path after move = %q, want Private/note.txt", got)
	}
}

func TestDeleteRevokesItsShare(t *testing.T) {
	s, sh := sharedOn(t, "Public/note.txt")

	w, _ := doJSON(t, s.deleteHandler, "POST", "/api/files/delete",
		map[string]string{"Path": "/Public/note.txt"})
	if w.Code != http.StatusOK {
		t.Fatalf("delete = %d, want 200", w.Code)
	}
	if got := storedPath(t, s); got != "" {
		t.Errorf("share still points at %q after its target was trashed", got)
	}
	w = asShare(t, s, sh, s.downloadHandler, accessRead, "GET",
		"/api/files/download?path=/Public/note.txt", nil)
	if w.Code != http.StatusUnauthorized {
		t.Errorf("revoked token = %d, want 401", w.Code)
	}
}

// The link names a path, so whatever later takes that path must not inherit everyone holding it.
func TestANewFileAtASharedPathInheritsNothing(t *testing.T) {
	s, sh := sharedOn(t, "Public/note.txt")

	w, _ := doJSON(t, s.renameHandler, "POST", "/api/files/rename",
		map[string]string{"dir": "/Public", "from": "note.txt", "to": "renamed.txt"})
	if w.Code != http.StatusOK {
		t.Fatalf("rename = %d, want 200", w.Code)
	}
	secret := filepath.Join(s.cfg.RootDir, "Public", "note.txt")
	if err := os.WriteFile(secret, []byte("a different file entirely"), 0644); err != nil {
		t.Fatal(err)
	}

	w = asShare(t, s, sh, s.downloadHandler, accessRead, "GET",
		"/api/files/download?path=/Public/note.txt", nil)
	if w.Code == http.StatusOK {
		t.Errorf("the old link read the new file at that path: %q", w.Body.String())
	}
}

// statAny is what decides whether a link opens a listing or a file, so both must be right.
func TestStatAnyDistinguishesFilesFromFolders(t *testing.T) {
	s, _ := sharedServer(t, shareView)
	r := httptest.NewRequest("GET", "/", nil)

	res, err := s.resolve(r, "Public")
	if err != nil {
		t.Fatal(err)
	}
	if st, err := s.statAny(context.Background(), res); err != nil || !st.IsDir {
		t.Errorf("Public: isDir=%v err=%v", st.IsDir, err)
	}
	res, _ = s.resolve(r, "Public/note.txt")
	// The size and date are what a file link shows in place of a listing row.
	if st, err := s.statAny(context.Background(), res); err != nil || st.IsDir {
		t.Errorf("note.txt: isDir=%v err=%v", st.IsDir, err)
	} else if st.Size != 1 || st.Modified.IsZero() {
		t.Errorf("note.txt: size=%d modified=%v, want size 1 and a real date", st.Size, st.Modified)
	}
	res, _ = s.resolve(r, "Public/missing")
	if _, err := s.statAny(context.Background(), res); err == nil {
		t.Error("missing path reported as present")
	}
}
