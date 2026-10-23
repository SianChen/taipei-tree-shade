'use strict';

const TAIPEI = [[121.457, 24.960], [121.666, 25.210]];
const NLSC = layer => `https://wmts.nlsc.gov.tw/wmts/${layer}/default/GoogleMapsCompatible/{z}/{y}/{x}`;
// Shade uses a green ramp, one step per shade class (meta.shade_breaks_m2): ColorBrewer Greens with the
// lightest steps dropped so the light end stays distinct from the unfilled unranked villages, and the blue
// taken out of the two darkest steps: blended onto the cool-gray basemap they otherwise read as slate blue.
// Vanished trees are violet: it separates from every green step under protan/deutan simulation, unlike orange or red.
const COLORS = {
  seq: ['#a1d99b', '#74c476', '#41ab5d', '#238b45', '#0b6e24', '#03470c'],
  pit: '#eb6834',
  gone: '#6250d6',
  muted: '#898781',
};
const SHADE_OPACITY = 0.75;
const BASEMAP_GRAY = '#eaebed';  // EMAP01's light gray, recovered from a screenshot; the legend blends onto it like the map does
const GONE_EMOJI_ZOOM = 16;
const PIT_EMOJI_ZOOM = 16;
const PIT_TEXT = {
  A: ['A 級', '2024 年有樹，現在空了（移除後沒補）'],
  B: ['B 級', '缺株：同一條路 15 m 內有樹'],
  C: ['C 級', '待確認：15 m 內沒有樹，也可能是資料沒涵蓋'],
};
const BASES = ['map', 'photo2024', 'photo2025'];
// The 五色鳥 in web/img/shade-N.webp, one scene per shade level (1 = least shade); cut by scripts/cut_mascot.py.
const SHADE_SCENES = ['在大太陽下冒汗、拿扇子搧風', '縮在一片小葉子下', '站在細樹枝上，半曬半蔭',
  '在樹蔭裡站著，表情放鬆', '在樹枝上打盹', '在濃密樹冠裡睡覺，旁邊有樹洞'];
// The sticker (web/img/bird-*.webp) that hops up on the map when a village is picked, by shade level.
// Unranked villages get the wave: no mood, since their shade is not measured.
const LEVEL_STICKERS = ['hot', 'worried', 'wave', 'laugh', 'sparkle', 'sleep'];
const PERSON_ICON = '<svg viewBox="0 0 13 18"><circle cx="6.5" cy="4" r="3.5"/><path d="M0 18c0-4.4 2.9-8 6.5-8s6.5 3.6 6.5 8z"/></svg>';
// Visitor counts come from GoatCounter (no cookies, no personal data); its public counter is cached for up to 4 hours.
const GOATCOUNTER = 'https://taipei-tree-shade.goatcounter.com';
const SITE_PATH = '/taipei-tree-shade/';
const LOOKUP_PATH = '/taipei-tree-shade/lookup';

const state = { mode: 'shade', villages: [], byCode: new Map(), pits: null, gone: null, meta: {},
  selected: null, pitShow: { A: true, B: true, C: false }, rankEnd: 'least' };

const $ = sel => document.querySelector(sel);
const fmt = n => (n == null ? '—' : Number(n).toLocaleString('zh-TW'));
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
// Mountain villages (low density) and hillside villages get their shade from forest the tree lists miss, so they are not ranked.
const unranked = p => p.low_density || p.hillside;
const streetView = ([lon, lat]) => `https://www.google.com/maps/@?api=1&map_action=pano&viewpoint=${lat},${lon}`;
const isMobile = () => window.matchMedia('(max-width: 720px)').matches;
const reducedMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;
const padding = () => (isMobile()
  ? { top: 40, left: 20, right: 20, bottom: Math.round(window.innerHeight * 0.48) + 20 }
  : { top: 40, left: 412, right: 40, bottom: 40 });

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
// Fetch the mascot images once the data is in, so a picked village's bird shows without a wait.
Promise.allSettled(Object.values(downloads)).then(() => {
  for (let level = 1; level <= SHADE_SCENES.length; level++) new Image().src = `img/shade-${level}.webp`;
  for (const name of LEVEL_STICKERS) new Image().src = `img/bird-${name}.webp`;
});

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

