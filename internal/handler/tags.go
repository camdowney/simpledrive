package handler

import "net/http"

// Roomier than prefs: this blob grows with every tagged path, not with the folders visited.
const maxTagsBytes = 4 << 20

// tagsHandler — GET/PUT /api/tags  stores the tag catalog and its per-path assignments.
func (s *server) tagsHandler(w http.ResponseWriter, r *http.Request) {
	s.serveJSONBlob(w, r, &s.tagsMu, s.cfg.TagsPath, maxTagsBytes)
}
