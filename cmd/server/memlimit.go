package main

import (
	"log"
	"os"
	"runtime/debug"
	"strconv"
	"strings"
)

// cgroupUnlimitedThreshold is the sentinel above which a cgroup memory value
// means "no limit". cgroup v1 encodes unlimited as math.MaxInt64 (page-aligned
// near 1<<63); 1<<62 is a safe upper bound that excludes all real limits while
// staying well below the unlimited sentinel.
const cgroupUnlimitedThreshold = int64(1 << 62)

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

// memlimitUnderprovisioned reports whether effectiveMB is less than half of
// cgroupMB. Extracted for unit testing the comparison boundary.
func memlimitUnderprovisioned(effectiveMB, cgroupMB int64) bool {
	return effectiveMB > 0 && cgroupMB > 0 && effectiveMB*2 < cgroupMB
}

// warnIfMemlimitUnderprovisioned logs a warning when GOMEMLIMIT is below 50%
// of the container cgroup memory limit, which causes the Go GC to thrash.
// In one reported incident (#1264) 82% of CPU was GC with a 1536 MiB limit
// on a 7.7 GB container — all endpoints 3-100x slower until maxMemoryMB was
// bumped and the process restarted.
//
// limitBytes is the value returned by applyMemoryLimit:
//   - source="derived"/"cgroup"/"host": the limit we set ourselves (> 0)
//   - source="env":  0 — we did not touch the runtime; read it back below
//   - source="none": 0 — no limit set at all; runtime default is math.MaxInt64,
//     which the >= cgroupUnlimitedThreshold guard below catches and skips
func warnIfMemlimitUnderprovisioned(limitBytes int64) {
	cgroupBytes := cgroupMemoryLimitFn()
	if cgroupBytes <= 0 {
		return
	}
	cgroupMB := cgroupBytes / (1024 * 1024)
	effective := limitBytes
	if effective <= 0 {
		// Either GOMEMLIMIT was set via env (source="env") or no limit was
		// configured (source="none"). Read the runtime's current value:
		// debug.SetMemoryLimit(-1) leaves the limit unchanged and returns it.
		effective = debug.SetMemoryLimit(-1)
	}
	if effective <= 0 || effective >= cgroupUnlimitedThreshold {
		return
	}
	effectiveMB := effective / (1024 * 1024)
	if memlimitUnderprovisioned(effectiveMB, cgroupMB) {
		log.Printf("[memlimit] WARN: GOMEMLIMIT=%d MiB is <50%% of container limit %d MiB — "+
			"GC may thrash under load; consider bumping packetStore.maxMemoryMB "+
			"(suggested: ~%d MiB, roughly 2/3 of container limit)",
			effectiveMB, cgroupMB, cgroupMB*2/3)
	}
}
