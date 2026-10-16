'use strict';

const TAIPEI = [[121.457, 24.960], [121.666, 25.210]];
const NLSC = layer => `https://wmts.nlsc.gov.tw/wmts/${layer}/default/GoogleMapsCompatible/{z}/{y}/{x}`;
// Shade uses a green ramp (ColorBrewer Greens, the lightest steps dropped so the light end stays
// distinct from the unfilled low-density villages). Vanished trees are violet: it separates from
// every green step under protan/deutan simulation, unlike orange or red.
const COLORS = {
  seq: ['#a1d99b', '#74c476', '#41ab5d', '#238b45', '#005a32'],
  pit: '#eb6834',
  gone: '#6250d6',
  muted: '#898781',
};
const SHADE_OPACITY = 0.66;
const GONE_EMOJI_ZOOM = 16;
const SCORE_STEPS = [20, 40, 60, 80];
const PIT_TEXT = {
  A: ['A 級', '2024 年有樹，現在空了（移除後沒補）'],
  B: ['B 級', '缺株：同一條路 15 m 內有樹'],
  C: ['C 級', '待確認：15 m 內沒有樹，也可能是資料沒涵蓋'],
};
const BASES = ['map', 'photo2024', 'photo2025'];
// Visitor counts come from GoatCounter (no cookies, no personal data); its public counter is cached for up to 4 hours.
const GOATCOUNTER = 'https://taipei-tree-shade.goatcounter.com';
const SITE_PATH = '/taipei-tree-shade/';
const LOOKUP_PATH = '/taipei-tree-shade/lookup';

const state = { mode: 'shade', villages: [], byCode: new Map(), pits: null, gone: null, meta: {},
  selected: null, pitShow: { A: true, B: true, C: false } };

const $ = sel => document.querySelector(sel);
const fmt = n => (n == null ? '—' : Number(n).toLocaleString('zh-TW'));
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const streetView = ([lon, lat]) => `https://www.google.com/maps/@?api=1&map_action=pano&viewpoint=${lat},${lon}`;
const isMobile = () => window.matchMedia('(max-width: 720px)').matches;
const padding = () => (isMobile()
  ? { top: 40, left: 20, right: 20, bottom: Math.round(window.innerHeight * 0.48) + 20 }
  : { top: 40, left: 400, right: 40, bottom: 40 });

// Start downloads before building the map, so the network overlaps map setup. The shade tab's data goes
// first; the other tabs' data starts once it is in, so it does not compete for bandwidth.
const downloads = {
  meta: loadJSON('data/meta.json'),
  villages: loadJSON('data/villages.topo.json').then(topo => topojson.feature(topo, topo.objects.villages)),
};
const afterVillages = downloads.villages.catch(() => {});
downloads.pits = afterVillages.then(() => loadJSON('data/pits.geojson'));
downloads.gone = afterVillages.then(() => loadJSON('data/gone.geojson'));

const map = new maplibregl.Map({
  container: 'map',
  bounds: TAIPEI,
  fitBoundsOptions: { padding: padding() },
  maxZoom: 20,
  attributionControl: false,
  style: {
    version: 8,
    sources: {
      map: { type: 'raster', tiles: [NLSC('EMAP01')], tileSize: 256, maxzoom: 19, attribution: '底圖、航照：內政部國土測繪中心' },
      photo2024: { type: 'raster', tiles: [NLSC('PHOTO2024')], tileSize: 256, maxzoom: 20 },
      photo2025: { type: 'raster', tiles: [NLSC('PHOTO2025')], tileSize: 256, maxzoom: 20 },
    },
    layers: BASES.map(b => ({ id: `base-${b}`, type: 'raster', source: b, layout: { visibility: b === 'map' ? 'visible' : 'none' } })),
  },
});
map.addControl(new maplibregl.AttributionControl({ compact: true }), 'bottom-right');
map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-right');

async function loadJSON(path) {
  const res = await fetch(path);
  if (!res.ok) throw new Error(`${path}: ${res.status}`);
  return res.json();
}

// All four files download at once and each is drawn as soon as it (and the map) is ready, in whatever
// order they arrive. A panel section waits only for the files it needs.
const PANEL_NEEDS = { shade: ['meta', 'villages'], pits: ['meta', 'villages'], gone: ['meta', 'gone'] };
const ready = {}, failed = {};
// Wait for the style only, not the basemap tiles ('load' waits for those), so data draws as early as possible.
const mapReady = new Promise(resolve => (map.isStyleLoaded() ? resolve() : map.once('style.load', resolve)));

