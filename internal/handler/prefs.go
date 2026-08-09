package handler

import (
	"encoding/json"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"sync"
)

const maxPrefsBytes = 1 << 20

// prefsHandler — GET/PUT /api/prefs  stores the single-user view/sort settings.
func (s *server) prefsHandler(w http.ResponseWriter, r *http.Request) {
	s.serveJSONBlob(w, r, &s.prefsMu, s.cfg.PrefsPath, maxPrefsBytes)
}

// serveJSONBlob stores a JSON object the client owns; the server never looks inside it.
func (s *server) serveJSONBlob(w http.ResponseWriter, r *http.Request, mu *sync.Mutex, path string, maxBytes int) {
	switch r.Method {
	case http.MethodGet:
		mu.Lock()
		data, err := os.ReadFile(path)
		mu.Unlock()
		w.Header().Set("Content-Type", "application/json")
		if err != nil {
			w.Write([]byte("{}"))
			return
		}
		w.Write(data)

	case http.MethodPut:
		body, err := io.ReadAll(io.LimitReader(r.Body, int64(maxBytes)+1))
		if err != nil {
			http.Error(w, `{"error":"read failed"}`, http.StatusBadRequest)
			return
		}
		if len(body) > maxBytes {
			http.Error(w, `{"error":"body too large"}`, http.StatusRequestEntityTooLarge)
			return
		}
		var obj map[string]json.RawMessage
		if json.Unmarshal(body, &obj) != nil {
			http.Error(w, `{"error":"expected a json object"}`, http.StatusBadRequest)
			return
		}
		mu.Lock()
		err = writeFileAtomic(path, body)
		mu.Unlock()
		if err != nil {
			http.Error(w, `{"error":"write failed"}`, http.StatusInternalServerError)
			return
		}
		w.WriteHeader(http.StatusNoContent)

	default:
		http.Error(w, `{"error":"method not allowed"}`, http.StatusMethodNotAllowed)
	}
}

func writeFileAtomic(path string, data []byte) error {
	tmp, err := os.CreateTemp(filepath.Dir(path), ".blob-*.tmp")
	if err != nil {
		return err
	}
	tmpName := tmp.Name()
	defer os.Remove(tmpName)
	if _, err := tmp.Write(data); err != nil {
		tmp.Close()
		return err
	}
	if err := tmp.Close(); err != nil {
		return err
	}
	return os.Rename(tmpName, path)
}
