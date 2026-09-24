//go:build linux || darwin

package tidaldl

import "syscall"

// freeBytes reports the space available to unprivileged writers on the
// filesystem holding path.
func freeBytes(path string) (uint64, bool) {
	var st syscall.Statfs_t
	if err := syscall.Statfs(path, &st); err != nil {
		return 0, false
	}
	return uint64(st.Bavail) * uint64(st.Bsize), true
}
