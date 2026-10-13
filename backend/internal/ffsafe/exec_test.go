package ffsafe

import (
	"fmt"
	"strings"
	"testing"
)

func TestTailKeepsTheEnd(t *testing.T) {
	tail := NewTail(8)
	for i := 0; i < 100; i++ {
		fmt.Fprintf(tail, "line %d\n", i)
	}
	if got := tail.String(); got != "line 99\n" {
		t.Fatalf("tail = %q", got)
	}
	big := NewTail(4)
	if n, err := big.Write([]byte(strings.Repeat("x", 100) + "abcd")); n != 104 || err != nil {
		t.Fatalf("Write = %d, %v", n, err)
	}
	if got := big.String(); got != "abcd" {
		t.Fatalf("tail = %q", got)
	}
}
