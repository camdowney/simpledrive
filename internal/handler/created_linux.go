package handler

import (
	"time"

	"golang.org/x/sys/unix"
)

// fileCreated returns a file's birth (creation) time, when the filesystem records one.
func fileCreated(abs string) (time.Time, bool) {
	var st unix.Statx_t
	if err := unix.Statx(unix.AT_FDCWD, abs, 0, unix.STATX_BTIME, &st); err != nil {
		return time.Time{}, false
	}
	if st.Mask&unix.STATX_BTIME == 0 || st.Btime.Sec == 0 {
		return time.Time{}, false
	}
	return time.Unix(st.Btime.Sec, int64(st.Btime.Nsec)), true
}
