# Search-Algorithms-Demos

Interactive visualizer for the classical AI search algorithms. Eight algorithms, three
views, no build step and no dependencies.

Open `index.html` in a browser. That is the whole setup.

## Algorithms

| | Complete | Optimal |
| --- | --- | --- |
| Breadth-first search | yes | only with equal step costs |
| Depth-first search | on a finite graph with an explored set | no |
| Depth-limited search | only if `L` >= depth of the shallowest goal | no |
| Iterative deepening | yes | in number of steps |
| Uniform-cost search | yes | yes |
| Greedy best-first | on a finite graph with an explored set | no |
| A* | yes | yes, with an admissible heuristic |
| Bidirectional search | yes | yes |

## Views

**Grid** — a weighted pathfinding board. Drag to draw walls, drag the start and goal
markers, shift-drag or right-drag to paint cost-5 terrain. Buttons for a recursive-division
maze, random walls and random terrain. Race mode runs all eight side by side on one board.

**Graph** — a state-space graph with labelled nodes and weighted edges. Five presets: the
Romania map with real road distances and real straight-line heuristics, a small exam-style
graph, a deep tree, a random generator, and one with a deliberately inadmissible heuristic
so you can watch A* return a suboptimal path.

**Tree** — the search tree the algorithm actually generates, growing as it expands. The same
state can appear at several tree nodes, which is the point. Depth-limited search draws its
cut line here, and iterative deepening visibly wipes and redraws the tree one level deeper
each round.

Alongside every run: the live frontier in queue, stack or priority-queue order with each
node's g, h and f; a step-by-step trace log; and the pseudocode.

## Conventions

Two switches, because courses and textbooks differ and the difference changes the answer.

**Goal test** — on expansion (when a node is popped) or on generation (when it is first
pushed). Testing on generation changes the expansion counts, and it costs uniform-cost
search and A* their optimality. That is not a bug in the visualizer; it is why the
convention matters, and you can watch it happen.

**Search type** — graph search keeps an explored set and never revisits a state. Tree search
keeps none, so a state can be reached again by a different path and appear many times in the
tree. Tree search still rejects any successor already on the current path, or depth-first
search would never terminate.

One subtlety worth knowing: a depth-limited search needs a *depth-aware* explored set.
Marking a state seen once and never revisiting it is unsound under a limit, because a state
first reached deep blocks the shallower route through it. The search can then report cutoff
when a goal does exist inside the limit, and iterative deepening loses its shallowest-goal
guarantee. Here the explored set records the depth a state was expanded at and re-expands on
a strictly shallower arrival.

## Verification

```
node tools/verify.mjs
SEED=12345 node tools/verify.mjs
```

Every algorithm is checked against a ground-truth Dijkstra across hundreds of random
weighted grids and graphs: uniform-cost, A* and bidirectional must return the optimal cost,
breadth-first and iterative deepening the fewest edges, A* must never expand more nodes than
uniform-cost, and every returned path must be contiguous, wall-free and correctly
terminated. Both goal-test conventions and both search types are exercised.

The suite is mutation-tested — each assertion class was confirmed to fail against a
deliberately broken implementation, including the two that are easy to get wrong and hard to
notice: bidirectional search stopping at the first frontier meeting, which is not optimal on
weighted graphs, and a backward search pricing edges with successors instead of
predecessors, which is wrong wherever step cost depends on the cell being entered.

## Layout

```
index.html
css/       base, grid, graph, tree
js/core/   problem interface, grid model, algorithms
js/data/   graph presets
js/worlds/ grid, graph and tree renderers
js/ui/     panels and the app conductor
tools/     verify.mjs
```

Plain classic scripts against one global, `SAD`, so it runs from `file://` with no server.
Algorithms are generators that yield step events; renderers only consume those events, so a
new view needs no algorithm changes and a new algorithm needs no view changes.

## License

MIT.
