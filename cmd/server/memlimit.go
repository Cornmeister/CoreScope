package main

import (
	"os"
	"runtime/debug"
	"strconv"
	"strings"
)

// applyMemoryLimit configures Go's soft memory limit (GOMEMLIMIT) so the
// process self-throttles GC under memory pressure instead of being SIGKILLed
// (#836) — and so it adapts to the machine it runs on instead of a hardcoded
// value.
//
// Precedence (first match wins):
//  1. "env"     — GOMEMLIMIT env var present: operator override, the runtime
//     already parsed it; we leave it alone.
//  2. "cgroup"  — a finite container memory limit (docker --memory / Coolify
//     "memory limit"): GOMEMLIMIT = 90% of it. PREFERRED: set a
//     per-environment container limit and the process auto-tunes
//     (a 2.5 GiB staging box vs a larger prod host) with no code or
//     env change.
//  3. "host"    — no container cap: derive from total host RAM, but
//     conservatively (50%, always reserving ≥1 GiB) because the
//     host may be shared with other containers. Set a container
//     limit instead for a tighter, safer fit.
//  4. "derived" — legacy fallback: packetStore.maxMemoryMB * 1.5.
//  5. "none"    — nothing to derive from.
//
// Returns the limit in bytes (0 if not set by us) and a source label.
// Indirection so tests can stub machine detection deterministically.
var (
	cgroupMemoryLimitFn = cgroupMemoryLimit
	hostMemTotalFn      = hostMemTotal
)

func applyMemoryLimit(maxMemoryMB int, envSet bool) (int64, string) {
	if envSet {
		return 0, "env"
	}

	floor := int64(maxMemoryMB) * 1024 * 1024 * 3 / 2 // store budget + 0.5x headroom

	if cg := cgroupMemoryLimitFn(); cg > 0 {
		limit := cg * 9 / 10
		if limit < floor {
			limit = floor // never starve the configured store budget
		}
		debug.SetMemoryLimit(limit)
		return limit, "cgroup"
	}

	if total := hostMemTotalFn(); total > 0 {
		const reserve = int64(1) << 30 // keep ≥1 GiB for OS + co-located processes
		limit := total / 2
		if total-limit < reserve {
			limit = total - reserve
		}
		if limit < floor {
			limit = floor
		}
		if limit > 0 {
			debug.SetMemoryLimit(limit)
			return limit, "host"
		}
	}

	if maxMemoryMB > 0 {
		debug.SetMemoryLimit(floor)
		return floor, "derived"
	}
	return 0, "none"
}

// cgroupMemoryLimit returns the container memory limit in bytes, or 0 when
// there is no finite limit (or it can't be read). Handles cgroup v2 and v1.
func cgroupMemoryLimit() int64 {
	// cgroup v2 (unified hierarchy)
	if b, err := os.ReadFile("/sys/fs/cgroup/memory.max"); err == nil {
		s := strings.TrimSpace(string(b))
		if s == "max" {
			return 0 // explicitly unlimited
		}
		if v, err := strconv.ParseInt(s, 10, 64); err == nil && isSaneLimit(v) {
			return v
		}
	}
	// cgroup v1
	if b, err := os.ReadFile("/sys/fs/cgroup/memory/memory.limit_in_bytes"); err == nil {
		if v, err := strconv.ParseInt(strings.TrimSpace(string(b)), 10, 64); err == nil && isSaneLimit(v) {
			return v
		}
	}
	return 0
}

// isSaneLimit rejects the near-max sentinel values cgroups report for
// "unlimited" (e.g. 0x7FFFFFFFFFFFF000 on cgroup v1).
func isSaneLimit(v int64) bool {
	const maxSane = int64(1) << 50 // 1 PiB; anything larger means "no limit"
	return v > 0 && v < maxSane
}

// hostMemTotal reads MemTotal from /proc/meminfo in bytes, 0 on failure.
func hostMemTotal() int64 { return meminfoField("MemTotal:") }

// hostMemAvailable reads MemAvailable from /proc/meminfo in bytes, 0 on failure.
// MemAvailable = the kernel's estimate of memory available for new allocations
// without swapping (free + reclaimable page cache), so it reflects real
// headroom on a host shared with other containers.
func hostMemAvailable() int64 { return meminfoField("MemAvailable:") }

// meminfoField returns the bytes value of a /proc/meminfo line (e.g. "MemTotal:").
func meminfoField(key string) int64 {
	b, err := os.ReadFile("/proc/meminfo")
	if err != nil {
		return 0
	}
	for _, line := range strings.Split(string(b), "\n") {
		if strings.HasPrefix(line, key) {
			fields := strings.Fields(line)
			if len(fields) >= 2 {
				if kb, err := strconv.ParseInt(fields[1], 10, 64); err == nil {
					return kb * 1024
				}
			}
		}
	}
	return 0
}
