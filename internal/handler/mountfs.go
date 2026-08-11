package handler

import (
	"context"
	"fmt"
	"io"
	"mime"
	"net/http"
	"os"
	"path"
	"path/filepath"
	"sort"
	"strings"
	"time"

	"simpledrive/internal/s3"
)

// maxS3Objects caps recursive listings so one request can't pull an unbounded bucket into memory.
const maxS3Objects = 50000

// resolved is a request path after mount routing: either a local file or a key in a mount.
type resolved struct {
	abs  string // local absolute path; empty when mnt is set
	mnt  *mount
	cli  *s3.Client
	rest string // slash path inside the mount; "" is the mount root
}

func (r *resolved) isS3() bool { return r.mnt != nil }

// key is the object key for this path.
func (r *resolved) key() string { return r.mnt.Prefix + r.rest }

// dirKey is the listing prefix for this path treated as a folder (always ends in "/" or is empty).
func (r *resolved) dirKey() string {
	if r.rest == "" {
		return r.mnt.Prefix
	}
	return r.mnt.Prefix + r.rest + "/"
}

func (r *resolved) isMountRoot() bool { return r.isS3() && r.rest == "" }

func (r *resolved) name() string {
	if r.rest == "" {
		return r.mnt.Name
	}
	return path.Base(r.rest)
}

// resolvePath is resolve for a handler that answers the caller directly: it writes the 400 itself.
func (s *server) resolvePath(w http.ResponseWriter, r *http.Request, rel string) (*resolved, bool) {
	res, err := s.resolve(r, rel)
	if err != nil {
		jsonErr(w, err.Error(), http.StatusBadRequest)
		return nil, false
	}
	return res, true
}

// resolveQuery is resolvePath on the ?path= parameter every route that names a file takes.
func (s *server) resolveQuery(w http.ResponseWriter, r *http.Request) (*resolved, bool) {
	return s.resolvePath(w, r, r.URL.Query().Get("path"))
}

// resolve routes rel to a mount or the local root. Every path passes through here, so it is
// where a share's subtree is enforced.
func (s *server) resolve(r *http.Request, rel string) (*resolved, error) {
	clean := cleanRel(rel)
	sh := shareOf(r)
	if sh != nil && !sh.covers(clean) {
		return nil, fmt.Errorf("not found")
	}
	first, rest, _ := strings.Cut(clean, "/")
	if first != "" {
		m, err := s.lookupMount(first)
		if err != nil {
			return nil, fmt.Errorf("read error")
		}
		if m != nil {
			cli, err := s.s3Client(m)
			if err != nil {
				return nil, err
			}
			return &resolved{mnt: m, cli: cli, rest: rest}, nil
		}
	}
	abs, err := s.safePath(rel)
	if err != nil {
		return nil, err
	}
	if sh != nil && !s.shareCoversReal(sh, abs) {
		return nil, fmt.Errorf("not found")
	}
	return &resolved{abs: abs}, nil
}

// safePath only proves the target is under the root; a symlink can still leave a share's subtree.
func (s *server) shareCoversReal(sh *share, abs string) bool {
	real, err := filepath.EvalSymlinks(abs)
	if err != nil {
		// Nothing there yet (a new file or folder), so its parent is what the links resolve through.
		real, err = filepath.EvalSymlinks(filepath.Dir(abs))
		if err != nil {
			return false
		}
	}
	return sh.covers(cleanRel(relOf(real, s.cfg.RootDir)))
}

func (s *server) lookupMount(name string) (*mount, error) {
	s.mountsMu.Lock()
	mounts, err := s.readMounts()
	s.mountsMu.Unlock()
	if err != nil {
		return nil, err
	}
	for i := range mounts {
		if strings.EqualFold(mounts[i].Name, name) {
			return &mounts[i], nil
		}
	}
	return nil, nil
}

// s3Client memoizes one client per mount so connections are pooled across requests.
func (s *server) s3Client(m *mount) (*s3.Client, error) {
	s.s3Mu.Lock()
	defer s.s3Mu.Unlock()
	if cli, ok := s.s3Clients[m.ID]; ok {
		return cli, nil
	}
	cli, err := s3.New(s3.Config{
		Bucket:          m.Bucket,
		Region:          m.Region,
		Endpoint:        m.Endpoint,
		AccessKeyID:     m.AccessKeyID,
		SecretAccessKey: m.SecretAccessKey,
	})
	if err != nil {
		return nil, err
	}
	s.s3Clients[m.ID] = cli
	return cli, nil
}

// s3Status maps bucket failures onto the status the browser should see.
func s3Status(err error) int {
	if s3.IsNotFound(err) {
		return http.StatusNotFound
	}
	return http.StatusBadGateway
}

