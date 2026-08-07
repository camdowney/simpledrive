package handler

import (
	"bytes"
	"encoding/json"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"simpledrive/internal/config"
	"simpledrive/internal/s3"
)

// mountedServer wires a server whose only mount is backed by fake, under the given prefix.
func mountedServer(t *testing.T, fake *fakeS3, prefix string) *server {
	t.Helper()
	dir := t.TempDir()
	root := filepath.Join(dir, "root")
	if err := os.Mkdir(root, 0755); err != nil {
		t.Fatal(err)
	}

	m := mount{
		ID: "m1", Name: "Bucket", Bucket: fake.bucket, Region: "us-east-1",
		Prefix: normalizePrefix(prefix), Endpoint: fake.srv.URL,
		AccessKeyID: "AKIATEST", SecretAccessKey: "secret",
	}
	data, _ := json.Marshal([]mount{m})
	mountsPath := filepath.Join(dir, "mounts.json")
	if err := os.WriteFile(mountsPath, data, 0600); err != nil {
		t.Fatal(err)
	}

	cli, err := s3.New(s3.Config{
		Bucket: m.Bucket, Region: m.Region, Endpoint: m.Endpoint,
		AccessKeyID: m.AccessKeyID, SecretAccessKey: m.SecretAccessKey,
		Transport: fake.srv.Client().Transport,
	})
	if err != nil {
		t.Fatal(err)
	}

	return &server{
		cfg:       &config.Config{RootDir: root, MountsPath: mountsPath},
		thumbs:    newThumbCache(filepath.Join(dir, "thumbs")),
		s3Clients: map[string]*s3.Client{"m1": cli},
	}
}

func doJSON(t *testing.T, h http.HandlerFunc, method, target string, body any) (*httptest.ResponseRecorder, map[string]any) {
	t.Helper()
	var r *http.Request
	if body != nil {
		b, _ := json.Marshal(body)
		r = httptest.NewRequest(method, target, bytes.NewReader(b))
	} else {
		r = httptest.NewRequest(method, target, nil)
	}
	w := httptest.NewRecorder()
	h(w, r)
	var out map[string]any
	json.Unmarshal(w.Body.Bytes(), &out)
	return w, out
}

func entryNames(out map[string]any) []string {
	names := []string{}
	list, _ := out["entries"].([]any)
	for _, e := range list {
		names = append(names, e.(map[string]any)["name"].(string))
	}
	return names
}

// B2 and R2 encode the region in the endpoint, so making it retypeable invites a mismatch.
func TestRegionDerivedFromEndpoint(t *testing.T) {
	cases := []struct{ endpoint, want string }{
		{"https://s3.us-east-005.backblazeb2.com", "us-east-005"},
		{"https://s3.us-west-004.backblazeb2.com", "us-west-004"},
		{"https://s3.us-east-005.backblazeb2.com/", "us-east-005"},
		{"https://abc123.r2.cloudflarestorage.com", "auto"},
		{"https://minio.example.com", ""},
		{"https://s3.amazonaws.com", ""},
		{"", ""},
	}
	for _, tc := range cases {
		if got := deriveRegion(tc.endpoint); got != tc.want {
			t.Errorf("deriveRegion(%q) = %q, want %q", tc.endpoint, got, tc.want)
		}
	}
}

func TestValidateMountFillsRegionAndStillRequiresIt(t *testing.T) {
	m := mount{Name: "B2", Bucket: "washington-pics", Endpoint: "https://s3.us-east-005.backblazeb2.com",
		AccessKeyID: "k", SecretAccessKey: "s"}
	if msg := validateMount(&m, nil); msg != "" {
		t.Fatalf("blank region with a B2 endpoint rejected: %s", msg)
	}
	if m.Region != "us-east-005" {
		t.Errorf("region = %q, want us-east-005", m.Region)
	}

	// An endpoint we can't read a region out of must still demand one.
	other := mount{Name: "M", Bucket: "b", Endpoint: "https://minio.example.com",
		AccessKeyID: "k", SecretAccessKey: "s"}
	if msg := validateMount(&other, nil); !strings.Contains(msg, "can't be read from that endpoint") {
		t.Errorf("unknown endpoint with blank region = %q", msg)
	}

	// The commonest mistake is omitting the endpoint entirely; say so rather than just "required".
	none := mount{Name: "A", Bucket: "b", AccessKeyID: "k", SecretAccessKey: "s"}
	if msg := validateMount(&none, nil); !strings.Contains(msg, "give an endpoint") {
		t.Errorf("no endpoint and no region = %q", msg)
	}
}

