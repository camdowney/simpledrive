//go:build !linux

package handler

import "time"

func fileCreated(string) (time.Time, bool) {
	return time.Time{}, false
}
