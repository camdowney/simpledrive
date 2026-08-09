package handler

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
)

const (
	// One at a time: a transcode saturates every core it's given, and this runs on a VPS.
	jobWorkers = 1
	// Past this the answer is to queue fewer, not to hold thousands of pending rows in memory.
	maxQueuedJobs = 200
	// Finished rows linger so the client can report the outcome, then age out of the list.
	jobRetention = 6 * time.Hour
	// A long film on slow hardware is hours; this only catches a genuinely wedged process.
	transcodeTimeout = 12 * time.Hour
)

type jobStatus string

const (
	jobQueued   jobStatus = "queued"
	jobRunning  jobStatus = "running"
	jobDone     jobStatus = "done"
	jobFailed   jobStatus = "failed"
	jobCanceled jobStatus = "canceled"
)

// job is one queued transcode. Everything the client polls lives here.
type job struct {
	ID       string    `json:"id"`
	Kind     string    `json:"kind"`
	Path     string    `json:"path"`
	Name     string    `json:"name"`
	Status   jobStatus `json:"status"`
	Progress float64   `json:"progress"` // 0-1; stays 0 while the length is unknown
	Error    string    `json:"error,omitempty"`
	Output   string    `json:"output,omitempty"`
	InSize   int64     `json:"inSize,omitempty"`
	OutSize  int64     `json:"outSize,omitempty"`
	Queued   time.Time `json:"queued"`
	Ended    time.Time `json:"ended,omitempty"`

	// run is the work itself; it reports progress through the pointer it is handed.
	run    func(*job) error
	cancel context.CancelFunc
}

type jobQueue struct {
	mu     sync.Mutex
	jobs   map[string]*job
	order  []string
	ch     chan string
	nextID int
}

func newJobQueue() *jobQueue {
	q := &jobQueue{jobs: map[string]*job{}, ch: make(chan string, maxQueuedJobs)}
	for i := 0; i < jobWorkers; i++ {
		go q.worker()
	}
	return q
}

// add enqueues j, refusing once the backlog is full rather than growing without bound.
func (q *jobQueue) add(j *job) error {
	q.mu.Lock()
	q.nextID++
	j.ID = strconv.Itoa(q.nextID)
	j.Status = jobQueued
	j.Queued = time.Now()
	q.jobs[j.ID] = j
	q.order = append(q.order, j.ID)
	q.mu.Unlock()

	select {
	case q.ch <- j.ID:
		return nil
	default:
		q.mu.Lock()
		delete(q.jobs, j.ID)
		q.order = q.order[:len(q.order)-1]
		q.mu.Unlock()
		return fmt.Errorf("too many jobs already queued")
	}
}

func (q *jobQueue) worker() {
	for id := range q.ch {
		q.mu.Lock()
		j := q.jobs[id]
		// A job canceled before a worker reached it never starts.
		if j == nil || j.Status != jobQueued {
			q.mu.Unlock()
			continue
		}
		ctx, cancel := context.WithTimeout(context.Background(), transcodeTimeout)
		j.cancel, j.Status = cancel, jobRunning
		q.mu.Unlock()

		err := j.run(j)

		q.mu.Lock()
		j.Ended = time.Now()
		switch {
		case ctx.Err() != nil || j.Status == jobCanceled:
			j.Status = jobCanceled
		case err != nil:
			j.Status, j.Error = jobFailed, err.Error()
		default:
			j.Status, j.Progress = jobDone, 1
		}
		j.cancel = nil
		q.mu.Unlock()
		cancel()
		q.sweep()
	}
}

// sweep drops finished rows the client has had ample time to read.
func (q *jobQueue) sweep() {
	q.mu.Lock()
	defer q.mu.Unlock()
	cutoff := time.Now().Add(-jobRetention)
	kept := q.order[:0]
	for _, id := range q.order {
		j := q.jobs[id]
		if j == nil {
			continue
		}
		if !j.Ended.IsZero() && j.Ended.Before(cutoff) {
			delete(q.jobs, id)
			continue
		}
		kept = append(kept, id)
	}
	q.order = kept
}

func (q *jobQueue) list() []job {
	q.mu.Lock()
	defer q.mu.Unlock()
	out := make([]job, 0, len(q.order))
	for _, id := range q.order {
		if j := q.jobs[id]; j != nil {
			out = append(out, *j) // copied under the lock; the client never sees a torn row
		}
	}
	sort.Slice(out, func(i, k int) bool { return out[i].Queued.After(out[k].Queued) })
	return out
}

func (q *jobQueue) cancel(id string) bool {
	q.mu.Lock()
	defer q.mu.Unlock()
	j := q.jobs[id]
	if j == nil {
		return false
	}
	switch j.Status {
	case jobRunning:
		j.Status = jobCanceled
		if j.cancel != nil {
			j.cancel()
		}
		return true
	case jobQueued:
		j.Status, j.Ended = jobCanceled, time.Now()
		return true
	}
	return false
}

func (q *jobQueue) setProgress(id string, p float64) {
	q.mu.Lock()
	defer q.mu.Unlock()
	if j := q.jobs[id]; j != nil && p > j.Progress {
		j.Progress = p
	}
}

// jobsHandler — GET /api/jobs  returns the queue, running and recently finished.
func (s *server) jobsHandler(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, map[string]any{"jobs": s.jobs.list()})
}

