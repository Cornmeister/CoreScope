# Decision: Go Server Full API Parity

**Author:** Hicks (Backend Dev)
**Date:** 2026-03-27

## Context

The Go server (`cmd/server/`) is intended as a drop-in replacement for the Node.js server. Multiple endpoints had response shape mismatches, missing fields, and performance issues.

## Changes Made

### Performance Fix: `/api/packets?groupByHash=true` (8s → <100ms)
- **Root cause**: `QueryGroupedPackets` was scanning `packets_v` VIEW (1.2M observations) with `GROUP BY hash`
- **Fix**: Rewrite to query `transmissions` table (52K rows) directly with correlated subqueries for count/observer_count/latest. Uses same `buildTransmissionWhere` filter builder and `idx_observations_transmission_id` index as the already-fast `QueryPackets`.

### `/api/stats` — Field parity
- `totalNodes` now uses 7-day active window (was counting ALL nodes)
- Added `totalNodesAllTime` field
- `GetRoleCounts` for stats uses 7-day filter (matches Node.js `server.js` line 880-886)

### `/api/nodes` — Counts parity
- Node listing counts use `GetAllRoleCounts` (no time filter) — matches Node.js behavior
- Stats endpoint uses `GetRoleCounts` (7-day filter) — matches Node.js behavior
- Two separate methods to avoid conflating different use cases

### `/api/packets/:id` — Path data
- Now parses `path_json` and returns actual hop array in `path` field (was returning empty array)

### `/api/observers` — Live computed fields
- `packetsLastHour`: batch query via `GetObserverPacketCounts` (observations table with observer_idx join)
- `lat`, `lon`, `nodeRole`: batch lookup via `GetNodeLocations` (nodes table where public_key matches observer ID)

### `/api/observers/:id` — packetsLastHour
- Now computes actual value from observations table

### `/api/nodes/bulk-health` — Per-node stats
- `totalTransmissions`, `totalObservations`, `packetsToday`, `avgSnr`, `lastHeard` now computed from SQL
- Was returning all zeros

### `/api/packets` — Multi-node filter
- Added `nodes` query parameter support (comma-separated pubkeys)
- New `QueryMultiNodePackets` DB method

## Files Modified
- `cmd/server/db.go` — QueryGroupedPackets rewrite, GetStats, GetRoleCounts, GetAllRoleCounts, GetObserverPacketCounts, GetNodeLocations, QueryMultiNodePackets, nullStrVal, nilIfEmpty helpers
- `cmd/server/routes.go` — handlePackets (multi-node), handleObservers, handleObserverDetail, handleBulkHealth, handlePacketDetail, handleStats
- `cmd/server/db_test.go` — Dynamic timestamps in seedTestData (7-day window compat)
- `cmd/server/routes_test.go` — Updated error test to drop observations table (grouped query no longer needs packets_v)

## Remaining Stubs (Acceptable)
Analytics endpoints (topology, distance, hash-sizes, subpaths) return structural stubs with correct field names. These require in-memory packet store or complex path resolution not yet ported to Go. The frontend degrades gracefully with empty arrays.
