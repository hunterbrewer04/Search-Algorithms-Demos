/* Graph world — SVG rendering of a preset graph model. Presets only, no editor. */
(function (root) {
'use strict';
const SAD = (root.SAD = root.SAD || {});

const NS = 'http://www.w3.org/2000/svg';
const PAD = 54;          // breathing room between the content box and the container
const AR  = 1.55;        // content box aspect, so the layout never stretches

function svgEl(tag, attrs){
  const e = document.createElementNS(NS, tag);
  if (attrs) for (const k in attrs) e.setAttribute(k, attrs[k]);
  return e;
}
const fmt = v =>
  v == null || !isFinite(v) ? '' : (v >= 1000 ? Math.round(v / 100) / 10 + 'k' : String(Math.round(v)));
const ekey = (a, b) => a < b ? a + '|' + b : b + '|' + a;

/* =========================================================
   State
   ========================================================= */
let host = null, wrap = null, svg = null, caption = null;
let gEdges, gPath, gCosts, gNodes, pathLine;
let model = null, radius = 17, sawH = false;
let box = { x:0, y:0, w:1, h:1 };
const nodes = new Map();   // id -> { x, y, px, py, g, dot, vals, gv, hv, fv }
const edges = new Map();   // key -> { a, b, cost, line, chip, text }

/* =========================================================
   Build
   ========================================================= */
function skeleton(container){
  host = container;
  wrap = document.createElement('div');
  wrap.className = 'world-graph';

  svg = svgEl('svg', { class:'gsvg', xmlns:NS, preserveAspectRatio:'xMidYMid meet' });
  gEdges = svgEl('g', { class:'edges' });
  gPath  = svgEl('g', { class:'pathlayer' });
  gCosts = svgEl('g', { class:'costs' });
  gNodes = svgEl('g', { class:'nodes' });
  pathLine = svgEl('path', { class:'pathline' });
  gPath.appendChild(pathLine);
  svg.append(gEdges, gPath, gCosts, gNodes);

  caption = document.createElement('div');
  caption.className = 'gcaption';

  wrap.append(svg, caption);
  host.appendChild(wrap);
}

function build(){
  gEdges.replaceChildren();
  gCosts.replaceChildren();
  gNodes.replaceChildren();
  nodes.clear();
  edges.clear();
  radius = model.nodes.length > 20 ? 15 : 18;

  for (const e of model.edges){
    const line = svgEl('line', { class:'gedge' });
    const w = 11 + String(e.cost).length * 6.6;
    const chip = svgEl('rect', { class:'gchip', rx:5, width:w.toFixed(1), height:15 });
    const text = svgEl('text', { class:'gcost' });
    text.textContent = String(e.cost);
    gEdges.appendChild(line);
    gCosts.append(chip, text);
    edges.set(ekey(e.a, e.b), { a:e.a, b:e.b, cost:e.cost, line, chip, text, w });
  }

  for (const n of model.nodes){
    const g = svgEl('g', { class:'gnode' });
    g.dataset.id = n.id;
    const pop = svgEl('g', { class:'pop' });
    pop.append(
      svgEl('circle', { class:'base', r:radius }),
      svgEl('circle', { class:'dot',  r:radius }),
      svgEl('circle', { class:'meetring', r:(radius + 5.5).toFixed(1) })
    );
    if (n.id === model.start){ g.classList.add('is-start'); pop.appendChild(startMark()); }
    else if (n.id === model.goal){ g.classList.add('is-goal'); pop.appendChild(goalMark()); }

    // labelPos keeps long city names off the cost chips on the dense presets
    const vals = svgEl('text', { class:'nval' });
    const lbl  = svgEl('text', { class:'nlbl' });
    lbl.textContent = n.label ?? n.id;
    switch (n.labelPos){
      case 'above':
        place1(lbl,  0, -(radius + 9),  'middle');
        place1(vals, 0, radius + 15,    'middle');
        break;
      case 'left':
        place1(lbl,  -(radius + 7), 4,  'end');
        place1(vals, radius + 7, 4,     'start');
        break;
      case 'right':
        place1(lbl,  radius + 7, 4,     'start');
        place1(vals, -(radius + 7), 4,  'end');
        break;
      default:
        place1(lbl,  0, radius + 15,    'middle');
        place1(vals, 0, -(radius + 9),  'middle');
    }

    g.append(pop, vals, lbl);
    gNodes.appendChild(g);
    nodes.set(n.id, { x:n.x, y:n.y, px:0, py:0, g, pop, vals, gv:null, hv:null, fv:null });
  }

  caption.innerHTML = '';
  const name = document.createElement('b');
  name.textContent = model.name || model.id;
  caption.appendChild(name);
  if (model.note){
    const note = document.createElement('span');
    note.textContent = model.note;
    caption.appendChild(note);
  }
  if (model.admissible === false) caption.classList.add('warn');
  else caption.classList.remove('warn');
}

function place1(t, x, y, anchor){
  t.setAttribute('x', x);
  t.setAttribute('y', y);
  t.setAttribute('text-anchor', anchor);
}

// the same two glyphs the grid uses for start and goal
function startMark(){
  const g = svgEl('g', { class:'mark' });
  const s = radius * 0.62;
  g.appendChild(svgEl('path', { d:`M${(-s * 0.55).toFixed(1)} ${(-s).toFixed(1)}L${s.toFixed(1)} 0L${(-s * 0.55).toFixed(1)} ${s.toFixed(1)}Z` }));
  return g;
}
function goalMark(){
  const g = svgEl('g', { class:'mark goal' });
  g.append(
    svgEl('circle', { class:'ring', r:(radius * 0.55).toFixed(1) }),
    svgEl('circle', { class:'pip',  r:(radius * 0.20).toFixed(1) })
  );
  return g;
}

/* =========================================================
   Layout — fit a fixed-aspect content box inside the container
   ========================================================= */
function measure(){
  let r = host.getBoundingClientRect();
  if (!(r.width > 40) || !(r.height > 40)) r = wrap.getBoundingClientRect();
  return {
    w: Math.max(360, Math.round(r.width)  || 900),
    h: Math.max(260, Math.round(r.height) || 560)
  };
}

function place(){
  const { w:W, h:H } = measure();
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`);

  const availW = Math.max(120, W - PAD * 2), availH = Math.max(90, H - PAD * 2);
  let bw = availW, bh = bw / AR;
  if (bh > availH){ bh = availH; bw = bh * AR; }
  box = { x:(W - bw) / 2, y:(H - bh) / 2, w:bw, h:bh };

  for (const n of nodes.values()){
    n.px = box.x + n.x * box.w;
    n.py = box.y + n.y * box.h;
    n.g.setAttribute('transform', `translate(${n.px.toFixed(1)} ${n.py.toFixed(1)})`);
  }

  for (const e of edges.values()){
    const A = nodes.get(e.a), B = nodes.get(e.b);
    if (!A || !B) continue;
    const dx = B.px - A.px, dy = B.py - A.py;
    const len = Math.hypot(dx, dy) || 1;
    const ox = dx / len * (radius + 1), oy = dy / len * (radius + 1);
    e.line.setAttribute('x1', (A.px + ox).toFixed(1));
    e.line.setAttribute('y1', (A.py + oy).toFixed(1));
    e.line.setAttribute('x2', (B.px - ox).toFixed(1));
    e.line.setAttribute('y2', (B.py - oy).toFixed(1));

    // sit the cost chip just off the line, always on the upper side, so it
    // clears the node labels hanging under the endpoints
    let nx = -dy / len, ny = dx / len;
    if (ny > 0){ nx = -nx; ny = -ny; }
    const cx = (A.px + B.px) / 2 + nx * 12, cy = (A.py + B.py) / 2 + ny * 12;
    e.chip.setAttribute('x', (cx - e.w / 2).toFixed(1));
    e.chip.setAttribute('y', (cy - 7.5).toFixed(1));
    e.text.setAttribute('x', cx.toFixed(1));
    e.text.setAttribute('y', (cy + 3.9).toFixed(1));
  }

  if (shown.length) drawPathLine(false);
}

/* =========================================================
   Search state
   ========================================================= */
const STATES = ['is-frontier', 'is-visited', 'is-cutoff', 'is-path'];
const RANK = { 'is-frontier':1, 'is-visited':2, 'is-cutoff':3, 'is-path':4 };
let shown = [];

function rankOf(g){
  let r = 0;
  for (const c of STATES) if (g.classList.contains(c)) r = Math.max(r, RANK[c]);
  return r;
}
function setState(id, cls){
  const n = nodes.get(id);
  if (!n) return;
  // tree search re-pushes states it has already expanded; that must not wipe the expansion
  if (cls === 'is-frontier' && rankOf(n.g) > RANK['is-frontier']) return;
  n.g.classList.remove(...STATES);
  n.g.classList.add(cls);
}

function setVals(id, s){
  const n = nodes.get(id);
  if (!n) return;
  const hadH = sawH;
  if (s.h > 0) sawH = true;
  if (s.g != null) n.gv = s.g;
  if (s.h != null) n.hv = s.h;
  if (s.f != null) n.fv = s.f;
  if (sawH && !hadH) for (const other of nodes.values()) renderVals(other);
  else renderVals(n);
}

function renderVals(n){
  let t = '';
  if (n.gv != null){
    t = 'g' + fmt(n.gv);
    if (sawH) t += ' h' + fmt(n.hv || 0) + ' f' + fmt(n.fv != null ? n.fv : n.gv + (n.hv || 0));
  }
  if (n.vals.textContent !== t) n.vals.textContent = t;
}

function markTreeEdge(from, to){
  const e = edges.get(ekey(from, to));
  if (e) e.line.classList.add('is-tree');
}

function pushAll(list, side){
  if (!list) return;
  for (const p of list){
    if (!p || p.id == null) continue;
    const n = nodes.get(p.id);
    if (!n) continue;
    if (side && !n.g.dataset.side) n.g.dataset.side = side;
    if (p.parent != null) markTreeEdge(p.parent, p.id);
    setState(p.id, 'is-frontier');
    setVals(p.id, p);
  }
}

// a one-shot class the CSS animation hangs off, cleared so it can fire again
function flash(id, cls){
  const n = nodes.get(id);
  if (!n) return;
  n.g.classList.remove(cls);
  requestAnimationFrame(() => n.g.classList.add(cls));
  setTimeout(() => n.g.classList.remove(cls), 520);
}

function clearSearch(){
  for (const n of nodes.values()){
    n.g.classList.remove(...STATES, 'is-meet', 'is-hl', 'is-stale');
    delete n.g.dataset.side;
    n.pop.style.animationDelay = '';
    n.gv = n.hv = n.fv = null;
    if (n.vals.textContent) n.vals.textContent = '';
  }
  for (const e of edges.values()) e.line.classList.remove('is-tree', 'is-path');
  sawH = false;
  shown = [];
  pathLine.style.transition = 'none';
  pathLine.style.opacity = 0;
  pathLine.removeAttribute('d');
}

/* =========================================================
   Solution path
   ========================================================= */
function drawPathLine(animate){
  const pts = shown.map(id => nodes.get(id)).filter(Boolean);
  if (pts.length < 2){ pathLine.removeAttribute('d'); return; }
  const d = pts.map((n, k) => `${k === 0 ? 'M' : 'L'}${n.px.toFixed(1)} ${n.py.toFixed(1)}`).join(' ');
  pathLine.setAttribute('d', d);
  pathLine.style.opacity = 1;

  let len = 0;
  try { len = pathLine.getTotalLength(); } catch (_){ /* not laid out yet */ }
  if (!animate || !len){
    pathLine.style.transition = 'none';
    pathLine.style.strokeDasharray = 'none';
    pathLine.style.strokeDashoffset = 0;
    return;
  }
  pathLine.style.transition = 'none';
  pathLine.style.strokeDasharray = len;
  pathLine.style.strokeDashoffset = len;
  requestAnimationFrame(() => {
    const ms = Math.min(1400, Math.max(360, shown.length * 130));
    pathLine.style.transition = `stroke-dashoffset ${ms}ms cubic-bezier(.3,.7,.3,1)`;
    pathLine.style.strokeDashoffset = 0;
  });
}

function showPath(path){
  if (!path || !path.length) return;
  shown = path.slice();
  for (let k = 1; k < shown.length; k++){
    const e = edges.get(ekey(shown[k - 1], shown[k]));
    if (e) e.line.classList.add('is-path');
  }
  shown.forEach((id, k) => {
    const n = nodes.get(id);
    if (!n) return;
    n.g.classList.remove(...STATES);
    n.pop.style.animationDelay = (k * 55) + 'ms';
    n.g.classList.add('is-path');
    setTimeout(() => { n.pop.style.animationDelay = ''; }, k * 55 + 700);
  });
  drawPathLine(true);
}

/* =========================================================
   World
   ========================================================= */
function presetById(id){
  const all = SAD.graphPresets || [];
  return all.find(p => p.id === id) || all[0];
}

function load(preset){
  model = (typeof preset.generate === 'function') ? preset.generate() : preset;
  build();
  clearSearch();
  place();
}

SAD.registerWorld({
  id: 'graph',
  label: 'Graph',
  order: 2,
  supportsRace: false,

  mount(container){
    skeleton(container);
    load((SAD.graphPresets || [])[0]);
    requestAnimationFrame(place);
  },

  activate(){ place(); },
  deactivate(){},

  problem(){ return SAD.graphProblem(model); },

  reset(){ clearSearch(); },

  resize(){ place(); },

  highlight(nodeId, on){
    const n = nodes.get(nodeId);
    if (n) n.g.classList.toggle('is-hl', !!on);
  },

  apply(step){
    if (!step) return;
    switch (step.kind){
      case 'init':
        pushAll(step.pushed, step.side);
        break;

      case 'expand':
        setState(step.id, 'is-visited');
        setVals(step.id, step);
        pushAll(step.pushed, step.side);
        break;

      case 'stale':
        flash(step.id, 'is-stale');
        break;

      case 'cutoff':
        setState(step.id, 'is-cutoff');
        setVals(step.id, step);
        break;

      case 'goal':
        setState(step.id, 'is-visited');
        setVals(step.id, step);
        break;

      case 'meet': {
        const n = nodes.get(step.id);
        if (n) n.g.classList.add('is-meet');   // additive: the run continues past the first touch
        setVals(step.id, step);
        break;
      }

      case 'restart':
        clearSearch();
        break;

      case 'fail':
      default:
        break;
    }
  },

  showPath,

  /* Addendum 1 */
  setPreset(presetId){
    const p = presetById(presetId);
    if (!p) return;
    load(p);
    SAD.worldChanged();
  },
  model(){ return model; }
});

})(typeof globalThis !== 'undefined' ? globalThis : window);
