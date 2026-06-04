package main

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"math"
	"net/http"
	"strings"
	"sync"
	"time"
)

// ─── Types ─────────────────────────────────────────────────────────────────────

type losRequest struct {
	LatA           float64 `json:"lat_a"`
	LonA           float64 `json:"lon_a"`
	LatB           float64 `json:"lat_b"`
	LonB           float64 `json:"lon_b"`
	AntennaHeightA float64 `json:"antenna_height_a"`
	AntennaHeightB float64 `json:"antenna_height_b"`
}

type losProfilePoint struct {
	Lat         float64 `json:"lat"`
	Lon         float64 `json:"lon"`
	TerrainElev float64 `json:"terrain_elev"`
	LOSElev     float64 `json:"los_elev"`
	Bulge       float64 `json:"bulge"`
	Blocked     bool    `json:"blocked"`
}

type losRelayPoint struct {
	Lat         float64 `json:"lat"`
	Lon         float64 `json:"lon"`
	TerrainElev float64 `json:"terrain_elev"`
}

type losAnalysisResult struct {
	LOSClear      bool
	MaxViolationM float64
	Relay         *losRelayPoint
}

type losResponse struct {
	LOSClear      bool              `json:"los_clear"`
	MaxViolationM float64           `json:"max_violation_m"`
	DistanceKm    float64           `json:"distance_km"`
	DataGaps      bool              `json:"data_gaps,omitempty"`
	EndpointGapA  bool              `json:"endpoint_gap_a,omitempty"`
	EndpointGapB  bool              `json:"endpoint_gap_b,omitempty"`
	Profile       []losProfilePoint `json:"profile"`
	Relay         *losRelayPoint    `json:"relay"`
}

// ─── Math ──────────────────────────────────────────────────────────────────────

const earthRadiusM = 6_371_000.0
const kFactor = 1.33

func interpolatePoint(lat1, lon1, lat2, lon2, t float64) (float64, float64) {
	return lat1 + t*(lat2-lat1), lon1 + t*(lon2-lon1)
}

func earthBulgeM(t, distM float64) float64 {
	return t * (1 - t) * distM * distM / (2 * earthRadiusM * kFactor)
}

// sampleViolationM returns how far a sample's terrain rises above the straight
// line-of-sight after accounting for Earth curvature. Positive = obstruction.
// Curvature raises the TERRAIN relative to the RF ray, so the bulge is added to
// terrain (NOT to losElev).
func sampleViolationM(terrainElev, losElev, bulge float64) float64 {
	return (terrainElev + bulge) - losElev
}

func losAnalyze(profile []losProfilePoint) losAnalysisResult {
	maxViolation := 0.0
	for _, p := range profile {
		v := sampleViolationM(p.TerrainElev, p.LOSElev, p.Bulge)
		if v > maxViolation {
			maxViolation = v
		}
	}
	clear := maxViolation <= 0
	var relay *losRelayPoint
	if !clear {
		relay = findRelay(profile)
	}
	return losAnalysisResult{
		LOSClear:      clear,
		MaxViolationM: math.Max(0, maxViolation),
		Relay:         relay,
	}
}

func findRelay(profile []losProfilePoint) *losRelayPoint {
	if len(profile) < 3 {
		return nil
	}
	bestWorst := math.MaxFloat64
	bestIdx := len(profile) / 2

	for c := 1; c < len(profile)-1; c++ {
		leftWorst := 0.0
		for i := 0; i <= c; i++ {
			v := sampleViolationM(profile[i].TerrainElev, profile[i].LOSElev, profile[i].Bulge)
			if v > leftWorst {
				leftWorst = v
			}
		}
		rightWorst := 0.0
		for i := c; i < len(profile); i++ {
			v := sampleViolationM(profile[i].TerrainElev, profile[i].LOSElev, profile[i].Bulge)
			if v > rightWorst {
				rightWorst = v
			}
		}
		worst := math.Max(leftWorst, rightWorst)
		if worst < bestWorst {
			bestWorst = worst
			bestIdx = c
		}
	}

	p := profile[bestIdx]
	return &losRelayPoint{Lat: p.Lat, Lon: p.Lon, TerrainElev: p.TerrainElev}
}

// ─── Elevation cache ───────────────────────────────────────────────────────────

type elevCacheEntry struct {
	elev      float64
	expiresAt time.Time
}

type elevationCache struct {
	mu      sync.Mutex
	entries map[string]elevCacheEntry
	ttl     time.Duration
}

func newElevationCache(ttl time.Duration) *elevationCache {
	return &elevationCache{entries: make(map[string]elevCacheEntry), ttl: ttl}
}

func (c *elevationCache) cacheKey(lat, lon float64) string {
	return fmt.Sprintf("%.4f,%.4f", lat, lon)
}

