// Core verification harness.
//   node tools/verify.mjs            run everything
//   SEED=123 node tools/verify.mjs   rerun a specific board set
//
// The core files are read and evaluated inside a bare vm context, so anything
// that touched the DOM would blow up here instead of in the browser. Files that
// have not been written yet are skipped with a note, and any algorithm that is
// not registered is skipped the same way, so this keeps working as the rest of
// the build lands.

import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');

/* ---------------------------------------------------------------
   seeded rng — boards reproduce from the printed seed
   --------------------------------------------------------------- */
const SEED = (Number(process.env.SEED) || 20260909) >>> 0;
function mulberry32(a){
  return function(){
    a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
let rng = mulberry32(SEED);
const rand  = () => rng();
const randInt = (lo, hi) => lo + Math.floor(rng() * (hi - lo + 1));
const pick  = arr => arr[randInt(0, arr.length - 1)];

/* ---------------------------------------------------------------
   load core against a fake global
   --------------------------------------------------------------- */
const notes = [];
const sandbox = { console, __rng: rand };
vm.createContext(sandbox);
vm.runInContext('Math.random = __rng;', sandbox);

const FILES = [
  'js/core/util.js',
  'js/core/grid-model.js',
  'js/core/problem.js',
  'js/core/algorithms.js',
  'js/core/algorithms-extra.js',
  'js/data/presets.js'
];
const loaded = [];
for (const f of FILES){
  const p = join(ROOT, f);
  if (!existsSync(p)){ notes.push(`${f} not present yet — skipped`); continue; }
  try {
    vm.runInContext(readFileSync(p, 'utf8'), sandbox, { filename: f });
    loaded.push(f);
  } catch (e) {
    console.error(`FAILED to load ${f}\n  ${e && e.stack ? e.stack : e}`);
    process.exit(2);
  }
}
const SAD = sandbox.SAD;
if (!SAD){ console.error('no SAD global after loading core files'); process.exit(2); }

/* ---------------------------------------------------------------
   assertions
   --------------------------------------------------------------- */
let checks = 0;
const failures = [];
const rows = [];

function ok(cond, msg, detail){
  checks++;
  if (!cond) failures.push(detail ? `${msg}\n        ${detail}` : msg);
  return !!cond;
}
const near = (a, b) => Math.abs(a - b) < 1e-9;

function section(name, cases, fn){
  const c0 = checks, f0 = failures.length;
  try { fn(); }
  catch (e){ failures.push(`${name}: threw — ${e && e.stack ? e.stack : e}`); }
  rows.push({ name, cases: typeof cases === 'function' ? cases() : cases,
              checks: checks - c0, failed: failures.length - f0 });
}

/* ---------------------------------------------------------------
   ground truth — deliberately independent of the code under test
   --------------------------------------------------------------- */
function allDists(problem, source){
  const dist = new Map([[source, 0]]);
  const done = new Set();
  for (;;){
    let best = null, bd = Infinity;
    for (const [k, v] of dist) if (!done.has(k) && v < bd){ bd = v; best = k; }
    if (best === null) break;
    done.add(best);
    for (const s of problem.successors(best)){
      const nd = bd + s.cost;
      const cur = dist.get(s.to);
      if (cur === undefined || nd < cur) dist.set(s.to, nd);
    }
  }
  return dist;
}

function dijkstra(problem){
  const dist = new Map([[problem.start, 0]]);
  const done = new Set();
  for (;;){
    let best = null, bd = Infinity;
    for (const [k, v] of dist) if (!done.has(k) && v < bd){ bd = v; best = k; }
    if (best === null) return null;
    done.add(best);
    if (problem.isGoal(best)) return bd;
    for (const s of problem.successors(best)){
      const nd = bd + s.cost;
      const cur = dist.get(s.to);
      if (cur === undefined || nd < cur) dist.set(s.to, nd);
    }
  }
}

function fewestEdges(problem){
  const d = new Map([[problem.start, 0]]);
  const q = [problem.start];
  for (let h = 0; h < q.length; h++){
    const n = q[h];
    if (problem.isGoal(n)) return d.get(n);
    for (const s of problem.successors(n))
      if (!d.has(s.to)){ d.set(s.to, d.get(n) + 1); q.push(s.to); }
  }
  return null;
}

/* ---------------------------------------------------------------
   driving a generator, and checking what it produced
   --------------------------------------------------------------- */
function drive(entry, problem, opts, budget, strictG){
  budget = budget || 400000;
  const seenG = strictG ? new Map() : null;
  let gen;
  try { gen = entry.make(problem, opts || {}); }
  catch (e){ return { error: `make() threw — ${e}` }; }

  let steps = 0, expanded = 0, peak = 0, last = null;
  const shape = [];
  for (;;){
    let r;
    try { r = gen.next(); }
    catch (e){ return { error: `next() threw at step ${steps} — ${e && e.stack ? e.stack : e}` }; }
    if (r.done) break;
    const s = r.value;
    if (++steps > budget) return { error: `did not terminate within ${budget} steps` };
    if (!s || typeof s.kind !== 'string'){ shape.push(`step ${steps} has no kind`); break; }

    if (s.kind === 'expand' || s.kind === 'cutoff') expanded++;
    if (typeof s.fsize === 'number' && s.fsize > peak) peak = s.fsize;

    if (s.pushed !== undefined){
      if (!Array.isArray(s.pushed)) shape.push(`pushed is not an array on ${s.kind}`);
      else for (const p of s.pushed){
        if (p == null || p.id === undefined) shape.push(`pushed entry without id on ${s.kind}`);
        else if (!('parent' in p)) shape.push(`pushed entry without parent on ${s.kind}`);
        else if (seenG){
          const prev = seenG.get(p.id);
          if (prev !== undefined && p.g >= prev)
            shape.push(`re-pushed ${p.id} at g=${p.g} without improving on g=${prev}`);
          if (prev === undefined || p.g < prev) seenG.set(p.id, p.g);
        }
      }
    }
    if (s.kind === 'init'){
      if (!Array.isArray(s.pushed) || s.pushed.length !== 1) shape.push('init must push exactly the root');
      else if (s.pushed[0].parent !== null) shape.push('init root must have parent null');
    }
    if (s.kind === 'goal' && !Array.isArray(s.path)) shape.push('goal step carries no path array');
    if ((steps % 25 === 0) && typeof s.frontier === 'function'){
      const f = s.frontier();
      if (!Array.isArray(f)) shape.push('frontier() did not return an array');
      else if (f.length && f[0].id === undefined) shape.push('frontier() entries have no id');
    }
    last = s;
    if (s.kind === 'goal' || s.kind === 'fail') break;
  }
  if (!last) return { error: 'generator yielded nothing' };
  if (last.kind !== 'goal' && last.kind !== 'fail')
    return { error: `ended on ${last.kind}, not goal or fail` };
  return { last, steps, expanded, peak, shape, found: last.kind === 'goal' };
}

function walkPath(problem, path){
  if (!Array.isArray(path) || !path.length) return { error: 'path missing or empty' };
  if (path[0] !== problem.start) return { error: `path starts at ${path[0]}, not ${problem.start}` };
  if (!problem.isGoal(path[path.length - 1])) return { error: `path ends at ${path[path.length - 1]}, not a goal` };
  let cost = 0;
  for (let i = 1; i < path.length; i++){
    const s = problem.successors(path[i - 1]).find(e => e.to === path[i]);
    if (!s) return { error: `no edge ${path[i - 1]} -> ${path[i]}` };
    cost += s.cost;
  }
  return { cost };
}

function gridPathProblem(model, path){
  for (const i of path) if (model.wall[i]) return `path crosses a wall at ${i}`;
  for (let k = 1; k < path.length; k++){
    const dc = Math.abs(model.cx(path[k]) - model.cx(path[k - 1]));
    const dr = Math.abs(model.cy(path[k]) - model.cy(path[k - 1]));
    if (dc + dr !== 1) return `path jumps ${path[k - 1]} -> ${path[k]}`;
  }
  return null;
}

/* best-first must not re-push a state unless the new g strictly improves */
const STRICT_G = new Set(['ucs', 'greedy', 'astar']);

/* runs one algorithm and validates whatever came back */
function solve(entry, problem, opts, where, model){
  const strictG = STRICT_G.has(entry.id) && (!opts || opts.search !== 'tree');
  const r = drive(entry, problem, opts, 0, strictG);
  if (r.error){ ok(false, `${where}: ${entry.id} ${r.error}`); return null; }
  for (const s of r.shape) ok(false, `${where}: ${entry.id} step shape — ${s}`);
  if (!r.found) return r;
  const v = walkPath(problem, r.last.path);
  if (v.error){ ok(false, `${where}: ${entry.id} returned an invalid path`, v.error); return r; }
  r.cost = v.cost;
  r.len = r.last.path.length - 1;
  if (model){
    const bad = gridPathProblem(model, r.last.path);
    if (bad) ok(false, `${where}: ${entry.id} grid path invalid`, bad);
  }
  ok(near(r.last.g, v.cost), `${where}: ${entry.id} reported g does not match the path`,
     `g=${r.last.g}, walked cost=${v.cost}`);
  return r;
}

const A = id => SAD.algorithmById(id);
const have = id => !!A(id);
const present = ['bfs','dfs','dls','iddfs','ucs','greedy','astar','bidirectional'].filter(have);
for (const id of ['bfs','dfs','dls','iddfs','ucs','greedy','astar','bidirectional'])
  if (!have(id)) notes.push(`algorithm '${id}' not registered — its cases were skipped`);

/* ---------------------------------------------------------------
   board and graph builders
   --------------------------------------------------------------- */
function weightedGrid(){
  const m = new SAD.GridModel(randInt(12, 30), randInt(8, 18));
  m.randomTerrain();
  m.randomWalls();
  return m;
}
function mazeGrid(){
  const m = new SAD.GridModel(randInt(13, 31), randInt(9, 19));
  m.clear();
  m.maze();
  return m;
}
function openGrid(cols, rows){
  const m = new SAD.GridModel(cols, rows);
  m.clear();
  return m;
}

function randomGraph(kind, lo, hi){
  const n = randInt(lo || 8, hi || 26);
  const nodes = [];
  for (let i = 0; i < n; i++)
    nodes.push({ id: 'n' + i, label: 'n' + i, x: rand(), y: rand() });

  const edges = [];
  const seen = new Set();
  const addEdge = (i, j, cost) => {
    const k = i < j ? i + ':' + j : j + ':' + i;
    if (i === j || seen.has(k)) return;
    seen.add(k);
    edges.push({ a: nodes[i].id, b: nodes[j].id, cost });
  };
  const hScale = kind === 'geom' ? randInt(40, 160) : 1;
  const costFor = (i, j) => kind === 'geom'
    ? Math.max(1, Math.ceil(hScale * Math.hypot(nodes[i].x - nodes[j].x, nodes[i].y - nodes[j].y)))
    : kind === 'unit' ? 1
    : randInt(1, 20);

  for (let i = 1; i < n; i++){                       // spanning tree keeps it connected
    const j = randInt(0, i - 1);
    addEdge(i, j, costFor(i, j));
  }
  const extra = randInt(n, n * 2);
  for (let e = 0; e < extra; e++){
    const i = randInt(0, n - 1), j = randInt(0, n - 1);
    addEdge(i, j, costFor(i, j));
  }

  const gm = {
    id: 'rand', name: 'random', undirected: true,
    nodes, edges, start: nodes[0].id, goal: nodes[n - 1].id,
    hScale, admissible: true
  };
  if (kind === 'table'){
    // h = lambda * true distance to the goal. Scaling a consistent heuristic by
    // a factor <= 1 keeps it consistent, which is what graph search needs.
    const p0 = SAD.graphProblem(gm);
    const d = allDists(p0, gm.goal);
    const lambda = rand();
    const h = {};
    for (const nd of nodes){
      const v = d.get(nd.id);
      h[nd.id] = v === undefined ? 0 : v * lambda;
    }
    gm.heuristic = h;
  }
  return gm;
}

/* ---------------------------------------------------------------
   1. wrapper, registry shape
   --------------------------------------------------------------- */
section('wrapper + registry', () => present.length, () => {
  ok(typeof SAD.Heap === 'function', 'SAD.Heap missing');
  ok(typeof SAD.GridModel === 'function', 'SAD.GridModel missing');
  ok(typeof SAD.gridProblem === 'function', 'SAD.gridProblem missing');
  ok(typeof SAD.graphProblem === 'function', 'SAD.graphProblem missing');
  ok(typeof SAD.registerAlgorithm === 'function', 'SAD.registerAlgorithm missing');
  ok(typeof SAD.registerWorld === 'function', 'SAD.registerWorld missing');
  ok(Array.isArray(SAD.algorithms), 'SAD.algorithms is not an array');

  const wanted = ['bfs','dfs','dls','iddfs','ucs','greedy','astar','bidirectional'];
  const got = SAD.algorithms.map(a => a.id);
  const expected = wanted.filter(id => got.includes(id));
  ok(got.join(',') === expected.join(','), 'algorithms are not in contract order',
     `expected ${expected.join(',')} — got ${got.join(',')}`);

  for (const a of SAD.algorithms){
    const where = `registry '${a.id}'`;
    ok(typeof a.name === 'string' && a.name.length > 0, `${where}: no name`);
    ok(typeof a.short === 'string' && a.short.length > 0, `${where}: no short`);
    ok(a.group === 'uninformed' || a.group === 'informed', `${where}: bad group ${a.group}`);
    ok(typeof a.desc === 'string' && a.desc.length > 40, `${where}: desc missing or too short`);
    ok(Array.isArray(a.complete) && a.complete.length === 2, `${where}: complete must be a 2-tuple`);
    ok(Array.isArray(a.optimal) && a.optimal.length === 2, `${where}: optimal must be a 2-tuple`);
    ok(typeof a.time === 'string' && typeof a.space === 'string', `${where}: time/space missing`);
    ok(typeof a.frontierLabel === 'string', `${where}: frontierLabel missing`);
    ok(Array.isArray(a.frontierKeys), `${where}: frontierKeys missing`);
    ok(typeof a.code === 'string' && a.code.includes('\n'), `${where}: code missing`);
    ok(a.supports && typeof a.supports === 'object', `${where}: supports missing`);
    ok(typeof a.make === 'function', `${where}: make missing`);
  }
  if (have('dls')) ok(A('dls').supports.limit === true, "dls must set supports.limit");
  if (have('iddfs')) ok(A('iddfs').supports.limit === true, "iddfs must set supports.limit");
  if (have('bidirectional'))
    ok(A('bidirectional').supports.undirectedOnly === true, 'bidirectional must set supports.undirectedOnly');
  for (const id of ['bfs','dfs','ucs','greedy','astar'])
    if (have(id)) ok(A(id).supports.limit !== true, `${id} must not claim supports.limit`);
});

/* ---------------------------------------------------------------
   2. grid model
   --------------------------------------------------------------- */
const MODEL_BOARDS = 40;
section('grid model', MODEL_BOARDS, () => {
  for (let i = 0; i < MODEL_BOARDS / 2; i++){
    const m = weightedGrid();
    ok(m.reachable(), `randomWalls board ${i} is unsolvable`);
    ok(m.wall[m.start] === 0 && m.wall[m.goal] === 0, `randomWalls board ${i} walled start or goal`);
    let heavy = 0;
    for (let k = 0; k < m.cost.length; k++){
      if (m.cost[k] !== 1 && m.cost[k] !== SAD.HEAVY){ ok(false, `board ${i} has cost ${m.cost[k]}`); break; }
      if (m.cost[k] > 1) heavy++;
    }
    ok(heavy > 0, `randomTerrain board ${i} painted nothing`);
  }
  for (let i = 0; i < MODEL_BOARDS / 2; i++){
    const m = mazeGrid();
    ok(m.reachable(), `maze board ${i} is unsolvable`);
    ok(m.cx(m.start) === 1 && m.cy(m.start) === 1, `maze board ${i} did not snap start to (1,1)`);
    ok(m.cx(m.goal) % 2 === 1 && m.cy(m.goal) % 2 === 1, `maze board ${i} goal is not on odd coordinates`);
  }

  // resize keeps the terrain that still fits
  const m = openGrid(20, 12);
  m.wall[m.idx(3, 4)] = 1;
  m.cost[m.idx(5, 6)] = SAD.HEAVY;
  m.resize(30, 18);
  ok(m.wall[m.idx(3, 4)] === 1, 'resize dropped a wall inside the old bounds');
  ok(m.cost[m.idx(5, 6)] === SAD.HEAVY, 'resize dropped terrain inside the old bounds');
  ok(m.cols === 30 && m.rows === 18, 'resize did not take');
  ok(m.wall.length === 30 * 18, 'resize did not resize the arrays');

  // the surface js/worlds/grid.js codes against — renaming any of this breaks
  // the grid world silently, so it is pinned here
  const g = openGrid(9, 9);
  for (const fn of ['idx','cx','cy','colOf','rowOf','neighbors','searchOrder','resize',
                    'clear','reachable','randomWalls','randomTerrain','randomWeights','maze'])
    ok(typeof g[fn] === 'function', `GridModel.${fn} is missing`);
  ok(SAD.GridModel.HEAVY === 5, 'GridModel.HEAVY must be 5', `got ${SAD.GridModel.HEAVY}`);
  ok(SAD.HEAVY === 5, 'SAD.HEAVY must be 5');
  ok(Array.isArray(SAD.graphPresets), 'SAD.graphPresets must be predeclared as an array');
  ok(typeof SAD.worldChanged === 'function', 'SAD.worldChanged must default to a no-op');
  ok(Array.isArray(SAD.worlds), 'SAD.worlds must be an array');
  const mid = g.idx(4, 4);
  ok(g.colOf(mid) === g.cx(mid) && g.rowOf(mid) === g.cy(mid), 'colOf/rowOf must match cx/cy');
  ok(g.wall.length === g.cols * g.rows && g.cost.length === g.cols * g.rows,
     'wall/cost must be cols*rows long');
  ok(g.idx(3, 5) === 5 * g.cols + 3, 'idx must be row * cols + col');

  // registerWorld keeps SAD.worlds sorted by .order
  const before = SAD.worlds.length;
  SAD.registerWorld({ id:'__t3', order:3 });
  SAD.registerWorld({ id:'__t1', order:1 });
  const probe = SAD.worlds.slice(before).map(w => w.id);
  ok(probe[0] === '__t1' && probe[1] === '__t3', 'registerWorld must sort by .order',
     `got ${probe.join(',')}`);
  ok(SAD.worldById('__t1') !== null, 'worldById must find a registered world');
  ok(typeof SAD.worldOf === 'function', 'SAD.worldOf is missing');
  ok(SAD.worldOf('__t3') === SAD.worldById('__t3'), 'worldOf must be an alias of worldById');
  SAD.worlds.length = before;

  // neighbors is clockwise; successors is the reverse of the DFS push order
  const nb = g.neighbors(mid);
  ok(nb.length === 4, 'interior cell should have 4 neighbors');
  ok(nb[0] === mid - 9 && nb[1] === mid + 1 && nb[2] === mid + 9 && nb[3] === mid - 1,
     'GridModel.neighbors must be clockwise up, right, down, left', `got ${nb.join(',')}`);
  g.wall[mid + 1] = 1;
  ok(g.neighbors(mid).length === 4, 'GridModel.neighbors must not filter walls');
  g.wall[mid + 1] = 0;

  const p = SAD.gridProblem(g);
  const order = p.successors(mid).map(s => s.to);
  ok(order.length === 4, 'interior cell should have 4 successors');
  ok(order[0] === mid + 9 && order[1] === mid + 1 && order[2] === mid - 9 && order[3] === mid - 1,
     'grid successors must be listed down, right, up, left', `got ${order.join(',')}`);
  ok(p.undirected === true, 'gridProblem must report undirected true');
  ok(p.label(g.idx(3, 5)) === '(5,3)', 'gridProblem.label must be "(row,col)"', `got ${p.label(g.idx(3,5))}`);

  // step cost is the cost of the cell being entered
  g.cost[mid + 1] = SAD.GridModel.HEAVY;
  const e = SAD.gridProblem(g).successors(mid).find(s => s.to === mid + 1);
  ok(e && e.cost === SAD.GridModel.HEAVY, 'successor cost must be cost[to]', `got ${e && e.cost}`);
});

/* ---------------------------------------------------------------
   3. grids vs ground truth
   --------------------------------------------------------------- */
const GRIDS = 60, MAZES = 20;
section('grids vs Dijkstra', GRIDS + MAZES, () => {
  for (let i = 0; i < GRIDS + MAZES; i++){
    const m = i < GRIDS ? weightedGrid() : mazeGrid();
    const p = SAD.gridProblem(m);
    const where = `grid #${i} ${m.cols}x${m.rows}`;
    const opt = dijkstra(p);
    const depth = fewestEdges(p);
    if (!ok(opt !== null, `${where}: generator produced an unsolvable board`)) continue;

    let ucsExpanded = null, astarExpanded = null;

    if (have('ucs')){
      const r = solve(A('ucs'), p, {}, where, m);
      if (r && r.found){
        ok(near(r.cost, opt), `${where}: UCS is not optimal`, `optimal ${opt}, got ${r.cost}`);
        ucsExpanded = r.expanded;
      } else ok(false, `${where}: UCS found nothing on a solvable board`);
    }
    if (have('astar')){
      const r = solve(A('astar'), p, {}, where, m);
      if (r && r.found){
        ok(near(r.cost, opt), `${where}: A* is not optimal`, `optimal ${opt}, got ${r.cost}`);
        astarExpanded = r.expanded;
      } else ok(false, `${where}: A* found nothing on a solvable board`);
    }
    if (ucsExpanded !== null && astarExpanded !== null)
      ok(astarExpanded <= ucsExpanded, `${where}: A* expanded more than UCS`,
         `A* ${astarExpanded}, UCS ${ucsExpanded}`);

    if (have('bfs')){
      const r = solve(A('bfs'), p, {}, where, m);
      if (r && r.found) ok(r.len === depth, `${where}: BFS did not return the fewest-edges path`,
                           `fewest ${depth}, got ${r.len}`);
      else ok(false, `${where}: BFS found nothing on a solvable board`);
    }
    if (have('dfs')){
      const r = solve(A('dfs'), p, {}, where, m);
      ok(r && r.found, `${where}: DFS found nothing on a solvable board`);
    }
    if (have('greedy')){
      const r = solve(A('greedy'), p, {}, where, m);
      ok(r && r.found, `${where}: greedy found nothing on a solvable board`);
    }
  }
});

/* ---------------------------------------------------------------
   4. graphs vs ground truth
   --------------------------------------------------------------- */
const GRAPHS = 24;
section('graphs vs Dijkstra', GRAPHS, () => {
  for (let i = 0; i < GRAPHS; i++){
    const kind = i % 2 ? 'table' : 'geom';
    const gm = randomGraph(kind);
    const p = SAD.graphProblem(gm);
    const where = `graph #${i} (${kind}, ${gm.nodes.length} nodes)`;
    const opt = dijkstra(p);
    const depth = fewestEdges(p);
    if (!ok(opt !== null, `${where}: generator produced a disconnected graph`)) continue;

    for (const n of gm.nodes) if (p.h(n.id) < 0) ok(false, `${where}: h(${n.id}) is negative`);
    ok(near(p.h(gm.goal), 0), `${where}: h at the goal must be 0`, `got ${p.h(gm.goal)}`);

    let ucsExpanded = null, astarExpanded = null;

    if (have('ucs')){
      const r = solve(A('ucs'), p, {}, where);
      if (r && r.found){
        ok(near(r.cost, opt), `${where}: UCS is not optimal`, `optimal ${opt}, got ${r.cost}`);
        ucsExpanded = r.expanded;
      } else ok(false, `${where}: UCS found nothing`);
    }
    if (have('astar')){
      const r = solve(A('astar'), p, {}, where);
      if (r && r.found){
        ok(near(r.cost, opt), `${where}: A* is not optimal`, `optimal ${opt}, got ${r.cost}`);
        astarExpanded = r.expanded;
      } else ok(false, `${where}: A* found nothing`);
    }
    if (ucsExpanded !== null && astarExpanded !== null)
      ok(astarExpanded <= ucsExpanded, `${where}: A* expanded more than UCS`,
         `A* ${astarExpanded}, UCS ${ucsExpanded}`);

    if (have('bfs')){
      const r = solve(A('bfs'), p, {}, where);
      if (r && r.found) ok(r.len === depth, `${where}: BFS did not return the fewest-edges path`,
                           `fewest ${depth}, got ${r.len}`);
      else ok(false, `${where}: BFS found nothing`);
    }
    if (have('dfs')) ok((solve(A('dfs'), p, {}, where) || {}).found, `${where}: DFS found nothing`);
    if (have('greedy')) ok((solve(A('greedy'), p, {}, where) || {}).found, `${where}: greedy found nothing`);
  }
});

/* ---------------------------------------------------------------
   5. directed graphs — predecessors must be the real reverse
   --------------------------------------------------------------- */
section('directed graphs', 8, () => {
  for (let i = 0; i < 8; i++){
    const gm = randomGraph('table');
    gm.undirected = false;
    delete gm.heuristic;                    // straight-line h stays admissible
    const p = SAD.graphProblem(gm);
    const where = `directed graph #${i}`;
    ok(p.undirected === false, `${where}: problem should report undirected false`);

    const fwd = new Set();
    for (const n of gm.nodes) for (const s of p.successors(n.id)) fwd.add(n.id + '>' + s.to + '@' + s.cost);
    const back = new Set();
    for (const n of gm.nodes) for (const s of p.predecessors(n.id)) back.add(s.from + '>' + n.id + '@' + s.cost);
    ok(fwd.size === back.size && [...fwd].every(k => back.has(k)),
       `${where}: predecessors are not the reverse of successors`,
       `${fwd.size} forward, ${back.size} backward`);

    const opt = dijkstra(p);
    if (have('ucs')){
      const r = solve(A('ucs'), p, {}, where);
      if (opt === null) ok(r && !r.found, `${where}: UCS reported a path where none exists`);
      else if (r && r.found) ok(near(r.cost, opt), `${where}: UCS is not optimal`, `optimal ${opt}, got ${r.cost}`);
      else ok(false, `${where}: UCS found nothing on a solvable graph`);
    }
  }
});

/* ---------------------------------------------------------------
   6. unreachable goals
   --------------------------------------------------------------- */
section('unreachable goals', 12, () => {
  const cases = [];
  for (let i = 0; i < 8; i++){
    const m = openGrid(randInt(14, 24), randInt(10, 16));
    for (const v of m.neighbors(m.goal)) m.wall[v] = 1;   // seal the goal in
    cases.push({ where: `sealed grid #${i}`, p: SAD.gridProblem(m), m });
  }
  for (let i = 0; i < 4; i++){
    const gm = randomGraph('geom');
    gm.nodes.push({ id: 'island', label: 'island', x: rand(), y: rand() });
    gm.goal = 'island';
    delete gm.heuristic;
    cases.push({ where: `island graph #${i}`, p: SAD.graphProblem(gm) });
  }

  for (const c of cases){
    ok(dijkstra(c.p) === null, `${c.where}: setup is wrong, the goal is reachable`);
    for (const id of present){
      // the cap is only there so iterative deepening cannot climb L forever;
      // everything else has to exhaust its frontier long before reaching it
      const opts = { maxExpansions: 200000 };
      if (id === 'dls' || id === 'iddfs') opts.limit = 12;
      const r = drive(A(id), c.p, opts, 400000);
      if (r.error){ ok(false, `${c.where}: ${id} ${r.error}`); continue; }
      ok(r.last.kind === 'fail', `${c.where}: ${id} did not fail on an unreachable goal`,
         `ended on ${r.last.kind}`);
      if (id !== 'iddfs')
        ok(r.last.note !== 'cap', `${c.where}: ${id} only failed by hitting the expansion cap`);
    }
  }
});

/* ---------------------------------------------------------------
   7. depth-limited search
   --------------------------------------------------------------- */
section('depth limits', have('dls') ? 12 : 0, () => {
  if (!have('dls')){ notes.push('dls absent — depth-limit cases skipped'); return; }
  for (let i = 0; i < 12; i++){
    const m = i % 2 ? weightedGrid() : mazeGrid();
    const p = SAD.gridProblem(m);
    const where = `dls grid #${i}`;
    const shallow = fewestEdges(p);
    if (!ok(shallow !== null && shallow >= 2, `${where}: board is degenerate`)) continue;

    // below the shallowest goal: must report a cutoff and no path
    const under = drive(A('dls'), p, { limit: shallow - 1 });
    if (under.error) ok(false, `${where}: ${under.error}`);
    else {
      ok(under.last.kind === 'fail', `${where}: DLS returned a path shallower than possible`,
         `limit ${shallow - 1}, shallowest goal ${shallow}`);
      ok(under.last.cutoff === true, `${where}: DLS did not report cutoff at limit ${shallow - 1}`);
    }

    // at or above: whatever comes back must respect the limit
    for (const L of [shallow, shallow + 3, shallow + 12]){
      const r = solve(A('dls'), p, { limit: L }, `${where} L=${L}`, m);
      if (r && r.found){
        ok(r.len <= L, `${where}: DLS returned a path deeper than its limit`,
           `limit ${L}, path depth ${r.len}`);
        ok(r.last.depth === r.len, `${where}: goal step depth does not match the path`,
           `depth ${r.last.depth}, path ${r.len}`);
      }
    }
  }
});

/* ---------------------------------------------------------------
   8. iterative deepening
   --------------------------------------------------------------- */
section('iddfs', have('iddfs') ? 16 : 0, () => {
  if (!have('iddfs')){ notes.push('iddfs absent — iterative deepening cases skipped'); return; }
  // Small on purpose. A round of IDDFS that keeps no explored set enumerates
  // simple paths, so these have to stay cheap for any honest implementation.
  const cases = [];
  for (let i = 0; i < 10; i++)
    cases.push({ where: `iddfs graph #${i}`, p: SAD.graphProblem(randomGraph('unit', 9, 16)) });
  for (let i = 0; i < 6; i++){
    const m = openGrid(randInt(7, 9), randInt(5, 6));
    m.randomWalls();                          // unweighted: every cost stays 1
    cases.push({ where: `iddfs grid #${i}`, p: SAD.gridProblem(m), m });
  }

  for (const c of cases){
    const depth = fewestEdges(c.p);
    if (!ok(depth !== null, `${c.where}: unsolvable problem`)) continue;
    const r = solve(A('iddfs'), c.p, { limit: 1, maxExpansions: 400000 }, c.where, c.m);
    if (r && r.found)
      ok(r.len === depth, `${c.where}: IDDFS did not return the fewest-edges path`,
         `fewest ${depth}, got ${r.len}`);
    else ok(false, `${c.where}: IDDFS found nothing on a solvable problem`);
  }
});

/* ---------------------------------------------------------------
   9. bidirectional — must not stop at the first meeting
   --------------------------------------------------------------- */
section('bidirectional', have('bidirectional') ? 24 : 0, () => {
  if (!have('bidirectional')){ notes.push('bidirectional absent — its cases were skipped'); return; }
  for (let i = 0; i < 16; i++){
    const gm = randomGraph(i % 2 ? 'table' : 'geom');
    const p = SAD.graphProblem(gm);
    const where = `bidir graph #${i}`;
    const opt = dijkstra(p);
    if (!ok(opt !== null, `${where}: disconnected graph`)) continue;
    const r = solve(A('bidirectional'), p, {}, where);
    if (r && r.found)
      ok(near(r.cost, opt), `${where}: bidirectional is not optimal — did it stop at the first meeting?`,
         `optimal ${opt}, got ${r.cost}`);
    else ok(false, `${where}: bidirectional found nothing`);
  }
  // weighted grids: entering a cell costs cost[cell], so the backward search has
  // to price edges with predecessors(), not successors()
  for (let i = 0; i < 8; i++){
    const m = weightedGrid();
    const p = SAD.gridProblem(m);
    const where = `bidir weighted grid #${i}`;
    const opt = dijkstra(p);
    if (!ok(opt !== null, `${where}: unsolvable board`)) continue;
    const r = solve(A('bidirectional'), p, {}, where, m);
    if (r && r.found)
      ok(near(r.cost, opt), `${where}: bidirectional is not optimal on a weighted grid`,
         `optimal ${opt}, got ${r.cost}`);
    else ok(false, `${where}: bidirectional found nothing`);
  }
});

/* ---------------------------------------------------------------
   10. convention switches
   --------------------------------------------------------------- */
section('goalTest / search switches', () => present.length * 4 + 3, () => {
  const gridM = openGrid(14, 10);
  gridM.randomWalls();
  const probs = [
    { where: 'switch grid', p: SAD.gridProblem(gridM), m: gridM },
    { where: 'switch graph', p: SAD.graphProblem(randomGraph('geom')) }
  ];

  for (const c of probs){
    for (const goalTest of ['pop', 'gen']){
      for (const search of ['graph', 'tree']){
        for (const id of present){
          const opts = { goalTest, search, maxExpansions: 4000 };
          if (id === 'dls' || id === 'iddfs') opts.limit = 10;
          const where = `${c.where} ${id} ${goalTest}/${search}`;
          const r = drive(A(id), c.p, opts, 200000);
          if (r.error){ ok(false, `${where}: ${r.error}`); continue; }
          ok(true, `${where}: terminated`);
          if (r.found){
            const v = walkPath(c.p, r.last.path);
            ok(!v.error, `${where}: invalid path`, v.error);
            if (c.m && !v.error){
              const bad = gridPathProblem(c.m, r.last.path);
              ok(!bad, `${where}: invalid grid path`, bad);
            }
          }
          if (search === 'tree')
            ok(r.expanded <= 4000, `${where}: blew past maxExpansions`, `expanded ${r.expanded}`);
        }
      }
    }
  }

  // tree search with no explored set must stop on the cap, not run forever
  const sealed = openGrid(14, 10);
  for (const v of sealed.neighbors(sealed.goal)) sealed.wall[v] = 1;
  const sp = SAD.gridProblem(sealed);
  for (const id of ['bfs', 'dfs']){
    if (!have(id)) continue;
    const r = drive(A(id), sp, { search: 'tree', maxExpansions: 60 }, 100000);
    if (r.error){ ok(false, `cap ${id}: ${r.error}`); continue; }
    ok(r.last.kind === 'fail' && r.last.note === 'cap',
       `cap ${id}: expected fail with note 'cap'`, `got ${r.last.kind}/${r.last.note}`);
    ok(r.expanded <= 60, `cap ${id}: expanded ${r.expanded} past the cap of 60`);
  }

  // goalTest 'gen' really does cost UCS and A* their optimality
  const trap = {
    id: 'trap', name: 'trap', undirected: true,
    nodes: [{ id:'S', label:'S', x:0, y:0 }, { id:'A', label:'A', x:.5, y:.5 }, { id:'G', label:'G', x:1, y:0 }],
    edges: [{ a:'S', b:'G', cost:100 }, { a:'S', b:'A', cost:1 }, { a:'A', b:'G', cost:1 }],
    start: 'S', goal: 'G', hScale: 0, admissible: true
  };
  const tp = SAD.graphProblem(trap);
  for (const id of ['ucs', 'astar']){
    if (!have(id)) continue;
    const a = drive(A(id), tp, { goalTest: 'pop' });
    const b = drive(A(id), tp, { goalTest: 'gen' });
    if (a.error || b.error){ ok(false, `trap ${id}: ${a.error || b.error}`); continue; }
    ok(a.found && near(walkPath(tp, a.last.path).cost, 2),
       `trap ${id}: goalTest 'pop' should return the cost-2 path`);
    ok(b.found && near(walkPath(tp, b.last.path).cost, 100),
       `trap ${id}: goalTest 'gen' should return the cost-100 path — the bug is being special-cased away`);
  }
});

/* ---------------------------------------------------------------
   11. graph presets, once they exist
   --------------------------------------------------------------- */
section('presets', SAD.graphPresets ? SAD.graphPresets.length : 0, () => {
  if (!Array.isArray(SAD.graphPresets) || !SAD.graphPresets.length){
    notes.push('SAD.graphPresets absent — preset cases skipped');
    return;
  }
  for (const gm of SAD.graphPresets){
    const p = SAD.graphProblem(gm);
    const where = `preset '${gm.id}'`;
    const opt = dijkstra(p);
    for (const id of present){
      const opts = (id === 'dls' || id === 'iddfs') ? { limit: 20, maxExpansions: 200000 } : {};
      const r = solve(A(id), p, opts, where);
      if (!r) continue;
      if (id === 'ucs' && opt !== null)
        ok(r.found && near(r.cost, opt), `${where}: UCS is not optimal`, `optimal ${opt}, got ${r.cost}`);
      if (id === 'astar' && opt !== null && gm.admissible !== false)
        ok(r.found && near(r.cost, opt), `${where}: A* is not optimal on an admissible preset`,
           `optimal ${opt}, got ${r.cost}`);
    }
  }
});

/* ---------------------------------------------------------------
   report
   --------------------------------------------------------------- */
const pad = (s, n) => String(s) + ' '.repeat(Math.max(0, n - String(s).length));
const padL = (s, n) => ' '.repeat(Math.max(0, n - String(s).length)) + String(s);

console.log('');
console.log(`core verification · seed ${SEED}`);
console.log(`loaded: ${loaded.join(', ')}`);
console.log('');
for (const r of rows)
  console.log(`  ${pad(r.name, 28)} ${padL(r.cases, 5)} cases ${padL(r.checks, 7)} checks ${padL(r.failed, 5)} failed`);
console.log('  ' + '-'.repeat(62));
console.log(`  ${pad('total', 28)} ${padL(rows.reduce((a, r) => a + r.cases, 0), 5)} cases ${padL(checks, 7)} checks ${padL(failures.length, 5)} failed`);

if (notes.length){
  console.log('');
  for (const n of notes) console.log(`  note: ${n}`);
}

if (failures.length){
  console.log('');
  console.log(`${failures.length} failure${failures.length === 1 ? '' : 's'}:`);
  for (const f of failures.slice(0, 25)) console.log(`  - ${f}`);
  if (failures.length > 25) console.log(`  ... and ${failures.length - 25} more`);
  console.log('');
  console.log('FAIL');
  process.exit(1);
}
console.log('');
console.log('PASS');