func TestValidateMountAcceptsBareEndpointHost(t *testing.T) {
	m := mount{Name: "B2", Bucket: "washington-pics", Endpoint: "s3.us-east-005.backblazeb2.com",
		AccessKeyID: "k", SecretAccessKey: "s"}
	if msg := validateMount(&m, nil); msg != "" {
		t.Fatalf("scheme-less endpoint rejected: %s", msg)
	}
	if m.Endpoint != "https://s3.us-east-005.backblazeb2.com" {
		t.Errorf("endpoint = %q", m.Endpoint)
	}
	if m.Region != "us-east-005" {
		t.Errorf("region = %q, want us-east-005", m.Region)
	}
}

func TestMountAppearsInRootListing(t *testing.T) {
	fake := newFakeS3("my-bucket")
	defer fake.close()
	s := mountedServer(t, fake, "")

	if err := os.Mkdir(filepath.Join(s.cfg.RootDir, "Local"), 0755); err != nil {
		t.Fatal(err)
	}
	_, out := doJSON(t, s.filesHandler, "GET", "/api/files?path=/", nil)

	got := entryNames(out)
	if len(got) != 2 || got[0] != "Bucket" || got[1] != "Local" {
		t.Fatalf("root listing = %v, want [Bucket Local]", got)
	}
	for _, e := range out["entries"].([]any) {
		m := e.(map[string]any)
		if m["name"] == "Bucket" && m["isMount"] != true {
			t.Errorf("mount entry not flagged isMount: %v", m)
		}
	}
}

func TestListMountUsesDelimiter(t *testing.T) {
	fake := newFakeS3("my-bucket")
	defer fake.close()
	fake.put("photos/a.jpg", "aaa")
	fake.put("photos/sub/b.jpg", "bbb")
	fake.put("photos/c.txt", "cc")
	s := mountedServer(t, fake, "photos/")

	_, out := doJSON(t, s.filesHandler, "GET", "/api/files?path=/Bucket", nil)
	if got := entryNames(out); strings.Join(got, ",") != "sub,a.jpg,c.txt" {
		t.Fatalf("listing = %v, want [sub a.jpg c.txt]", got)
	}
	if out["path"] != "/Bucket" {
		t.Errorf("path = %v, want /Bucket", out["path"])
	}

	_, out = doJSON(t, s.filesHandler, "GET", "/api/files?path=/Bucket/sub", nil)
	if got := entryNames(out); strings.Join(got, ",") != "b.jpg" {
		t.Fatalf("subfolder listing = %v, want [b.jpg]", got)
	}
}

// The prefix must never leak into names the client sees, or paths round-trip wrong.
func TestPrefixIsHiddenFromClient(t *testing.T) {
	fake := newFakeS3("my-bucket")
	defer fake.close()
	fake.put("team/docs/notes.txt", "hi")
	s := mountedServer(t, fake, "team")

	_, out := doJSON(t, s.filesHandler, "GET", "/api/files?path=/Bucket/docs", nil)
	if got := entryNames(out); strings.Join(got, ",") != "notes.txt" {
		t.Fatalf("listing = %v, want [notes.txt]", got)
	}
}

