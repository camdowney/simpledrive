package handler

import (
	"encoding/binary"
	"io"
	"time"
)

// QuickTime timestamps count seconds from 1904-01-01 UTC, not the Unix epoch.
var qtEpoch = time.Date(1904, 1, 1, 0, 0, 0, 0, time.UTC)

// readVideoMeta fills capture time (clamped like EXIF) and duration from the movie header.
func readVideoMeta(ra io.ReaderAt, size int64, modTime time.Time, meta *fileMeta) {
	buf, n, ok := mp4Mvhd(ra, size)
	if !ok {
		return
	}
	if t, ok := mvhdCreationTime(buf); ok {
		meta.DateTaken = clampedRFC3339(t, modTime)
	}
	meta.Duration = mvhdDurationSecs(buf, n)
}

// mp4CreationTime returns the recording time stored in a MOV/MP4's moov/mvhd box.
func mp4CreationTime(ra io.ReaderAt, size int64) (time.Time, bool) {
	buf, _, ok := mp4Mvhd(ra, size)
	if !ok {
		return time.Time{}, false
	}
	return mvhdCreationTime(buf)
}

// mp4Mvhd reads up to 32 bytes of moov/mvhd payload — enough for either version's duration.
func mp4Mvhd(ra io.ReaderAt, size int64) ([32]byte, int, bool) {
	var buf [32]byte
	moovOff, moovEnd, ok := mp4FindBox(ra, 0, size, "moov")
	if !ok {
		return buf, 0, false
	}
	mvhdOff, mvhdEnd, ok := mp4FindBox(ra, moovOff, moovEnd, "mvhd")
	if !ok {
		return buf, 0, false
	}
	// Clamp to the box so a short payload can't hand back the next box's bytes as fields.
	want := int64(len(buf))
	if mvhdOff+want > mvhdEnd {
		want = mvhdEnd - mvhdOff
	}
	if want < 12 {
		return buf, 0, false
	}
	n, err := ra.ReadAt(buf[:want], mvhdOff)
	if err != nil && err != io.EOF {
		return buf, 0, false
	}
	return buf, n, n >= 12
}

func mvhdCreationTime(buf [32]byte) (time.Time, bool) {
	var secs int64
	if buf[0] == 1 {
		secs = int64(binary.BigEndian.Uint64(buf[4:12]))
	} else {
		secs = int64(binary.BigEndian.Uint32(buf[4:8]))
	}
	t := qtEpoch.Add(time.Duration(secs) * time.Second)
	// Muxers that don't know the date write 0 (or near-epoch garbage); treat those as absent.
	if secs <= 0 || t.Year() < 1971 {
		return time.Time{}, false
	}
	return t, true
}

// mvhdDurationSecs rounds the header's duration/timescale to whole seconds; 0 means unknown.
func mvhdDurationSecs(buf [32]byte, n int) int {
	var scale uint32
	var dur uint64
	if buf[0] == 1 {
		if n < 32 {
			return 0
		}
		scale = binary.BigEndian.Uint32(buf[20:24])
		dur = binary.BigEndian.Uint64(buf[24:32])
		// All-ones means the muxer didn't know the length.
		if dur == ^uint64(0) {
			return 0
		}
	} else {
		if n < 20 {
			return 0
		}
		scale = binary.BigEndian.Uint32(buf[12:16])
		d := binary.BigEndian.Uint32(buf[16:20])
		if d == ^uint32(0) {
			return 0
		}
		dur = uint64(d)
	}
	if scale == 0 || dur == 0 {
		return 0
	}
	secs := (dur + uint64(scale)/2) / uint64(scale)
	if secs == 0 {
		return 1
	}
	return int(secs)
}

// mp4FindBox scans the boxes in [off, end) for one named name, returning its payload bounds.
func mp4FindBox(ra io.ReaderAt, off, end int64, name string) (int64, int64, bool) {
	var hdr [16]byte
	for off+8 <= end {
		if _, err := ra.ReadAt(hdr[:8], off); err != nil {
			return 0, 0, false
		}
		size := int64(binary.BigEndian.Uint32(hdr[:4]))
		hdrLen := int64(8)
		switch size {
		case 0: // box runs to end of file
			size = end - off
		case 1: // 64-bit size follows the type
			if _, err := ra.ReadAt(hdr[8:16], off+8); err != nil {
				return 0, 0, false
			}
			size = int64(binary.BigEndian.Uint64(hdr[8:16]))
			hdrLen = 16
		}
		if size < hdrLen || size > end-off {
			return 0, 0, false
		}
		if string(hdr[4:8]) == name {
			return off + hdrLen, off + size, true
		}
		off += size
	}
	return 0, 0, false
}
