package main

import (
	"encoding/json"
	"log"
	"strings"
	"sync"
	"time"
)

// RouteHistoryBuilderInterval is how often the ingestor derives route-history
// edge events from observations. The server aggregates this table directly.
const RouteHistoryBuilderInterval = 60 * time.Second

const (
	// routeHistoryBackfillLookback is how far back the startup backfill fills
	// route-history. It MUST stay strictly below defaultRouteHistoryEdgeRetentionDays:
	// the backfill replays observations into route_history_edges (INSERT OR IGNORE),
	// and the hourly aggregate's count only increments when a raw edge is NEW. If
	// the backfill replayed observations whose raw edges were already pruned, the
	// hourly counts would double. config.RouteHistoryBackfillSettings clamps this.
	routeHistoryBackfillLookback = 24 * time.Hour
	routeHistoryBackfillWindow   = time.Hour
	routeHistoryBackfillPause    = 2 * time.Second

	// Retention windows are decoupled (issue: 46 GB prod DB). The raw
	// route_history_edges table is only a build intermediate + per-observation
	// idempotency guard, so it is kept short. The route_history_edge_hourly
	// aggregate is what the server renders (buildRouteHistoryPayload prefers it),
	// so it carries the full displayable window.
	defaultRouteHistoryEdgeRetentionDays   = 2
	defaultRouteHistoryHourlyRetentionDays = 8
)

type routeHistoryEdgeRow struct {
	obsID       int64
	hopIndex    int
	bucketStart int64
	a, b        string
	hash        string
	lastSeen    string
}

func (s *Store) StartRouteHistoryBuilder(interval time.Duration) func() {
	if interval <= 0 {
		interval = RouteHistoryBuilderInterval
	}
	stop := make(chan struct{})
	done := make(chan struct{})
	backfillDone := make(chan struct{})

	var stopOnce sync.Once
	go func() {
		defer close(done)
		// Do not scan the full 7-day route-history window at startup. On large
		// DBs that monopolized the ingestor for minutes and prevented MQTT
		// callbacks from flowing. Keep the live edge warm with a small recent
		// window; the historical window is backfilled below in bounded chunks.
		initialSince := time.Now().Add(-2 * interval).Unix()
		if n, err := s.buildAndPersistRouteHistoryEdges(initialSince); err != nil {
			log.Printf("[route-history-build] initial build error: %v", err)
		} else {
			log.Printf("[route-history-build] initial build: %d edge events inserted", n)
		}
		if n, err := s.pruneRouteHistoryEdges(defaultRouteHistoryEdgeRetentionDays, defaultRouteHistoryHourlyRetentionDays); err != nil {
			log.Printf("[route-history-build] initial prune error: %v", err)
		} else if n > 0 {
			log.Printf("[route-history-build] initial prune removed %d old edge events", n)
		}

		t := time.NewTicker(interval)
		defer t.Stop()
		lastBuildAt := time.Now().Add(-2 * interval)
		lastPruneAt := time.Now()
		for {
			select {
			case <-t.C:
				sinceUnix := lastBuildAt.Add(-10 * time.Second).Unix()
				lastBuildAt = time.Now()
				if n, err := s.buildAndPersistRouteHistoryEdges(sinceUnix); err != nil {
					log.Printf("[route-history-build] tick error: %v", err)
				} else if n > 0 {
					log.Printf("[route-history-build] %d edge events inserted", n)
				}
				if time.Since(lastPruneAt) >= 24*time.Hour {
					lastPruneAt = time.Now()
					if n, err := s.pruneRouteHistoryEdges(defaultRouteHistoryEdgeRetentionDays, defaultRouteHistoryHourlyRetentionDays); err != nil {
						log.Printf("[route-history-build] prune error: %v", err)
					} else if n > 0 {
						log.Printf("[route-history-build] pruned %d old edge events", n)
					}
				}
			case <-stop:
				return
			}
		}
	}()

	go func() {
		defer close(backfillDone)
		s.backfillRouteHistoryEdges(stop, time.Now(), routeHistoryBackfillLookback, routeHistoryBackfillWindow, routeHistoryBackfillPause)
	}()

	return func() {
		stopOnce.Do(func() { close(stop) })
		select {
		case <-done:
		case <-time.After(5 * time.Second):
		}
		select {
		case <-backfillDone:
		case <-time.After(5 * time.Second):
		}
	}
}

