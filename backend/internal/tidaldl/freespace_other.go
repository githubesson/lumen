//go:build !(linux || darwin)

package tidaldl

// freeBytes is unknown here; the free-space floor is skipped.
func freeBytes(string) (uint64, bool) { return 0, false }
