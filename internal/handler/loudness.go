package handler

import (
	"bufio"
	"context"
	"io"
	"math"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"time"
)

const (
	// Playback target. Gain only ever attenuates (HTMLMediaElement.volume caps at 1), so this sits
	// below the mastering level of essentially every track rather than at a broadcast -23 LUFS.
	loudnessTargetLUFS = -18.0
	// A scan decodes the whole file, so it needs far longer than a thumbnail's frame grab.
	loudnessTimeout = 3 * time.Minute
	// Two at once keeps a phone's prefetch responsive without pinning every core on a small VPS.
	loudnessConcurrency = 2
	// Floor on the applied gain, so one mis-measured file can't silence the player.
	loudnessMinGain = 0.05
)

// loudnessHandler — GET /api/files/loudness?path=<rel> returns the playback gain for a track.
// The measurement is cached by content hash, so only the first play of a file pays for it.
func (s *server) loudnessHandler(w http.ResponseWriter, r *http.Request) {
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
	// Scanning an S3 object means pulling the whole thing down per track; not worth the egress.
	if res.isS3() {
		writeJSON(w, http.StatusOK, map[string]any{"gain": 1})
		return
	}
	abs := res.abs
	if !audioExts[strings.ToLower(filepath.Ext(abs))] {
		writeJSON(w, http.StatusOK, map[string]any{"gain": 1})
		return
	}
	fi, err := os.Stat(abs)
	if err != nil || !fi.Mode().IsRegular() {
		jsonErr(w, "not found", http.StatusNotFound)
		return
	}
	hash, err := s.thumbs.contentHash(abs, fi)
	if err != nil {
		jsonErr(w, "read error", http.StatusInternalServerError)
		return
	}

	di, measured := s.thumbs.loudness(hash, abs)
	if !measured {
		// Unmeasurable (no ffmpeg, or a file ffmpeg won't decode): play it untouched.
		writeJSON(w, http.StatusOK, map[string]any{"gain": 1})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"gain":   loudnessGain(di.LUFS),
		"lufs":   math.Round(di.LUFS*10) / 10,
		"target": loudnessTargetLUFS,
	})
}

// loudnessGain converts measured loudness into a volume multiplier, attenuating only.
func loudnessGain(lufs float64) float64 {
	if lufs == 0 || lufs <= -70 {
		return 1 // -70 LUFS is ffmpeg's "effectively silent" floor; boosting it would just raise noise
	}
	g := math.Pow(10, (loudnessTargetLUFS-lufs)/20)
	if g > 1 {
		return 1
	}
	if g < loudnessMinGain {
		return loudnessMinGain
	}
	// Two decimals is finer than the ear resolves and keeps the cached value stable.
	return math.Round(g*100) / 100
}

// loudness answers from the sidecar, scanning once per content otherwise. A failed scan is
// recorded too, so an undecodable file isn't rescanned on every play.
func (c *thumbCache) loudness(hash, src string) (durInfo, bool) {
	if di, ok := c.readDur(hash); ok && di.LUFSMeasured {
		return di, di.LUFS != 0
	}
	if c.ffmpeg == "" {
		return durInfo{}, false
	}

	v, err, _ := c.group.Do("lufs:"+hash, func() (any, error) {
		c.loudSem <- struct{}{}
		defer func() { <-c.loudSem }()
		// A queued duplicate may have finished the scan while this one waited for the semaphore.
		if di, ok := c.readDur(hash); ok && di.LUFSMeasured {
			return di, nil
		}
		lufs := scanLoudness(c.ffmpeg, src)
		return c.updateDur(hash, func(di *durInfo) {
			di.LUFS, di.LUFSMeasured = lufs, true
		}), nil
	})
	if err != nil {
		return durInfo{}, false
	}
	di := v.(durInfo)
	return di, di.LUFS != 0
}

// scanLoudness runs ffmpeg's EBU R128 meter over the whole file; 0 means it couldn't be measured.
func scanLoudness(bin, src string) float64 {
	ctx, cancel := context.WithTimeout(context.Background(), loudnessTimeout)
	defer cancel()
	cmd := exec.CommandContext(ctx, bin, "-nostdin", "-v", "info",
		"-i", src, "-af", "ebur128", "-f", "null", "-")
	// The meter reports on stderr, alongside every other diagnostic ffmpeg emits.
	stderr, err := cmd.StderrPipe()
	if err != nil {
		return 0
	}
	if err := cmd.Start(); err != nil {
		return 0
	}
	lufs := parseEBUR128(stderr)
	cmd.Wait()
	return lufs
}

// parseEBUR128 pulls integrated loudness out of the meter's trailing summary block. The per-frame
// lines carry an "I:" too, so only the one after "Integrated loudness" counts.
func parseEBUR128(r io.Reader) float64 {
	sc := bufio.NewScanner(r)
	sc.Buffer(make([]byte, 0, 64<<10), 1<<20)
	inSummary := false
	var lufs float64
	for sc.Scan() {
		line := strings.TrimSpace(sc.Text())
		if strings.HasPrefix(line, "Integrated loudness") {
			inSummary = true
			continue
		}
		if !inSummary || !strings.HasPrefix(line, "I:") {
			continue
		}
		f := strings.Fields(strings.TrimPrefix(line, "I:"))
		if len(f) == 0 {
			continue
		}
		if v, err := strconv.ParseFloat(f[0], 64); err == nil {
			lufs = v
		}
		inSummary = false
	}
	return lufs
}
