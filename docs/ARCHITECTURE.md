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

Structures (buildings and bridges) are rectangles of cells listed in the map; towns are
circles. The layout is fixed and generated with the map. What changes in play lives in the
world: structure health, who is inside, who owns a town. The world owns its map, because
play changes the terrain: a collapsed building turns its cells to rubble, a cut bridge
turns back into river. After such a change the passability tables are rebuilt and every
flowfield is thrown away (`refreshPassability`, a few milliseconds, a handful of times per
game). `lineOfSight` walks a line in half-cell steps and fails on a standing building, on
more than 12 units of forest, or on ground that rises above the line between the two eyes.

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
4. Acquire targets: nearest living enemy within 44 units that is in line of sight and not
   concealed (forest, rubble, or a building it has not fired from). Units without a target
   look every 4 ticks, everyone re-evaluates every 16, staggered by id; sight to the current
   target is re-checked every 4. Sight tests are the costly part, so they run last, only
   for a candidate closer than the best so far, at most 8 per search.
5. Steer: units free to fight close to weapon range and hold; plain move orders keep moving.
   Straight line if walkable, else the flowfield.
6. Separate (soft collisions), fire (hitscan, damage accumulated, for units and for
   structures; guns launch shells), land the shells due this tick, integrate (impassable ground is a hard wall units slide along), then resolve
   damage, deaths, wreck expiry and collapsing structures.
7. Once a second: town capture, income, bridge repair.

Garrisoned units stay in the unit arrays (they keep targeting and firing through the normal
path) with `inside` set to their building; they do not move or collide. Range is the
weapon's plus a bonus for height difference (and for firing from a building).

Sight and spotting: step 4 above now reads "within its own sight (per type) or spotted by
the army, within 44 units". Before it, `updateJamming` marks drones inside an enemy
jammer's bubble and `updateSpotters` lets sensors (recon teams, recon drones) mark every
enemy in view as spotted. `spotted` is read and written in the same pass in index order:
deterministic, though a unit can benefit from a mark set earlier in the same tick.

Air is a third movement class whose cost table is 1 everywhere, so drones need no special
case in movement: the straight line is always clear. They are skipped where ground rules
apply (line of sight, shell blast, town capture, collisions with ground units).

Indirect fire: guns skip the normal target search and pick among enemies whose `spotted`
tick is in the future (set by any enemy unit that has them as a target in sight, and by
their own firing). `launch` puts a shell into a small pool in the world (where and when it
lands, who fired it); `resolveShells` applies area damage through the collision grid on
the tick it lands. Shells are sim state and part of the hash. A smoke shell instead stamps
`map.smoke` (per cell, the tick until which smoke stands there) around its impact;
`lineOfSight` gives up after two half-cell steps of smoke and `concealed` hides whatever
stands in it. The world keeps the list of smoked cells for the hash.

Unit types live in `src/sim/units.ts` as a table of integers (health, speed, range, reload,
movement class, damage per target type, armour by facing, seats). A damage of zero against
a type means "cannot engage it": such targets are never acquired.

Vehicles have a hull direction (`faceX`, `faceY`, a Q10 unit vector) that turns toward the
direction of travel or, standing, toward the target; `fire` picks the front, side or rear
armour from the angle between it and the shooter. A squad riding in a carrier stays in the
unit arrays with `carrier` set to the vehicle: it is left out of both grids (so nothing can
target or bump it), skips targeting, steering and firing, and has its position copied from
the vehicle after `integrate`.

## Economy (`src/sim/economy.ts`)

Prices and building types are tables of integers next to the unit table. Resource sites
are points generated with the map (`placeSites`); what is left at each lives in the world.
A truck is an ordinary unit with a job (`job`, `jobSite`, `jobStruct`, `cargo`): go to the
site, load for three seconds, drive to the nearest finished depot or headquarters, unload,
repeat. It moves with the normal move order (`sendTo`), so it paths and collides like
everything else, and arrival is a distance test against the site or the building's
footprint. Any other order clears the job.