// The colour a shade fill shows on the map: the fill at SHADE_OPACITY over the basemap.
function onMap(hex) {
  const rgb = h => [1, 3, 5].map(i => parseInt(h.slice(i, i + 2), 16));
  const [fill, base] = [rgb(hex), rgb(BASEMAP_GRAY)];
  return `rgb(${fill.map((v, i) => Math.round(SHADE_OPACITY * v + (1 - SHADE_OPACITY) * base[i])).join(',')})`;
}

function shadeColor() {
  return ['step', ['coalesce', ['get', 'shade_class'], 0], COLORS.seq[0], ...COLORS.seq.slice(1).flatMap((c, i) => [i + 1, c])];
}

// Unranked villages are left unfilled: an unranked gray sat too close to the lightest green.
function shadeOpacity(on) {
  return on ? ['case', ['any', ['==', ['get', 'low_density'], true], ['==', ['get', 'hillside'], true]], 0, SHADE_OPACITY] : 0;
}

function pitFilter() {
  return ['in', ['get', 'c'], ['literal', Object.keys(state.pitShow).filter(k => state.pitShow[k])]];
}

const POINT_LAYERS = ['pits', 'pits-emoji', 'gone', 'gone-emoji'];
const PIT_LAYERS = ['pits', 'pits-emoji'];

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
  const sortKey = ['match', ['get', 'c'], 'A', 3, 'B', 2, 1];
  map.addLayer({ id: 'pits', type: 'circle', source: 'pits', filter: pitFilter(), maxzoom: PIT_EMOJI_ZOOM,
    layout: { visibility: 'none', 'circle-sort-key': sortKey },
    paint: {
      'circle-radius': ['interpolate', ['linear'], ['zoom'], 11, 2, 14, 3.5, 17, 7],
      'circle-color': ['match', ['get', 'c'], 'A', COLORS.pit, '#ffffff'],
      'circle-stroke-color': ['match', ['get', 'c'], 'A', '#ffffff', 'B', COLORS.pit, COLORS.muted],
      'circle-stroke-width': ['match', ['get', 'c'], 'A', 1, 1.5],
    } });
  // At street level each empty pit becomes a 🌱 on its class's disc: what can be planted again, against the 🪵 of what was lost.
  for (const [c, fill, stroke] of [['A', COLORS.pit, '#ffffff'], ['B', '#ffffff', COLORS.pit], ['C', '#ffffff', COLORS.muted]]) {
    map.addImage(`sprout-${c}`, emojiImage('🌱', { fill, stroke }), { pixelRatio: 2 });
  }
  map.addLayer({ id: 'pits-emoji', type: 'symbol', source: 'pits', filter: pitFilter(), minzoom: PIT_EMOJI_ZOOM,
    layout: { visibility: 'none', 'icon-image': ['concat', 'sprout-', ['get', 'c']], 'icon-allow-overlap': true,
      'symbol-sort-key': sortKey,
      'icon-size': ['interpolate', ['linear'], ['zoom'], PIT_EMOJI_ZOOM, 0.34, 19, 0.6] } });
  PIT_LAYERS.forEach(bindPointCursor);
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