// Keys with XML- and URL-hostile characters must survive listing, download and delete intact.
func TestAwkwardKeyNames(t *testing.T) {
	fake := newFakeS3("my-bucket")
	defer fake.close()
	names := []string{"a & b.txt", "üñî çafé.txt", "100% done.txt", "quote\"d.txt", "plus+plus.txt"}
	for _, n := range names {
		fake.put(n, "body of "+n)
	}
	fake.put("weird dir & co/inner.txt", "inner")
	s := mountedServer(t, fake, "")

	_, out := doJSON(t, s.filesHandler, "GET", "/api/files?path=/Bucket", nil)
	got := map[string]bool{}
	for _, n := range entryNames(out) {
		got[n] = true
	}
	for _, n := range append(names, "weird dir & co") {
		if !got[n] {
			t.Errorf("listing lost %q; got %v", n, entryNames(out))
		}
	}

	for _, n := range names {
		w := httptest.NewRecorder()
		target := "/api/files/download?path=" + url.QueryEscape("/Bucket/"+n)
		s.downloadHandler(w, httptest.NewRequest("GET", target, nil))
		if w.Code != 200 || w.Body.String() != "body of "+n {
			t.Errorf("download %q = %d %q", n, w.Code, w.Body.String())
		}
	}

	w, _ := doJSON(t, s.deleteHandler, "POST", "/api/files/delete", map[string]string{"path": "/Bucket/a & b.txt"})
	if w.Code != 200 {
		t.Fatalf("delete status %d: %s", w.Code, w.Body)
	}
	if _, ok := fake.get("a & b.txt"); ok {
		t.Errorf("object survived delete; keys = %v", fake.keys())
	}
}

func TestListingAFileReportsNotDir(t *testing.T) {
	fake := newFakeS3("my-bucket")
	defer fake.close()
	fake.put("a.txt", "hello")
	s := mountedServer(t, fake, "")

	_, out := doJSON(t, s.filesHandler, "GET", "/api/files?path=/Bucket/a.txt", nil)
	if out["notDir"] != true {
		t.Fatalf("listing a file = %v, want notDir", out)
	}

	w, _ := doJSON(t, s.filesHandler, "GET", "/api/files?path=/Bucket/missing", nil)
	if w.Code != http.StatusNotFound {
		t.Fatalf("missing path status = %d, want 404", w.Code)
	}
}

func TestDownloadFromMount(t *testing.T) {
	fake := newFakeS3("my-bucket")
	defer fake.close()
	fake.put("hello.txt", "hello world")
	s := mountedServer(t, fake, "")

	w := httptest.NewRecorder()
	s.downloadHandler(w, httptest.NewRequest("GET", "/api/files/download?path=/Bucket/hello.txt", nil))
	if w.Code != 200 || w.Body.String() != "hello world" {
		t.Fatalf("download = %d %q", w.Code, w.Body.String())
	}
	if cd := w.Header().Get("Content-Disposition"); !strings.Contains(cd, "hello.txt") {
		t.Errorf("Content-Disposition = %q", cd)
	}

	// Ranged requests must pass through so media can seek.
	r := httptest.NewRequest("GET", "/api/files/download?path=/Bucket/hello.txt", nil)
	r.Header.Set("Range", "bytes=0-4")
	w = httptest.NewRecorder()
	s.downloadHandler(w, r)
	if w.Code != http.StatusPartialContent || w.Body.String() != "hello" {
		t.Fatalf("ranged download = %d %q", w.Code, w.Body.String())
	}
}

func TestUploadToMount(t *testing.T) {
	fake := newFakeS3("my-bucket")
	defer fake.close()
	fake.put("data/dup.txt", "original")
	s := mountedServer(t, fake, "data/")

	var buf bytes.Buffer
	mw := multipart.NewWriter(&buf)
	for _, name := range []string{"new.txt", "dup.txt"} {
		fw, _ := mw.CreateFormFile("files", name)
		fw.Write([]byte("body of " + name))
	}
	mw.Close()

	r := httptest.NewRequest("POST", "/api/files/upload?path=/Bucket", &buf)
	r.Header.Set("Content-Type", mw.FormDataContentType())
	w := httptest.NewRecorder()
	s.uploadHandler(w, r)
	if w.Code != 200 {
		t.Fatalf("upload status %d: %s", w.Code, w.Body)
	}

	if got, _ := fake.get("data/new.txt"); got != "body of new.txt" {
		t.Errorf("new.txt = %q", got)
	}
	if got, _ := fake.get("data/dup.txt"); got != "original" {
		t.Errorf("existing object was overwritten: %q", got)
	}
	if got, ok := fake.get("data/dup (1).txt"); !ok || got != "body of dup.txt" {
		t.Errorf("collision not renamed; keys = %v", fake.keys())
	}
}