func (c *elevationCache) get(lat, lon float64) (float64, bool) {
	c.mu.Lock()
	defer c.mu.Unlock()
	e, ok := c.entries[c.cacheKey(lat, lon)]
	if !ok || time.Now().After(e.expiresAt) {
		return 0, false
	}
	return e.elev, true
}

func (c *elevationCache) set(lat, lon, elev float64) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.entries[c.cacheKey(lat, lon)] = elevCacheEntry{elev: elev, expiresAt: time.Now().Add(c.ttl)}
}

// ─── Elevation API client ──────────────────────────────────────────────────────

type losHandler struct {
	cfg    *Config
	client *http.Client
	cache  *elevationCache
}

func newLOSHandler(cfg *Config) *losHandler {
	return &losHandler{
		cfg:    cfg,
		client: &http.Client{Timeout: 15 * time.Second},
		cache:  newElevationCache(cfg.LOSCacheTTL()),
	}
}

type topoDataset struct {
	Elevation *float64 `json:"elevation"`
}

type topoPoint struct {
	// opentopodata / open-elevation return elevation flat on each result
	// (results[].elevation). This is the configured default API's shape.
	Elevation *float64 `json:"elevation"`
	// Some services nest it under datasets[] — kept for compatibility.
	Datasets []topoDataset `json:"datasets"`
}

type topoResponse struct {
	Results []topoPoint `json:"results"`
}

// fetchElevations resolves an elevation (m ASL) for every (lat, lon) point. It
// returns a per-point gaps slice: gaps[i] is true when neither the primary nor
// the fallback dataset had data for point i, in which case elevs[i] is 0 (a
// sea-level estimate). Callers can inspect specific indices — e.g. the path
// endpoints or a coverage centre — where a gap is more consequential than a
// gap on an intermediate sample.
func (h *losHandler) fetchElevations(ctx context.Context, lats, lons []float64) (elevs []float64, gaps []bool, err error) {
	n := len(lats)
	elevs = make([]float64, n)
	gaps = make([]bool, n)
	missing := make([]int, 0, n)

	for i := 0; i < n; i++ {
		if e, ok := h.cache.get(lats[i], lons[i]); ok {
			elevs[i] = e
		} else {
			missing = append(missing, i)
		}
	}
	if len(missing) == 0 {
		return elevs, gaps, nil
	}

	fallback := h.cfg.LOSElevationFallbackDataset()

	// Primary dataset (e.g. AHN — high-resolution, but Netherlands-only).
	resolved, stillMissing, perr := h.fetchDataset(ctx, h.cfg.LOSElevationDataset(), missing, lats, lons)
	if perr != nil {
		if fallback == "" {
			return nil, nil, perr // preserve original behaviour when no fallback is configured
		}
		// With a fallback configured, a primary failure is not fatal — let the
		// fallback dataset try every point the primary couldn't return.
		log.Printf("[los] primary elevation dataset %q failed (%v) — falling back to %q", h.cfg.LOSElevationDataset(), perr, fallback)
		resolved, stillMissing = nil, missing
	}
	for idx, e := range resolved {
		elevs[idx] = e
		h.cache.set(lats[idx], lons[idx], e)
	}

	// Fallback dataset (e.g. srtm30m) for points the primary lacks — outside the
	// primary's coverage area (AHN stops at the Dutch border) or if it was down.
	if fallback != "" && len(stillMissing) > 0 {
		fbResolved, fbMissing, ferr := h.fetchDataset(ctx, fallback, stillMissing, lats, lons)
		if ferr != nil {
			log.Printf("[los] fallback elevation dataset %q failed: %v", fallback, ferr)
		} else {
			for idx, e := range fbResolved {
				elevs[idx] = e
				h.cache.set(lats[idx], lons[idx], e)
			}
			stillMissing = fbMissing
		}
	}

	if len(stillMissing) > 0 {
		log.Printf("[los] %d/%d profile points had no elevation (primary %q, fallback %q) — using 0",
			len(stillMissing), n, h.cfg.LOSElevationDataset(), fallback)
	}
	for _, idx := range stillMissing {
		gaps[idx] = true
	}
	return elevs, gaps, nil
}

// anyTrue reports whether any element of the slice is true.
func anyTrue(bs []bool) bool {
	for _, b := range bs {
		if b {
			return true
		}
	}
	return false
}

