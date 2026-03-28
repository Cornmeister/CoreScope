'use strict';

// Test db.js functions with a temp database
const path = require('path');
const fs = require('fs');
const os = require('os');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'meshcore-db-test-'));
const dbPath = path.join(tmpDir, 'test.db');
process.env.DB_PATH = dbPath;

// Now require db.js — it will use our temp DB
const db = require('./db');

let passed = 0, failed = 0;
function assert(cond, msg) {
  if (cond) { passed++; console.log(`  ✅ ${msg}`); }
  else { failed++; console.error(`  ❌ ${msg}`); }
}

function cleanup() {
  try { db.db.close(); } catch {}
  try { fs.rmSync(tmpDir, { recursive: true }); } catch {}
}

console.log('── db.js tests ──\n');

// --- Schema ---
console.log('Schema:');
{
  const tables = db.db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(r => r.name);
  assert(tables.includes('nodes'), 'nodes table exists');
  assert(tables.includes('observers'), 'observers table exists');
  assert(tables.includes('transmissions'), 'transmissions table exists');
  assert(tables.includes('observations'), 'observations table exists');
}

// --- upsertNode ---
console.log('\nupsertNode:');
{
  db.upsertNode({ public_key: 'aabbccdd11223344aabbccdd11223344', name: 'TestNode', role: 'repeater', lat: 37.0, lon: -122.0 });
  const node = db.getNode('aabbccdd11223344aabbccdd11223344');
  assert(node !== null, 'node inserted');
  assert(node.name === 'TestNode', 'name correct');
  assert(node.role === 'repeater', 'role correct');
  assert(node.lat === 37.0, 'lat correct');

  // Update
  db.upsertNode({ public_key: 'aabbccdd11223344aabbccdd11223344', name: 'UpdatedNode', role: 'room' });
  const node2 = db.getNode('aabbccdd11223344aabbccdd11223344');
  assert(node2.name === 'UpdatedNode', 'name updated');
  assert(node2.name === 'UpdatedNode', 'name updated');
  assert(node2.advert_count === 0, 'advert_count unchanged by upsertNode');

  // advert_count only increments via incrementAdvertCount
  db.incrementAdvertCount('aabbccdd11223344aabbccdd11223344');
  const node3 = db.getNode('aabbccdd11223344aabbccdd11223344');
  assert(node3.advert_count === 1, 'advert_count incremented via incrementAdvertCount');
}

// --- upsertObserver ---
console.log('\nupsertObserver:');
{
  db.upsertObserver({ id: 'obs-1', name: 'Observer One', iata: 'SFO' });
  const observers = db.getObservers();
  assert(observers.length >= 1, 'observer inserted');
  assert(observers.some(o => o.id === 'obs-1'), 'observer found by id');
  assert(observers.find(o => o.id === 'obs-1').name === 'Observer One', 'observer name correct');

  // Upsert again
  db.upsertObserver({ id: 'obs-1', name: 'Observer Updated' });
  const obs2 = db.getObservers().find(o => o.id === 'obs-1');
  assert(obs2.name === 'Observer Updated', 'observer name updated');
  assert(obs2.packet_count === 2, 'packet_count incremented');
}

// --- updateObserverStatus ---
console.log('\nupdateObserverStatus:');
{
  db.updateObserverStatus({ id: 'obs-2', name: 'Status Observer', iata: 'LAX', model: 'T-Deck' });
  const obs = db.getObservers().find(o => o.id === 'obs-2');
  assert(obs !== null, 'observer created via status update');
  assert(obs.model === 'T-Deck', 'model set');
  assert(obs.packet_count === 0, 'packet_count stays 0 for status update');
}

// --- insertTransmission ---
console.log('\ninsertTransmission:');
{
  const result = db.insertTransmission({
    raw_hex: '0400aabbccdd',
    hash: 'hash-001',
    timestamp: '2025-01-01T00:00:00Z',
    observer_id: 'obs-1',
    observer_name: 'Observer One',
    direction: 'rx',
    snr: 10.5,
    rssi: -85,
    route_type: 1,
    payload_type: 4,
    payload_version: 1,
    path_json: '["aabb","ccdd"]',
    decoded_json: '{"type":"ADVERT","pubKey":"aabbccdd11223344aabbccdd11223344","name":"TestNode"}',
  });
  assert(result !== null, 'transmission inserted');
  assert(result.transmissionId > 0, 'has transmissionId');
  assert(result.observationId > 0, 'has observationId');

  // Duplicate hash = same transmission, new observation
  const result2 = db.insertTransmission({
    raw_hex: '0400aabbccdd',
    hash: 'hash-001',
    timestamp: '2025-01-01T00:01:00Z',
    observer_id: 'obs-2',
    observer_name: 'Observer Two',
    direction: 'rx',
    snr: 8.0,
    rssi: -90,
    route_type: 1,
    payload_type: 4,
    path_json: '["aabb"]',
    decoded_json: '{"type":"ADVERT","pubKey":"aabbccdd11223344aabbccdd11223344","name":"TestNode"}',
  });
  assert(result2.transmissionId === result.transmissionId, 'same transmissionId for duplicate hash');

  // No hash = null
  const result3 = db.insertTransmission({ raw_hex: '0400' });
  assert(result3 === null, 'no hash returns null');
}