func TestReadWriteMountText(t *testing.T) {
	fake := newFakeS3("my-bucket")
	defer fake.close()
	fake.put("notes.md", "# hi")
	s := mountedServer(t, fake, "")

	_, out := doJSON(t, s.readHandler, "GET", "/api/files/read?path=/Bucket/notes.md", nil)
	if out["content"] != "# hi" {
		t.Fatalf("read = %v", out)
	}

	w, _ := doJSON(t, s.writeHandler, "POST", "/api/files/write?path=/Bucket/notes.md",
		map[string]string{"content": "# edited"})
	if w.Code != 200 {
		t.Fatalf("write status %d: %s", w.Code, w.Body)
	}
	if got, _ := fake.get("notes.md"); got != "# edited" {
		t.Fatalf("stored = %q", got)
	}
}

func TestMkdirWritesMarkerObject(t *testing.T) {
	fake := newFakeS3("my-bucket")
	defer fake.close()
	s := mountedServer(t, fake, "")

	w, _ := doJSON(t, s.mkdirHandler, "POST", "/api/files/mkdir", map[string]string{"path": "/Bucket/newdir"})
	if w.Code != 200 {
		t.Fatalf("mkdir status %d: %s", w.Code, w.Body)
	}
	if _, ok := fake.get("newdir/"); !ok {
		t.Fatalf("no marker object; keys = %v", fake.keys())
	}

	// The new folder must show up as a folder, not vanish behind its own marker.
	_, out := doJSON(t, s.filesHandler, "GET", "/api/files?path=/Bucket", nil)
	if got := entryNames(out); strings.Join(got, ",") != "newdir" {
		t.Fatalf("listing after mkdir = %v", got)
	}

	w, _ = doJSON(t, s.mkdirHandler, "POST", "/api/files/mkdir", map[string]string{"path": "/Bucket/newdir"})
	if w.Code != http.StatusConflict {
		t.Fatalf("duplicate mkdir status = %d, want 409", w.Code)
	}
}

func TestRenameInMount(t *testing.T) {
	fake := newFakeS3("my-bucket")
	defer fake.close()
	fake.put("a.txt", "content")
	fake.put("dir/one.txt", "1")
	fake.put("dir/two.txt", "2")
	s := mountedServer(t, fake, "")

	w, _ := doJSON(t, s.renameHandler, "POST", "/api/files/rename",
		map[string]string{"dir": "/Bucket", "from": "a.txt", "to": "b.txt"})
	if w.Code != 200 {
		t.Fatalf("rename status %d: %s", w.Code, w.Body)
	}
	if got, _ := fake.get("b.txt"); got != "content" {
		t.Errorf("renamed object = %q", got)
	}
	if _, ok := fake.get("a.txt"); ok {
		t.Errorf("source key survived rename")
	}

	w, _ = doJSON(t, s.renameHandler, "POST", "/api/files/rename",
		map[string]string{"dir": "/Bucket", "from": "dir", "to": "moved"})
	if w.Code != 200 {
		t.Fatalf("folder rename status %d: %s", w.Code, w.Body)
	}
	if got := fake.keys(); strings.Join(got, ",") != "b.txt,moved/one.txt,moved/two.txt" {
		t.Fatalf("keys after folder rename = %v", got)
	}
}

// A date edit has nowhere to go on S3; it must be refused rather than silently dropped.
func TestRenameRejectsModifiedInMount(t *testing.T) {
	fake := newFakeS3("my-bucket")
	defer fake.close()
	fake.put("a.txt", "x")
	s := mountedServer(t, fake, "")

	w, _ := doJSON(t, s.renameHandler, "POST", "/api/files/rename", map[string]string{
		"dir": "/Bucket", "from": "a.txt", "to": "a.txt", "modified": "2024-01-01T00:00:00Z",
	})
	if w.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400", w.Code)
	}
}