func s3Fail(w http.ResponseWriter, err error) {
	jsonErr(w, err.Error(), s3Status(err))
}

// mountEntries lists connected buckets as folders for the root listing.
func (s *server) mountEntries() ([]entry, error) {
	s.mountsMu.Lock()
	mounts, err := s.readMounts()
	s.mountsMu.Unlock()
	if err != nil {
		return nil, err
	}
	out := make([]entry, 0, len(mounts))
	for _, m := range mounts {
		// HasThumb is asserted, not checked: probing every bucket would cost a LIST per listing.
		out = append(out, entry{Name: m.Name, IsDir: true, HasThumb: true, IsMount: true})
	}
	return out, nil
}

// listS3 returns one directory level, with "/" as the delimiter standing in for folders.
func (s *server) listS3(ctx context.Context, r *resolved) ([]entry, error) {
	prefix := r.dirKey()
	lst, err := r.cli.List(ctx, prefix, "/", maxS3Objects)
	if err != nil {
		return nil, err
	}

	entries := make([]entry, 0, len(lst.Objects)+len(lst.Prefixes))
	for _, p := range lst.Prefixes {
		name := strings.TrimSuffix(strings.TrimPrefix(p, prefix), "/")
		if name == "" {
			continue
		}
		// S3 has no folder mtime; the zero time renders as "—" client-side.
		entries = append(entries, entry{Name: name, IsDir: true, HasThumb: true})
	}
	for _, o := range lst.Objects {
		name := strings.TrimPrefix(o.Key, prefix)
		// Skip the folder-marker object for this prefix itself.
		if name == "" || strings.HasSuffix(name, "/") {
			continue
		}
		e := entry{
			Name:     name,
			Size:     o.Size,
			Modified: o.Modified.UTC(),
			MimeType: mime.TypeByExtension(filepath.Ext(name)),
		}
		// Sidecared when the thumb was built; reading the object itself for a size is not worth it.
		if imageThumbExts[strings.ToLower(filepath.Ext(name))] && s.thumbs != nil {
			hash := s3ObjectHash(r.mnt.Bucket, o.Key, o.ETag, o.Size)
			if di, ok := s.thumbs.readDur(hash); ok {
				e.Width, e.Height = di.Width, di.Height
			}
		}
		entries = append(entries, e)
	}
	return entries, nil
}

// statS3 reports whether rest names an existing object, a folder prefix, or nothing.
func (s *server) statS3(ctx context.Context, r *resolved) (obj *s3.Object, isDir bool, err error) {
	if r.rest == "" {
		return nil, true, nil
	}
	obj, err = r.cli.Head(ctx, r.key())
	if err == nil {
		return obj, false, nil
	}
	if !s3.IsNotFound(err) {
		return nil, false, err
	}
	lst, listErr := r.cli.List(ctx, r.dirKey(), "/", 1)
	if listErr != nil {
		return nil, false, listErr
	}
	if len(lst.Objects) > 0 || len(lst.Prefixes) > 0 {
		return nil, true, nil
	}
	return nil, false, err
}

// s3Keys returns a path's objects: just its own key for a file, the whole subtree for a folder.
func s3Keys(ctx context.Context, r *resolved) ([]s3.Object, error) {
	if obj, err := r.cli.Head(ctx, r.key()); err == nil {
		return []s3.Object{*obj}, nil
	} else if !s3.IsNotFound(err) {
		return nil, err
	}
	lst, err := r.cli.List(ctx, r.dirKey(), "", maxS3Objects)
	if err != nil {
		return nil, err
	}
	return lst.Objects, nil
}

// uniqueS3Key appends " (n)" until the key is free, mirroring createUnique's local behaviour.
func uniqueS3Key(ctx context.Context, cli *s3.Client, dirKey, name string) (string, string, error) {
	ext := filepath.Ext(name)
	base := strings.TrimSuffix(name, ext)
	if base == "" {
		base, ext = name, ""
	}
	for i := 0; i < 1000; i++ {
		try := name
		if i > 0 {
			try = fmt.Sprintf("%s (%d)%s", base, i, ext)
		}
		_, err := cli.Head(ctx, dirKey+try)
		if s3.IsNotFound(err) {
			return dirKey + try, try, nil
		}
		if err != nil {
			return "", "", err
		}
	}
	return "", "", fmt.Errorf("too many files with that name")
}

func contentTypeFor(name string) string {
	if ct := mime.TypeByExtension(filepath.Ext(name)); ct != "" {
		return ct
	}
	return "application/octet-stream"
}

// putS3Local uploads a local file, streaming from disk with its size already known.
func putS3Local(ctx context.Context, cli *s3.Client, key, localPath string) error {
	f, err := os.Open(localPath)
	if err != nil {
		return err
	}
	defer f.Close()
	fi, err := f.Stat()
	if err != nil {
		return err
	}
	return cli.Put(ctx, key, f, fi.Size(), contentTypeFor(key))
}