// --- getPackets ---
console.log('\ngetPackets:');
{
  const { rows, total } = db.getPackets({ limit: 10 });
  assert(total >= 1, 'has packets');
  assert(rows.length >= 1, 'returns rows');
  assert(rows[0].hash === 'hash-001', 'correct hash');

  // Filter by type
  const { rows: r2 } = db.getPackets({ type: 4 });
  assert(r2.length >= 1, 'filter by type works');

  const { rows: r3 } = db.getPackets({ type: 99 });
  assert(r3.length === 0, 'filter by nonexistent type returns empty');

  // Filter by hash
  const { rows: r4 } = db.getPackets({ hash: 'hash-001' });
  assert(r4.length >= 1, 'filter by hash works');
}

// --- getPacket ---
console.log('\ngetPacket:');
{
  const { rows } = db.getPackets({ limit: 1 });
  const pkt = db.getPacket(rows[0].id);
  assert(pkt !== null, 'getPacket returns packet');
  assert(pkt.hash === 'hash-001', 'correct packet');

  const missing = db.getPacket(999999);
  assert(missing === null, 'missing packet returns null');
}

// --- getTransmission ---
console.log('\ngetTransmission:');
{
  const tx = db.getTransmission(1);
  assert(tx !== null, 'getTransmission returns data');
  assert(tx.hash === 'hash-001', 'correct hash');

  const missing = db.getTransmission(999999);
  assert(missing === null, 'missing transmission returns null');
}

// --- getNodes ---
console.log('\ngetNodes:');
{
  const { rows, total } = db.getNodes({ limit: 10 });
  assert(total >= 1, 'has nodes');
  assert(rows.length >= 1, 'returns node rows');

  // Sort by name
  const { rows: r2 } = db.getNodes({ sortBy: 'name' });
  assert(r2.length >= 1, 'sort by name works');

  // Invalid sort falls back to last_seen
  const { rows: r3 } = db.getNodes({ sortBy: 'DROP TABLE nodes' });
  assert(r3.length >= 1, 'invalid sort is safe');
}

// --- getNode ---
console.log('\ngetNode:');
{
  const node = db.getNode('aabbccdd11223344aabbccdd11223344');
  assert(node !== null, 'getNode returns node');
  assert(Array.isArray(node.recentPackets), 'has recentPackets');

  const missing = db.getNode('nonexistent');
  assert(missing === null, 'missing node returns null');
}

// --- searchNodes ---
console.log('\nsearchNodes:');
{
  const results = db.searchNodes('Updated');
  assert(results.length >= 1, 'search by name');

  const r2 = db.searchNodes('aabbcc');
  assert(r2.length >= 1, 'search by pubkey prefix');

  const r3 = db.searchNodes('nonexistent_xyz');
  assert(r3.length === 0, 'no results for nonexistent');
}

// --- getStats ---
console.log('\ngetStats:');
{
  const stats = db.getStats();
  assert(stats.totalNodes >= 1, 'totalNodes');
  assert(stats.totalObservers >= 1, 'totalObservers');
  assert(typeof stats.totalPackets === 'number', 'totalPackets is number');
  assert(typeof stats.packetsLastHour === 'number', 'packetsLastHour is number');
  assert(typeof stats.totalNodesAllTime === 'number', 'totalNodesAllTime is number');
  assert(stats.totalNodesAllTime >= stats.totalNodes, 'totalNodesAllTime >= totalNodes');
}

