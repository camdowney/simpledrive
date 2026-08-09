package handler

import (
	"archive/zip"
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"io"
	"mime"
	"net/http"
	"os"
	"path"
	"path/filepath"
	"strings"
	"time"

	"simpledrive/internal/s3"
)

// filesS3 answers a directory listing for a path inside a mount.
func (s *server) filesS3(w http.ResponseWriter, r *http.Request, res *resolved) {
	entries, err := s.listS3(r.Context(), res)
	if err != nil {
		s3Fail(w, err)
		return
	}
	if len(entries) == 0 && !res.isMountRoot() {
		// Nothing at this prefix: it's either an object (open it as a file) or gone.
		if _, err := res.cli.Head(r.Context(), res.key()); err == nil {
			writeJSON(w, http.StatusOK, map[string]any{"notDir": true})
			return
		}
		if _, err := res.cli.Head(r.Context(), res.dirKey()); err != nil {
			jsonErr(w, "not found", http.StatusNotFound)
			return
		}
	}
	sortEntriesForListing(entries)
	writeJSON(w, http.StatusOK, map[string]any{
		"path":    "/" + path.Join(res.mnt.Name, res.rest),
		"entries": entries,
		// Buckets carry no settable mtime, so the client hides the date editor here.
		"inMount": true,
	})
}

// downloadS3 streams an object through, preserving ranges so video seeking works.
func (s *server) downloadS3(w http.ResponseWriter, r *http.Request, res *resolved) {
	name := res.name()
	inline := r.URL.Query().Get("inline") == "1" &&
		inlineSafe(mime.TypeByExtension(filepath.Ext(name)))
	if !inline {
		cd := mime.FormatMediaType("attachment", map[string]string{"filename": name})
		w.Header().Set("Content-Disposition", cd)
	}
	resp, err := res.cli.Get(r.Context(), res.key(), r.Header.Get("Range"))
	if err != nil {
		http.Error(w, err.Error(), s3Status(err))
		return
	}
	defer resp.Body.Close()

	for _, h := range []string{"Content-Type", "Content-Length", "Content-Range", "ETag", "Last-Modified"} {
		if v := resp.Header.Get(h); v != "" {
			w.Header().Set(h, v)
		}
	}
	w.Header().Set("Accept-Ranges", "bytes")
	w.WriteHeader(resp.StatusCode)
	io.Copy(w, resp.Body)
}

// readS3 returns an object's text for the editor.
func (s *server) readS3(w http.ResponseWriter, r *http.Request, res *resolved) {
	obj, err := res.cli.Head(r.Context(), res.key())
	if err != nil {
		s3Fail(w, err)
		return
	}
	if obj.Size > maxEditableSize {
		jsonErr(w, "file too large for text editor", http.StatusRequestEntityTooLarge)
		return
	}
	resp, err := res.cli.Get(r.Context(), res.key(), "")
	if err != nil {
		s3Fail(w, err)
		return
	}
	defer resp.Body.Close()
	data, err := io.ReadAll(io.LimitReader(resp.Body, maxEditableSize))
	if err != nil {
		jsonErr(w, "read error", http.StatusBadGateway)
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"content": string(data)})
}