// getS3Local downloads an object to a local path, creating parent directories as needed.
func getS3Local(ctx context.Context, cli *s3.Client, key, localPath string) error {
	if err := os.MkdirAll(filepath.Dir(localPath), 0755); err != nil {
		return err
	}
	resp, err := cli.Get(ctx, key, "")
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	f, err := os.Create(localPath)
	if err != nil {
		return err
	}
	if _, err := io.Copy(f, resp.Body); err != nil {
		f.Close()
		os.Remove(localPath)
		return err
	}
	return f.Close()
}

// deleteS3 removes a file or an entire folder subtree.
func deleteS3(ctx context.Context, r *resolved) error {
	objs, err := s3Keys(ctx, r)
	if err != nil {
		return err
	}
	for _, o := range objs {
		if err := r.cli.Delete(ctx, o.Key); err != nil {
			return err
		}
	}
	// Folder markers don't appear in a delimited listing of themselves; drop it explicitly.
	if r.rest != "" {
		r.cli.Delete(ctx, r.dirKey())
	}
	return nil
}

// forEachMappedKey walks from's objects, handing each one its destination key under to.
func forEachMappedKey(ctx context.Context, from, to *resolved, fn func(o s3.Object, dst string) error) error {
	objs, err := s3Keys(ctx, from)
	if err != nil {
		return err
	}
	if len(objs) == 0 {
		return fmt.Errorf("not found")
	}
	single := len(objs) == 1 && objs[0].Key == from.key()
	for _, o := range objs {
		dst := to.key()
		if !single {
			dst = to.dirKey() + strings.TrimPrefix(o.Key, from.dirKey())
		}
		if err := fn(o, dst); err != nil {
			return err
		}
	}
	return nil
}

// copyWithin duplicates a file or subtree inside one bucket, server-side.
func copyWithin(ctx context.Context, from, to *resolved) error {
	return forEachMappedKey(ctx, from, to, func(o s3.Object, dst string) error {
		return from.cli.Copy(ctx, o.Key, dst, o.Size, contentTypeFor(dst))
	})
}

// uploadPartS3 streams one form part straight to the bucket under a free key.
func (s *server) uploadPartS3(ctx context.Context, res *resolved, part io.Reader, name string) (string, error) {
	key, final, err := uniqueS3Key(ctx, res.cli, res.dirKey(), name)
	if err != nil {
		return "", err
	}
	if _, err := res.cli.PutStream(ctx, key, part, contentTypeFor(name)); err != nil {
		return "", err
	}
	return final, nil
}

// moveAcross moves a file or folder between backends, copying then deleting the source.
func (s *server) moveAcross(ctx context.Context, from, to *resolved) error {
	if to.isS3() {
		if _, _, err := s.statS3(ctx, to); err == nil {
			return fmt.Errorf("a file or folder with that name already exists at the destination")
		}
	} else if _, err := os.Stat(to.abs); err == nil {
		return fmt.Errorf("a file or folder with that name already exists at the destination")
	}

	switch {
	case from.isS3() && to.isS3() && from.mnt.ID == to.mnt.ID:
		if err := copyWithin(ctx, from, to); err != nil {
			return err
		}
		return deleteS3(ctx, from)

	case from.isS3() && to.isS3():
		if err := s.s3ToS3(ctx, from, to); err != nil {
			return err
		}
		return deleteS3(ctx, from)

	case from.isS3():
		if err := s.s3ToLocal(ctx, from, to.abs); err != nil {
			return err
		}
		return deleteS3(ctx, from)

	default:
		if err := s.localToS3(ctx, from.abs, to); err != nil {
			return err
		}
		return os.RemoveAll(from.abs)
	}
}

// copyAcross duplicates a file or folder between backends, leaving the source where it is.
func (s *server) copyAcross(ctx context.Context, from, to *resolved) error {
	if to.isS3() {
		if _, _, err := s.statS3(ctx, to); err == nil {
			return fmt.Errorf("a file or folder with that name already exists at the destination")
		}
	} else if _, err := os.Stat(to.abs); err == nil {
		return fmt.Errorf("a file or folder with that name already exists at the destination")
	}

	switch {
	case from.isS3() && to.isS3() && from.mnt.ID == to.mnt.ID:
		if strings.HasPrefix(to.key(), from.dirKey()) {
			return fmt.Errorf("a folder can't be copied into itself")
		}
		// Same bucket: the objects are duplicated inside it, so nothing crosses the wire.
		return copyWithin(ctx, from, to)
	case from.isS3() && to.isS3():
		return s.s3ToS3(ctx, from, to)
	case from.isS3():
		return s.s3ToLocal(ctx, from, to.abs)
	default:
		return s.localToS3(ctx, from.abs, to)
	}
}