// jobCancelHandler — POST /api/jobs/cancel  body: {id}
func (s *server) jobCancelHandler(w http.ResponseWriter, r *http.Request) {
	var body struct{ ID string }
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		jsonErr(w, "bad request", http.StatusBadRequest)
		return
	}
	if !s.jobs.cancel(body.ID) {
		jsonErr(w, "that job already finished", http.StatusConflict)
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
}

// videoPreset names the height a transcode targets; the width follows the source's aspect.
var videoPresets = map[string]int{"720p": 720, "1080p": 1080, "1440p": 1440}

// resizeVideoHandler — POST /api/media/resize-video
// body: {path, preset, crf, replace}
func (s *server) resizeVideoHandler(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Path    string `json:"path"`
		Preset  string `json:"preset"`
		CRF     int    `json:"crf"`
		Replace bool   `json:"replace"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		jsonErr(w, "bad request", http.StatusBadRequest)
		return
	}
	height, ok := videoPresets[body.Preset]
	if !ok {
		jsonErr(w, "unknown size preset", http.StatusBadRequest)
		return
	}
	// Below 18 the file stops shrinking; above 30 the artefacts are obvious.
	if body.CRF < 18 || body.CRF > 30 {
		jsonErr(w, "quality must be between 18 and 30", http.StatusBadRequest)
		return
	}
	if s.thumbs.ffmpeg == "" {
		jsonErr(w, "ffmpeg is not installed on the server", http.StatusServiceUnavailable)
		return
	}

	abs, err := s.localEditTarget(r, body.Path, videoThumbExts)
	if err != nil {
		jsonErr(w, err.Error(), editStatus(err))
		return
	}
	fi, err := os.Stat(abs)
	if err != nil {
		jsonErr(w, "not found", http.StatusNotFound)
		return
	}

	j := &job{
		Kind:   "video-resize",
		Path:   s.relOf(abs),
		Name:   filepath.Base(abs),
		InSize: fi.Size(),
	}
	j.run = func(j *job) error {
		out := suffixedName(filepath.Base(abs), "-resized", ".mp4")
		saved, err := s.commitEdit(abs, out, body.Replace, func(dst string) error {
			return s.transcodeVideo(j, abs, dst, height, body.CRF)
		})
		if err != nil {
			return err
		}
		os.Chtimes(saved, fi.ModTime(), fi.ModTime())
		s.thumbs.invalidateFolder(filepath.Dir(saved))

		s.jobs.mu.Lock()
		j.Output = s.relOf(saved)
		if o, err := os.Stat(saved); err == nil {
			j.OutSize = o.Size()
		}
		s.jobs.mu.Unlock()
		return nil
	}
	if err := s.jobs.add(j); err != nil {
		jsonErr(w, err.Error(), http.StatusTooManyRequests)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"status": "ok", "id": j.ID})
}

// transcodeVideo re-encodes to H.264/AAC: H.264 decodes in hardware where HEVC often doesn't.
func (s *server) transcodeVideo(j *job, src, dst string, height, crf int) error {
	total := 0
	if s.thumbs.ffprobe != "" {
		total = ffprobeDuration(s.thumbs.ffprobe, src)
	}

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	s.jobs.mu.Lock()
	// The queue's cancel fires this one; the worker's timeout context still bounds the whole job.
	prev := j.cancel
	j.cancel = func() {
		cancel()
		if prev != nil {
			prev()
		}
	}
	s.jobs.mu.Unlock()

	// Only ever scale down, and keep the height even: H.264 chroma needs a multiple of 2.
	scale := fmt.Sprintf("scale=-2:'min(%d,ih)'", height)
	cmd := exec.CommandContext(ctx, s.thumbs.ffmpeg, "-nostdin", "-v", "error",
		"-i", src,
		"-vf", scale,
		"-c:v", "libx264", "-preset", "medium", "-crf", strconv.Itoa(crf),
		"-pix_fmt", "yuv420p",
		"-c:a", "aac", "-b:a", "128k",
		// Rotation lives in a side-data tag that the filter graph consumes; keep the timestamps sane.
		"-movflags", "+faststart",
		"-map_metadata", "0",
		"-progress", "pipe:1", "-nostats",
		"-f", "mp4", "-y", dst)

	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return err
	}
	var stderr strings.Builder
	cmd.Stderr = &stderr
	if err := cmd.Start(); err != nil {
		return err
	}
	readFFmpegProgress(stdout, total, func(p float64) { s.jobs.setProgress(j.ID, p) })
	if err := cmd.Wait(); err != nil {
		if ctx.Err() != nil {
			return fmt.Errorf("canceled")
		}
		if msg := strings.TrimSpace(stderr.String()); msg != "" {
			return fmt.Errorf("ffmpeg: %s", strings.ReplaceAll(msg, "\n", "; "))
		}
		return err
	}
	return nil
}

// readFFmpegProgress turns -progress key=value output into a 0-1 fraction of the known length.
func readFFmpegProgress(r io.Reader, totalSecs int, report func(float64)) {
	sc := bufio.NewScanner(r)
	for sc.Scan() {
		key, value, ok := strings.Cut(strings.TrimSpace(sc.Text()), "=")
		if !ok || key != "out_time_us" || totalSecs <= 0 {
			continue
		}
		us, err := strconv.ParseFloat(value, 64)
		if err != nil {
			continue
		}
		p := us / 1e6 / float64(totalSecs)
		if p > 0.99 {
			p = 0.99 // the last percent is the muxer flushing; done is what the worker sets
		}
		if p > 0 {
			report(p)
		}
	}
}