// --- getStats active node filtering ---
console.log('\ngetStats active node filtering:');
{
  // Insert a node with last_seen 30 days ago (should be excluded from totalNodes)
  const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 3600000).toISOString();
  db.upsertNode({ public_key: 'deadnode0000000000000000deadnode00', name: 'DeadNode', role: 'repeater', last_seen: thirtyDaysAgo, first_seen: thirtyDaysAgo });

  // Insert a node with last_seen now (should be included)
  db.upsertNode({ public_key: 'livenode0000000000000000livenode00', name: 'LiveNode', role: 'companion', last_seen: new Date().toISOString() });

  const stats = db.getStats();
  assert(stats.totalNodesAllTime > stats.totalNodes, 'dead node excluded from totalNodes but included in totalNodesAllTime');

  // Verify the dead node is in totalNodesAllTime
  const allTime = stats.totalNodesAllTime;
  assert(allTime >= 3, 'totalNodesAllTime includes dead + live nodes');

  // Verify active count doesn't include the 30-day-old node
  // The dead node's last_seen is 30 days ago, window is 7 days
  const nodeInDb = db.getNode('deadnode0000000000000000deadnode00');
  assert(nodeInDb !== null, 'dead node exists in DB');
  const liveNode = db.getNode('livenode0000000000000000livenode00');
  assert(liveNode !== null, 'live node exists in DB');
}

// --- getNodeHealth ---
console.log('\ngetNodeHealth:');
{
  const health = db.getNodeHealth('aabbccdd11223344aabbccdd11223344');
  assert(health !== null, 'returns health data');
  assert(health.node.name === 'UpdatedNode', 'has node info');
  assert(typeof health.stats.totalPackets === 'number', 'has totalPackets stat');
  assert(Array.isArray(health.observers), 'has observers array');
  assert(Array.isArray(health.recentPackets), 'has recentPackets array');

  const missing = db.getNodeHealth('nonexistent');
  assert(missing === null, 'missing node returns null');
}

// --- getNodeAnalytics ---
console.log('\ngetNodeAnalytics:');
{
  const analytics = db.getNodeAnalytics('aabbccdd11223344aabbccdd11223344', 7);
  assert(analytics !== null, 'returns analytics');
  assert(analytics.node.name === 'UpdatedNode', 'has node info');
  assert(Array.isArray(analytics.activityTimeline), 'has activityTimeline');
  assert(Array.isArray(analytics.snrTrend), 'has snrTrend');
  assert(Array.isArray(analytics.packetTypeBreakdown), 'has packetTypeBreakdown');
  assert(Array.isArray(analytics.observerCoverage), 'has observerCoverage');
  assert(Array.isArray(analytics.hopDistribution), 'has hopDistribution');
  assert(Array.isArray(analytics.peerInteractions), 'has peerInteractions');
  assert(Array.isArray(analytics.uptimeHeatmap), 'has uptimeHeatmap');
  assert(typeof analytics.computedStats.availabilityPct === 'number', 'has availabilityPct');
  assert(typeof analytics.computedStats.signalGrade === 'string', 'has signalGrade');

  const missing = db.getNodeAnalytics('nonexistent', 7);
  assert(missing === null, 'missing node returns null');
}

// --- seed ---
console.log('\nseed:');
{
  if (typeof db.seed === 'function') {
    // Already has data, should return false
    const result = db.seed();
    assert(result === false, 'seed returns false when data exists');
  } else {
    console.log('  (skipped — seed not exported)');
  }
}

// --- v3 schema tests (fresh DB should be v3) ---
console.log('\nv3 schema:');
{
  assert(db.schemaVersion >= 3, 'fresh DB creates v3 schema');

  // observations table should have observer_idx, not observer_id
  const cols = db.db.pragma('table_info(observations)').map(c => c.name);
  assert(cols.includes('observer_idx'), 'observations has observer_idx column');
  assert(!cols.includes('observer_id'), 'observations does NOT have observer_id column');
  assert(!cols.includes('observer_name'), 'observations does NOT have observer_name column');
  assert(!cols.includes('hash'), 'observations does NOT have hash column');
  assert(!cols.includes('created_at'), 'observations does NOT have created_at column');

  // timestamp should be integer
  const obsRow = db.db.prepare('SELECT typeof(timestamp) as t FROM observations LIMIT 1').get();
  if (obsRow) {
    assert(obsRow.t === 'integer', 'timestamp is stored as integer');
  }

  // packets_v view should still expose observer_id, observer_name, ISO timestamp
  const viewRow = db.db.prepare('SELECT * FROM packets_v LIMIT 1').get();
  if (viewRow) {
    assert('observer_id' in viewRow, 'packets_v exposes observer_id');
    assert('observer_name' in viewRow, 'packets_v exposes observer_name');
    assert(typeof viewRow.timestamp === 'string', 'packets_v timestamp is ISO string');
  }

  // user_version is 3
  const sv = db.db.pragma('user_version', { simple: true });
  assert(sv === 3, 'user_version is 3');
}