// Drawn at 128 px so the enlarged icon stays sharp. With a disc ({ fill, stroke }) the emoji sits smaller on a ringed circle.
function emojiImage(ch, disc = null, size = 128) {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext('2d');
  if (disc) {
    ctx.beginPath();
    ctx.arc(size / 2, size / 2, size * 0.43, 0, 2 * Math.PI);
    ctx.fillStyle = disc.fill;
    ctx.fill();
    ctx.lineWidth = size * 0.08;
    ctx.strokeStyle = disc.stroke;
    ctx.stroke();
  }
  ctx.font = `${size * (disc ? 0.52 : 0.8)}px "Apple Color Emoji", "Segoe UI Emoji", "Noto Color Emoji", sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(ch, size / 2, size * 0.55);
  return ctx.getImageData(0, 0, size, size);
}

function bindMapEvents() {
  map.on('click', e => {
    const wanted = state.mode === 'pits' ? PIT_LAYERS : state.mode === 'gone' ? ['gone', 'gone-emoji'] : [];
    const pointLayers = wanted.filter(id => map.getLayer(id));
    const box = [[e.point.x - 6, e.point.y - 6], [e.point.x + 6, e.point.y + 6]];
    const hit = pointLayers.length ? map.queryRenderedFeatures(box, { layers: pointLayers })[0] : null;
    if (hit) return showPointPopup(hit);
    if (!ready.villages || !ready.meta) return;
    const v = findVillage(e.lngLat.lng, e.lngLat.lat);
    if (v) selectVillage(v, { fly: false, track: true, at: e.lngLat });
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
      p.low_density ? '山區里，不排名' : p.hillside ? '靠山的里，不排名' : `每人 ${p.shade_m2_per_person} m² 樹蔭`}`;
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
  for (const layer of PIT_LAYERS) {
    if (map.getLayer(layer)) map.setLayoutProperty(layer, 'visibility', mode === 'pits' ? 'visible' : 'none');
  }
  for (const layer of ['gone', 'gone-emoji']) {
    if (map.getLayer(layer)) map.setLayoutProperty(layer, 'visibility', mode === 'gone' ? 'visible' : 'none');
  }
}