func (s *server) s3ToS3(ctx context.Context, from, to *resolved) error {
	return forEachMappedKey(ctx, from, to, func(o s3.Object, dst string) error {
		resp, err := from.cli.Get(ctx, o.Key, "")
		if err != nil {
			return err
		}
		defer resp.Body.Close()
		// Across buckets there's no server-side copy, so oversized objects stream through multipart.
		if o.Size > s3.MaxSinglePut {
			_, err := to.cli.PutStream(ctx, dst, resp.Body, contentTypeFor(dst))
			return err
		}
		return to.cli.Put(ctx, dst, resp.Body, o.Size, contentTypeFor(dst))
	})
}

func (s *server) s3ToLocal(ctx context.Context, from *resolved, destAbs string) error {
	objs, err := s3Keys(ctx, from)
	if err != nil {
		return err
	}
	if len(objs) == 0 {
		return fmt.Errorf("not found")
	}
	if len(objs) == 1 && objs[0].Key == from.key() {
		return getS3Local(ctx, from.cli, objs[0].Key, destAbs)
	}
	for _, o := range objs {
		rel := strings.TrimPrefix(o.Key, from.dirKey())
		if rel == "" || strings.HasSuffix(rel, "/") {
			continue
		}
		if err := getS3Local(ctx, from.cli, o.Key, filepath.Join(destAbs, filepath.FromSlash(rel))); err != nil {
			return err
		}
	}
	return nil
}

func (s *server) localToS3(ctx context.Context, srcAbs string, to *resolved) error {
	fi, err := os.Stat(srcAbs)
	if err != nil {
		return err
	}
	if !fi.IsDir() {
		return putS3Local(ctx, to.cli, to.key(), srcAbs)
	}
	return filepath.WalkDir(srcAbs, func(p string, d os.DirEntry, err error) error {
		if err != nil || d.IsDir() || !d.Type().IsRegular() {
			return err
		}
		rel, err := filepath.Rel(srcAbs, p)
		if err != nil {
			return err
		}
		return putS3Local(ctx, to.cli, to.dirKey()+filepath.ToSlash(rel), p)
	})
}

// s3FolderChild picks a folder's sort-first previewable child, mirroring findThumbable.
func (s *server) s3FolderChild(ctx context.Context, r *resolved, sortBy string, desc bool) (*resolved, *s3.Object) {
	entries, err := s.listS3(ctx, r)
	if err != nil {
		return nil, nil
	}
	var best *entry
	var bestCand thumbCand
	for i := range entries {
		e := &entries[i]
		if e.IsDir {
			continue
		}
		ext := strings.ToLower(filepath.Ext(e.Name))
		if !thumbableExt(ext, s.thumbs.ffmpeg) {
			continue
		}
		if !rawThumbExts[ext] && e.Size > thumbMaxSourceSize {
			continue
		}
		cand := thumbCand{name: e.Name, mtime: e.Modified, size: e.Size}
		if best == nil || thumbLess(cand, bestCand, sortBy, desc) {
			best, bestCand = e, cand
		}
	}
	if best == nil {
		return nil, nil
	}
	child := &resolved{mnt: r.mnt, cli: r.cli, rest: path.Join(r.rest, best.Name)}
	obj, err := child.cli.Head(ctx, child.key())
	if err != nil {
		return nil, nil
	}
	return child, obj
}

// sortEntriesForListing orders a listing dirs-first then by name, on either backend.
func sortEntriesForListing(entries []entry) {
	sort.Slice(entries, func(i, j int) bool {
		if entries[i].IsDir != entries[j].IsDir {
			return entries[i].IsDir
		}
		return compareFileNames(entries[i].Name, entries[j].Name) < 0
	})
}

// Extension weighed apart from the stem so "photo-resized.jpg" follows "photo.jpg"; client agrees.
func compareFileNames(a, b string) int {
	as, ax := splitFileName(a)
	bs, bx := splitFileName(b)
	if as != bs {
		return strings.Compare(as, bs)
	}
	return strings.Compare(ax, bx)
}

// splitFileName lowercases and separates the extension; a dotfile keeps its whole name as the stem.
func splitFileName(name string) (string, string) {
	name = strings.ToLower(name)
	if i := strings.LastIndex(name, "."); i > 0 {
		return name[:i], name[i:]
	}
	return name, ""
}

// s3Modified is the object's timestamp in UTC, or the zero time when the bucket reported none.
func s3Modified(o *s3.Object) time.Time {
	if o == nil || o.Modified.IsZero() {
		return time.Time{}
	}
	return o.Modified.UTC()
}