func (s *server) writeS3(w http.ResponseWriter, r *http.Request, res *resolved, content string) {
	body := strings.NewReader(content)
	if err := res.cli.Put(r.Context(), res.key(), body, int64(len(content)), contentTypeFor(res.rest)); err != nil {
		s3Fail(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
}

// mkdirS3 writes an empty marker object; S3 has no directories of its own.
func (s *server) mkdirS3(w http.ResponseWriter, r *http.Request, res *resolved, unique bool) {
	if res.isMountRoot() {
		jsonErr(w, "already exists", http.StatusConflict)
		return
	}
	if unique {
		s.mkdirUniqueS3(w, r, res)
		return
	}
	_, isDir, err := s.statS3(r.Context(), res)
	if err == nil && isDir {
		jsonErr(w, "already exists", http.StatusConflict)
		return
	}
	if err != nil && !s3.IsNotFound(err) {
		s3Fail(w, err)
		return
	}
	if err := res.cli.Put(r.Context(), res.dirKey(), strings.NewReader(""), 0, ""); err != nil {
		s3Fail(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"status": "ok", "name": res.name()})
}

// mkdirUniqueS3 suffixes the folder name until the key is free, as uniqueS3Key does for a file.
func (s *server) mkdirUniqueS3(w http.ResponseWriter, r *http.Request, res *resolved) {
	for i := 0; i < 1000; i++ {
		try := res.rest
		if i > 0 {
			try = fmt.Sprintf("%s (%d)", res.rest, i)
		}
		probe := &resolved{mnt: res.mnt, cli: res.cli, rest: try}
		_, _, err := s.statS3(r.Context(), probe)
		if err == nil {
			continue
		}
		if !s3.IsNotFound(err) {
			s3Fail(w, err)
			return
		}
		if err := res.cli.Put(r.Context(), probe.dirKey(), strings.NewReader(""), 0, ""); err != nil {
			s3Fail(w, err)
			return
		}
		writeJSON(w, http.StatusOK, map[string]string{"status": "ok", "name": path.Base(try)})
		return
	}
	jsonErr(w, "too many folders with that name", http.StatusConflict)
}

// renameS3 copies to the new key then drops the old; answers the request and reports success.
func (s *server) renameS3(w http.ResponseWriter, r *http.Request, from, to *resolved) bool {
	ctx := r.Context()
	if _, _, err := s.statS3(ctx, to); err == nil {
		jsonErr(w, "a file or folder with that name already exists", http.StatusConflict)
		return false
	}
	if err := copyWithin(ctx, from, to); err != nil {
		s3Fail(w, err)
		return false
	}
	if err := deleteS3(ctx, from); err != nil {
		s3Fail(w, err)
		return false
	}
	writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
	return true
}

// thumbS3 caches previews keyed by the object's ETag, so unchanged objects never re-download.
func (s *server) thumbS3(w http.ResponseWriter, r *http.Request, res *resolved) {
	ctx := r.Context()
	obj, isDir, err := s.statS3(ctx, res)
	if err != nil {
		s3Fail(w, err)
		return
	}

	if isDir {
		sortBy, desc := thumbSortParams(r)
		child, childObj := s.s3FolderChild(ctx, res, sortBy, desc)
		if child == nil {
			jsonErr(w, "not thumbnailable", http.StatusUnsupportedMediaType)
			return
		}
		res, obj = child, childObj
	}

	video := isVideoName(res.rest)
	if video && s.thumbs.ffmpeg == "" {
		jsonErr(w, "not thumbnailable", http.StatusUnsupportedMediaType)
		return
	}
	// The cap guards whole-object fetches; videos and raws range-read and so are exempt.
	if !video && !isRawName(res.rest) && obj.Size > thumbMaxSourceSize {
		jsonErr(w, "not thumbnailable", http.StatusUnsupportedMediaType)
		return
	}

	hash := s3ThumbHash(res, obj)

	etag := `"` + hash + `"`
	cacheControl := thumbCacheControl(isDir)
	if thumbNotModified(w, r, etag, cacheControl) {
		return
	}

	target := res
	cachePath, err := s.thumbs.ensureWith(hash, func(cachePath string) error {
		return s.thumbFromS3(ctx, target, hash, cachePath)
	})
	serveThumb(w, cachePath, err, etag, cacheControl)
}

// displayS3 mirrors thumbS3 for the screen-sized viewer JPEG ("-d" cache variant).
func (s *server) displayS3(w http.ResponseWriter, r *http.Request, res *resolved) {
	ctx := r.Context()
	obj, isDir, err := s.statS3(ctx, res)
	if err != nil {
		s3Fail(w, err)
		return
	}
	ext := strings.ToLower(filepath.Ext(res.rest))
	if isDir || (!imageThumbExts[ext] && !rawThumbExts[ext]) {
		jsonErr(w, "not displayable", http.StatusUnsupportedMediaType)
		return
	}
	if !isRawName(res.rest) && obj.Size > thumbMaxSourceSize {
		jsonErr(w, "not displayable", http.StatusUnsupportedMediaType)
		return
	}

	target, hash := res, s3ThumbHash(res, obj)
	s.serveDisplay(w, r, hash, isRawName(res.rest), func(ctx context.Context) (string, error) {
		return s.thumbs.ensureWith(hash+"-d", func(string) error {
			return s.displayFromS3(ctx, target, hash)
		})
	})
}

// displayFromS3 scales from ranged reads for raws, else from a scratch-file download.
func (s *server) displayFromS3(ctx context.Context, res *resolved, hash string) error {
	outs := s.thumbs.scaledOutputsFor(res.rest, hash, true)
	if isRawName(res.rest) {
		obj, err := res.cli.Head(ctx, res.key())
		if err != nil {
			return err
		}
		jpg, err := rawPreview(s3ReaderAt{ctx: ctx, res: res}, obj.Size)
		if err != nil {
			return err
		}
		return writeScaledAll(bytes.NewReader(jpg), outs)
	}
	tmp, err := s.fetchS3Temp(ctx, res)
	if err != nil {
		return err
	}
	defer os.Remove(tmp)
	return generateOutputs(tmp, outs)
}

// s3ThumbHash keys the thumb cache (and its sidecars) for an object; ETag+size track content.
func s3ThumbHash(res *resolved, obj *s3.Object) string {
	sum := sha256.Sum256([]byte(res.mnt.Bucket + "\x00" + res.key() + "\x00" + obj.ETag + "\x00" + fmt.Sprint(obj.Size)))
	return hex.EncodeToString(sum[:])
}

// thumbFromS3 downloads to a scratch file (both decoders need a real path); the display sibling
// rides along, so the viewer never re-fetches.
func (s *server) thumbFromS3(ctx context.Context, res *resolved, hash, cachePath string) error {
	outs := s.thumbs.scaledOutputsFor(res.rest, hash, false)
	// Raws never land on disk: two ranged GETs beat downloading tens of megabytes.
	if isRawName(res.rest) {
		obj, err := res.cli.Head(ctx, res.key())
		if err != nil {
			return err
		}
		jpg, err := rawPreview(s3ReaderAt{ctx: ctx, res: res}, obj.Size)
		if err != nil {
			return err
		}
		return writeScaledAll(bytes.NewReader(jpg), outs)
	}
	// Videos stay remote too: ffmpeg range-reads a presigned URL for the one frame it needs.
	if isVideoName(res.rest) {
		url, err := res.cli.Presign(res.key(), s3ThumbURLTTL)
		if err != nil {
			return err
		}
		return s.thumbs.generateVideoThumb(url, cachePath)
	}
	tmp, err := s.fetchS3Temp(ctx, res)
	if err != nil {
		return err
	}
	defer os.Remove(tmp)
	return generateOutputs(tmp, outs)
}

// fetchS3Temp downloads an object to a temp file whose extension the decoders can sniff.
func (s *server) fetchS3Temp(ctx context.Context, res *resolved) (string, error) {
	f, err := os.CreateTemp("", "simpledrive-thumb-*"+filepath.Ext(res.rest))
	if err != nil {
		return "", err
	}
	resp, err := res.cli.Get(ctx, res.key(), "")
	if err != nil {
		f.Close()
		os.Remove(f.Name())
		return "", err
	}
	_, err = io.Copy(f, io.LimitReader(resp.Body, thumbMaxSourceSize))
	resp.Body.Close()
	f.Close()
	if err != nil {
		os.Remove(f.Name())
		return "", err
	}
	return f.Name(), nil
}

// metaS3 reports an object's timestamp and, for images, its dimensions and EXIF capture time.
func (s *server) metaS3(w http.ResponseWriter, r *http.Request, res *resolved) {
	obj, err := res.cli.Head(r.Context(), res.key())
	if err != nil {
		s3Fail(w, err)
		return
	}
	modTime := s3Modified(obj)

	meta := fileMeta{}
	// S3 keeps no birth time; the object's last write is the only creation stamp available.
	if !modTime.IsZero() {
		meta.Created = modTime.Format(time.RFC3339)
	}
	switch ext := strings.ToLower(filepath.Ext(res.rest)); {
	case imageThumbExts[ext] && obj.Size <= thumbMaxSourceSize:
		if tmp, err := s.fetchS3Temp(r.Context(), res); err == nil {
			readImageMeta(tmp, modTime, &meta)
			os.Remove(tmp)
		}
	case rawThumbExts[ext]:
		readRawMeta(s3ReaderAt{ctx: r.Context(), res: res}, obj.Size, modTime, &meta)
	case videoThumbExts[ext]:
		// Box parsing costs ranged B2 reads, so the answer is sidecared under the thumb key.
		hash := s3ThumbHash(res, obj)
		if di, ok := s.thumbs.readDur(hash); ok {
			meta.Duration, meta.DateTaken = di.Duration, di.Taken
		} else if mvhdExts[ext] {
			readVideoMeta(s3ReaderAt{ctx: r.Context(), res: res}, obj.Size, modTime, &meta)
			s.thumbs.writeDur(hash, durInfo{Duration: meta.Duration, Taken: meta.DateTaken})
		}
	case audioExts[ext]:
		// ffprobe range-reads the presigned URL, so the object never lands on disk.
		if url, err := res.cli.Presign(res.key(), s3ThumbURLTTL); err == nil {
			meta.Duration = s.thumbs.audioDuration(s3ThumbHash(res, obj), url)
		}
	}

	writeJSON(w, http.StatusOK, meta)
}

// addS3ToZip streams an object or a whole prefix into the archive.
func addS3ToZip(ctx context.Context, zw *zip.Writer, res *resolved, nameInZip string) {
	objs, err := s3Keys(ctx, res)
	if err != nil {
		return
	}
	single := len(objs) == 1 && objs[0].Key == res.key()
	for _, o := range objs {
		name := nameInZip
		if !single {
			rel := strings.TrimPrefix(o.Key, res.dirKey())
			if rel == "" || strings.HasSuffix(rel, "/") {
				continue
			}
			name = nameInZip + "/" + rel
		}
		resp, err := res.cli.Get(ctx, o.Key, "")
		if err != nil {
			continue
		}
		fw, err := zw.CreateHeader(&zip.FileHeader{
			Name:     name,
			Method:   zip.Deflate,
			Modified: o.Modified,
		})
		if err == nil {
			io.Copy(fw, resp.Body)
		}
		resp.Body.Close()
	}
}

// removeMount disconnects a bucket; the bucket's contents are left untouched.
func (s *server) removeMount(id string) error {
	s.mountsMu.Lock()
	defer s.mountsMu.Unlock()
	mounts, err := s.readMounts()
	if err != nil {
		return err
	}
	kept := make([]mount, 0, len(mounts))
	for _, m := range mounts {
		if m.ID != id {
			kept = append(kept, m)
		}
	}
	if err := s.writeMounts(kept); err != nil {
		return err
	}
	s.s3Mu.Lock()
	delete(s.s3Clients, id)
	s.s3Mu.Unlock()
	return nil
}

// renameMount changes a mount's display name, rejecting collisions with another mount.
func (s *server) renameMount(id, name string) error {
	name = strings.TrimSpace(name)
	if msg := validateMountName(name); msg != "" {
		return fmt.Errorf("%s", msg)
	}
	s.mountsMu.Lock()
	defer s.mountsMu.Unlock()
	mounts, err := s.readMounts()
	if err != nil {
		return err
	}
	for _, m := range mounts {
		if m.ID != id && strings.EqualFold(m.Name, name) {
			return fmt.Errorf("a mount with that name already exists")
		}
	}
	if _, err := os.Stat(filepath.Join(s.cfg.RootDir, name)); err == nil {
		return fmt.Errorf("a folder with that name already exists")
	}
	for i := range mounts {
		if mounts[i].ID == id {
			mounts[i].Name = name
		}
	}
	return s.writeMounts(mounts)
}
