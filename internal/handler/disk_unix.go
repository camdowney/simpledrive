//go:build linux || darwin

package handler

import "golang.org/x/sys/unix"

// diskUsage reports the capacity of the filesystem holding path, in bytes.
func diskUsage(path string) (total, free int64, ok bool) {
	var st unix.Statfs_t
	if err := unix.Statfs(path, &st); err != nil {
		return 0, 0, false
	}
	// Bavail, not Bfree: the blocks reserved for root are not space the drive can actually use.
	return int64(st.Blocks) * int64(st.Bsize), int64(st.Bavail) * int64(st.Bsize), true
}
