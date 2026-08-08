package handler

import (
	"encoding/json"
	"fmt"
	"io"
	"mime"
	"net/http"
	"os"
	"path"
	"path/filepath"
	"strconv"
	"strings"
	"time"
)

type entry struct {
	Name     string    `json:"name"`
	Size     int64     `json:"size"`
	Modified time.Time `json:"modified"`
	IsDir    bool      `json:"isDir"`
	MimeType string    `json:"mimeType,omitempty"`
	// HasThumb marks a folder with a previewable child, so the client skips a 415 round-trip.
	HasThumb bool `json:"hasThumb,omitempty"`
	// IsMount marks a connected bucket, which the client labels and deletes differently.
	IsMount bool `json:"isMount,omitempty"`
	// IsTrash marks the trash folder, which the client pins to the top and refuses to act on.
	IsTrash bool `json:"isTrash,omitempty"`
	// IsVault marks an encrypted folder, which the client opens with a passphrase, not a listing.
	IsVault bool `json:"isVault,omitempty"`
}

// maxEditableSize caps what the text editor will load, on either backend.
const maxEditableSize = 10 << 20

// underRoot reports whether abs is the root dir or inside it.
func (s *server) underRoot(abs string) bool {
	return abs == s.cfg.RootDir || strings.HasPrefix(abs, s.cfg.RootDir+string(filepath.Separator))
}

// safePath resolves rel against the root dir, rejecting ".." and symlink escapes.
func (s *server) safePath(rel string) (string, error) {
	clean := filepath.Join(s.cfg.RootDir, filepath.FromSlash(path.Clean("/"+rel)))
	if !s.underRoot(clean) {
		return "", fmt.Errorf("path traversal rejected")
	}
	// Resolve symlinks to catch any symlink inside the root that points outside.
	real, err := filepath.EvalSymlinks(clean)
	if err != nil {
		if !os.IsNotExist(err) {
			return "", fmt.Errorf("path error")
		}
		// Path doesn't exist yet (e.g. upload dest); check the parent isn't a symlink escape.
		realParent, err := filepath.EvalSymlinks(filepath.Dir(clean))
		if err != nil {
			return "", fmt.Errorf("path error")
		}
		if !s.underRoot(realParent) {
			return "", fmt.Errorf("path traversal rejected")
		}
		return clean, nil
	}
	if !s.underRoot(real) {
		return "", fmt.Errorf("path traversal rejected")
	}
	return clean, nil
}

// inlineSafe reports whether a MIME type is safe inline; SVG excluded (can carry script).
func inlineSafe(mimeType string) bool {
	if i := strings.IndexByte(mimeType, ';'); i >= 0 {
		mimeType = mimeType[:i]
	}
	mimeType = strings.TrimSpace(strings.ToLower(mimeType))
	switch {
	case mimeType == "image/svg+xml":
		return false
	case strings.HasPrefix(mimeType, "image/"),
		strings.HasPrefix(mimeType, "video/"),
		strings.HasPrefix(mimeType, "audio/"):
		return true
	case mimeType == "application/pdf":
		return true
	}
	return false
}

func writeJSON(w http.ResponseWriter, code int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(code)
	json.NewEncoder(w).Encode(v)
}

func jsonErr(w http.ResponseWriter, msg string, code int) {
	writeJSON(w, code, map[string]string{"error": msg})
}

