# Architecture

Revolution is a browser RTS built for very large battles (target: 3000+ units at 60 fps)
and for lockstep multiplayer later. Those two goals drive every structural choice below.

## The two halves

```
 main thread (presentation)                     Web Worker (simulation)
 ┌──────────────────────────────┐   commands    ┌──────────────────────────────┐
 │ input  -> selection, orders  │ ────────────> │ fixed 20 Hz tick             │
 │ camera                       │               │ integer-only, seeded RNG     │
 │ renderer (WebGPU / WebGL2)   │ <──────────── │ ECS on typed arrays          │
 │ interpolation, HUD           │   snapshots   │ state hash                   │
 └──────────────────────────────┘               └──────────────────────────────┘
```

**Simulation** (`src/sim`) is the game. It is a pure function of `(seed, commands per
tick)`: no clock, no DOM, no floats that could round differently on another machine, no
`Math.random`. It advances in fixed 50 ms ticks.

**Presentation** (`src/client`, `src/main.ts`) draws the latest state and turns input into
commands. It can never change the simulation except by sending a command. It may use
floats freely.

**The worker** (`src/worker`) hosts the simulation off the main thread, so a heavy tick
never drops a frame and a slow frame never slows the game.

## Determinism rules

1. All sim quantities are integers. Distances are fixed-point Q22.10 (1 world unit = 1024),
   see `src/sim/fixed.ts`. Intermediate products stay below 2^53, so JS number arithmetic on
   them is exact on every engine.
2. Randomness comes only from the xorshift32 generator whose state lives in the world
   (`src/sim/rng.ts`).
3. No iteration over hash maps or anything with engine-defined order. Entities are processed
   in index order; effects that depend on neighbours are computed from start-of-tick state
   and applied afterwards.
4. ESLint enforces 1 and 2 inside `src/sim` (transcendental `Math` functions, `Date`,
   `performance`, DOM globals are errors).
5. `tests/sim.test.ts` runs a scripted game twice and compares the state hash on every tick,
   and pins a golden hash so behaviour changes are always deliberate.

## Data layout

`World` (`src/sim/world.ts`) is structure-of-arrays: one typed array per component
(`posX`, `velX`, `targetX`, `speed`, `team`, `kind`, `hp`, `cooldown`, `attack`, `state`,
...), an entity is an index. A slot is free, alive or a wreck; freed slots are reused by
later spawns, lowest index first. No per-tick allocation in the hot loops.

## The map (`src/sim/map.ts`)

A 256x256 grid of 4-unit cells: an integer heightfield and a terrain type per cell,
generated from the seed. Per movement class (vehicle, foot) it holds a cost per cell
(0 = impassable) and, for every cell, the nearest passable one, used to move spawn points
and order targets off ground a unit cannot stand on. The collision grid uses the same cells.

## Pathfinding (`src/sim/path.ts`)

Flowfields: `buildField` runs Dijkstra with a bucket queue from one or many goal cells and
writes the cost-to-goal of every cell; `flowDirection` picks the cheapest neighbour (never
cutting a blocked corner); `clearLine` tells whether a straight walk is possible. Fields for
move orders live in the world, shared by goal and class and built on first use.

## One tick (`src/sim/sim.ts`)

1. Apply commands (move, attack-move, stop, spawn). A move order assigns formation slots and
   a group pace.
2. Sort living units into two uniform grids by counting sort: 4-unit cells for collisions,
   16-unit cells for targeting.
3. Refresh at most one "nearest enemy" chase field, if any unit asked for one last tick.
4. Acquire targets: nearest living enemy within 44 units that is not concealed by forest.
   Units without a target look every 4 ticks, everyone re-evaluates every 16, staggered by id.
5. Steer: units free to fight close to weapon range and hold; plain move orders keep moving.
   Straight line if walkable, else the flowfield.
6. Separate (soft collisions), fire (hitscan, damage accumulated), integrate (impassable
   ground is a hard wall units slide along), then resolve damage, deaths, and wreck expiry.

Unit types live in `src/sim/units.ts` as a table of integers (health, speed, range, reload,
movement class, damage per target type).

## Commands

`src/sim/commands.ts` defines the only inputs to the sim: move, attack-move, stop, spawn. A
command holds integers only; float-to-fixed conversion happens once on the client before
sending. In single player a command applies on the next tick. In lockstep multiplayer the
same commands get scheduled a few ticks ahead and broadcast; the sim does not change.

## Rendering

Three.js `WebGPURenderer`, which uses WebGPU where available and WebGL2 otherwise.

- **Models** (`src/client/models.ts`) are generated at start-up from boxes and cylinders, in
  three levels of detail. Vertex attributes carry albedo and a team-marking mask.
- **Batches** (`src/client/batch.ts`): one instanced draw call per model part per level of
  detail (tank hull, tank turret, soldier, far tank, far squad). Per instance: a matrix and
  a 4-float tint (team colour and burn).
- **Per frame** (`src/client/units.ts`): interpolate each unit between the last two 20 Hz
  snapshots, cull against the frustum, choose the level of detail by distance, write the
  instance. Turrets track the attack target; infantry squads are five soldier instances that
  thin out as the squad loses health.
- **Effects** (`src/client/effects.ts`): pooled camera-facing sprites (additive fire, blended
  smoke) and stretched tracer quads, three draw calls in all, fed by sim events.
- **Light**: hemisphere sky light plus one sun with a shadow map that follows the camera
  focus. ACES tone mapping.

Snapshots are transferred (not copied) from the worker as typed arrays: positions, a
state/kind/team byte, health, attack target, and the tick's combat events.

## Player view

The player commands team 0. `src/client/fog.ts` computes what that army sees (10 Hz, one
stamp per occupied cell) into a 256x256 texture that every world material multiplies its
colour by; enemy units outside vision are not drawn and their effects not played.
`src/client/minimap.ts` draws terrain, fog, units and the camera outline into a 256-pixel
canvas ten times a second. Selection, control groups and the minimap are client state.

## Current limits, on purpose

- Height does not affect the fight yet (no high-ground bonus, no line of sight). Planned
  with buildings in M4.
- Weapons fire over water, forest and cliffs: no line-of-fire check yet (M4).
- If all 96 flowfield slots are in use, further units walk straight until one frees up.
- A command naming a slot that died and was reused reaches the new occupant. Harmless in
  single player; multiplayer will add a generation counter per slot.
- Models are untextured procedural geometry (see decision 011).