A base building is a structure of kind `S_BASE`, added to the map during play
(`addStructure`), with its owner, type, construction progress, queue and rally point in
the world (`sTeam`, `sType`, `sBuild`, `sQueue`, ...). Placing one changes the terrain, so
it goes through the same path as a collapsing house: passability rebuilt, flowfields
dropped, and in addition every unit standing on the plot is moved to the nearest free
cell. `canPlace` (in the map module, shared with the client's placement preview) demands
open ground on the plot and one cell around it, which is what guarantees buildings can
never disconnect the map. Production advances the first queue entry one tick at a time and
spawns the unit south of the building (`spawnUnit`), unless the army is at its unit limit.
All of it is covered by the state hash.

## The AI (`src/sim/ai.ts`)

A player made of code (decision 043): `aiThink(ai, world, out)` appends commands, the
worker calls it before every `step()`. Its work is spread over the second: on one tick it
looks (`perceive`) and runs `economy` and `production`, half a period later it looks
again and runs `military`. A think costs about 0.02 ms per tick on average.

- `perceive`: sorts its own units by job; marks which 16-unit squares it has eyes on;
  lists the enemies in sight; updates the threat memory, the houses known to be held and
  the enemy base buildings found
- `economy`: trucks to sites (wells first, a cap per site, off sites under fire), a depot
  at the next stockpile and well when the ones in reach are full, the next building from
  a short priority list, technology, repairs. It saves for the next building or tier
  (`resS`, `resF`, `resC`) except under attack
- `production`: the wanted army as weights per unit type, from the tier and from the
  enemy types seen; each idle building gets the type furthest below its share
- `military`: `enlist` gives new units a job; `garrisons` puts town troops into houses;
  `scouting` runs recon posts and drone rounds; `runReserve` answers the worst alarm;
  `runForce` drives the field army and the raiders through march, assault and retreat

`tools/aimatch.ts` plays AI against AI without a browser and prints a line a minute; it is
the way to test a change to the AI or to prices (a 40-minute game takes a few seconds).

## Commands

`src/sim/commands.ts` defines the only inputs to the sim: move, attack-move, stop, spawn,
garrison a building, shell a structure, mount carriers, dismount, bombard a point, hold,
and for the economy: gather, build, assist, train, cancel, rally, research, stance. A
command holds integers only; float-to-fixed conversion happens once on the client before
sending. In single player a command applies on the next tick. In lockstep multiplayer the
same commands get scheduled a few ticks ahead and broadcast; the sim does not change.

## Rendering

Three.js `WebGPURenderer`, which uses WebGPU where available and WebGL2 otherwise.

- **Models** (`src/client/models.ts`) are generated at start-up from boxes and cylinders, in
  three levels of detail. Vertex attributes carry albedo and a team-marking mask.
- **Batches** (`src/client/batch.ts`): one instanced draw call per model part per level of
  detail. `UnitView` holds a table per unit type: a vehicle is a hull, a turret and a far
  mesh; a foot unit is a list of figures (soldiers, a launcher) and a far mesh. Vehicles
  other than the tank come from one parametric builder (`buildVehicle`). Per instance: a matrix and
  a 4-float tint (team colour and burn).
- **Per frame** (`src/client/units.ts`): interpolate each unit between the last two 20 Hz
  snapshots, cull against the frustum, choose the level of detail by distance, write the
  instance. Turrets track the attack target; infantry squads are five soldier instances that
  thin out as the squad loses health.
- **Effects** (`src/client/effects.ts`): pooled camera-facing sprites (additive fire, blended
  smoke) and stretched tracer quads, three draw calls in all, fed by sim events.
- **Scars** (`src/client/scars.ts`): craters and burn marks, permanent, one draw call.
- **Light**: hemisphere sky light plus one sun with a shadow map that follows the camera
  focus. ACES tone mapping.

- **Structures** (`src/client/structures.ts`): one mesh per building or bridge, rebuilt
  from boxes when it changes state (standing, shot up, collapsed). On top, two small
  instanced batches for the readability layer: a pip per squad over an occupied house, a
  flag per town.

Snapshots are transferred (not copied) from the worker as typed arrays: positions, a
state/team byte, unit type, hull heading, squads aboard (plus "inside a building" and "revealed"), health, attack target,
structure health, town owners, and the tick's combat events.

## Player view

The player commands team 0. `src/client/fog.ts` computes what that army sees (10 Hz: 120
rays from one viewpoint per occupied 2x2 cells, as far as that unit type sees, each stopped
by buildings, hills and deep forest; a drone lights a plain circle) into a 256x256 texture that every world material multiplies its
colour by; enemy units outside vision are not drawn and their effects not played.
`src/client/minimap.ts` draws terrain, fog, units and the camera outline into a 256-pixel
canvas ten times a second. Selection, control groups and the minimap are client state.

## Current limits, on purpose

- Blue does not react beyond shooting what it sees, and does not build: no AI until M7.
- Your base buildings lift the fog for 28 units around them, on the client only: in the
  sim a building spots nothing. Enemy base buildings are drawn from the start.
- Commands do not say who sent them; the sim takes the army from the units or the building
  named. Multiplayer will add the sender and check it.
- Fog of war (client) and the fight (sim) use the same sight rules but separate code; the
  fog is per cell, so they can disagree by a cell at the edges.
- If all 96 flowfield slots are in use, further units walk straight until one frees up.
- A command naming a slot that died and was reused reaches the new occupant. Harmless in
  single player; multiplayer will add a generation counter per slot.
- Models are untextured procedural geometry (see decision 011).
