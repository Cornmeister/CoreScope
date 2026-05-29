package main

import (
	"runtime/debug"
	"testing"
)

// stubDetection forces the machine-detection helpers to fixed values for the
// duration of a test (restored on cleanup), so derivation precedence is
// deterministic regardless of the host/CI environment.
func stubDetection(t *testing.T, cgroup, host int64) {
	t.Helper()
	origCg, origHost := cgroupMemoryLimitFn, hostMemTotalFn
	cgroupMemoryLimitFn = func() int64 { return cgroup }
	hostMemTotalFn = func() int64 { return host }
	t.Cleanup(func() {
		cgroupMemoryLimitFn, hostMemTotalFn = origCg, origHost
	})
}

func TestApplyMemoryLimit_FromEnv(t *testing.T) {
	t.Setenv("GOMEMLIMIT", "850MiB")
	defer debug.SetMemoryLimit(-1)

	limit, source := applyMemoryLimit(512, true /* envSet */)
	if source != "env" {
		t.Fatalf("expected source=env, got %q", source)
	}
	// When env is set, our function must NOT override it; reported limit is 0.
	if limit != 0 {
		t.Fatalf("expected limit=0 (not set by us), got %d", limit)
	}
}

func TestApplyMemoryLimit_Cgroup(t *testing.T) {
	defer debug.SetMemoryLimit(-1)
	stubDetection(t, 4*1024*1024*1024, 8*1024*1024*1024) // 4 GiB container on an 8 GiB host

	limit, source := applyMemoryLimit(1024, false)
	if source != "cgroup" {
		t.Fatalf("expected source=cgroup, got %q", source)
	}
	want := int64(4*1024*1024*1024) * 9 / 10 // 90% of the cgroup cap
	if limit != want {
		t.Fatalf("expected limit=%d, got %d", want, limit)
	}
}

func TestApplyMemoryLimit_CgroupFloor(t *testing.T) {
	defer debug.SetMemoryLimit(-1)
	// Tiny cgroup cap (512 MiB); 90% = 460 MiB is below the store floor
	// (1024 * 1.5 = 1536 MiB) — must not starve the configured store budget.
	stubDetection(t, 512*1024*1024, 8*1024*1024*1024)

	limit, source := applyMemoryLimit(1024, false)
	if source != "cgroup" {
		t.Fatalf("expected source=cgroup, got %q", source)
	}
	floor := int64(1024) * 1024 * 1024 * 3 / 2
	if limit != floor {
		t.Fatalf("expected floor=%d, got %d", floor, limit)
	}
}

func TestApplyMemoryLimit_HostFallback(t *testing.T) {
	defer debug.SetMemoryLimit(-1)
	stubDetection(t, 0 /* no cgroup cap */, 8*1024*1024*1024) // 8 GiB host

	limit, source := applyMemoryLimit(1024, false)
	if source != "host" {
		t.Fatalf("expected source=host, got %q", source)
	}
	want := int64(8*1024*1024*1024) / 2 // 50% of host RAM (reserve is 1 GiB, not binding here)
	if limit != want {
		t.Fatalf("expected limit=%d, got %d", want, limit)
	}
}

func TestApplyMemoryLimit_HostReserve(t *testing.T) {
	defer debug.SetMemoryLimit(-1)
	// Small host (1.5 GiB): 50% = 768 MiB, but that leaves <1 GiB reserve, so
	// the 1 GiB reserve binds → limit = 1.5 GiB - 1 GiB = 512 MiB. That's below
	// the store floor (0 here since maxMemoryMB=0), so it stays at 512 MiB.
	stubDetection(t, 0, 3*1024*1024*1024/2)

	limit, source := applyMemoryLimit(0, false)
	if source != "host" {
		t.Fatalf("expected source=host, got %q", source)
	}
	want := int64(3*1024*1024*1024/2) - (int64(1) << 30)
	if limit != want {
		t.Fatalf("expected limit=%d (host - 1GiB reserve), got %d", want, limit)
	}
}

func TestApplyMemoryLimit_DerivedFromMaxMemoryMB(t *testing.T) {
	defer debug.SetMemoryLimit(-1)
	stubDetection(t, 0, 0) // no cgroup, no host info → legacy derivation

	limit, source := applyMemoryLimit(512, false)
	if source != "derived" {
		t.Fatalf("expected source=derived, got %q", source)
	}
	want := int64(768) * 1024 * 1024 // 512 * 1.5
	if limit != want {
		t.Fatalf("expected limit=%d, got %d", want, limit)
	}
	if cur := debug.SetMemoryLimit(-1); cur != want {
		t.Fatalf("runtime memory limit not set: want=%d got=%d", want, cur)
	}
}

func TestApplyMemoryLimit_None(t *testing.T) {
	defer debug.SetMemoryLimit(-1)
	debug.SetMemoryLimit(int64(1<<63 - 1)) // reset to "no limit"
	stubDetection(t, 0, 0)

	limit, source := applyMemoryLimit(0, false)
	if source != "none" {
		t.Fatalf("expected source=none, got %q", source)
	}
	if limit != 0 {
		t.Fatalf("expected limit=0, got %d", limit)
	}
}

func TestIsSaneLimit(t *testing.T) {
	cases := []struct {
		v    int64
		want bool
	}{
		{0, false},
		{-1, false},
		{512 * 1024 * 1024, true},
		{int64(1) << 50, false},            // 1 PiB sentinel → "unlimited"
		{int64(0x7FFFFFFFFFFFF000), false}, // cgroup v1 unlimited sentinel
	}
	for _, c := range cases {
		if got := isSaneLimit(c.v); got != c.want {
			t.Errorf("isSaneLimit(%d)=%v, want %v", c.v, got, c.want)
		}
	}
}
