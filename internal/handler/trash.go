package handler

import (
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"
)

const (
	trashDirName = ".trash"
	// Retention is in days, so an hourly sweep is granular enough and costs one readdir.
	trashGCInterval = time.Hour
)

// trashEntry records where a deleted file came from, so restore can put it back.
type trashEntry struct {
	Name      string    `json:"name"` // basename inside .trash, unique
	From      string    `json:"from"` // original path relative to root, slash-separated
	DeletedAt time.Time `json:"deletedAt"`
	// The original mtime, which the move into trash overwrites; restore puts it back.
	ModTime time.Time `json:"modTime"`
	IsDir   bool      `json:"isDir"`
	Size    int64     `json:"size,omitempty"`
}

func (s *server) trashDir() string { return filepath.Join(s.cfg.RootDir, trashDirName) }

// inTrash reports whether abs is the trash dir or inside it.
func (s *server) inTrash(abs string) bool {
	td := s.trashDir()
	return abs == td || strings.HasPrefix(abs, td+string(filepath.Separator))
}

// isTrashRoot reports whether abs is the trash dir itself, which is not the user's to move.
func (s *server) isTrashRoot(abs string) bool { return abs == s.trashDir() }

func (s *server) readTrashIndex() (map[string]trashEntry, error) {
	idx := map[string]trashEntry{}
	b, err := os.ReadFile(s.cfg.TrashIndexPath)
	if err != nil {
		if os.IsNotExist(err) {
			return idx, nil
		}
		return nil, err
	}
	if err := json.Unmarshal(b, &idx); err != nil {
		// A corrupt index costs restore paths, not the files; start over rather than fail every delete.
		return map[string]trashEntry{}, nil
	}
	return idx, nil
}

func (s *server) writeTrashIndex(idx map[string]trashEntry) error {
	b, err := json.Marshal(idx)
	if err != nil {
		return err
	}
	return writeFileAtomic(s.cfg.TrashIndexPath, b)
}

// Reserves a name with an O_EXCL placeholder the caller's rename replaces, closing the race with
// a concurrent delete. A directory gets none — os.Rename won't land on an existing path — so
// trashMu is what keeps two deletes off the same name.
func trashUniqueName(dir, name string, isDir bool) (string, error) {
	ext := filepath.Ext(name)
	base := strings.TrimSuffix(name, ext)
	if base == "" {
		base, ext = name, ""
	}
	for i := 0; i < 10000; i++ {
		try := name
		if i > 0 {
			try = fmt.Sprintf("%s (%d)%s", base, i, ext)
		}
		path := filepath.Join(dir, try)
		if isDir {
			if _, err := os.Lstat(path); os.IsNotExist(err) {
				return try, nil
			} else if err != nil {
				return "", err
			}
			continue
		}
		f, err := os.OpenFile(path, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o644)
		if err == nil {
			f.Close()
			return try, nil
		}
		if !os.IsExist(err) {
			return "", err
		}
	}
	return "", errors.New("trash name exhausted")
}

// moveToTrash relocates abs into .trash and indexes where it came from.
func (s *server) moveToTrash(abs string) error {
	fi, err := os.Lstat(abs)
	if err != nil {
		return err
	}
	dir := s.trashDir()
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return err
	}

	s.trashMu.Lock()
	defer s.trashMu.Unlock()

	name, err := trashUniqueName(dir, filepath.Base(abs), fi.IsDir())
	if err != nil {
		return err
	}
	dest := filepath.Join(dir, name)
	if err := os.Rename(abs, dest); err != nil {
		if !fi.IsDir() {
			os.Remove(dest) // drop the placeholder so it isn't left behind as an empty file
		}
		return err
	}

	// Deletion time rides on the entry's mtime so an unindexed orphan is still purgeable.
	now := time.Now()
	os.Chtimes(dest, now, now)

	rel := filepath.ToSlash(strings.TrimPrefix(strings.TrimPrefix(abs, s.cfg.RootDir), string(filepath.Separator)))
	idx, err := s.readTrashIndex()
	if err != nil {
		return err
	}
	idx[name] = trashEntry{
		Name:      name,
		From:      rel,
		DeletedAt: now,
		ModTime:   fi.ModTime(),
		IsDir:     fi.IsDir(),
		Size:      fi.Size(),
	}
	return s.writeTrashIndex(idx)
}