// filesHandler — GET /api/files?path=<rel>  lists a directory.
func (s *server) filesHandler(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		jsonErr(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	rel := r.URL.Query().Get("path")
	res, err := s.resolve(r, rel)
	if err != nil {
		jsonErr(w, err.Error(), http.StatusBadRequest)
		return
	}
	if res.isS3() {
		s.filesS3(w, r, res)
		return
	}
	abs := res.abs

	infos, err := os.ReadDir(abs)
	if err != nil {
		if os.IsNotExist(err) {
			jsonErr(w, "not found", http.StatusNotFound)
			return
		}
		// Listing a file fails; flag it so the client opens it as a file, not a folder.
		if fi, statErr := os.Stat(abs); statErr == nil && !fi.IsDir() {
			writeJSON(w, http.StatusOK, map[string]any{"notDir": true})
			return
		}
		jsonErr(w, "read error", http.StatusInternalServerError)
		return
	}

	// A vault's directory holds only its own machinery and blobs named by random id, none of it
	// meant for the browser: its contents are listed from the encrypted index instead. Withholding
	// them here is what keeps RECOVERY.md out of SimpleDrive while leaving it in the folder itself,
	// where a desktop finds it if this server ever isn't there to ask.
	if isVaultDir(abs) {
		writeJSON(w, http.StatusOK, map[string]any{
			"path":    relOf(abs, s.cfg.RootDir),
			"inVault": true,
			"entries": []entry{},
		})
		return
	}

	atRoot := abs == s.cfg.RootDir
	entries := make([]entry, 0, len(infos))
	for _, info := range infos {
		// Half-finished uploads are the server's own scratch space, not something to browse.
		if atRoot && info.Name() == uploadsDirName {
			continue
		}
		fi, err := info.Info()
		if err != nil {
			continue
		}
		e := entry{
			Name:     info.Name(),
			Modified: fi.ModTime().UTC(),
			IsDir:    info.IsDir(),
		}
		if !info.IsDir() {
			e.Size = fi.Size()
			e.MimeType = mime.TypeByExtension(filepath.Ext(info.Name()))
		} else {
			child := filepath.Join(abs, info.Name())
			e.IsTrash = atRoot && info.Name() == trashDirName
			e.IsVault = isVaultDir(child)
			// Neither wants a preview of its contents: a vault holds only ciphertext, and the
			// trash should read as the trash rather than as whatever was last thrown away.
			if !e.IsVault && !e.IsTrash {
				e.HasThumb = s.thumbs.folderChild(child, fi.ModTime(), "name", false) != ""
			}
		}
		entries = append(entries, e)
	}

	// Connected buckets are virtual children of the root and exist in no directory.
	if atRoot {
		mounts, err := s.mountEntries()
		if err != nil {
			jsonErr(w, "read error", http.StatusInternalServerError)
			return
		}
		entries = append(entries, mounts...)
	}

	// Dirs first, then files, both sorted by name.
	sortEntriesForListing(entries)

	writeJSON(w, http.StatusOK, map[string]any{
		"path":    relOf(abs, s.cfg.RootDir),
		"entries": entries,
	})
}

// relOf turns an absolute path back into the root-relative one the client navigates by.
func relOf(abs, root string) string {
	return "/" + strings.TrimPrefix(strings.TrimPrefix(abs, root), string(filepath.Separator))
}

// downloadHandler — GET /api/files/download?path=<rel>  streams a file.
func (s *server) downloadHandler(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		jsonErr(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	rel := r.URL.Query().Get("path")
	res, err := s.resolve(r, rel)
	if err != nil {
		jsonErr(w, err.Error(), http.StatusBadRequest)
		return
	}
	if res.isS3() {
		s.downloadS3(w, r, res)
		return
	}
	abs := res.abs

	f, err := os.Open(abs)
	if err != nil {
		if os.IsNotExist(err) {
			http.Error(w, "not found", http.StatusNotFound)
			return
		}
		http.Error(w, "error", http.StatusInternalServerError)
		return
	}
	defer f.Close()

	fi, err := f.Stat()
	if err != nil || fi.IsDir() {
		http.Error(w, "not a file", http.StatusBadRequest)
		return
	}

	// Force non-passive types (HTML/SVG/XML/unknown) to download so they can't run script.
	inline := r.URL.Query().Get("inline") == "1" &&
		inlineSafe(mime.TypeByExtension(filepath.Ext(fi.Name())))
	if !inline {
		cd := mime.FormatMediaType("attachment", map[string]string{"filename": fi.Name()})
		w.Header().Set("Content-Disposition", cd)
	}
	http.ServeContent(w, r, fi.Name(), fi.ModTime(), f)
}

// createUnique appends " (n)" before the extension rather than overwrite; O_EXCL closes the race.
func createUnique(dir, name string) (*os.File, error) {
	ext := filepath.Ext(name)
	base := strings.TrimSuffix(name, ext)
	if base == "" { // Ext(".hidden") is the whole name; suffix after it, not before
		base, ext = name, ""
	}
	for i := 0; ; i++ {
		try := name
		if i > 0 {
			try = fmt.Sprintf("%s (%d)%s", base, i, ext)
		}
		f, err := os.OpenFile(filepath.Join(dir, try), os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o644)
		if !os.IsExist(err) {
			return f, err
		}
	}
}

// uploadHandler — POST /api/files/upload?path=<rel>  receives multipart uploads.
func (s *server) uploadHandler(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		jsonErr(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}

	rel := r.URL.Query().Get("path")
	res, err := s.resolve(r, rel)
	if err != nil {
		jsonErr(w, err.Error(), http.StatusBadRequest)
		return
	}
	destDir := res.abs

	// A vault rewrites its index in place on every change; nothing else may overwrite on upload.
	overwrite := r.URL.Query().Get("overwrite") == "1"
	if overwrite && (res.isS3() || !isVaultDir(destDir)) {
		jsonErr(w, "overwrite is only allowed inside a vault", http.StatusBadRequest)
		return
	}

	mr, err := r.MultipartReader()
	if err != nil {
		jsonErr(w, "parse error: "+err.Error(), http.StatusBadRequest)
		return
	}

	saved := []string{}
	var clientMod time.Time
	for {
		part, err := mr.NextPart()
		if err == io.EOF {
			break
		}
		if err != nil {
			jsonErr(w, "parse error: "+err.Error(), http.StatusBadRequest)
			return
		}

		if part.FormName() == "lastModified" && part.FileName() == "" {
			b, _ := io.ReadAll(io.LimitReader(part, 32))
			part.Close()
			if ms, err := strconv.ParseInt(strings.TrimSpace(string(b)), 10, 64); err == nil && ms > 0 {
				clientMod = time.UnixMilli(ms)
			}
			continue
		}

		if part.FormName() != "files" || part.FileName() == "" {
			part.Close()
			continue
		}

		name := filepath.Base(part.FileName())
		if name == "" || name == "." {
			part.Close()
			continue
		}

		if res.isS3() {
			final, err := s.uploadPartS3(r.Context(), res, part, name)
			part.Close()
			if err != nil {
				jsonErr(w, err.Error(), s3Status(err))
				return
			}
			saved = append(saved, final)
			continue
		}

		if overwrite {
			final, err := saveOverwrite(destDir, name, part)
			part.Close()
			if err != nil {
				jsonErr(w, "write error", http.StatusInternalServerError)
				return
			}
			saved = append(saved, final)
			continue
		}

		dst, err := createUnique(destDir, name)
		if err != nil {
			part.Close()
			jsonErr(w, "create error", http.StatusInternalServerError)
			return
		}

		_, copyErr := io.Copy(dst, part)
		part.Close()
		dst.Close()
		if copyErr != nil {
			os.Remove(dst.Name())
			jsonErr(w, "write error", http.StatusInternalServerError)
			return
		}
		// Prefer embedded capture time (iOS resets lastModified on export); best-effort.
		if t, ok := mediaTakenTime(dst.Name()); ok {
			os.Chtimes(dst.Name(), t, t)
		} else if !clientMod.IsZero() {
			os.Chtimes(dst.Name(), clientMod, clientMod)
		}
		saved = append(saved, filepath.Base(dst.Name()))
	}

	if len(saved) == 0 {
		jsonErr(w, "no files", http.StatusBadRequest)
		return
	}

	if sh := shareOf(r); sh != nil && sh.Mode == shareDrop {
		// A suffixed name would tell a drop link's holder which names are already taken.
		writeJSON(w, http.StatusOK, map[string]any{"status": "ok"})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"status": "ok", "saved": saved})
}

// readHandler — GET /api/files/read?path=<rel>  returns file text content.
func (s *server) readHandler(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		jsonErr(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	rel := r.URL.Query().Get("path")
	res, err := s.resolve(r, rel)
	if err != nil {
		jsonErr(w, err.Error(), http.StatusBadRequest)
		return
	}
	if res.isS3() {
		s.readS3(w, r, res)
		return
	}
	abs := res.abs

	fi, err := os.Stat(abs)
	if err != nil {
		if os.IsNotExist(err) {
			jsonErr(w, "not found", http.StatusNotFound)
			return
		}
		jsonErr(w, "read error", http.StatusInternalServerError)
		return
	}
	if fi.IsDir() {
		jsonErr(w, "not a file", http.StatusBadRequest)
		return
	}
	if fi.Size() > maxEditableSize {
		jsonErr(w, "file too large for text editor", http.StatusRequestEntityTooLarge)
		return
	}
	data, err := os.ReadFile(abs)
	if err != nil {
		jsonErr(w, "read error", http.StatusInternalServerError)
		return
	}

	writeJSON(w, http.StatusOK, map[string]string{"content": string(data)})
}

// writeHandler — POST /api/files/write?path=<rel>  saves text content.
func (s *server) writeHandler(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		jsonErr(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	rel := r.URL.Query().Get("path")
	res, err := s.resolve(r, rel)
	if err != nil {
		jsonErr(w, err.Error(), http.StatusBadRequest)
		return
	}

	var body struct {
		Content string `json:"content"`
	}
	r.Body = http.MaxBytesReader(w, r.Body, maxEditableSize)
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		jsonErr(w, "bad request", http.StatusBadRequest)
		return
	}

	if res.isS3() {
		s.writeS3(w, r, res, body.Content)
		return
	}
	if err := os.WriteFile(res.abs, []byte(body.Content), 0644); err != nil {
		jsonErr(w, "write error", http.StatusInternalServerError)
		return
	}

	writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
}

// mkdirHandler — POST /api/files/mkdir  body: {path}
func (s *server) mkdirHandler(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		jsonErr(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	var body struct {
		Path string `json:"path"`
		// Unique suffixes the name until one is free, the way an uploaded file's name is.
		Unique bool `json:"unique"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		jsonErr(w, "bad request", http.StatusBadRequest)
		return
	}
	res, err := s.resolve(r, body.Path)
	if err != nil {
		jsonErr(w, err.Error(), http.StatusBadRequest)
		return
	}
	if res.isS3() {
		s.mkdirS3(w, r, res, body.Unique)
		return
	}
	if body.Unique {
		// The suffixed name is made in the parent, which the root has none of inside the drive.
		if res.abs == s.cfg.RootDir {
			jsonErr(w, "bad request", http.StatusBadRequest)
			return
		}
		name, err := mkdirUnique(res.abs)
		if err != nil {
			jsonErr(w, "server error", http.StatusInternalServerError)
			return
		}
		writeJSON(w, http.StatusOK, map[string]string{"status": "ok", "name": name})
		return
	}
	if err := os.Mkdir(res.abs, 0755); err != nil {
		if os.IsExist(err) {
			jsonErr(w, "already exists", http.StatusConflict)
			return
		}
		jsonErr(w, "server error", http.StatusInternalServerError)
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"status": "ok", "name": filepath.Base(res.abs)})
}

// mkdirUnique makes abs, suffixing its name until one is free; a folder's dots are never split off.
func mkdirUnique(abs string) (string, error) {
	parent, name := filepath.Split(abs)
	for i := 0; i < 1000; i++ {
		try := name
		if i > 0 {
			try = fmt.Sprintf("%s (%d)", name, i)
		}
		err := os.Mkdir(filepath.Join(parent, try), 0755)
		if err == nil {
			return try, nil
		}
		if !os.IsExist(err) {
			return "", err
		}
	}
	return "", fmt.Errorf("too many folders with that name")
}

// renameHandler — POST /api/files/rename body {dir, from, to, modified?}; modified is RFC3339.
func (s *server) renameHandler(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		jsonErr(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	var body struct {
		Dir      string `json:"dir"`
		From     string `json:"from"`
		To       string `json:"to"`
		Modified string `json:"modified"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		jsonErr(w, "bad request", http.StatusBadRequest)
		return
	}
	if strings.ContainsAny(body.From, "/\\") || strings.ContainsAny(body.To, "/\\") {
		jsonErr(w, "names must not contain path separators", http.StatusBadRequest)
		return
	}
	fromRel, toRel := path.Join(body.Dir, body.From), path.Join(body.Dir, body.To)
	fromRes, err := s.resolve(r, fromRel)
	if err != nil {
		jsonErr(w, err.Error(), http.StatusBadRequest)
		return
	}
	toRes, err := s.resolve(r, toRel)
	if err != nil {
		jsonErr(w, err.Error(), http.StatusBadRequest)
		return
	}
	if fromRes.isS3() {
		// S3 stores no settable timestamp, so the details dialog's date field can't apply here.
		if body.Modified != "" {
			jsonErr(w, "a bucket's dates can't be edited", http.StatusBadRequest)
			return
		}
		if fromRes.isMountRoot() {
			// Renaming a bucket's folder is a change to the connection itself, not to its contents.
			if shareOf(r) != nil {
				jsonErr(w, "a connected bucket can't be renamed through a link", http.StatusForbidden)
				return
			}
			old := fromRes.mnt.Name
			if err := s.renameMount(fromRes.mnt.ID, body.To); err != nil {
				jsonErr(w, err.Error(), http.StatusBadRequest)
				return
			}
			// The bucket's name is the first segment of every path inside it, links included.
			s.retargetShares(old, body.To)
			writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
			return
		}
		if s.renameS3(w, r, fromRes, toRes) {
			s.retargetShares(fromRel, toRel)
		}
		return
	}
	if toRes.isS3() {
		jsonErr(w, "a connected bucket already uses that name", http.StatusConflict)
		return
	}
	// Renaming the trash away, or onto it, would strand every restore path in the index.
	if s.isTrashRoot(fromRes.abs) || s.isTrashRoot(toRes.abs) {
		jsonErr(w, "the trash folder can't be renamed", http.StatusBadRequest)
		return
	}
	fromAbs, toAbs := fromRes.abs, toRes.abs
	finalAbs := fromAbs
	if body.From != body.To {
		if _, err := os.Stat(toAbs); err == nil {
			jsonErr(w, "a file or folder with that name already exists", http.StatusConflict)
			return
		}
		if err := os.Rename(fromAbs, toAbs); err != nil {
			if os.IsNotExist(err) {
				jsonErr(w, "not found", http.StatusNotFound)
				return
			}
			jsonErr(w, "server error", http.StatusInternalServerError)
			return
		}
		s.retargetShares(fromRel, toRel)
		finalAbs = toAbs
	}
	if body.Modified != "" {
		t, err := time.Parse(time.RFC3339, body.Modified)
		if err != nil {
			jsonErr(w, "bad date", http.StatusBadRequest)
			return
		}
		if err := os.Chtimes(finalAbs, t, t); err != nil {
			if os.IsNotExist(err) {
				jsonErr(w, "not found", http.StatusNotFound)
				return
			}
			jsonErr(w, "server error", http.StatusInternalServerError)
			return
		}
		s.thumbs.invalidateFolder(filepath.Dir(finalAbs))
	}
	writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
}

// moveHandler — POST /api/files/move body {from, to}; both are full relative paths.
func (s *server) moveHandler(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		jsonErr(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	var body struct {
		From string `json:"from"`
		To   string `json:"to"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		jsonErr(w, "bad request", http.StatusBadRequest)
		return
	}
	fromRes, err := s.resolve(r, body.From)
	if err != nil {
		jsonErr(w, err.Error(), http.StatusBadRequest)
		return
	}
	toRes, err := s.resolve(r, body.To)
	if err != nil {
		jsonErr(w, err.Error(), http.StatusBadRequest)
		return
	}
	if fromRes.isMountRoot() || toRes.isMountRoot() {
		jsonErr(w, "a connected bucket can't be moved", http.StatusBadRequest)
		return
	}
	if fromRes.isS3() || toRes.isS3() {
		if err := s.moveAcross(r.Context(), fromRes, toRes); err != nil {
			jsonErr(w, err.Error(), s3Status(err))
			return
		}
		s.retargetShares(body.From, body.To)
		writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
		return
	}
	if s.isTrashRoot(fromRes.abs) {
		jsonErr(w, "the trash folder can't be moved", http.StatusBadRequest)
		return
	}
	// A move into the trash would skip moveToTrash, leaving an item the index can't restore.
	if s.inTrash(toRes.abs) {
		jsonErr(w, "delete a file to send it to the trash", http.StatusBadRequest)
		return
	}
	fromAbs, toAbs := fromRes.abs, toRes.abs
	if _, err := os.Stat(toAbs); err == nil {
		jsonErr(w, "a file or folder with that name already exists at the destination", http.StatusConflict)
		return
	}
	if err := os.Rename(fromAbs, toAbs); err != nil {
		if os.IsNotExist(err) {
			jsonErr(w, "not found", http.StatusNotFound)
			return
		}
		jsonErr(w, "server error", http.StatusInternalServerError)
		return
	}
	s.retargetShares(body.From, body.To)
	writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
}

// copyHandler — POST /api/files/copy body {from, to}; both are full relative paths.
func (s *server) copyHandler(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		jsonErr(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	var body struct {
		From string `json:"from"`
		To   string `json:"to"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		jsonErr(w, "bad request", http.StatusBadRequest)
		return
	}
	fromRes, err := s.resolve(r, body.From)
	if err != nil {
		jsonErr(w, err.Error(), http.StatusBadRequest)
		return
	}
	toRes, err := s.resolve(r, body.To)
	if err != nil {
		jsonErr(w, err.Error(), http.StatusBadRequest)
		return
	}
	// A bucket's own folder is the connection, not a directory that can be duplicated.
	if fromRes.isMountRoot() || toRes.isMountRoot() {
		jsonErr(w, "a connected bucket can't be copied", http.StatusBadRequest)
		return
	}
	if fromRes.isS3() || toRes.isS3() {
		if err := s.copyAcross(r.Context(), fromRes, toRes); err != nil {
			jsonErr(w, err.Error(), s3Status(err))
			return
		}
		writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
		return
	}
	// Copying into the trash would leave an item the index has no restore path for.
	if s.inTrash(toRes.abs) {
		jsonErr(w, "the trash only takes deleted files", http.StatusBadRequest)
		return
	}
	// A folder copied into itself would recurse until the disk gave out.
	if s.underPath(toRes.abs, fromRes.abs) {
		jsonErr(w, "a folder can't be copied into itself", http.StatusBadRequest)
		return
	}
	if _, err := os.Stat(toRes.abs); err == nil {
		jsonErr(w, "a file or folder with that name already exists at the destination", http.StatusConflict)
		return
	}
	if err := copyTree(fromRes.abs, toRes.abs); err != nil {
		os.RemoveAll(toRes.abs)
		if os.IsNotExist(err) {
			jsonErr(w, "not found", http.StatusNotFound)
			return
		}
		jsonErr(w, "server error", http.StatusInternalServerError)
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
}

// underPath reports whether abs is base or sits inside it.
func (s *server) underPath(abs, base string) bool {
	return abs == base || strings.HasPrefix(abs, base+string(filepath.Separator))
}

// copyTree duplicates a file or a whole directory, carrying mode and mtime across.
func copyTree(from, to string) error {
	fi, err := os.Lstat(from)
	if err != nil {
		return err
	}
	switch {
	case fi.IsDir():
		if err := os.Mkdir(to, fi.Mode().Perm()); err != nil {
			return err
		}
		infos, err := os.ReadDir(from)
		if err != nil {
			return err
		}
		for _, info := range infos {
			if err := copyTree(filepath.Join(from, info.Name()), filepath.Join(to, info.Name())); err != nil {
				return err
			}
		}
	case fi.Mode().IsRegular():
		if err := copyFile(from, to, fi.Mode().Perm()); err != nil {
			return err
		}
	default:
		return nil // sockets, devices and dangling symlinks have no copy worth making
	}
	return os.Chtimes(to, fi.ModTime(), fi.ModTime())
}

func copyFile(from, to string, perm os.FileMode) error {
	src, err := os.Open(from)
	if err != nil {
		return err
	}
	defer src.Close()
	dst, err := os.OpenFile(to, os.O_WRONLY|os.O_CREATE|os.O_EXCL, perm)
	if err != nil {
		return err
	}
	if _, err := io.Copy(dst, src); err != nil {
		dst.Close()
		return err
	}
	return dst.Close()
}

// deleteHandler — POST /api/files/delete  body: {path}
func (s *server) deleteHandler(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		jsonErr(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	var body struct{ Path string }
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		jsonErr(w, "bad request", http.StatusBadRequest)
		return
	}
	res, err := s.resolve(r, body.Path)
	if err != nil {
		jsonErr(w, err.Error(), http.StatusBadRequest)
		return
	}
	if res.isS3() {
		// Deleting a bucket's own folder disconnects it; it never erases the bucket.
		if res.isMountRoot() {
			if shareOf(r) != nil {
				jsonErr(w, "a connected bucket can't be disconnected through a link", http.StatusForbidden)
				return
			}
			err = s.removeMount(res.mnt.ID)
		} else {
			err = deleteS3(r.Context(), res)
		}
		if err != nil {
			jsonErr(w, err.Error(), s3Status(err))
			return
		}
		if res.isMountRoot() {
			s.revokeSharesUnder(res.mnt.Name)
		} else {
			s.revokeSharesUnder(body.Path)
		}
		writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
		return
	}
	// Refuse to delete the root itself.
	if res.abs == s.cfg.RootDir {
		jsonErr(w, "cannot delete root", http.StatusBadRequest)
		return
	}
	// Deleting something already in the trash is the permanent one; everything else is recoverable.
	if s.inTrash(res.abs) {
		if err := os.RemoveAll(res.abs); err != nil {
			jsonErr(w, "server error", http.StatusInternalServerError)
			return
		}
		s.revokeSharesUnder(body.Path)
		writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
		return
	}
	if err := s.moveToTrash(res.abs); err != nil {
		if os.IsNotExist(err) {
			jsonErr(w, "not found", http.StatusNotFound)
			return
		}
		jsonErr(w, "server error", http.StatusInternalServerError)
		return
	}
	// The trash is not a path a link may reach, so a trashed target ends the links to it.
	s.revokeSharesUnder(body.Path)
	s.thumbs.invalidateFolder(filepath.Dir(res.abs))
	writeJSON(w, http.StatusOK, map[string]string{"status": "ok", "trashed": "1"})
}