func (s *Store) buildAndPersistRouteHistoryEdges(sinceUnix int64) (int, error) {
	return s.buildAndPersistRouteHistoryEdgesWindow(sinceUnix, 0)
}

func (s *Store) buildAndPersistRouteHistoryEdgesWindow(sinceUnix, untilUnix int64) (int, error) {
	res, err := s.buildAndPersistDerivedEdgesWindow(sinceUnix, untilUnix, derivedEdgesBuildOptions{RouteHistory: true})
	if err != nil {
		return 0, err
	}
	return res.RouteHistoryEdges, nil
}

func (s *Store) backfillRouteHistoryEdges(stop <-chan struct{}, now time.Time, lookback, window, pause time.Duration) {
	if lookback <= 0 || window <= 0 {
		return
	}
	end := now.UTC().Truncate(time.Hour)
	start := end.Add(-lookback)
	total := 0
	for cursor := end.Add(-window); !cursor.Before(start); cursor = cursor.Add(-window) {
		select {
		case <-stop:
			return
		default:
		}
		until := cursor.Add(window)
		n, err := s.buildAndPersistRouteHistoryEdgesWindow(cursor.Unix(), until.Unix())
		if err != nil {
			log.Printf("[route-history-build] backfill window [%s, %s) error: %v",
				cursor.Format(time.RFC3339), until.Format(time.RFC3339), err)
		} else {
			total += n
			if n > 0 {
				log.Printf("[route-history-build] backfill window [%s, %s): %d edge events inserted",
					cursor.Format(time.RFC3339), until.Format(time.RFC3339), n)
			}
		}
		select {
		case <-stop:
			return
		case <-time.After(pause):
		}
	}
	log.Printf("[route-history-build] backfill complete: %d edge events inserted", total)
}

// pruneRouteHistoryEdges deletes from the two route-history tables on
// INDEPENDENT windows: the raw per-observation edges (edgeDays, short) and the
// hourly aggregate that the UI renders (hourlyDays, long). Decoupling them lets
// the displayed route-history keep its full time range while the heavy raw
// table — which is only a build intermediate + idempotency guard — stays small.
// Returns the number of raw edge rows deleted.
func (s *Store) pruneRouteHistoryEdges(edgeDays, hourlyDays int) (int64, error) {
	if edgeDays <= 0 {
		edgeDays = defaultRouteHistoryEdgeRetentionDays
	}
	if hourlyDays <= 0 {
		hourlyDays = defaultRouteHistoryHourlyRetentionDays
	}
	edgeCutoff := time.Now().UTC().Add(-time.Duration(edgeDays) * 24 * time.Hour).Format(time.RFC3339)
	res, err := s.db.Exec(`DELETE FROM route_history_edges WHERE last_seen < ?`, edgeCutoff)
	if err != nil {
		return 0, err
	}
	n, _ := res.RowsAffected()
	hourlyCutoff := time.Now().UTC().Add(-time.Duration(hourlyDays) * 24 * time.Hour).Truncate(time.Hour).Unix()
	if _, err := s.db.Exec(`DELETE FROM route_history_edge_hourly WHERE bucket_start < ?`, hourlyCutoff); err != nil {
		return n, err
	}
	return n, nil
}

func parseRouteHistoryPath(resolvedPath, pathJSON string, idx prefixIndex) []string {
	if path := parseStringPathArray(resolvedPath); len(path) >= 2 {
		out := make([]string, 0, len(path))
		for _, hop := range path {
			h := strings.ToLower(strings.TrimSpace(hop))
			if h != "" {
				out = append(out, h)
			}
		}
		return out
	}
	raw := parseStringPathArray(pathJSON)
	if len(raw) < 2 {
		return nil
	}
	out := make([]string, 0, len(raw))
	for _, hop := range raw {
		resolved, ok := resolvePrefix(idx, hop)
		if !ok {
			out = append(out, "")
			continue
		}
		out = append(out, resolved)
	}
	return out
}

func parseStringPathArray(s string) []string {
	if s == "" || s == "[]" {
		return nil
	}
	var arr []string
	if json.Unmarshal([]byte(s), &arr) == nil {
		return arr
	}
	var nullable []*string
	if json.Unmarshal([]byte(s), &nullable) != nil {
		return nil
	}
	out := make([]string, 0, len(nullable))
	for _, p := range nullable {
		if p == nil {
			out = append(out, "")
		} else {
			out = append(out, *p)
		}
	}
	return out
}
