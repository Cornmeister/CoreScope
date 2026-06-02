package main

import (
	"net/http"
	"net/http/httptest"
	"strconv"
	"sync/atomic"
	"testing"
	"time"
)

// serveCount drives a singleKeyByteCache.serve and returns the response body,
// counting how many times build() actually ran (a DB recompute in production).
func serveOnce(c *singleKeyByteCache, opts serveOpts, ttl time.Duration, fresh bool, builds *int32) string {
	req := httptest.NewRequest(http.MethodGet, "/api/observers", nil)
	if fresh {
		req.Header.Set("X-Fresh", "1")
	}
	rec := httptest.NewRecorder()
	c.serve(rec, req, ttl, "test", opts, func() ([]byte, error) {
		n := atomic.AddInt32(builds, 1)
		return []byte(`{"build":` + strconv.Itoa(int(n)) + `}`), nil
	})
	return rec.Body.String()
}

// TestFreshFloorBypass verifies that a fresh request (X-Fresh: 1) ignores the
// long TTL once the cached payload is older than FreshFloor, while normal
// requests keep serving the cached payload — the core of the "live Observers
// list without hammering the DB" behavior.
func TestFreshFloorBypass(t *testing.T) {
	var c singleKeyByteCache
	var builds int32
	const ttl = 30 * time.Second
	opts := serveOpts{CacheControl: "private, max-age=5", FreshFloor: 50 * time.Millisecond}

	// First call builds and caches.
	if got := serveOnce(&c, opts, ttl, false, &builds); got != `{"build":1}` {
		t.Fatalf("first build: got %s", got)
	}
	if builds != 1 {
		t.Fatalf("expected 1 build, got %d", builds)
	}

	// A normal request within TTL serves the cached payload (no rebuild).
	if got := serveOnce(&c, opts, ttl, false, &builds); got != `{"build":1}` || builds != 1 {
		t.Fatalf("normal request should hit cache: got %s, builds %d", got, builds)
	}

	// A fresh request while the payload is still younger than FreshFloor also
	// serves the cache — this is what bounds load under a packet burst.
	if got := serveOnce(&c, opts, ttl, true, &builds); got != `{"build":1}` || builds != 1 {
		t.Fatalf("fresh request within floor should hit cache: got %s, builds %d", got, builds)
	}

	// Once older than FreshFloor, a fresh request rebuilds even though the TTL
	// is far from expired.
	time.Sleep(60 * time.Millisecond)
	if got := serveOnce(&c, opts, ttl, true, &builds); got != `{"build":2}` || builds != 2 {
		t.Fatalf("fresh request past floor should rebuild: got %s, builds %d", got, builds)
	}

	// And a normal request still serves the now-current payload from cache.
	if got := serveOnce(&c, opts, ttl, false, &builds); got != `{"build":2}` || builds != 2 {
		t.Fatalf("normal request after rebuild should hit cache: got %s, builds %d", got, builds)
	}
}

// TestFreshRequestNoStore verifies fresh responses carry Cache-Control: no-store
// so the browser can't re-cache a forced/live refresh, while normal responses
// keep their configured caching header.
func TestFreshRequestNoStore(t *testing.T) {
	var c singleKeyByteCache
	var builds int32
	opts := serveOpts{CacheControl: "private, max-age=5, stale-while-revalidate=15", FreshFloor: 3 * time.Second}

	// Normal request keeps the configured header.
	req := httptest.NewRequest(http.MethodGet, "/api/observers", nil)
	rec := httptest.NewRecorder()
	c.serve(rec, req, 30*time.Second, "test", opts, func() ([]byte, error) {
		atomic.AddInt32(&builds, 1)
		return []byte(`{}`), nil
	})
	if cc := rec.Header().Get("Cache-Control"); cc != "private, max-age=5, stale-while-revalidate=15" {
		t.Fatalf("normal Cache-Control: got %q", cc)
	}

	// Fresh request gets no-store.
	freshReq := httptest.NewRequest(http.MethodGet, "/api/observers", nil)
	freshReq.Header.Set("X-Fresh", "1")
	freshRec := httptest.NewRecorder()
	c.serve(freshRec, freshReq, 30*time.Second, "test", opts, func() ([]byte, error) {
		atomic.AddInt32(&builds, 1)
		return []byte(`{}`), nil
	})
	if cc := freshRec.Header().Get("Cache-Control"); cc != "no-store" {
		t.Fatalf("fresh Cache-Control: got %q, want no-store", cc)
	}
}

// TestFreshFloorZeroIgnored verifies that without a FreshFloor, an X-Fresh header
// has no effect — endpoints that don't opt in keep their normal TTL semantics.
func TestFreshFloorZeroIgnored(t *testing.T) {
	var c singleKeyByteCache
	var builds int32
	opts := serveOpts{CacheControl: "private, max-age=5"} // FreshFloor == 0

	serveOnce(&c, opts, 30*time.Second, false, &builds)
	// Fresh header present but no FreshFloor configured: must still hit cache.
	if got := serveOnce(&c, opts, 30*time.Second, true, &builds); got != `{"build":1}` || builds != 1 {
		t.Fatalf("fresh without FreshFloor should be ignored: got %s, builds %d", got, builds)
	}
}
