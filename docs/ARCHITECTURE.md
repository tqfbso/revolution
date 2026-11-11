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
(`posX`, `posY`, `velX`, `targetX`, `speed`, `team`, `flags`, ...), an entity is an index.
Systems are plain loops over those arrays (`src/sim/sim.ts`): apply commands, squad roaming,
steering, separation (uniform grid, counting sort), integration. No per-tick allocation in
the hot loops.

## Commands

`src/sim/commands.ts` defines the only inputs to the sim: move, stop, spawn. A command holds
integers only; float-to-fixed conversion happens once on the client before sending. In single
player a command applies on the next tick. In lockstep multiplayer the same commands get
scheduled a few ticks ahead and broadcast; the sim does not change.

## Rendering

Three.js `WebGPURenderer`, which uses WebGPU where available and WebGL2 otherwise. All units
are one `InstancedMesh` (one draw call); each frame the client interpolates between the two
latest 20 Hz snapshots and writes instance matrices straight into the GPU buffer. Terrain is
a single vertex-coloured mesh.

Snapshots are transferred (not copied) from the worker as `Float32Array`s.

## Current limits, on purpose

- Terrain height is visual only; the sim is flat. Heightmap moves into the sim (as integers)
  when terrain starts to affect gameplay.
- Movement is straight-line with soft separation. Flowfield pathfinding comes with obstacles.
- Entities are never removed yet. A free-list arrives with combat.
