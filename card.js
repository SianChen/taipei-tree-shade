'use strict';

// The top of a village's card (name, mascot, shade meter, shade per person, residents per tree, rank) and what a
// shared village says. The map panel (app.js) and the share images (scripts/build_share.mjs) both draw from here,
// so a shared card always says what the panel says. ctx is { meta, villages }: meta.json and every village's properties.

// The 五色鳥 in web/img/shade-N.webp, one scene per shade level (1 = least shade); cut by scripts/cut_mascot.py.
const SHADE_SCENES = ['在大太陽下冒汗、拿扇子搧風', '縮在一片小葉子下', '站在細樹枝上，半曬半蔭',
  '在樹蔭裡站著，表情放鬆', '在樹枝上打盹', '在濃密樹冠裡睡覺，旁邊有樹洞'];
const PERSON_ICON = '<svg viewBox="0 0 13 18"><circle cx="6.5" cy="4" r="3.5"/><path d="M0 18c0-4.4 2.9-8 6.5-8s6.5 3.6 6.5 8z"/></svg>';

const fmt = n => (n == null ? '—' : Number(n).toLocaleString('zh-TW'));
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
// Mountain villages (low density) and hillside villages get their shade from forest the tree lists miss, so they are not ranked.
const unranked = p => p.low_density || p.hillside;

// One 🌳 per shade class, lit up to the village's class (the map colour); none lit when the village has no trees at all.
function treeMeter(p) {
  if (unranked(p)) return '';
  const levels = SHADE_SCENES.length;
  const lit = p.street_trees + p.park_trees === 0 ? 0 : 1 + p.shade_class;
  const trees = Array.from({ length: levels }, (_, i) => `<span class="${i < lit ? 'on' : 'off'}">🌳</span>`).join('');
  return `<div class="tree-meter" role="img" aria-label="樹蔭等級 ${lit} / ${levels}">${trees}<span class="tree-meter-label">樹蔭等級 ${lit} / ${levels}</span></div>`;
}

// City rank counted from whichever end is nearer, with the share of ranked villages it has more (or less) shade than.
// A tied group spans ranks r .. r + ties - 1 from the bottom; counted from the top it starts at n - (r + ties - 1) + 1.
// The share is floored, so "多於 76%" is never claimed for 75.9%.
function cityRank(p, ctx) {
  const n = ctx.meta.villages_scored, r = p.shade_rank_from_bottom, ties = p.shade_rank_ties || 1;
  return r <= n / 2
    ? { n, ties, bottom: true, rank: r, pct: Math.floor(100 * (n - (r + ties - 1)) / n) }
    : { n, ties, bottom: false, rank: n - (r + ties - 1) + 1, pct: Math.floor(100 * (r - 1) / n) };
}

// The same count within the district, from the ranked villages' values.
function districtRank(p, ctx) {
  const peers = ctx.villages.filter(q => q.district === p.district && !unranked(q));
  const above = peers.filter(q => q.shade_m2_per_person > p.shade_m2_per_person).length;
  const below = peers.filter(q => q.shade_m2_per_person < p.shade_m2_per_person).length;
  const n = peers.length, ties = n - above - below;
  return below + 1 <= n / 2 ? { n, ties, bottom: true, rank: below + 1 } : { n, ties, bottom: false, rank: above + 1 };
}

const tieText = ties => (ties > 1 ? `（${ties} 個里並列）` : '');

function rankText(p, ctx) {
  if (p.low_density) return `位於山區、每公頃不到 ${ctx.meta.low_density_per_ha} 人，樹蔭主要來自山林，不列入排名。`;
  if (p.hillside) return `里內 ${p.hillside_pct}% 是山坡保護區，樹蔭主要來自樹木資料沒有涵蓋的山林，不列入排名。`;
  const { n, ties, bottom, rank } = cityRank(p, ctx);
  return `全市 ${n} 個里中，樹蔭${bottom ? '倒數' : '排'}第 ${rank} 名${tieText(ties)}。`;
}

function rankLines(p, ctx) {
  if (unranked(p)) return `<p class="vc-rank">${rankText(p, ctx)}</p>`;
  const c = cityRank(p, ctx), d = districtRank(p, ctx);
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
function treesPerPerson(p, ctx) {
  if (unranked(p) || !p.population) return '';
  const trees = p.street_trees + p.park_trees;
  let icons, line;
  if (trees === 0) {
    icons = PERSON_ICON;
    line = `里界 ${ctx.meta.boundary_buffer_m} m 內<strong>沒有</strong>行道樹或公園樹木`;
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

// animate: pop the mascot in, for a new pick.
function cardTop(p, ctx, { animate = false } = {}) {
  return `
    <h2>${esc(p.village)}<small>${esc(p.district)}</small></h2>
    <div class="vc-hero">
      ${mascot(p, animate)}
      <div>
        ${treeMeter(p)}
        <p class="big-num">${p.shade_m2_per_person ?? '—'}<small>m²</small></p>
        <p class="big-label">每人分到的樹蔭（估計）</p>
      </div>
    </div>
    ${treesPerPerson(p, ctx)}
    ${rankLines(p, ctx)}`;
}

// A shared village's headline and rank sentence: the share text, and the title and description of its link preview.
function shareSummary(p, ctx) {
  const name = `${p.district}${p.village}`;
  if (unranked(p)) return { name, title: `${name}的樹蔭`, rank: rankText(p, ctx) };
  const c = cityRank(p, ctx);
  return {
    name,
    title: `${name}每人${c.bottom ? '只' : ''}分到 ${p.shade_m2_per_person} m² 樹蔭`,
    rank: `全市 ${c.n} 個里中${c.bottom ? '倒數' : ''}第 ${c.rank} 名${tieText(c.ties)}，樹蔭${c.bottom ? '少' : '多'}於 ${c.pct}% 的里。`,
  };
}