// --- v3 ingestion: observer resolved via observer_idx ---
console.log('\nv3 ingestion with observer resolution:');
{
  // Insert a new observer
  db.upsertObserver({ id: 'obs-v3-test', name: 'V3 Test Observer' });

  // Insert observation referencing that observer
  const result = db.insertTransmission({
    raw_hex: '0400deadbeef',
    hash: 'hash-v3-001',
    timestamp: '2025-06-01T12:00:00Z',
    observer_id: 'obs-v3-test',
    observer_name: 'V3 Test Observer',
    direction: 'rx',
    snr: 12.0,
    rssi: -80,
    route_type: 1,
    payload_type: 4,
    path_json: '["aabb"]',
  });
  assert(result !== null, 'v3 insertion succeeded');
  assert(result.transmissionId > 0, 'v3 has transmissionId');

  // Verify via packets_v view
  const pkt = db.db.prepare('SELECT * FROM packets_v WHERE hash = ?').get('hash-v3-001');
  assert(pkt !== null, 'v3 packet found via view');
  assert(pkt.observer_id === 'obs-v3-test', 'v3 observer_id resolved in view');
  assert(pkt.observer_name === 'V3 Test Observer', 'v3 observer_name resolved in view');
  assert(typeof pkt.timestamp === 'string', 'v3 timestamp is ISO string in view');
  assert(pkt.timestamp.includes('2025-06-01'), 'v3 timestamp date correct');

  // Raw observation should have integer timestamp
  const obs = db.db.prepare('SELECT * FROM observations ORDER BY id DESC LIMIT 1').get();
  assert(typeof obs.timestamp === 'number', 'v3 raw observation timestamp is integer');
  assert(obs.observer_idx !== null, 'v3 observation has observer_idx');
}

// --- v3 dedup ---
console.log('\nv3 dedup:');
{
  // Insert same observation again — should be deduped
  const result = db.insertTransmission({
    raw_hex: '0400deadbeef',
    hash: 'hash-v3-001',
    timestamp: '2025-06-01T12:00:00Z',
    observer_id: 'obs-v3-test',
    direction: 'rx',
    snr: 12.0,
    rssi: -80,
    path_json: '["aabb"]',
  });
  assert(result.observationId === 0, 'duplicate caught by in-memory dedup');

  // Different observer = not a dupe
  db.upsertObserver({ id: 'obs-v3-test-2', name: 'V3 Test Observer 2' });
  const result2 = db.insertTransmission({
    raw_hex: '0400deadbeef',
    hash: 'hash-v3-001',
    timestamp: '2025-06-01T12:01:00Z',
    observer_id: 'obs-v3-test-2',
    direction: 'rx',
    snr: 9.0,
    rssi: -88,
    path_json: '["ccdd"]',
  });
  assert(result2.observationId > 0, 'different observer is not a dupe');
}

// --- removePhantomNodes ---
console.log('\nremovePhantomNodes:');
{
  // Insert phantom nodes (short public_keys like hop prefixes)
  db.upsertNode({ public_key: 'aabb', name: null, role: 'repeater' });
  db.upsertNode({ public_key: 'ccddee', name: null, role: 'repeater' });
  db.upsertNode({ public_key: 'ff001122', name: null, role: 'repeater' });
  db.upsertNode({ public_key: '0011223344556677', name: null, role: 'repeater' }); // 16 chars — still phantom

  // Verify they exist
  assert(db.getNode('aabb') !== null, 'phantom node aabb exists before cleanup');
  assert(db.getNode('ccddee') !== null, 'phantom node ccddee exists before cleanup');
  assert(db.getNode('ff001122') !== null, 'phantom node ff001122 exists before cleanup');
  assert(db.getNode('0011223344556677') !== null, 'phantom 16-char exists before cleanup');

  // Verify real node still exists
  assert(db.getNode('aabbccdd11223344aabbccdd11223344') !== null, 'real node exists before cleanup');

  // Run cleanup
  const removed = db.removePhantomNodes();
  assert(removed === 4, `removed 4 phantom nodes (got ${removed})`);

  // Verify phantoms are gone
  assert(db.getNode('aabb') === null, 'phantom aabb removed');
  assert(db.getNode('ccddee') === null, 'phantom ccddee removed');
  assert(db.getNode('ff001122') === null, 'phantom ff001122 removed');
  assert(db.getNode('0011223344556677') === null, 'phantom 16-char removed');

  // Verify real node is still there
  assert(db.getNode('aabbccdd11223344aabbccdd11223344') !== null, 'real node preserved after cleanup');

  // Running again should remove 0
  const removed2 = db.removePhantomNodes();
  assert(removed2 === 0, 'second cleanup removes nothing');
}

