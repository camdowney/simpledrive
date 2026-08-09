package handler

import (
	"encoding/json"
	"os"
	"slices"
	"time"
)

// jsonCache memoizes a parsed config list. resolve reads mounts.json and requireAccess reads
// shares.json on every request, so the parse is held rather than repeated per call.
type jsonCache[T any] struct {
	size  int64
	mtime time.Time
	items []T
	ok    bool
}

// load parses path, reusing the last parse while the file's size and mtime both hold, so a file
// edited outside the process is still picked up. Callers must hold the mutex guarding this cache;
// each gets its own copy to mutate.
func (c *jsonCache[T]) load(path string) ([]T, error) {
	fi, err := os.Stat(path)
	if err != nil {
		c.forget()
		if os.IsNotExist(err) {
			return nil, nil
		}
		return nil, err
	}
	if c.ok && c.size == fi.Size() && c.mtime.Equal(fi.ModTime()) {
		return slices.Clone(c.items), nil
	}
	data, err := os.ReadFile(path)
	if err != nil {
		c.forget()
		if os.IsNotExist(err) {
			return nil, nil
		}
		return nil, err
	}
	var items []T
	if err := json.Unmarshal(data, &items); err != nil {
		c.forget()
		return nil, err
	}
	c.items, c.size, c.mtime, c.ok = items, fi.Size(), fi.ModTime(), true
	return slices.Clone(c.items), nil
}

// forget drops the memo, so a write within the same mtime tick can't be served from a stale parse.
func (c *jsonCache[T]) forget() {
	c.items, c.ok = nil, false
}