// Share links carry only ?v=. A ?mode= URL was copied from the address bar, so open the default view instead.
const params = new URLSearchParams(location.search);
let pendingVillage = params.has('mode') ? null : params.get('v');
if (params.has('mode')) history.replaceState(null, '', location.pathname);

const ON_ARRIVAL = {
  meta(meta) { state.meta = meta; renderAbout(); },
  villages(villages) {
    state.villages = villages.features;
    for (const f of state.villages) {
      f.bbox = bboxOf(f.geometry.coordinates);
      state.byCode.set(f.properties.code, f);
    }
    addVillageLayers(villages);
  },
  pits(pits) { state.pits = pits; addPitLayer(pits); },
  gone(gone) { state.gone = gone; addGoneLayers(gone); },
};

mapReady.then(() => { state.mapReady = true; bindMapEvents(); setMode('shade'); });
renderVisits();
for (const name of Object.keys(downloads)) {
  Promise.all([downloads[name], mapReady])
    .then(([data]) => { ON_ARRIVAL[name](data); ready[name] = true; })
    .catch(err => { failed[name] = err.message; })
    .finally(onDataChange);
}
renderModeBody();  // shows 載入中… until the shade tab's data arrives

function onDataChange() {
  if (!state.mapReady) return;  // setMode() renders everything once the map loads
  applyModeToLayers();
  renderModeBody();
  if (pendingVillage && ready.villages && ready.meta) {
    const v = state.byCode.get(pendingVillage);
    pendingVillage = null;
    if (v) selectVillage(v);
  }
}

function bboxOf(rings) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const ring of rings) for (const [x, y] of ring) {
    x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y);
  }
  return [[x0, y0], [x1, y1]];
}

function inside(lon, lat, rings) {
  let hit = false;
  for (const ring of rings) {
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const [xi, yi] = ring[i], [xj, yj] = ring[j];
      if ((yi > lat) !== (yj > lat) && lon < (xj - xi) * (lat - yi) / (yj - yi) + xi) hit = !hit;
    }
  }
  return hit;
}

function findVillage(lon, lat) {
  return state.villages.find(f => {
    const [[x0, y0], [x1, y1]] = f.bbox;
    return lon >= x0 && lon <= x1 && lat >= y0 && lat <= y1 && inside(lon, lat, f.geometry.coordinates);
  });
}

function shadeColor() {
  return ['step', ['coalesce', ['get', 'shade_score'], 0], COLORS.seq[0],
    SCORE_STEPS[0], COLORS.seq[1], SCORE_STEPS[1], COLORS.seq[2], SCORE_STEPS[2], COLORS.seq[3], SCORE_STEPS[3], COLORS.seq[4]];
}

// Low-density villages are left unfilled: an unranked gray sat too close to the lightest green.
function shadeOpacity(on) {
  return on ? ['case', ['==', ['get', 'low_density'], true], 0, SHADE_OPACITY] : 0;
}

function pitFilter() {
  return ['in', ['get', 'c'], ['literal', Object.keys(state.pitShow).filter(k => state.pitShow[k])]];
}

const POINT_LAYERS = ['pits', 'gone', 'gone-emoji'];

function addVillageLayers(villages) {
  // Villages may arrive after the point layers; keep their fills underneath.
  const below = POINT_LAYERS.find(id => map.getLayer(id));
  map.addSource('villages', { type: 'geojson', data: villages, promoteId: 'code' });
  map.addLayer({ id: 'village-fill', type: 'fill', source: 'villages',
    paint: { 'fill-color': shadeColor(), 'fill-opacity': shadeOpacity(true) } }, below);
  map.addLayer({ id: 'village-line', type: 'line', source: 'villages',
    paint: { 'line-color': '#ffffff', 'line-width': ['interpolate', ['linear'], ['zoom'], 11, 0.4, 15, 1.4] } }, below);
  map.addLayer({ id: 'village-hover', type: 'line', source: 'villages',
    paint: { 'line-color': '#0b0b0b', 'line-width': 1.4,
      'line-opacity': ['case', ['boolean', ['feature-state', 'hover'], false], 0.8, 0] } }, below);
  map.addLayer({ id: 'village-selected', type: 'line', source: 'villages', filter: ['==', ['get', 'code'], ''],
    paint: { 'line-color': '#0b0b0b', 'line-width': 2.5 } }, below);
  bindVillageHover();
}

