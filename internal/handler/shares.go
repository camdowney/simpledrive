package handler

import (
	"context"
	"crypto/rand"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"log"
	"net/http"
	"os"
	"path"
	"strings"
	"time"
)

const (
	shareView = "view"
	shareEdit = "edit"
	// shareDrop takes files and gives nothing back: its holder can't list, read, or change a thing.
	shareDrop = "drop"

	maxLabelRunes = 60
)

// access is what a route needs; a share's mode decides which levels it can reach.
type access int

const (
	accessInfo   access = iota // what the link itself is, which every mode may ask
	accessRead                 // listing, downloading, previewing
	accessWrite                // changing or removing what is already there
	accessUpload               // adding new files, the one thing a drop link may do
)

// share grants access to one subtree without an account: the token is the entire credential.
type share struct {
	ID      string    `json:"id"`
	Token   string    `json:"token"`
	Path    string    `json:"path"`
	Mode    string    `json:"mode"`
	Label   string    `json:"label"`
	Created time.Time `json:"created"`
}

// cleanLabel keeps a label to one short line: it is owner-facing bookkeeping, not content.
func cleanLabel(s string) string {
	s = strings.TrimSpace(strings.Map(func(r rune) rune {
		if r == '\n' || r == '\r' || r == '\t' {
			return ' '
		}
		return r
	}, s))
	if len([]rune(s)) > maxLabelRunes {
		s = string([]rune(s)[:maxLabelRunes])
	}
	return strings.TrimSpace(s)
}

func (sh *share) canEdit() bool { return sh.Mode == shareEdit }

func (sh *share) allows(level access) bool {
	switch sh.Mode {
	case shareEdit:
		return true
	case shareDrop:
		return level == accessInfo || level == accessUpload
	default:
		return level == accessInfo || level == accessRead
	}
}

// refusal explains a rejected level in terms of what the link is, not what the route wanted.
func (sh *share) refusal() string {
	if sh.Mode == shareDrop {
		return "this link only accepts uploads"
	}
	return "this link is view-only"
}

// within reports whether p is base itself or sits inside it. Both must already be cleaned.
func within(p, base string) bool {
	return p == base || strings.HasPrefix(p, base+"/")
}

// covers reports whether clean (a cleaned, slash-less-prefixed path) is the share or inside it.
func (sh *share) covers(clean string) bool {
	return within(clean, sh.Path)
}

// cleanRel normalizes a request path the way resolve does, so both agree on what a path means.
func cleanRel(rel string) string {
	return strings.TrimPrefix(path.Clean("/"+rel), "/")
}

func (s *server) readShares() ([]share, error) {
	data, err := os.ReadFile(s.cfg.SharesPath)
	if err != nil {
		if os.IsNotExist(err) {
			return nil, nil
		}
		return nil, err
	}
	var shares []share
	if err := json.Unmarshal(data, &shares); err != nil {
		return nil, err
	}
	return shares, nil
}

func (s *server) writeShares(shares []share) error {
	data, err := json.MarshalIndent(shares, "", "  ")
	if err != nil {
		return err
	}
	// writeFileAtomic goes through os.CreateTemp, which always creates 0600 — keep it that way.
	return writeFileAtomic(s.cfg.SharesPath, data)
}

// retargetShares follows links whose target moved, so no new file inherits their old path.
func (s *server) retargetShares(from, to string) {
	from, to = cleanRel(from), cleanRel(to)
	if from == "" || from == to {
		return
	}
	s.sharesMu.Lock()
	defer s.sharesMu.Unlock()
	shares, err := s.readShares()
	if err != nil {
		log.Printf("shares: reading to retarget %s: %v", from, err)
		return
	}
	kept := make([]share, 0, len(shares))
	moved := false
	for _, sh := range shares {
		if !within(sh.Path, from) {
			kept = append(kept, sh)
			continue
		}
		moved = true
		if to == "" {
			continue
		}
		sh.Path = to + sh.Path[len(from):]
		kept = append(kept, sh)
	}
	if !moved {
		return
	}
	if err := s.writeShares(kept); err != nil {
		log.Printf("shares: retargeting %s: %v", from, err)
	}
}

