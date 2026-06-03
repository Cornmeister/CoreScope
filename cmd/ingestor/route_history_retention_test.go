package main

import (
	"testing"
	"time"
)

// TestPruneRouteHistoryEdgesDecoupledWindows verifies the raw edge table and the
// hourly aggregate are pruned on INDEPENDENT windows: raw edges short, hourly
// (the rendered/displayable table) long. This is what lets the route-history map
// keep its full time range while the heavy raw table stays small.
func TestPruneRouteHistoryEdgesDecoupledWindows(t *testing.T) {
	store, err := OpenStore(tempDBPath(t))
	if err != nil {
		t.Fatalf("OpenStore: %v", err)
	}
	defer store.Close()

	now := time.Now().UTC()
	rfc := func(d time.Duration) string { return now.Add(-d).Format(time.RFC3339) }
	bucket := func(d time.Duration) int64 { return now.Add(-d).Truncate(time.Hour).Unix() }

	// Raw edges: one 5 days old, one 1 day old.
	if _, err := store.db.Exec(`INSERT INTO route_history_edges
		(observation_id, hop_index, bucket_start, node_a, node_b, packet_hash, last_seen)
		VALUES (1,0,?,?,?,?,?), (2,0,?,?,?,?,?)`,
		bucket(5*24*time.Hour), "a", "b", "h1", rfc(5*24*time.Hour),
		bucket(24*time.Hour), "a", "b", "h2", rfc(24*time.Hour)); err != nil {
		t.Fatalf("seed edges: %v", err)
	}
	// Hourly aggregate: one 10 days old, one 1 day old.
	if _, err := store.db.Exec(`INSERT INTO route_history_edge_hourly
		(bucket_start, node_a, node_b, count, last_seen, sample1)
		VALUES (?,?,?,1,?,?), (?,?,?,1,?,?)`,
		bucket(10*24*time.Hour), "a", "b", rfc(10*24*time.Hour), "h0",
		bucket(24*time.Hour), "c", "d", rfc(24*time.Hour), "h2"); err != nil {
		t.Fatalf("seed hourly: %v", err)
	}

	// edges retention 2 days, hourly retention 8 days.
	if _, err := store.pruneRouteHistoryEdges(2, 8); err != nil {
		t.Fatalf("prune: %v", err)
	}

	var edges, hourly int
	store.db.QueryRow(`SELECT COUNT(*) FROM route_history_edges`).Scan(&edges)
	store.db.QueryRow(`SELECT COUNT(*) FROM route_history_edge_hourly`).Scan(&hourly)

	// Raw edge older than 2d gone, 1d kept.
	if edges != 1 {
		t.Errorf("route_history_edges: got %d, want 1 (5d pruned, 1d kept)", edges)
	}
	// Hourly: 10d gone (>8d), 1d kept — the displayable aggregate survives far
	// longer than the raw edges.
	if hourly != 1 {
		t.Errorf("route_history_edge_hourly: got %d, want 1 (10d pruned, 1d kept)", hourly)
	}
}

// TestRouteHistoryBackfillLookbackClampedBelowEdgeRetention guards the count
// double-increment invariant: the backfill must never replay observations whose
// raw edges have already been pruned (that would re-increment the hourly count),
// so its lookback is clamped strictly below the edge-retention window.
func TestRouteHistoryBackfillLookbackClampedBelowEdgeRetention(t *testing.T) {
	days := func(n int) time.Duration { return time.Duration(n) * 24 * time.Hour }

	// edgeRetention=2, requested backfill=7 → clamp to 1 day (edgeRetention-1).
	cfg := &Config{RouteHistory: &RouteHistoryConfig{EdgeRetentionDays: 2, BackfillDays: 7}}
	got := cfg.RouteHistoryBackfillSettings()
	if got.Lookback != days(1) {
		t.Errorf("lookback: got %v, want 1d (clamped below edgeRetention=2)", got.Lookback)
	}
	if got.EdgeRetentionDays != 2 || got.HourlyRetentionDays != 8 {
		t.Errorf("retentions: edge=%d hourly=%d, want 2/8", got.EdgeRetentionDays, got.HourlyRetentionDays)
	}

	// Larger edge retention leaves a larger backfill window intact (7 < 8 ok).
	cfg2 := &Config{RouteHistory: &RouteHistoryConfig{EdgeRetentionDays: 8, BackfillDays: 7}}
	if got2 := cfg2.RouteHistoryBackfillSettings(); got2.Lookback != days(7) {
		t.Errorf("lookback: got %v, want 7d (7 < 8, not clamped)", got2.Lookback)
	}

	// Defaults: edge=2, hourly=8, backfill lookback clamped to 1d.
	def := (&Config{}).RouteHistoryBackfillSettings()
	if def.EdgeRetentionDays != 2 || def.HourlyRetentionDays != 8 || def.Lookback != days(1) {
		t.Errorf("defaults: edge=%d hourly=%d lookback=%v, want 2/8/1d",
			def.EdgeRetentionDays, def.HourlyRetentionDays, def.Lookback)
	}
}