function addPitLayer(pits) {
  map.addSource('pits', { type: 'geojson', data: pits });
  map.addLayer({ id: 'pits', type: 'circle', source: 'pits', filter: pitFilter(),
    layout: { visibility: 'none', 'circle-sort-key': ['match', ['get', 'c'], 'A', 3, 'B', 2, 1] },
    paint: {
      'circle-radius': ['interpolate', ['linear'], ['zoom'], 11, 2, 14, 3.5, 17, 7],
      'circle-color': ['match', ['get', 'c'], 'A', COLORS.pit, '#ffffff'],
      'circle-stroke-color': ['match', ['get', 'c'], 'A', '#ffffff', 'B', COLORS.pit, COLORS.muted],
      'circle-stroke-width': ['match', ['get', 'c'], 'A', 1, 1.5],
    } });
  bindPointCursor('pits');
}

function addGoneLayers(gone) {
  map.addSource('gone', { type: 'geojson', data: gone });
  map.addLayer({ id: 'gone', type: 'circle', source: 'gone', maxzoom: GONE_EMOJI_ZOOM, layout: { visibility: 'none' },
    paint: {
      'circle-radius': ['interpolate', ['linear'], ['zoom'], 11, 2, 14, 3.5, 17, 7],
      'circle-color': COLORS.gone, 'circle-stroke-color': '#ffffff', 'circle-stroke-width': 1,
    } });
  // At street level each vanished tree becomes a 🪵, so a cleared row reads as a row of stumps.
  map.addImage('stump', emojiImage('🪵'), { pixelRatio: 2 });
  map.addLayer({ id: 'gone-emoji', type: 'symbol', source: 'gone', minzoom: GONE_EMOJI_ZOOM,
    layout: { visibility: 'none', 'icon-image': 'stump', 'icon-allow-overlap': true,
      'icon-size': ['interpolate', ['linear'], ['zoom'], GONE_EMOJI_ZOOM, 0.38, 19, 0.7] } });
  bindPointCursor('gone');
  bindPointCursor('gone-emoji');
}