// revokeSharesUnder drops the links to something that is no longer at that path at all.
func (s *server) revokeSharesUnder(p string) { s.retargetShares(p, "") }

func (s *server) lookupShare(token string) (*share, error) {
	if token == "" {
		return nil, nil
	}
	s.sharesMu.Lock()
	shares, err := s.readShares()
	s.sharesMu.Unlock()
	if err != nil {
		return nil, err
	}
	for i := range shares {
		if shares[i].Token == token {
			return &shares[i], nil
		}
	}
	return nil, nil
}

// statInfo is a listing row for a path with no listing behind it, which is all a file link has.
type statInfo struct {
	IsDir    bool      `json:"isDir"`
	Size     int64     `json:"size"`
	Modified time.Time `json:"modified"`
}

// statAny reports whether a resolved path exists, and describes it the way a listing would.
func (s *server) statAny(ctx context.Context, res *resolved) (statInfo, error) {
	if res.isS3() {
		if res.isMountRoot() {
			return statInfo{IsDir: true}, nil
		}
		obj, isDir, err := s.statS3(ctx, res)
		if err != nil || isDir {
			return statInfo{IsDir: isDir}, err
		}
		return statInfo{Size: obj.Size, Modified: obj.Modified}, nil
	}
	fi, err := os.Stat(res.abs)
	if err != nil {
		return statInfo{}, err
	}
	return statInfo{IsDir: fi.IsDir(), Size: fi.Size(), Modified: fi.ModTime()}, nil
}

// sharesHandler — GET /api/shares lists links, POST creates one, DELETE revokes by id.
func (s *server) sharesHandler(w http.ResponseWriter, r *http.Request) {
	switch r.Method {
	case http.MethodGet:
		s.sharesMu.Lock()
		shares, err := s.readShares()
		s.sharesMu.Unlock()
		if err != nil {
			jsonErr(w, "read error", http.StatusInternalServerError)
			return
		}
		if shares == nil {
			shares = []share{}
		}
		writeJSON(w, http.StatusOK, map[string]any{"shares": shares})

	case http.MethodPost:
		var body struct {
			Path  string `json:"path"`
			Mode  string `json:"mode"`
			Label string `json:"label"`
		}
		r.Body = http.MaxBytesReader(w, r.Body, 1<<16)
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			jsonErr(w, "bad request", http.StatusBadRequest)
			return
		}
		if body.Mode != shareView && body.Mode != shareEdit && body.Mode != shareDrop {
			jsonErr(w, "mode must be view, edit, or drop", http.StatusBadRequest)
			return
		}
		clean := cleanRel(body.Path)
		if clean == "" {
			jsonErr(w, "share a folder or file, not the whole drive", http.StatusBadRequest)
			return
		}
		res, err := s.resolve(r, clean)
		if err != nil {
			jsonErr(w, err.Error(), http.StatusBadRequest)
			return
		}
		st, err := s.statAny(r.Context(), res)
		if err != nil {
			jsonErr(w, "not found", http.StatusNotFound)
			return
		}
		// A drop link is a destination, and a file is not somewhere uploads can land.
		if body.Mode == shareDrop && !st.IsDir {
			jsonErr(w, "a drop link needs a folder to collect into", http.StatusBadRequest)
			return
		}

		s.sharesMu.Lock()
		defer s.sharesMu.Unlock()
		shares, err := s.readShares()
		if err != nil {
			jsonErr(w, "read error", http.StatusInternalServerError)
			return
		}
		// Labels exist to hand a different link to each person, so every create mints its own.
		sh := share{Path: clean, Mode: body.Mode, Label: cleanLabel(body.Label), Created: time.Now().UTC()}
		buf := make([]byte, 8)
		if _, err := rand.Read(buf); err != nil {
			jsonErr(w, "server error", http.StatusInternalServerError)
			return
		}
		sh.ID = hex.EncodeToString(buf)
		tok := make([]byte, 24)
		if _, err := rand.Read(tok); err != nil {
			jsonErr(w, "server error", http.StatusInternalServerError)
			return
		}
		sh.Token = base64.RawURLEncoding.EncodeToString(tok)
		if err := s.writeShares(append(shares, sh)); err != nil {
			jsonErr(w, "write error", http.StatusInternalServerError)
			return
		}
		writeJSON(w, http.StatusCreated, sh)

	case http.MethodPatch:
		var body struct {
			ID    string `json:"id"`
			Label string `json:"label"`
		}
		r.Body = http.MaxBytesReader(w, r.Body, 1<<16)
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			jsonErr(w, "bad request", http.StatusBadRequest)
			return
		}
		s.sharesMu.Lock()
		defer s.sharesMu.Unlock()
		shares, err := s.readShares()
		if err != nil {
			jsonErr(w, "read error", http.StatusInternalServerError)
			return
		}
		found := -1
		for i := range shares {
			if shares[i].ID == body.ID {
				found = i
				break
			}
		}
		if found < 0 {
			jsonErr(w, "not found", http.StatusNotFound)
			return
		}
		shares[found].Label = cleanLabel(body.Label)
		if err := s.writeShares(shares); err != nil {
			jsonErr(w, "write error", http.StatusInternalServerError)
			return
		}
		writeJSON(w, http.StatusOK, shares[found])

	case http.MethodDelete:
		id := r.URL.Query().Get("id")
		s.sharesMu.Lock()
		defer s.sharesMu.Unlock()
		shares, err := s.readShares()
		if err != nil {
			jsonErr(w, "read error", http.StatusInternalServerError)
			return
		}
		kept := make([]share, 0, len(shares))
		for _, sh := range shares {
			if sh.ID != id {
				kept = append(kept, sh)
			}
		}
		if len(kept) == len(shares) {
			jsonErr(w, "not found", http.StatusNotFound)
			return
		}
		if err := s.writeShares(kept); err != nil {
			jsonErr(w, "write error", http.StatusInternalServerError)
			return
		}
		writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})

	default:
		jsonErr(w, "method not allowed", http.StatusMethodNotAllowed)
	}
}

