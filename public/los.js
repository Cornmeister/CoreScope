/* === CoreScope — los.js (Line-of-Sight Analyzer) === */
'use strict';

(function () {
  var losMap = null;
  var markerA = null;
  var markerB = null;
  var losPolyline = null;
  var relayMarker = null;
  var losChart = null;
  var losModalChart = null;
  var _lastResult = null; // last analysis payload, for the full-screen modal
  var pickingPoint = null; // 'a' | 'b' | null
  var _cleanups = []; // teardown callbacks for destroy()

  // ── Icons ──────────────────────────────────────────────────────────────────
  function makePin(color) {
    return L.divIcon({
      html: '<div style="width:14px;height:14px;background:' + color + ';border:2px solid #fff;border-radius:50%;box-shadow:0 1px 3px rgba(0,0,0,0.4)"></div>',
      className: '',
      iconSize: [14, 14],
      iconAnchor: [7, 7],
    });
  }

  function makeTowerIcon() {
    return L.divIcon({
      html: '<div title="Suggested relay" style="font-size:20px;line-height:1;text-shadow:0 1px 2px rgba(0,0,0,0.5)">📡</div>',
      className: '',
      iconSize: [24, 24],
      iconAnchor: [12, 12],
    });
  }

  // ── Map setup ──────────────────────────────────────────────────────────────
  var _losTileLayer = null;
  var _losThemeObs = null;

  function setLosTiles(tileKey) {
    if (_losTileLayer) { _losTileLayer.remove(); _losTileLayer = null; }
    if (_losThemeObs) { _losThemeObs.disconnect(); _losThemeObs = null; }
    var isTopo = tileKey === 'topo';
    var url = isTopo ? window.TILE_TOPO : window.getTileUrl();
    _losTileLayer = L.tileLayer(url, {
      maxZoom: isTopo ? 17 : 19,
      attribution: isTopo ? '© OpenTopoMap contributors' : '© OpenStreetMap © CartoDB',
    }).addTo(losMap);
    if (!isTopo) {
      _losThemeObs = new MutationObserver(function () {
        if (_losTileLayer) _losTileLayer.setUrl(window.getTileUrl());
      });
      _losThemeObs.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    }
  }

  function initMap(container) {
    if (losMap) { losMap.remove(); losMap = null; }
    losMap = L.map(container, { zoomControl: true, attributionControl: false });
    losMap.setView([52.0, 5.0], 9);
    losMap.on('click', onMapClick);
    var savedTile = localStorage.getItem('meshcore-los-tile') || 'default';
    setLosTiles(savedTile);
  }

  function onMapClick(e) {
    if (!pickingPoint) return;
    var lat = e.latlng.lat.toFixed(6);
    var lon = e.latlng.lng.toFixed(6);
    if (pickingPoint === 'a') setPointA(lat, lon);
    else setPointB(lat, lon);
    stopPickMode();
  }

  function setPointA(lat, lon) {
    document.getElementById('los-lat-a').value = lat;
    document.getElementById('los-lon-a').value = lon;
    if (markerA) markerA.remove();
    markerA = L.marker([parseFloat(lat), parseFloat(lon)], { icon: makePin('#3b82f6') })
      .addTo(losMap).bindTooltip('Point A').openTooltip();
    fitMapToPoints();
    updatePolyline();
  }

  function setPointB(lat, lon) {
    document.getElementById('los-lat-b').value = lat;
    document.getElementById('los-lon-b').value = lon;
    if (markerB) markerB.remove();
    markerB = L.marker([parseFloat(lat), parseFloat(lon)], { icon: makePin('#ef4444') })
      .addTo(losMap).bindTooltip('Point B').openTooltip();
    fitMapToPoints();
    updatePolyline();
  }

  function fitMapToPoints() {
    if (markerA && markerB) {
      losMap.fitBounds(L.latLngBounds(markerA.getLatLng(), markerB.getLatLng()).pad(0.2));
    } else if (markerA) {
      losMap.setView(markerA.getLatLng(), 12);
    } else if (markerB) {
      losMap.setView(markerB.getLatLng(), 12);
    }
  }

  function updatePolyline() {
    if (losPolyline) { losPolyline.remove(); losPolyline = null; }
    if (markerA && markerB) {
      losPolyline = L.polyline([markerA.getLatLng(), markerB.getLatLng()], {
        color: '#3b82f6', weight: 2, dashArray: '6,4', opacity: 0.7,
      }).addTo(losMap);
    }
  }

  function startPickMode(point) {
    pickingPoint = point;
    losMap.getContainer().style.cursor = 'crosshair';
    var btnId = point === 'a' ? 'los-pick-a' : 'los-pick-b';
    var btn = document.getElementById(btnId);
    if (btn) { btn.textContent = 'Cancel'; btn.classList.add('los-pick-active'); }
  }

  function stopPickMode() {
    pickingPoint = null;
    losMap.getContainer().style.cursor = '';
    ['los-pick-a', 'los-pick-b'].forEach(function (id) {
      var btn = document.getElementById(id);
      if (btn) { btn.textContent = '📍 Pick'; btn.classList.remove('los-pick-active'); }
    });
  }

  // ── Node autocomplete ──────────────────────────────────────────────────────
  function setupAutocomplete(inputId, latId, lonId, setPointFn) {
    var input = document.getElementById(inputId);
    var list = document.getElementById(inputId + '-list');
    if (!input || !list) return;
    var debounce = null;
    function onInput() {
      clearTimeout(debounce);
      var q = input.value.trim();
      if (q.length < 2) { list.innerHTML = ''; list.hidden = true; return; }
      debounce = setTimeout(function () {
        fetch('/api/nodes/search?q=' + encodeURIComponent(q) + '&limit=8')
          .then(function (r) { return r.ok ? r.json() : { nodes: [] }; })
          .then(function (data) {
            var nodes = data.nodes || [];
            list.innerHTML = '';
            if (!nodes.length) { list.hidden = true; return; }
            list.hidden = false;
            nodes.forEach(function (node) {
              if (node.lat == null || node.lon == null) return;
              var li = document.createElement('li');
              li.className = 'los-autocomplete-item';
              li.textContent = (node.name || node.public_key.slice(0, 12)) +
                ' (' + (+node.lat).toFixed(4) + ', ' + (+node.lon).toFixed(4) + ')';
              li.addEventListener('mousedown', function (e) {
                e.preventDefault();
                input.value = node.name || node.public_key.slice(0, 12);
                list.innerHTML = ''; list.hidden = true;
                setPointFn((+node.lat).toFixed(6), (+node.lon).toFixed(6));
              });
              list.appendChild(li);
            });
          }).catch(function () { list.hidden = true; });
      }, 250);
    }
    function onBlur() {
      setTimeout(function () { list.innerHTML = ''; list.hidden = true; }, 200);
    }
    input.addEventListener('input', onInput);
    input.addEventListener('blur', onBlur);
    _cleanups.push(function () {
      clearTimeout(debounce);
      input.removeEventListener('input', onInput);
      input.removeEventListener('blur', onBlur);
    });
  }

  // ── Analysis ───────────────────────────────────────────────────────────────
  function runAnalysis() {
    var latA = parseFloat(document.getElementById('los-lat-a').value);
    var lonA = parseFloat(document.getElementById('los-lon-a').value);
    var latB = parseFloat(document.getElementById('los-lat-b').value);
    var lonB = parseFloat(document.getElementById('los-lon-b').value);
    var htA  = parseFloat(document.getElementById('los-ht-a').value) || 2;
    var htB  = parseFloat(document.getElementById('los-ht-b').value) || 2;

    if (isNaN(latA) || isNaN(lonA) || isNaN(latB) || isNaN(lonB)) {
      showError('Please set both Point A and Point B before running.');
      return;
    }

    var resultEl = document.getElementById('los-result');
    resultEl.innerHTML = '<div class="los-spinner">⏳ Fetching elevation data…</div>';

    fetch('/api/los', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ lat_a: latA, lon_a: lonA, lat_b: latB, lon_b: lonB,
                             antenna_height_a: htA, antenna_height_b: htB }),
    })
      .then(function (r) {
        if (!r.ok) return r.json().then(function (e) { throw new Error(e.error || 'Server error'); });
        return r.json();
      })
      .then(renderResult)
      .catch(function (err) {
        showError(err.message || 'Elevation API unavailable. Try again later.', true);
      });
  }

  // Renders the elevation-source breakdown (how many sample points came from the
  // primary dataset vs the fallback vs genuine gaps), so it is clear which data
  // the result is actually based on.
  function elevSourcesHtml(es) {
    if (!es) return '';
    var parts = [(es.primary_dataset || 'primary') + ' ' + (es.primary || 0)];
    if (es.fallback_dataset) parts.push(es.fallback_dataset + ' ' + (es.fallback || 0));
    parts.push('none ' + (es.gap || 0));
    return '<div class="los-distance">Elevation: <strong>' + parts.join(' · ') + '</strong></div>';
  }

  function renderResult(data) {
    _lastResult = data;
    var resultEl = document.getElementById('los-result');
    var statusClass = data.los_clear ? 'los-clear' : 'los-blocked';
    var statusText  = data.los_clear
      ? '🟢 Clear — direct LOS confirmed'
      : '🔴 Blocked — ' + data.max_violation_m.toFixed(1) + ' m max violation';

    if (relayMarker) { relayMarker.remove(); relayMarker = null; }
    var relayHtml = '';
    if (data.relay) {
      relayHtml = '<div class="los-relay-info">' +
        '📡 Relay suggestion: <strong>' + data.relay.lat.toFixed(5) + '°, ' +
        data.relay.lon.toFixed(5) + '°</strong>' +
        ' (' + Math.round(data.relay.terrain_elev) + ' m ASL)' +
        ' <button class="los-btn los-btn-sm" id="los-show-relay">Show on map</button>' +
        '</div>';
      relayMarker = L.marker([data.relay.lat, data.relay.lon], { icon: makeTowerIcon() })
        .addTo(losMap)
        .bindTooltip('Relay suggestion (' + Math.round(data.relay.terrain_elev) + ' m ASL)');
    }

    var gapsHtml = data.data_gaps
      ? '<div class="los-warning">⚠️ Some elevation values unavailable, estimated as sea level.</div>'
      : '';

    var endpointGapHtml = '';
    if (data.endpoint_gap_a || data.endpoint_gap_b) {
      var which = (data.endpoint_gap_a && data.endpoint_gap_b)
        ? 'Both endpoints have'
        : (data.endpoint_gap_a ? 'Point A has' : 'Point B has');
      endpointGapHtml = '<div class="los-warning los-warning-strong">⚠️ ' + which +
        ' no elevation data, so the antenna base was assumed to be at sea level. ' +
        'This shifts the whole sightline, so the result may be unreliable. ' +
        'Try a point with terrain coverage.</div>';
    }

    resultEl.innerHTML =
      '<div class="los-status ' + statusClass + '">' + statusText + '</div>' +
      '<div class="los-distance">Distance: <strong>' + data.distance_km.toFixed(2) + ' km</strong></div>' +
      elevSourcesHtml(data.elev_sources) +
      gapsHtml +
      endpointGapHtml +
      '<div class="los-chart-head">' +
        '<span>Elevation profile</span>' +
        '<button class="los-btn los-btn-sm" id="los-expand">⛶ Full screen</button>' +
      '</div>' +
      '<div class="los-chart-wrap"><canvas id="los-chart"></canvas></div>' +
      relayHtml;

    if (data.relay) {
      var showBtn = document.getElementById('los-show-relay');
      if (showBtn) {
        showBtn.addEventListener('click', function () {
          losMap.setView([data.relay.lat, data.relay.lon], 13);
        });
      }
    }

    var expandBtn = document.getElementById('los-expand');
    if (expandBtn) expandBtn.addEventListener('click', openModal);

    renderChart(data.profile, data.distance_km);
  }

  // Shared Chart.js config so the inline chart and the full-screen modal stay
  // identical. Earth curvature raises the terrain relative to the straight RF
  // ray, so we plot effective terrain (terrain + bulge) against the straight LOS.
  function losChartConfig(profile, totalKm) {
    var n = profile.length;
    var labels = profile.map(function (_, i) {
      return (i / Math.max(n - 1, 1) * totalKm).toFixed(2);
    });
    var terrain = profile.map(function (p) { return p.terrain_elev + p.bulge; });
    var losLine  = profile.map(function (p) { return p.los_elev; });

    return {
      type: 'line',
      data: {
        labels: labels,
        datasets: [
          {
            label: 'Terrain + Earth curvature (m ASL)',
            data: terrain,
            fill: true,
            backgroundColor: 'rgba(139,90,43,0.35)',
            borderColor: 'rgba(139,90,43,0.8)',
            borderWidth: 1.5,
            pointRadius: 0,
            tension: 0.2,
          },
          {
            label: 'Line of sight (m ASL)',
            data: losLine,
            fill: false,
            borderColor: 'rgba(59,130,246,0.85)',
            borderWidth: 2,
            borderDash: [6, 3],
            pointRadius: 0,
            tension: 0.1,
          },
        ],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: { display: true, position: 'top' },
          tooltip: {
            callbacks: {
              title: function (items) { return 'Distance: ' + items[0].label + ' km'; },
              label: function (item) {
                return item.dataset.label + ': ' + (+item.raw).toFixed(1) + ' m';
              },
            },
          },
        },
        scales: {
          x: { title: { display: true, text: 'Distance (km)' }, ticks: { maxTicksLimit: 10 } },
          y: { title: { display: true, text: 'Elevation (m ASL)' } },
        },
      },
    };
  }

  function renderChart(profile, totalKm) {
    var canvas = document.getElementById('los-chart');
    if (!canvas || typeof Chart === 'undefined') return;
    if (losChart) { losChart.destroy(); losChart = null; }
    losChart = new Chart(canvas, losChartConfig(profile, totalKm));
  }

  // ── Full-screen modal ────────────────────────────────────────────────────────
  function openModal() {
    if (!_lastResult) return;
    var modal = document.getElementById('los-modal');
    if (!modal) return;

    var d = _lastResult;
    var statusClass = d.los_clear ? 'los-clear' : 'los-blocked';
    var statusText  = d.los_clear
      ? '🟢 Clear — direct LOS confirmed'
      : '🔴 Blocked — ' + d.max_violation_m.toFixed(1) + ' m max violation';
    var summary = document.getElementById('los-modal-summary');
    if (summary) {
      summary.innerHTML =
        '<span class="los-status ' + statusClass + '">' + statusText + '</span>' +
        '<span class="los-distance">Distance: <strong>' + d.distance_km.toFixed(2) + ' km</strong></span>';
    }

    modal.hidden = false;
    if (typeof Chart !== 'undefined') {
      if (losModalChart) { losModalChart.destroy(); losModalChart = null; }
      var canvas = document.getElementById('los-modal-chart');
      if (canvas) losModalChart = new Chart(canvas, losChartConfig(d.profile, d.distance_km));
    }
  }

  function closeModal() {
    var modal = document.getElementById('los-modal');
    if (modal) modal.hidden = true;
    if (losModalChart) { losModalChart.destroy(); losModalChart = null; }
  }

  function showError(msg, retryable) {
    var resultEl = document.getElementById('los-result');
    var retryBtn = retryable
      ? '<button class="los-btn los-btn-primary" id="los-retry" style="margin-top:8px">Retry</button>'
      : '';
    resultEl.innerHTML = '<div class="los-error">❌ ' + msg + '</div>' + retryBtn;
    if (retryable) {
      var btn = document.getElementById('los-retry');
      if (btn) btn.addEventListener('click', runAnalysis);
    }
  }

  // ── Layout ─────────────────────────────────────────────────────────────────
  function buildHTML() {
    return '<div class="los-page">' +
      '<h2>🔭 Line-of-Sight Analyzer</h2>' +
      '<div class="los-body">' +
        '<div class="los-controls">' +
          '<details class="los-help">' +
            '<summary>How this works</summary>' +
            '<ul>' +
              '<li>Terrain elevation is sampled along the straight path from Point A to Point B.</li>' +
              '<li>Earth curvature uses the standard 4/3 effective radius. The bulge grows with the square of distance, so it climbs fast on long links (about 1.5 m at 10 km, 20 m at 37 km, 37 m at 50 km).</li>' +
              '<li>Antenna height is measured from the ground directly under each point, so a 2 m antenna on a 100 m hill sits at 102 m above sea level.</li>' +
              '<li>The path is Clear only when the terrain plus curvature stays below the straight line between the two antenna tips.</li>' +
              '<li>Where elevation data is missing (for example over open water) the point is estimated at sea level. A missing endpoint is flagged separately because it shifts the whole sightline.</li>' +
              '<li>This is geometric line of sight. It does not subtract a Fresnel-zone clearance, so a real radio link needs a bit more margin than Clear implies.</li>' +
            '</ul>' +
          '</details>' +
          '<div class="los-point-group">' +
            '<h3>Point A</h3>' +
            '<div class="los-autocomplete-wrap">' +
              '<input id="los-node-a" class="los-input" type="text" placeholder="Search node…" autocomplete="off">' +
              '<ul id="los-node-a-list" class="los-autocomplete-list" hidden></ul>' +
            '</div>' +
            '<div class="los-coord-row">' +
              '<label>Lat <input id="los-lat-a" class="los-input los-coord" type="number" step="any" placeholder="52.000"></label>' +
              '<label>Lon <input id="los-lon-a" class="los-input los-coord" type="number" step="any" placeholder="4.000"></label>' +
              '<button id="los-pick-a" class="los-btn los-pick-btn">📍 Pick</button>' +
            '</div>' +
            '<label class="los-ht-label">Antenna height (m) <input id="los-ht-a" class="los-input los-coord" type="number" value="2" min="0" step="0.5"></label>' +
          '</div>' +
          '<div class="los-point-group">' +
            '<h3>Point B</h3>' +
            '<div class="los-autocomplete-wrap">' +
              '<input id="los-node-b" class="los-input" type="text" placeholder="Search node…" autocomplete="off">' +
              '<ul id="los-node-b-list" class="los-autocomplete-list" hidden></ul>' +
            '</div>' +
            '<div class="los-coord-row">' +
              '<label>Lat <input id="los-lat-b" class="los-input los-coord" type="number" step="any" placeholder="52.100"></label>' +
              '<label>Lon <input id="los-lon-b" class="los-input los-coord" type="number" step="any" placeholder="4.100"></label>' +
              '<button id="los-pick-b" class="los-btn los-pick-btn">📍 Pick</button>' +
            '</div>' +
            '<label class="los-ht-label">Antenna height (m) <input id="los-ht-b" class="los-input los-coord" type="number" value="2" min="0" step="0.5"></label>' +
          '</div>' +
          '<button id="los-run" class="los-btn los-btn-primary">Run Analysis</button>' +
          '<div id="los-result" class="los-result-area"></div>' +
        '</div>' +
        '<div class="los-map-wrap">' +
          '<div id="los-map" class="los-map"></div>' +
          '<div class="tool-tile-picker" id="los-tile-picker">' +
            '<button class="tpick-btn" id="los-tile-default">🗺 Default</button>' +
            '<button class="tpick-btn" id="los-tile-topo">🏔 Topo</button>' +
          '</div>' +
        '</div>' +
      '</div>' +
      '<div id="los-modal" class="los-modal" hidden>' +
        '<div class="los-modal-backdrop" id="los-modal-backdrop"></div>' +
        '<div class="los-modal-content">' +
          '<div class="los-modal-head">' +
            '<div id="los-modal-summary" class="los-modal-summary"></div>' +
            '<button class="los-btn los-btn-sm" id="los-modal-close">✕ Close</button>' +
          '</div>' +
          '<div class="los-modal-chart-wrap"><canvas id="los-modal-chart"></canvas></div>' +
        '</div>' +
      '</div>' +
    '</div>';
  }

  function buildCSS() {
    if (document.getElementById('los-styles')) return;
    var style = document.createElement('style');
    style.id = 'los-styles';
    style.textContent = [
      '.los-page { padding: 20px; display: flex; flex-direction: column; height: calc(100vh - 120px); min-height: 400px; box-sizing: border-box; }',
      '.los-page h2 { margin: 0 0 12px; font-size: 1.4rem; flex-shrink: 0; }',
      '.los-body { display: flex; gap: 20px; flex: 1; min-height: 0; }',
      '.los-controls { flex: 0 0 340px; display: flex; flex-direction: column; gap: 16px; overflow-y: auto; }',
      '.los-map-wrap { flex: 1; position: relative; border-radius: 8px; overflow: hidden; min-height: 300px; }',
      '.los-map { width: 100%; height: 100%; border-radius: 8px; border: 1px solid var(--border); }',
      '.los-point-group { background: var(--card-bg); border: 1px solid var(--border); border-radius: 8px; padding: 14px; }',
      '.los-point-group h3 { margin: 0 0 10px; font-size: 0.95rem; }',
      '.los-input { background: var(--input-bg); border: 1px solid var(--border); color: var(--text); border-radius: 4px; padding: 6px 8px; font-size: 13px; width: 100%; box-sizing: border-box; }',
      '.los-coord-row { display: flex; gap: 6px; align-items: flex-end; margin-top: 8px; }',
      '.los-coord-row label { flex: 1; font-size: 12px; color: var(--text-muted); }',
      '.los-coord { margin-top: 3px; }',
      '.los-ht-label { font-size: 12px; color: var(--text-muted); display: block; margin-top: 8px; }',
      '.los-ht-label .los-coord { width: 80px; }',
      '.los-btn { padding: 7px 14px; border-radius: 6px; border: 1px solid var(--border); cursor: pointer; font-size: 13px; background: var(--card-bg); color: var(--text); }',
      '.los-btn:hover { background: var(--row-hover); }',
      '.los-btn-primary { background: var(--accent); color: #fff; border-color: var(--accent); font-weight: 600; width: 100%; padding: 10px; }',
      '.los-btn-primary:hover { opacity: 0.88; }',
      '.los-pick-btn { flex: 0 0 auto; padding: 6px 10px; font-size: 12px; width: auto; }',
      '.los-pick-active { background: var(--status-amber) !important; color: #fff !important; border-color: transparent !important; }',
      '.los-autocomplete-wrap { position: relative; }',
      '.los-autocomplete-list { position: absolute; top: 100%; left: 0; right: 0; background: var(--card-bg); border: 1px solid var(--border); border-radius: 4px; list-style: none; margin: 2px 0 0; padding: 0; max-height: 200px; overflow-y: auto; z-index: 500; }',
      '.los-autocomplete-item { padding: 7px 10px; font-size: 12px; cursor: pointer; }',
      '.los-autocomplete-item:hover { background: var(--row-hover); }',
      '.los-result-area { margin-top: 4px; }',
      '.los-spinner { padding: 16px; text-align: center; color: var(--text-muted); font-size: 13px; }',
      '.los-status { padding: 10px 14px; border-radius: 6px; font-weight: 600; font-size: 14px; margin-bottom: 8px; }',
      '.los-clear { background: rgba(34,197,94,0.12); color: var(--status-green); border: 1px solid rgba(34,197,94,0.3); }',
      '.los-blocked { background: rgba(239,68,68,0.10); color: var(--status-red); border: 1px solid rgba(239,68,68,0.3); }',
      '.los-distance { font-size: 13px; color: var(--text-muted); margin-bottom: 8px; }',
      '.los-warning { font-size: 12px; color: var(--status-amber); padding: 6px 8px; background: rgba(245,158,11,0.1); border-radius: 4px; margin-bottom: 8px; }',
      '.los-error { padding: 10px 14px; background: rgba(239,68,68,0.08); color: var(--status-red); border-radius: 6px; font-size: 13px; }',
      '.los-chart-wrap { height: 200px; margin-bottom: 10px; }',
      '.los-relay-info { font-size: 13px; padding: 8px 10px; background: var(--section-bg); border: 1px solid var(--border); border-radius: 6px; }',
      '.los-btn-sm { padding: 3px 8px; font-size: 12px; width: auto; margin-left: 6px; }',
      '.los-warning-strong { color: var(--status-red); background: rgba(239,68,68,0.10); border: 1px solid rgba(239,68,68,0.3); }',
      '.los-help { background: var(--card-bg); border: 1px solid var(--border); border-radius: 8px; padding: 10px 14px; font-size: 12px; color: var(--text-muted); }',
      '.los-help summary { cursor: pointer; font-weight: 600; color: var(--text); font-size: 13px; }',
      '.los-help ul { margin: 8px 0 0; padding-left: 18px; line-height: 1.5; }',
      '.los-help li { margin-bottom: 5px; }',
      '.los-chart-head { display: flex; align-items: center; justify-content: space-between; font-size: 12px; color: var(--text-muted); margin: 4px 0; }',
      '.los-chart-head .los-btn-sm { margin-left: 0; }',
      '.los-modal { position: fixed; inset: 0; z-index: 3000; display: flex; align-items: center; justify-content: center; }',
      '.los-modal[hidden] { display: none; }',
      '.los-modal-backdrop { position: absolute; inset: 0; background: rgba(0,0,0,0.6); }',
      '.los-modal-content { position: relative; background: var(--card-bg); border: 1px solid var(--border); border-radius: 10px; width: min(1100px, 94vw); height: min(82vh, 820px); padding: 16px; display: flex; flex-direction: column; gap: 10px; box-shadow: 0 10px 40px rgba(0,0,0,0.45); }',
      '.los-modal-head { display: flex; align-items: center; justify-content: space-between; gap: 12px; flex-wrap: wrap; }',
      '.los-modal-summary { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; }',
      '.los-modal-summary .los-status { margin-bottom: 0; }',
      '.los-modal-summary .los-distance { margin-bottom: 0; }',
      '.los-modal-chart-wrap { flex: 1; min-height: 0; }',
      '/* tile picker — shared class, also used by rf-coverage and analytics route-history map */',
      '.tool-tile-picker { position: absolute; top: 8px; right: 8px; z-index: 500; display: flex; gap: 3px; background: var(--card-bg); border: 1px solid var(--border); border-radius: 6px; padding: 3px; box-shadow: 0 1px 4px rgba(0,0,0,0.15); }',
      '.tpick-btn { padding: 4px 9px; font-size: 11px; border: none; border-radius: 4px; cursor: pointer; background: transparent; color: var(--text-muted); }',
      '.tpick-btn.active { background: var(--accent); color: #fff; }',
      '.tpick-btn:hover:not(.active) { background: var(--row-hover); color: var(--text); }',
      '@media (max-width: 768px) {',
      '  .los-page { height: auto; min-height: unset; }',
      '  .los-body { flex-direction: column; }',
      '  .los-controls { flex: none; overflow-y: visible; }',
      '  .los-map-wrap { min-height: 300px; }',
      '}',
    ].join('\n');
    document.head.appendChild(style);
  }

  // ── Register page ──────────────────────────────────────────────────────────
  registerPage('los', {
    init: function (container) {
      buildCSS();
      container.innerHTML = buildHTML();
      setTimeout(function () {
        initMap(document.getElementById('los-map'));
        setupAutocomplete('los-node-a', 'los-lat-a', 'los-lon-a', setPointA);
        setupAutocomplete('los-node-b', 'los-lat-b', 'los-lon-b', setPointB);
        document.getElementById('los-pick-a').addEventListener('click', function () {
          if (pickingPoint === 'a') stopPickMode(); else startPickMode('a');
        });
        document.getElementById('los-pick-b').addEventListener('click', function () {
          if (pickingPoint === 'b') stopPickMode(); else startPickMode('b');
        });
        document.getElementById('los-run').addEventListener('click', runAnalysis);

        // ── Tile picker ────────────────────────────────────────────────────
        var savedTile = localStorage.getItem('meshcore-los-tile') || 'default';
        document.getElementById('los-tile-default').classList.toggle('active', savedTile === 'default');
        document.getElementById('los-tile-topo').classList.toggle('active', savedTile === 'topo');

        function switchLosTile(key) {
          localStorage.setItem('meshcore-los-tile', key);
          setLosTiles(key);
          document.getElementById('los-tile-default').classList.toggle('active', key === 'default');
          document.getElementById('los-tile-topo').classList.toggle('active', key === 'topo');
        }
        document.getElementById('los-tile-default').addEventListener('click', function () { switchLosTile('default'); });
        document.getElementById('los-tile-topo').addEventListener('click', function () { switchLosTile('topo'); });

        // ── Full-screen modal close handlers ───────────────────────────────
        var modalClose = document.getElementById('los-modal-close');
        var modalBackdrop = document.getElementById('los-modal-backdrop');
        if (modalClose) modalClose.addEventListener('click', closeModal);
        if (modalBackdrop) modalBackdrop.addEventListener('click', closeModal);
        function onEsc(e) { if (e.key === 'Escape') closeModal(); }
        document.addEventListener('keydown', onEsc);
        _cleanups.push(function () { document.removeEventListener('keydown', onEsc); });
      }, 0);
    },
    destroy: function () {
      _cleanups.forEach(function (fn) { fn(); });
      _cleanups = [];
      if (losMap) {
        losMap.off('click', onMapClick);
        losMap.remove();
        losMap = null;
      }
      if (_losThemeObs) { _losThemeObs.disconnect(); _losThemeObs = null; }
      _losTileLayer = null;
      if (losChart) { losChart.destroy(); losChart = null; }
      if (losModalChart) { losModalChart.destroy(); losModalChart = null; }
      _lastResult = null;
      markerA = markerB = losPolyline = relayMarker = null;
      pickingPoint = null;
      var s = document.getElementById('los-styles');
      if (s) s.remove();
    },
  });
})();