// Legend labels: 0, the lower edge of each class above the first, and the highest ranked value.
function legendLabels() {
  const max = Math.max(...state.villages.map(f => f.properties).filter(p => !unranked(p)).map(p => p.shade_m2_per_person));
  return [0, ...state.meta.shade_breaks_m2, max];
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
    const labels = legendLabels();
    const ranked = villages.filter(p => !unranked(p)).sort((a, c) => a.shade_m2_per_person - c.shade_m2_per_person);
    const most = state.rankEnd === 'most';
    const shown = most ? ranked.slice(-10).reverse() : ranked.slice(0, 10);
    body.innerHTML = `
      <p>每個里的居民，平均分到多少樹蔭（行道樹和公園樹木）。顏色越深，樹蔭越多，每一階約占六分之一的里。</p>
      <div class="legend">
        <div class="ramp">${COLORS.seq.map(c => `<span style="background:${onMap(c)}"></span>`).join('')}</div>
        <div class="ramp-labels">${labels.map(v => `<span>${v < 10 ? v : Math.round(v)}</span>`).join('')}</div>
        <div>每人分到的樹蔭（m²，估計）</div>
        <div class="item"><span class="swatch square no-rank"></span>山區和靠山的里：不上色、不排名</div>
      </div>
      <div class="rank-head">
        <h3>每人樹蔭${most ? '最多' : '最少'}的 10 個里</h3>
        <div class="seg compact" role="radiogroup" aria-label="列出樹蔭最少或最多的里">
          <button role="radio" data-end="least" aria-checked="${!most}">最少</button>
          <button role="radio" data-end="most" aria-checked="${most}">最多</button>
        </div>
      </div>
      ${rankList(shown, p => `${p.district}${p.village}`, p => `${p.shade_m2_per_person} m²`)}`;
    body.querySelectorAll('button[data-end]').forEach(btn => btn.addEventListener('click', () => {
      state.rankEnd = btn.dataset.end;
      renderModeBody();
    }));
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
      <p class="hint">放大到街道後，每個空樹穴顯示為 🌱。資料比對結果，尚待現場確認。點任一點可開街景或切換航照。</p>
      <h3>A 級空樹穴最多的 10 個里</h3>
      ${rankList(mostA, p => `${p.district}${p.village}`, p => `${fmt(p.pits_A)} 個`)}`;
    body.querySelectorAll('input[data-pit]').forEach(input => input.addEventListener('change', () => {
      state.pitShow[input.dataset.pit] = input.checked;
      for (const layer of PIT_LAYERS) if (map.getLayer(layer)) map.setFilter(layer, pitFilter());
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

// One 🌳 per shade class, lit up to the village's class (the map colour); none lit when the village has no trees at all.
function treeMeter(p) {
  if (unranked(p)) return '';
  const levels = COLORS.seq.length;
  const lit = p.street_trees + p.park_trees === 0 ? 0 : 1 + p.shade_class;
  const trees = Array.from({ length: levels }, (_, i) => `<span class="${i < lit ? 'on' : 'off'}">🌳</span>`).join('');
  return `<div class="tree-meter" role="img" aria-label="樹蔭等級 ${lit} / ${levels}">${trees}<span class="tree-meter-label">樹蔭等級 ${lit} / ${levels}</span></div>`;
}

// City rank counted from whichever end is nearer, with the share of ranked villages it has more (or less) shade than.
// A tied group spans ranks r .. r + ties - 1 from the bottom; counted from the top it starts at n - (r + ties - 1) + 1.
// The share is floored, so "多於 76%" is never claimed for 75.9%.
function cityRank(p) {
  const n = state.meta.villages_scored, r = p.shade_rank_from_bottom, ties = p.shade_rank_ties || 1;
  return r <= n / 2
    ? { n, ties, bottom: true, rank: r, pct: Math.floor(100 * (n - (r + ties - 1)) / n) }
    : { n, ties, bottom: false, rank: n - (r + ties - 1) + 1, pct: Math.floor(100 * (r - 1) / n) };
}

// The same count within the district, from the ranked villages' values.
function districtRank(p) {
  const peers = state.villages.map(f => f.properties).filter(q => q.district === p.district && !unranked(q));
  const above = peers.filter(q => q.shade_m2_per_person > p.shade_m2_per_person).length;
  const below = peers.filter(q => q.shade_m2_per_person < p.shade_m2_per_person).length;
  const n = peers.length, ties = n - above - below;
  return below + 1 <= n / 2 ? { n, ties, bottom: true, rank: below + 1 } : { n, ties, bottom: false, rank: above + 1 };
}

const tieText = ties => (ties > 1 ? `（${ties} 個里並列）` : '');

function rankText(p) {
  if (p.low_density) return '位於山區、每公頃不到 5 人，樹蔭主要來自山林，不列入排名。';
  if (p.hillside) return `里內 ${p.hillside_pct}% 是山坡保護區，樹蔭主要來自樹木資料沒有涵蓋的山林，不列入排名。`;
  const { n, ties, bottom, rank } = cityRank(p);
  return `全市 ${n} 個里中，樹蔭${bottom ? '倒數' : '排'}第 ${rank} 名${tieText(ties)}。`;
}

function rankLines(p) {
  if (unranked(p)) return `<p class="vc-rank">${rankText(p)}</p>`;
  const c = cityRank(p), d = districtRank(p);
  return `<div>
    <p class="vc-rank"><span>全市 ${c.n} 個里中${c.bottom ? '倒數' : ''}第 <b>${c.rank}</b> 名${tieText(c.ties)}，</span><span>樹蔭${c.bottom ? '少' : '多'}於 <b>${c.pct}%</b> 的里</span></p>
    <p class="vc-rank-sub">${esc(p.district)} ${d.n} 個里中${d.bottom ? '倒數' : ''}第 ${d.rank} 名${tieText(d.ties)}</p>
  </div>`;
}

function mascot(p, animate) {
  const cls = `mascot${animate ? ' pop' : ''}`;
  if (unranked(p)) return `<img class="${cls} sticker" src="img/bird-wave.webp" alt="五色鳥在揮手">`;
  const level = 1 + p.shade_class;
  return `<img class="${cls}" src="img/shade-${level}.webp" alt="五色鳥${SHADE_SCENES[level - 1]}">`;
}

// The shade per person, retold as residents per tree from the same counts as the card (crowns are not 1 m² each,
// so trees are counted, not shade). Left out for unranked villages, whose forest is not in the tree data.
function treesPerPerson(p) {
  if (unranked(p) || !p.population) return '';
  const trees = p.street_trees + p.park_trees;
  let icons, line;
  if (trees === 0) {
    icons = PERSON_ICON;
    line = `里界 ${state.meta.boundary_buffer_m} m 內<strong>沒有</strong>行道樹或公園樹木`;
  } else if (trees >= p.population) {
    const each = trees / p.population;
    icons = `<span class="tree">${'🌳'.repeat(Math.min(Math.round(each), 3))}</span>${PERSON_ICON}`;
    line = `每人約分到 <strong>${each.toFixed(1)} 棵樹</strong>`;
  } else {
    const people = Math.round(p.population / trees);
    icons = `<span class="tree">🌳</span>${PERSON_ICON.repeat(Math.min(people, 10))}${people > 10 ? '…' : ''}`;
    line = `大約每 <strong>${fmt(people)} 人</strong>分 1 棵樹`;
  }
  return `<div class="vc-box"><div class="vc-icons" aria-hidden="true">${icons}</div><p>${line}</p></div>`;
}

// A sticker of the village's mood hops up where it was picked, then fades.
let popMarker = null;
function popSticker(p, lngLat) {
  if (reducedMotion()) return;
  const img = new Image();
  img.src = `img/bird-${unranked(p) ? 'wave' : LEVEL_STICKERS[p.shade_class]}.webp`;
  img.alt = '';
  img.decode().then(() => {
    img.width = img.naturalWidth / 2;  // the stickers are cut at 2x
    const el = document.createElement('div');
    el.className = 'map-pop';
    el.append(img);
    popMarker?.remove();
    const marker = popMarker = new maplibregl.Marker({ element: el, anchor: 'bottom' }).setLngLat(lngLat).addTo(map);
    img.addEventListener('animationend', () => marker.remove(), { once: true });
  }).catch(() => {});
}

// track: count this as a lookup. Only user actions pass it, not a share link opening a village.
// animate: a new pick (the card pops and a sticker hops up at `at`, or mid-village); re-renders for a tab switch pass false.
function selectVillage(f, { fly = true, track = false, animate = true, at = null } = {}) {
  const p = f.properties;
  state.selected = p.code;
  if (track) trackLookup();
  map.setFilter('village-selected', ['==', ['get', 'code'], p.code]);
  if (fly) map.fitBounds(f.bbox, { padding: padding(), maxZoom: 16 });
  // Only ?v= goes in the address bar, so a copied URL always opens on the default shade tab.
  history.replaceState(null, '', `?v=${encodeURIComponent(p.code)}`);
  if (animate) {
    const [[x0, y0], [x1, y1]] = f.bbox;
    const spot = at || [(x0 + x1) / 2, (y0 + y1) / 2];
    if (fly) map.once('moveend', () => popSticker(p, spot));
    else popSticker(p, spot);
  }

  const card = $('#village-card');
  card.hidden = false;
  card.innerHTML = `
    <h2>${esc(p.village)}<small>${esc(p.district)}</small></h2>
    <div class="vc-hero">
      ${mascot(p, animate)}
      <div>
        ${treeMeter(p)}
        <p class="big-num">${p.shade_m2_per_person ?? '—'}<small>m²</small></p>
        <p class="big-label">每人分到的樹蔭（估計）</p>
      </div>
    </div>
    ${treesPerPerson(p)}
    ${rankLines(p)}
    <dl class="vc-stats">
      <div><dt>🌳 行道樹</dt><dd>${fmt(p.street_trees)} 棵</dd></div>
      <div><dt>🌲 公園樹木</dt><dd>${fmt(p.park_trees)} 棵</dd></div>
      <div><dt>人口</dt><dd>${fmt(p.population)}</dd></div>
      <div><dt>65 歲以上</dt><dd>${p.elderly_pct ?? '—'}%</dd></div>
      <div><dt>🌱 空樹穴 A/B/C</dt><dd>${fmt(p.pits_A)}/${fmt(p.pits_B)}/${fmt(p.pits_C)}</dd></div>
      <div><dt>🪵 消失的樹</dt><dd>${fmt(p.disappeared)} 棵</dd></div>
    </dl>
    <p class="hint">行道樹、公園樹木都含里界 ${state.meta.boundary_buffer_m} m 內的樹；消失的樹指 2024 年 11 月以來。</p>
    <div class="actions">
      <button class="primary" id="share-btn">分享這個里</button>
      <a class="outline" target="_blank" rel="noopener" href="https://social-plugins.line.me/lineit/share?url=${encodeURIComponent(shareUrl(p))}">分享到 LINE</a>
    </div>
    <p class="hint" id="share-status"></p>`;
  $('#share-btn').addEventListener('click', () => share(p));
  // On a phone the card goes to the top of the sheet, so the bird and the number show without scrolling.
  if (animate) card.scrollIntoView({ behavior: 'smooth', block: isMobile() ? 'start' : 'nearest' });
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
  const text = unranked(p)
    ? `把三千棵🌳種回來｜${p.district}${p.village}的樹蔭地圖。查查你家：`
    : `把三千棵🌳種回來｜${p.district}${p.village}每人只分到 ${p.shade_m2_per_person} m² 樹蔭，${rankText(p)}查查你家：`;
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
  const html = f.source === 'pits'
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
  document.querySelectorAll('.basemap .seg button').forEach(btn => btn.setAttribute('aria-checked', String(btn.dataset.base === base)));
}

function renderAbout() {
  const m = state.meta;
  $('#about-body').innerHTML = `
    <ul>
      <li>行道樹、公園樹木：臺北市政府工務局公園路燈工程管理處（<a href="https://data.gov.tw/dataset/128274" target="_blank" rel="noopener">開放資料</a>），${esc(m.trees_downloaded)} 下載，行道樹 ${fmt(m.street_trees_now)} 棵。</li>
      <li>2024 年 11 月行道樹（${fmt(m.street_trees_2024_11)} 棵）：同一份官方檔案的舊版，由 Wayback Machine 存檔。</li>
      <li>樹穴：臺北市政府工務局新建工程處（<a href="https://data.gov.tw/dataset/134908" target="_blank" rel="noopener">開放資料</a>）。</li>
      <li>村里界、底圖、航照：內政部國土測繪中心。人口：臺北市政府民政局，${esc(m.population_month)}。</li>
      <li>山坡保護區：臺北市政府都市發展局都市計畫使用分區圖（<a href="https://data.gov.tw/dataset/156197" target="_blank" rel="noopener">開放資料</a>）。</li>
    </ul>
    <p>樹蔭是估計值：用行道樹和公園樹木的樹幹胸徑推算樹冠大小（樹冠直徑以公尺計，約為胸徑公分數的 ${esc(m.crown_m_per_dbh_cm)} 倍），只用來比較各里高低。里界多沿道路中線劃，里界 ${esc(m.boundary_buffer_m)} 公尺內的樹會同時算給兩側的里。</p>
    <p>樹木資料只有市府管理的行道樹和公園樹木，不含山林、校園、私人庭院和河濱公園的樹。所以每公頃不到 ${esc(m.low_density_per_ha)} 人的山區里，以及面積 ${esc(m.hillside_zone_pct)}% 以上是都市計畫保護區（山坡地）的靠山里，樹蔭主要來自資料以外的山林，不列入排名。</p>
    <p>空樹穴和消失的樹是資料比對的結果，尚待現場確認。</p>
    <p>造訪人數由 <a href="https://www.goatcounter.com/" target="_blank" rel="noopener">GoatCounter</a> 統計，不使用 cookie、不記錄個資，數字最多延遲 4 小時更新。</p>`;
}

document.querySelectorAll('.tabs button').forEach(b => b.addEventListener('click', () => {
  setMode(b.dataset.mode);
  if (state.selected) selectVillage(state.byCode.get(state.selected), { fly: false, animate: false });
}));
$('#sheet-handle').addEventListener('click', () => {
  const open = $('#panel').classList.toggle('expanded');
  $('#sheet-handle').setAttribute('aria-expanded', String(open));
  $('#sheet-handle').setAttribute('aria-label', open ? '收合面板' : '展開面板');
});
document.querySelectorAll('.basemap .seg button').forEach(b => b.addEventListener('click', () => setBase(b.dataset.base)));

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
    selectVillage(v, { track: true, at: [lon, lat] });
  }, err => {
    btn.textContent = '查我家附近';
    hint.textContent = `無法取得位置（${err.message}），請直接點地圖。`;
  }, { enableHighAccuracy: true, timeout: 10000 });
});