// shareInfoHandler — GET /api/share/info tells a link's visitor what they were given.
func (s *server) shareInfoHandler(w http.ResponseWriter, r *http.Request) {
	sh := shareOf(r)
	// The owner's session carries no share scope, but their browser still holds the link's token.
	if sh == nil {
		if c, err := r.Cookie(shareCookie); err == nil {
			sh, _ = s.lookupShare(c.Value)
		}
	}
	if sh == nil {
		jsonErr(w, "not a share", http.StatusNotFound)
		return
	}
	res, err := s.resolve(r, sh.Path)
	if err != nil {
		jsonErr(w, err.Error(), http.StatusBadRequest)
		return
	}
	st, err := s.statAny(r.Context(), res)
	if err != nil {
		jsonErr(w, "the shared item no longer exists", http.StatusNotFound)
		return
	}
	// Size and date stand in for the listing row a file link never gets, so it can show details.
	writeJSON(w, http.StatusOK, map[string]any{
		"path":     "/" + sh.Path,
		"name":     path.Base(sh.Path),
		"mode":     sh.Mode,
		"isDir":    st.IsDir,
		"size":     st.Size,
		"modified": st.Modified,
	})
}

// shareEntryHandler — GET /s/<token> stores the token as a cookie, then serves the app.
func (s *server) shareEntryHandler(w http.ResponseWriter, r *http.Request) {
	token := strings.Trim(strings.TrimPrefix(r.URL.Path, "/s/"), "/")
	sh, err := s.lookupShare(token)
	if err != nil {
		http.Error(w, "server error", http.StatusInternalServerError)
		return
	}
	if sh == nil {
		http.Error(w, "this link is no longer valid", http.StatusNotFound)
		return
	}
	http.SetCookie(w, &http.Cookie{
		Name:     shareCookie,
		Value:    token,
		Path:     "/",
		Expires:  time.Now().Add(30 * 24 * time.Hour),
		HttpOnly: true,
		Secure:   s.secureRequest(r),
		SameSite: http.SameSiteStrictMode,
	})
	s.serveIndex(w)
}