// Drawn at 128 px so the enlarged icon stays sharp.
function emojiImage(ch, size = 128) {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext('2d');
  ctx.font = `${size * 0.8}px "Apple Color Emoji", "Segoe UI Emoji", "Noto Color Emoji", sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(ch, size / 2, size * 0.55);
  return ctx.getImageData(0, 0, size, size);
}

function bindMapEvents() {
  map.on('click', e => {
    const wanted = state.mode === 'pits' ? ['pits'] : state.mode === 'gone' ? ['gone', 'gone-emoji'] : [];
    const pointLayers = wanted.filter(id => map.getLayer(id));
    const box = [[e.point.x - 6, e.point.y - 6], [e.point.x + 6, e.point.y + 6]];
    const hit = pointLayers.length ? map.queryRenderedFeatures(box, { layers: pointLayers })[0] : null;
    if (hit) return showPointPopup(hit);
    if (!ready.villages || !ready.meta) return;
    const v = findVillage(e.lngLat.lng, e.lngLat.lat);
    if (v) selectVillage(v, { fly: false, track: true });
  });
}

function bindPointCursor(layer) {
  map.on('mouseenter', layer, () => { map.getCanvas().style.cursor = 'pointer'; });
  map.on('mouseleave', layer, () => { map.getCanvas().style.cursor = ''; });
}

function bindVillageHover() {
  let hovered = null;
  const tooltip = $('#tooltip');
  map.on('mousemove', 'village-fill', e => {
    const f = e.features[0];
    if (hovered !== f.id) {
      if (hovered != null) map.setFeatureState({ source: 'villages', id: hovered }, { hover: false });
      hovered = f.id;
      map.setFeatureState({ source: 'villages', id: hovered }, { hover: true });
    }
    if (state.mode !== 'shade') { tooltip.hidden = true; return; }
    const p = state.byCode.get(f.properties.code).properties;
    tooltip.innerHTML = `<strong>${esc(p.district)}${esc(p.village)}</strong><br>${
      p.low_density ? '山區里，不排名' : `每人 ${p.shade_m2_per_person} m² 樹蔭`}`;
    tooltip.style.left = `${e.originalEvent.clientX + 14}px`;
    tooltip.style.top = `${e.originalEvent.clientY + 14}px`;
    tooltip.hidden = false;
  });
  map.on('mouseleave', 'village-fill', () => {
    if (hovered != null) map.setFeatureState({ source: 'villages', id: hovered }, { hover: false });
    hovered = null;
    tooltip.hidden = true;
  });
}

function setMode(mode) {
  if (!['shade', 'pits', 'gone'].includes(mode)) mode = 'shade';
  state.mode = mode;
  document.querySelectorAll('.tabs button').forEach(b => b.setAttribute('aria-selected', String(b.dataset.mode === mode)));
  applyModeToLayers();
  renderModeBody();
}

// Layers that have not arrived yet are skipped; they pick up the mode when they are added.
function applyModeToLayers() {
  const mode = state.mode;
  if (map.getLayer('village-fill')) {
    map.setPaintProperty('village-fill', 'fill-opacity', shadeOpacity(mode === 'shade'));
    map.setPaintProperty('village-line', 'line-color', mode === 'shade' ? '#ffffff' : COLORS.muted);
  }
  if (map.getLayer('pits')) map.setLayoutProperty('pits', 'visibility', mode === 'pits' ? 'visible' : 'none');
  for (const layer of ['gone', 'gone-emoji']) {
    if (map.getLayer(layer)) map.setLayoutProperty(layer, 'visibility', mode === 'gone' ? 'visible' : 'none');
  }
}

function scoreBreaks() {
  const scored = state.villages.map(f => f.properties).filter(p => !p.low_density && p.shade_score != null);
  const values = scored.map(p => p.shade_m2_per_person);
  const breaks = SCORE_STEPS.map(t => Math.min(...scored.filter(p => p.shade_score >= t).map(p => p.shade_m2_per_person)));
  return [Math.min(...values), ...breaks, Math.max(...values)];
}

function rankList(items, label, value) {
  return `<ol class="rank">${items.map(p => `<li data-code="${esc(p.code)}"><span>${esc(label(p))}</span><span class="num">${esc(value(p))}</span></li>`).join('')}</ol>`;
}

function renderModeBody() {
  const body = $('#mode-body');
  const needs = PANEL_NEEDS[state.mode];
  const broken = needs.filter(name => failed[name]);
  if (broken.length) {
    body.innerHTML = `<p>資料載入失敗：${esc(broken.map(name => failed[name]).join('、'))}</p>`;
    return;
  }
  if (!needs.every(name => ready[name])) {
    body.innerHTML = '<p class="hint">載入中…</p>';
    return;
  }
  const villages = state.villages.map(f => f.properties);
  if (state.mode === 'shade') {
    const b = scoreBreaks();
    const least = villages.filter(p => !p.low_density).sort((a, c) => a.shade_m2_per_person - c.shade_m2_per_person).slice(0, 10);
    body.innerHTML = `
      <p>每個里的居民，平均分到多少行道樹樹蔭。顏色越深，樹蔭越多。</p>
      <div class="legend">
        <div class="ramp">${COLORS.seq.map(c => `<span style="background:${c}"></span>`).join('')}</div>
        <div class="ramp-labels">${b.map(v => `<span>${v < 10 ? v.toFixed(1) : Math.round(v)}</span>`).join('')}</div>
        <div>每人分到的行道樹樹蔭（m²，估計）</div>
        <div class="item"><span class="swatch square no-rank"></span>陽明山、貓空等山區里：不上色、不排名</div>
      </div>
      <h3>每人樹蔭最少的 10 個里</h3>
      ${rankList(least, p => `${p.district}${p.village}`, p => `${p.shade_m2_per_person} m²`)}`;
  } else if (state.mode === 'pits') {
    const c = state.meta.pit_classes || {};
    const total = Object.values(c).reduce((s, n) => s + n, 0);
    const mostA = [...villages].sort((a, v) => v.pits_A - a.pits_A).slice(0, 10);
    body.innerHTML = `
      <p>新工處登錄的 ${fmt(total)} 個樹穴，和行道樹位置比對後，這些是空的：</p>
      <div class="legend">
        ${['A', 'B', 'C'].map(k => `
          <label><input type="checkbox" data-pit="${k}" ${state.pitShow[k] ? 'checked' : ''}>
            <span class="swatch" style="${k === 'A' ? `background:${COLORS.pit}` : `border:2px solid ${k === 'B' ? COLORS.pit : COLORS.muted}`}"></span>
            <span><strong>${PIT_TEXT[k][0]} ${fmt(c[k])}</strong>　${PIT_TEXT[k][1]}</span></label>`).join('')}
      </div>
      <p class="hint">資料比對結果，尚待現場確認。點任一點可開街景或切換航照。</p>
      <h3>A 級空樹穴最多的 10 個里</h3>
      ${rankList(mostA, p => `${p.district}${p.village}`, p => `${fmt(p.pits_A)} 個`)}`;
    body.querySelectorAll('input[data-pit]').forEach(input => input.addEventListener('change', () => {
      state.pitShow[input.dataset.pit] = input.checked;
      if (map.getLayer('pits')) map.setFilter('pits', pitFilter());
    }));
  } else {
    const roads = new Map();
    for (const f of state.gone.features) {
      const key = `${f.properties.district}${(f.properties.road || '').split(' ')[0]}`;
      if (!roads.has(key)) roads.set(key, []);
      roads.get(key).push(f.geometry.coordinates);
    }
    const top = [...roads.entries()].sort((a, b) => b[1].length - a[1].length).slice(0, 10);
    body.innerHTML = `
      <p class="headline">🪵 ${fmt(state.meta.disappeared_trees)}<small>棵</small></p>
      <p>2024 年 11 月的行道樹資料裡有，現在消失、5 公尺內也沒有其他樹的行道樹。</p>
      <div class="legend"><div class="item"><span class="swatch" style="background:${COLORS.gone}"></span>消失的行道樹（放大到街道後顯示為 🪵）</div></div>
      <p class="hint">資料中消失不一定是被砍除，也可能是移植或資料修正。點任一點，可以切換 113、114 年航照比對。</p>
      <h3>消失最多的路段</h3>
      <ol class="rank">${top.map(([road, pts], i) => `<li data-road="${i}"><span>${esc(road)}</span><span class="num">${fmt(pts.length)} 棵</span></li>`).join('')}</ol>`;
    body.querySelectorAll('li[data-road]').forEach(li => li.addEventListener('click', () => {
      const pts = top[Number(li.dataset.road)][1];
      const lons = pts.map(p => p[0]), lats = pts.map(p => p[1]);
      map.fitBounds([[Math.min(...lons), Math.min(...lats)], [Math.max(...lons), Math.max(...lats)]], { padding: padding(), maxZoom: 18 });
    }));
  }
  body.querySelectorAll('li[data-code]').forEach(li => li.addEventListener('click', () => selectVillage(state.byCode.get(li.dataset.code), { track: true })));
}

// Five 🌳, one lit per shade quintile (the same bins as the map colours); none lit when the village has no street trees.
function treeMeter(p) {
  if (p.low_density) return '';
  const lit = p.street_trees === 0 ? 0 : 1 + SCORE_STEPS.filter(t => (p.shade_score ?? 0) >= t).length;
  const trees = Array.from({ length: 5 }, (_, i) => `<span class="${i < lit ? 'on' : 'off'}">🌳</span>`).join('');
  return `<div class="tree-meter" role="img" aria-label="樹蔭等級 ${lit} / 5">${trees}<span class="tree-meter-label">樹蔭等級 ${lit} / 5</span></div>`;
}

function rankText(p) {
  if (p.low_density) return '位於山區、每公頃不到 5 人，樹蔭主要來自山林，不列入排名。';
  const n = state.meta.villages_scored, r = p.shade_rank_from_bottom, ties = p.shade_rank_ties || 1;
  const tie = ties > 1 ? `（${ties} 個里並列）` : '';
  // A tied group spans ranks r .. r + ties - 1 from the bottom; counted from the top it starts at n - (r + ties - 1) + 1.
  return r <= n / 2
    ? `全市 ${n} 個里中，樹蔭倒數第 ${r} 名${tie}。`
    : `全市 ${n} 個里中，樹蔭排第 ${n - (r + ties - 1) + 1} 名${tie}。`;
}

// track: count this as a lookup. Only user actions pass it, not a share link opening a village.
function selectVillage(f, { fly = true, track = false } = {}) {
  const p = f.properties;
  state.selected = p.code;
  if (track) trackLookup();
  map.setFilter('village-selected', ['==', ['get', 'code'], p.code]);
  if (fly) map.fitBounds(f.bbox, { padding: padding(), maxZoom: 16 });
  // Only ?v= goes in the address bar, so a copied URL always opens on the default shade tab.
  history.replaceState(null, '', `?v=${encodeURIComponent(p.code)}`);

  const card = $('#village-card');
  card.hidden = false;
  card.innerHTML = `
    <h2>${esc(p.district)} ${esc(p.village)}</h2>
    ${treeMeter(p)}
    <p class="headline">${p.shade_m2_per_person ?? '—'} m²<small>每人分到的行道樹樹蔭（估計）</small></p>
    <p>${rankText(p)}</p>
    <dl>
      <dt>🌳 行道樹（含里界 ${state.meta.boundary_buffer_m} m 內）</dt><dd>${fmt(p.street_trees)} 棵</dd>
      <dt>人口</dt><dd>${fmt(p.population)}</dd>
      <dt>65 歲以上</dt><dd>${p.elderly_pct ?? '—'}%</dd>
      <dt>🌱 空樹穴 A / B / C</dt><dd>${fmt(p.pits_A)} / ${fmt(p.pits_B)} / ${fmt(p.pits_C)}</dd>
      <dt>🪵 2024 年以來消失的樹</dt><dd>${fmt(p.disappeared)} 棵</dd>
    </dl>
    <div class="actions">
      <button class="ghost" id="share-btn">分享這個里</button>
      <a class="ghost" target="_blank" rel="noopener" href="https://social-plugins.line.me/lineit/share?url=${encodeURIComponent(shareUrl(p))}">分享到 LINE</a>
    </div>
    <p class="hint" id="share-status"></p>`;
  $('#share-btn').addEventListener('click', () => share(p));
  card.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

// Record one lookup per page load as a virtual pageview, so the public counter can report it per visitor.
function trackLookup() {
  if (state.lookupTracked) return;
  state.lookupTracked = true;
  const send = () => window.goatcounter?.count?.({ path: LOOKUP_PATH, title: '查詢里的樹蔭' });
  if (window.goatcounter?.count) send();
  else window.addEventListener('load', send, { once: true });
}

async function renderVisits() {
  const count = async path => {
    const res = await fetch(`${GOATCOUNTER}/counter/${encodeURI(path)}.json`);
    return res.ok ? (await res.json()).count : null;
  };
  try {
    const [visits, lookups] = await Promise.all([count(SITE_PATH), count(LOOKUP_PATH)]);
    if (visits == null) return;
    const el = $('#visits');
    el.textContent = lookups != null ? `已有 ${visits} 人造訪，${lookups} 人查過里的樹蔭` : `已有 ${visits} 人造訪`;
    el.hidden = false;
  } catch { /* the counter is optional; blocked or offline just hides it */ }
}

function shareUrl(p) {
  return `${location.origin}${location.pathname}?v=${encodeURIComponent(p.code)}`;
}

async function share(p) {
  const url = shareUrl(p);
  const text = p.low_density
    ? `把三千棵🌳種回來｜${p.district}${p.village}的樹蔭地圖。查查你家：`
    : `把三千棵🌳種回來｜${p.district}${p.village}每人只分到 ${p.shade_m2_per_person} m² 行道樹樹蔭，${rankText(p)}查查你家：`;
  if (navigator.share) {
    try { await navigator.share({ title: '把三千棵🌳種回來', text, url }); return; } catch { /* fall through to copy */ }
  }
  try {
    await navigator.clipboard.writeText(`${text}${url}`);
    $('#share-status').textContent = '已複製分享文字與連結。';
  } catch {
    $('#share-status').textContent = url;
  }
}

function showPointPopup(f) {
  const p = f.properties, coords = f.geometry.coordinates;
  const html = f.layer.id === 'pits'
    ? `<h4>空樹穴・${esc(PIT_TEXT[p.c][0])}</h4>
       <p>${esc(PIT_TEXT[p.c][1])}</p>
       <p>${esc(p.district)} ${esc(p.road || '附近沒有可對照的路名')}</p>
       <p>樹穴面積 ${esc(p.area)} m²${p.near != null ? `・最近的樹 ${esc(p.near)} m` : ''}</p>`
    : `<h4>消失的${esc(p.species)}</h4>
       <p>${esc(p.district)} ${esc(p.road)}</p>
       <p>胸徑 ${esc(p.dbh)} cm・樹高 ${esc(p.height)} m・調查於 ${esc(p.surveyed)}</p>`;
  const popup = new maplibregl.Popup({ maxWidth: '300px' }).setLngLat(coords).setHTML(`${html}
    <div class="links"><a href="${streetView(coords)}" target="_blank" rel="noopener">Google 街景</a>
    <button data-base="photo2024">113 年航照</button><button data-base="photo2025">114 年航照</button></div>`).addTo(map);
  popup.getElement().querySelectorAll('button[data-base]').forEach(btn => btn.addEventListener('click', () => {
    setBase(btn.dataset.base);
    map.easeTo({ center: coords, zoom: Math.max(map.getZoom(), 19) });
  }));
}

function setBase(base) {
  for (const b of BASES) map.setLayoutProperty(`base-${b}`, 'visibility', b === base ? 'visible' : 'none');
  document.querySelectorAll('.seg button').forEach(btn => btn.setAttribute('aria-checked', String(btn.dataset.base === base)));
}

function renderAbout() {
  const m = state.meta;
  $('#about-body').innerHTML = `
    <ul>
      <li>行道樹、公園樹木：臺北市政府工務局公園路燈工程管理處（<a href="https://data.gov.tw/dataset/128274" target="_blank" rel="noopener">開放資料</a>），${esc(m.trees_downloaded)} 下載，行道樹 ${fmt(m.street_trees_now)} 棵。</li>
      <li>2024 年 11 月行道樹（${fmt(m.street_trees_2024_11)} 棵）：同一份官方檔案的舊版，由 Wayback Machine 存檔。</li>
      <li>樹穴：臺北市政府工務局新建工程處（<a href="https://data.gov.tw/dataset/134908" target="_blank" rel="noopener">開放資料</a>）。</li>
      <li>村里界、底圖、航照：內政部國土測繪中心。人口：臺北市政府民政局，${esc(m.population_month)}。</li>
    </ul>
    <p>樹蔭是估計值：用樹幹胸徑推算樹冠大小（樹冠直徑以公尺計，約為胸徑公分數的 ${esc(m.crown_m_per_dbh_cm)} 倍），只用來比較各里高低。里界多沿道路中線劃，里界 ${esc(m.boundary_buffer_m)} 公尺內的行道樹會同時算給兩側的里。每公頃不到 ${esc(m.low_density_per_ha)} 人的里（陽明山、貓空等山區，樹蔭主要來自山林）不列入排名。</p>
    <p>空樹穴和消失的樹是資料比對的結果，尚待現場確認。</p>
    <p>造訪人數由 <a href="https://www.goatcounter.com/" target="_blank" rel="noopener">GoatCounter</a> 統計，不使用 cookie、不記錄個資，數字最多延遲 4 小時更新。</p>`;
}

document.querySelectorAll('.tabs button').forEach(b => b.addEventListener('click', () => {
  setMode(b.dataset.mode);
  if (state.selected) selectVillage(state.byCode.get(state.selected), { fly: false });
}));
document.querySelectorAll('.seg button').forEach(b => b.addEventListener('click', () => setBase(b.dataset.base)));

let locateMarker = null;
$('#locate-btn').addEventListener('click', () => {
  const btn = $('#locate-btn'), hint = document.querySelector('.locate .hint');
  if (!navigator.geolocation) { hint.textContent = '這個瀏覽器不支援定位，請直接點地圖。'; return; }
  btn.textContent = '定位中…';
  navigator.geolocation.getCurrentPosition(pos => {
    btn.textContent = '查我家附近';
    const { longitude: lon, latitude: lat } = pos.coords;
    if (!ready.villages || !ready.meta) { hint.textContent = '資料還在載入，請稍候再按一次。'; return; }
    const v = findVillage(lon, lat);
    if (!v) { hint.textContent = '你目前不在台北市，請直接點地圖上的里。'; return; }
    if (locateMarker) locateMarker.remove();
    locateMarker = new maplibregl.Marker({ color: '#0b0b0b' }).setLngLat([lon, lat]).addTo(map);
    selectVillage(v, { track: true });
  }, err => {
    btn.textContent = '查我家附近';
    hint.textContent = `無法取得位置（${err.message}），請直接點地圖。`;
  }, { enableHighAccuracy: true, timeout: 10000 });
});