// trashRestoreHandler — POST /api/trash/restore  body: {name}
// Exists for the undo prompt: it is the one path that knows where a deleted file came from.
func (s *server) trashRestoreHandler(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		jsonErr(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	var body struct{ Name string }
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		jsonErr(w, "bad request", http.StatusBadRequest)
		return
	}
	name := filepath.Base(body.Name)
	if name == "" || name == "." || name == string(filepath.Separator) {
		jsonErr(w, "bad request", http.StatusBadRequest)
		return
	}
	src := filepath.Join(s.trashDir(), name)
	if _, err := os.Lstat(src); err != nil {
		jsonErr(w, "not found", http.StatusNotFound)
		return
	}

	s.trashMu.Lock()
	defer s.trashMu.Unlock()

	idx, err := s.readTrashIndex()
	if err != nil {
		jsonErr(w, "read error", http.StatusInternalServerError)
		return
	}
	e, ok := idx[name]
	if !ok || e.From == "" {
		jsonErr(w, "this item has no recorded original location", http.StatusConflict)
		return
	}
	dest, err := s.safePath(e.From)
	if err != nil || s.inTrash(dest) {
		jsonErr(w, "bad original location", http.StatusBadRequest)
		return
	}
	if err := os.MkdirAll(filepath.Dir(dest), 0o755); err != nil {
		jsonErr(w, "server error", http.StatusInternalServerError)
		return
	}
	// The original name may have been reused since the delete, so land beside it rather than clobber.
	finalName, err := trashUniqueName(filepath.Dir(dest), filepath.Base(dest), e.IsDir)
	if err != nil {
		jsonErr(w, "server error", http.StatusInternalServerError)
		return
	}
	final := filepath.Join(filepath.Dir(dest), finalName)
	if err := os.Rename(src, final); err != nil {
		if !e.IsDir {
			os.Remove(final)
		}
		jsonErr(w, "server error", http.StatusInternalServerError)
		return
	}
	if !e.ModTime.IsZero() {
		os.Chtimes(final, e.ModTime, e.ModTime)
	}
	delete(idx, name)
	s.writeTrashIndex(idx)
	s.thumbs.invalidateFolder(filepath.Dir(final))

	rel := filepath.ToSlash(strings.TrimPrefix(strings.TrimPrefix(final, s.cfg.RootDir), string(filepath.Separator)))
	writeJSON(w, http.StatusOK, map[string]string{"status": "ok", "path": "/" + rel})
}

// trashGCLoop drops entries past the retention window, and prunes index rows whose file is gone.
func (s *server) trashGCLoop() {
	for {
		s.purgeTrashOnce()
		time.Sleep(trashGCInterval)
	}
}

func (s *server) purgeTrashOnce() {
	retention, keep := s.cfg.TrashRetention()

	s.trashMu.Lock()
	defer s.trashMu.Unlock()

	idx, err := s.readTrashIndex()
	if err != nil {
		return
	}
	dir := s.trashDir()
	infos, err := os.ReadDir(dir)
	if err != nil {
		// The whole folder can be deleted from the browser, which orphans every index row.
		if os.IsNotExist(err) && len(idx) > 0 {
			s.writeTrashIndex(map[string]trashEntry{})
		}
		return
	}

	present := map[string]bool{}
	cutoff := time.Now().Add(-retention)
	for _, info := range infos {
		present[info.Name()] = true
		if !keep {
			continue
		}
		deletedAt := time.Time{}
		if e, ok := idx[info.Name()]; ok {
			deletedAt = e.DeletedAt
		}
		if deletedAt.IsZero() {
			// An orphan carries its deletion time only as an mtime, which moveToTrash stamps.
			if fi, err := info.Info(); err == nil {
				deletedAt = fi.ModTime()
			}
		}
		if !deletedAt.IsZero() && deletedAt.Before(cutoff) {
			if os.RemoveAll(filepath.Join(dir, info.Name())) == nil {
				delete(idx, info.Name())
				present[info.Name()] = false
			}
		}
	}
	for name := range idx {
		if !present[name] {
			delete(idx, name)
		}
	}
	s.writeTrashIndex(idx)
}
