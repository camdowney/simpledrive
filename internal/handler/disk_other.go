//go:build !linux && !darwin

package handler

func diskUsage(string) (total, free int64, ok bool) { return 0, 0, false }