func TestRenameMountRenamesTheMount(t *testing.T) {
	fake := newFakeS3("my-bucket")
	defer fake.close()
	s := mountedServer(t, fake, "")

	w, _ := doJSON(t, s.renameHandler, "POST", "/api/files/rename",
		map[string]string{"dir": "/", "from": "Bucket", "to": "Archive"})
	if w.Code != 200 {
		t.Fatalf("status %d: %s", w.Code, w.Body)
	}
	mounts, err := s.readMounts()
	if err != nil || len(mounts) != 1 || mounts[0].Name != "Archive" {
		t.Fatalf("mounts = %+v (err %v)", mounts, err)
	}
	if mounts[0].SecretAccessKey != "secret" {
		t.Errorf("rename dropped credentials")
	}
}

func TestDeleteInMount(t *testing.T) {
	fake := newFakeS3("my-bucket")
	defer fake.close()
	fake.put("keep.txt", "k")
	fake.put("dir/one.txt", "1")
	fake.put("dir/two.txt", "2")
	s := mountedServer(t, fake, "")

	w, _ := doJSON(t, s.deleteHandler, "POST", "/api/files/delete", map[string]string{"path": "/Bucket/dir"})
	if w.Code != 200 {
		t.Fatalf("status %d: %s", w.Code, w.Body)
	}
	if got := fake.keys(); strings.Join(got, ",") != "keep.txt" {
		t.Fatalf("keys after folder delete = %v", got)
	}
}

// Deleting the mount's folder disconnects it; erasing the bucket would be unrecoverable.
func TestDeleteMountRootOnlyDisconnects(t *testing.T) {
	fake := newFakeS3("my-bucket")
	defer fake.close()
	fake.put("a.txt", "keep me")
	s := mountedServer(t, fake, "")

	w, _ := doJSON(t, s.deleteHandler, "POST", "/api/files/delete", map[string]string{"path": "/Bucket"})
	if w.Code != 200 {
		t.Fatalf("status %d: %s", w.Code, w.Body)
	}
	mounts, _ := s.readMounts()
	if len(mounts) != 0 {
		t.Fatalf("mount survived: %+v", mounts)
	}
	if _, ok := fake.get("a.txt"); !ok {
		t.Fatalf("bucket contents were deleted")
	}
}

func TestMoveLocalIntoMount(t *testing.T) {
	fake := newFakeS3("my-bucket")
	defer fake.close()
	s := mountedServer(t, fake, "")

	src := filepath.Join(s.cfg.RootDir, "note.txt")
	if err := os.WriteFile(src, []byte("local body"), 0644); err != nil {
		t.Fatal(err)
	}

	w, _ := doJSON(t, s.moveHandler, "POST", "/api/files/move",
		map[string]string{"from": "/note.txt", "to": "/Bucket/note.txt"})
	if w.Code != 200 {
		t.Fatalf("status %d: %s", w.Code, w.Body)
	}
	if got, _ := fake.get("note.txt"); got != "local body" {
		t.Errorf("uploaded body = %q", got)
	}
	if _, err := os.Stat(src); !os.IsNotExist(err) {
		t.Errorf("source file survived the move")
	}
}

func TestMoveMountFileToLocal(t *testing.T) {
	fake := newFakeS3("my-bucket")
	defer fake.close()
	fake.put("remote.txt", "remote body")
	s := mountedServer(t, fake, "")

	w, _ := doJSON(t, s.moveHandler, "POST", "/api/files/move",
		map[string]string{"from": "/Bucket/remote.txt", "to": "/remote.txt"})
	if w.Code != 200 {
		t.Fatalf("status %d: %s", w.Code, w.Body)
	}
	body, err := os.ReadFile(filepath.Join(s.cfg.RootDir, "remote.txt"))
	if err != nil || string(body) != "remote body" {
		t.Fatalf("local file = %q (err %v)", body, err)
	}
	if _, ok := fake.get("remote.txt"); ok {
		t.Errorf("object survived the move")
	}
}