// fetchDataset queries a single opentopodata dataset for the given point indices,
// batched to opentopodata's 100-locations-per-request limit. It returns the
// resolved elevations keyed by index and the indices that came back with no data
// (null elevation, or fewer/no results — e.g. the point is outside the dataset's
// coverage, or the dataset isn't served by this instance).
func (h *losHandler) fetchDataset(ctx context.Context, dataset string, idxs []int, lats, lons []float64) (resolved map[int]float64, missing []int, err error) {
	resolved = make(map[int]float64, len(idxs))
	const batchSize = 100
	for start := 0; start < len(idxs); start += batchSize {
		end := start + batchSize
		if end > len(idxs) {
			end = len(idxs)
		}
		batch := idxs[start:end]

		var sb strings.Builder
		for j, idx := range batch {
			if j > 0 {
				sb.WriteByte('|')
			}
			fmt.Fprintf(&sb, "%.6f,%.6f", lats[idx], lons[idx])
		}
		url := h.cfg.LOSElevationURL() + "/v1/" + dataset + "?locations=" + sb.String()

		req, reqErr := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
		if reqErr != nil {
			return nil, nil, fmt.Errorf("los elevation request: %w", reqErr)
		}
		resp, doErr := h.client.Do(req)
		if doErr != nil {
			return nil, nil, fmt.Errorf("los elevation fetch: %w", doErr)
		}
		var tr topoResponse
		decErr := json.NewDecoder(resp.Body).Decode(&tr)
		resp.Body.Close()
		if decErr != nil {
			return nil, nil, fmt.Errorf("los elevation decode: %w", decErr)
		}

		for j, idx := range batch {
			if j >= len(tr.Results) {
				missing = append(missing, idx)
				continue
			}
			r := tr.Results[j]
			// opentopodata/open-elevation return elevation flat
			// (results[].elevation); some services nest it under datasets[].
			// Accept either shape.
			elev := r.Elevation
			if elev == nil && len(r.Datasets) > 0 {
				elev = r.Datasets[0].Elevation
			}
			if elev == nil {
				missing = append(missing, idx)
				continue
			}
			resolved[idx] = *elev
		}
	}
	return resolved, missing, nil
}

// ─── HTTP handler ──────────────────────────────────────────────────────────────

func (s *Server) handleLOS(w http.ResponseWriter, r *http.Request) {
	var req losRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid JSON body")
		return
	}
	if req.LatA < -90 || req.LatA > 90 || req.LatB < -90 || req.LatB > 90 {
		writeError(w, http.StatusBadRequest, "lat out of range")
		return
	}
	if req.LonA < -180 || req.LonA > 180 || req.LonB < -180 || req.LonB > 180 {
		writeError(w, http.StatusBadRequest, "lon out of range")
		return
	}
	if req.AntennaHeightA <= 0 {
		req.AntennaHeightA = 2
	}
	if req.AntennaHeightB <= 0 {
		req.AntennaHeightB = 2
	}

	distKm := haversineKm(req.LatA, req.LonA, req.LatB, req.LonB)
	distM := distKm * 1000

	sampleMin := s.cfg.LOSSampleMin()
	sampleMax := s.cfg.LOSSampleMax()
	n := int(distM / 50)
	if n < sampleMin {
		n = sampleMin
	}
	if n > sampleMax {
		n = sampleMax
	}
	if n < 2 {
		n = 2
	}

	lats := make([]float64, n)
	lons := make([]float64, n)
	for i := 0; i < n; i++ {
		t := float64(i) / float64(n-1)
		lats[i], lons[i] = interpolatePoint(req.LatA, req.LonA, req.LatB, req.LonB, t)
	}

	h := s.getLOSHandler()
	elevs, gaps, err := h.fetchElevations(r.Context(), lats, lons)
	if err != nil {
		log.Printf("[los] elevation fetch failed: %v", err)
		writeError(w, http.StatusBadGateway, "elevation API unavailable")
		return
	}
	dataGaps := anyTrue(gaps)
	// A gap on an endpoint (the antenna base) shifts the whole sightline, so it
	// is far more consequential than a gap on an intermediate sample.
	endpointGapA := gaps[0]
	endpointGapB := gaps[n-1]

	elevA := elevs[0] + req.AntennaHeightA
	elevB := elevs[n-1] + req.AntennaHeightB

	profile := make([]losProfilePoint, n)
	for i := 0; i < n; i++ {
		t := float64(i) / float64(n-1)
		losElev := elevA + t*(elevB-elevA)
		bulge := earthBulgeM(t, distM)
		blocked := sampleViolationM(elevs[i], losElev, bulge) > 0
		profile[i] = losProfilePoint{
			Lat:         lats[i],
			Lon:         lons[i],
			TerrainElev: elevs[i],
			LOSElev:     losElev,
			Bulge:       bulge,
			Blocked:     blocked,
		}
	}

	analysis := losAnalyze(profile)

	resp := losResponse{
		LOSClear:      analysis.LOSClear,
		MaxViolationM: analysis.MaxViolationM,
		DistanceKm:    distKm,
		DataGaps:      dataGaps,
		EndpointGapA:  endpointGapA,
		EndpointGapB:  endpointGapB,
		Profile:       profile,
		Relay:         analysis.Relay,
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(resp)
}

// getLOSHandler returns the server's shared LOS handler, initializing it lazily on first use.
// sync.Once ensures this is safe for concurrent callers.
func (s *Server) getLOSHandler() *losHandler {
	s.losOnce.Do(func() {
		s.losHandler = newLOSHandler(s.cfg)
	})
	return s.losHandler
}