// --- stats exclude phantom nodes ---
console.log('\nstats exclude phantom nodes:');
{
  const statsBefore = db.getStats();
  const countBefore = statsBefore.totalNodesAllTime;

  // Insert a phantom — should be cleanable
  db.upsertNode({ public_key: 'deadbeef', name: null, role: 'repeater' });
  const statsWithPhantom = db.getStats();
  assert(statsWithPhantom.totalNodesAllTime === countBefore + 1, 'phantom inflates totalNodesAllTime');

  // Clean it
  db.removePhantomNodes();
  const statsAfter = db.getStats();
  assert(statsAfter.totalNodesAllTime === countBefore, 'phantom removed from totalNodesAllTime');
}

// --- moveStaleNodes ---
console.log('\nmoveStaleNodes:');
{
  // Verify inactive_nodes table exists
  const tables = db.db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(r => r.name);
  assert(tables.includes('inactive_nodes'), 'inactive_nodes table exists');

  // Verify inactive_nodes has same columns as nodes
  const nodesCols = db.db.pragma('table_info(nodes)').map(c => c.name).sort();
  const inactiveCols = db.db.pragma('table_info(inactive_nodes)').map(c => c.name).sort();
  assert(JSON.stringify(nodesCols) === JSON.stringify(inactiveCols), 'inactive_nodes has same columns as nodes');

  // Insert a stale node (last_seen 30 days ago) and a fresh node
  const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 3600000).toISOString();
  const now = new Date().toISOString();
  db.upsertNode({ public_key: 'stale00000000000000000000stale000', name: 'StaleNode', role: 'repeater', last_seen: thirtyDaysAgo, first_seen: thirtyDaysAgo });
  db.upsertNode({ public_key: 'fresh00000000000000000000fresh000', name: 'FreshNode', role: 'companion', last_seen: now, first_seen: now });

  // Verify both exist in nodes
  assert(db.getNode('stale00000000000000000000stale000') !== null, 'stale node exists before move');
  assert(db.getNode('fresh00000000000000000000fresh000') !== null, 'fresh node exists before move');

  // Move stale nodes (7 day threshold)
  const moved = db.moveStaleNodes(7);
  assert(moved >= 1, `moveStaleNodes moved at least 1 node (got ${moved})`);

  // Stale node should be gone from nodes
  assert(db.getNode('stale00000000000000000000stale000') === null, 'stale node removed from nodes');

  // Fresh node should still be in nodes
  assert(db.getNode('fresh00000000000000000000fresh000') !== null, 'fresh node still in nodes');

  // Stale node should be in inactive_nodes
  const inactive = db.db.prepare('SELECT * FROM inactive_nodes WHERE public_key = ?').get('stale00000000000000000000stale000');
  assert(inactive !== null, 'stale node exists in inactive_nodes');
  assert(inactive.name === 'StaleNode', 'stale node name preserved in inactive_nodes');
  assert(inactive.role === 'repeater', 'stale node role preserved in inactive_nodes');

  // Fresh node should NOT be in inactive_nodes
  const freshInactive = db.db.prepare('SELECT * FROM inactive_nodes WHERE public_key = ?').get('fresh00000000000000000000fresh000');
  assert(!freshInactive, 'fresh node not in inactive_nodes');

  // Running again should move 0 (already moved)
  const moved2 = db.moveStaleNodes(7);
  assert(moved2 === 0, 'second moveStaleNodes moves nothing');

  // With nodeDays=0 should be a no-op
  const moved3 = db.moveStaleNodes(0);
  assert(moved3 === 0, 'moveStaleNodes(0) is a no-op');

  // With null should be a no-op
  const moved4 = db.moveStaleNodes(null);
  assert(moved4 === 0, 'moveStaleNodes(null) is a no-op');
}

cleanup();
delete process.env.DB_PATH;

console.log(`\n═══════════════════════════════════════`);
console.log(`  PASSED: ${passed}`);
console.log(`  FAILED: ${failed}`);
console.log(`═══════════════════════════════════════`);
if (failed > 0) process.exit(1);