func TestMoveMountFolderToLocal(t *testing.T) {
	fake := newFakeS3("my-bucket")
	defer fake.close()
	fake.put("tree/a.txt", "A")
	fake.put("tree/deep/b.txt", "B")
	s := mountedServer(t, fake, "")

	w, _ := doJSON(t, s.moveHandler, "POST", "/api/files/move",
		map[string]string{"from": "/Bucket/tree", "to": "/tree"})
	if w.Code != 200 {
		t.Fatalf("status %d: %s", w.Code, w.Body)
	}
	for rel, want := range map[string]string{"tree/a.txt": "A", "tree/deep/b.txt": "B"} {
		body, err := os.ReadFile(filepath.Join(s.cfg.RootDir, filepath.FromSlash(rel)))
		if err != nil || string(body) != want {
			t.Errorf("%s = %q (err %v)", rel, body, err)
		}
	}
}

func TestMoveRejectsMountRoot(t *testing.T) {
	fake := newFakeS3("my-bucket")
	defer fake.close()
	s := mountedServer(t, fake, "")

	w, _ := doJSON(t, s.moveHandler, "POST", "/api/files/move",
		map[string]string{"from": "/Bucket", "to": "/Elsewhere"})
	if w.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400", w.Code)
	}
}

func TestMountPathTraversalStaysInPrefix(t *testing.T) {
	fake := newFakeS3("my-bucket")
	defer fake.close()
	fake.put("safe/in.txt", "in")
	fake.put("outside.txt", "out")
	s := mountedServer(t, fake, "safe/")

	// "..' must not climb above the mount's prefix into the rest of the bucket.
	_, out := doJSON(t, s.filesHandler, "GET",
		"/api/files?path="+url.QueryEscape("/Bucket/../.."), nil)
	if got := entryNames(out); strings.Join(got, ",") != "Bucket" {
		t.Fatalf("traversal listing = %v, want the root listing", got)
	}

	w := httptest.NewRecorder()
	s.downloadHandler(w, httptest.NewRequest("GET",
		"/api/files/download?path="+url.QueryEscape("/Bucket/../outside.txt"), nil))
	if w.Code == 200 {
		t.Fatalf("traversal reached an object outside the prefix: %q", w.Body)
	}
}

func TestMountRequestsAreSigned(t *testing.T) {
	fake := newFakeS3("my-bucket")
	defer fake.close()
	fake.put("a.txt", "x")
	s := mountedServer(t, fake, "")

	doJSON(t, s.filesHandler, "GET", "/api/files?path=/Bucket", nil)
	if len(fake.signed) == 0 {
		t.Fatal("no requests reached the bucket")
	}
	for _, auth := range fake.signed {
		if !strings.HasPrefix(auth, "AWS4-HMAC-SHA256 Credential=AKIATEST/") ||
			!strings.Contains(auth, "SignedHeaders=host;x-amz-content-sha256;x-amz-date") ||
			!strings.Contains(auth, "Signature=") {
			t.Fatalf("malformed Authorization header: %q", auth)
		}
	}
}

// An edited copy has to land beside what it came from: comparing whole names would sort
// "photo-resized.jpg" ahead of "photo.jpg", since a dash sorts before a dot.
func TestListingSortKeepsEditedCopiesWithTheirOriginal(t *testing.T) {
	entries := []entry{
		{Name: "photo-resized.jpg"},
		{Name: "Photo.png"},
		{Name: "photo.jpg"},
		{Name: "notes.txt"},
		{Name: "album", IsDir: true},
	}
	sortEntriesForListing(entries)
	var got []string
	for _, e := range entries {
		got = append(got, e.Name)
	}
	want := []string{"album", "notes.txt", "photo.jpg", "Photo.png", "photo-resized.jpg"}
	if strings.Join(got, ",") != strings.Join(want, ",") {
		t.Errorf("got %v, want %v", got, want)
	}
}
