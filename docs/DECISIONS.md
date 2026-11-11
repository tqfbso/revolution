# Decisions

A short log of choices that would be expensive to reverse. Newest last. To change one, add
a new entry that supersedes it.

## 001 Browser, TypeScript, Vite

The game ships as a web page: a link is the whole install, deploys are instant, and it runs
on any desktop OS. TypeScript for type safety across sim, worker and client; Vite for build.
Revisit only if we hit a quality or performance ceiling the browser cannot pass.

## 002 Three.js with WebGPU renderer, WebGL2 fallback

Three.js gives us a mature scene graph, loaders and tooling, and its `WebGPURenderer` picks
WebGPU or WebGL2 at start. We keep unit rendering in a few instanced draw calls so we are
not bound by scene-graph overhead.

## 003 Deterministic fixed-step simulation, separated from rendering

The sim is integer-only, seeded, and advances at a fixed 20 Hz; rendering interpolates. This
is required for lockstep multiplayer and replays, where each machine must compute the exact
same game from the same commands. Retrofitting determinism later is close to a rewrite, so
it is in from day one. 20 Hz matches classic RTS feel and leaves 50 ms of budget per tick.

## 004 Fixed-point Q22.10 on JS numbers

World distances are integers with 10 fractional bits. On a 1024-unit map all intermediate
products stay below 2^53, so ordinary JS arithmetic is exact, with no BigInt or WASM needed.
The price: map size and precision are bounded, and sim code must use the helpers in
`src/sim/fixed.ts` instead of float math. A lint rule enforces this.

## 005 Simulation in a Web Worker, snapshots by transfer

Game logic runs off the main thread so frame rate and tick rate cannot hurt each other.
State crosses the boundary as transferred typed arrays. We do not use `SharedArrayBuffer`
because it needs cross-origin isolation headers that GitHub Pages cannot set.

## 006 Data-oriented ECS on typed arrays

Components are flat typed arrays, entities are indices, systems are loops. This is what makes
thousands of units cheap (cache-friendly, no garbage) and makes hashing and later saving or
syncing the state trivial. No ECS library: the pattern is small and we need full control of
iteration order for determinism.

## 007 Commands are the only input to the simulation

Selection and camera are client state. Anything that changes the game goes through a
`Command`. Single player and multiplayer share this path; lockstep only adds scheduling and
transport.

## 008 Lockstep (not client-server state sync) for multiplayer

With thousands of units, sending state is too much data; sending commands is tiny. Lockstep
is the standard answer for large-scale RTS. Consequence: decisions 003, 004 and 007 are
non-negotiable.

## 009 GitHub Pages, deploy on every merge to main

Free, zero-ops, and the live link always shows the latest merged work.

## 010 Original IP

Real-world present-day setting and three power blocs as inspiration, but all names, units,
art and audio are original. Nothing is copied from existing games.

## 011 Art direction: grounded realism

Fabio's call (2026-11-11): the game should look real, uncomfortably so. No sci-fi, no
cartoon. Concretely: present-day military proportions and silhouettes (original designs, not
copies of specific real vehicles), muted service paint, physically plausible smoke, fire and
dust, wrecks that stay and burn. Team colour never floods a hull: it appears on small
markings (recognition panels, stripes, shoulder patches). Telling armies apart at long range
is the job of a separate readability layer (the far level of detail today; rings, outlines
and icons as the UI grows), which is UI, not world.

Known gap: the current models are procedural boxes and cylinders with flat colours. They get
proportions and lighting right but not surface realism. Closing that gap needs textured
models (authored or CC0, for example Poly Haven) and a real sky; planned for the polish
milestone, pulled forward if the look blocks decisions.

## 012 Levels of detail chosen per unit, per frame, on the CPU

Every unit is tested against the view frustum and binned by camera distance into one of
three instanced batches per model part (full detail, simplified, a few triangles). Draw
calls stay around a dozen regardless of army size; triangles scale with what is close, not
with how many units exist. Shadows are cast only by the two nearer levels and the shadow map
covers only the area near the camera focus. `?lod=` scales the distances, `?shadows=0`
turns shadows off, for testing on slow machines.

## 013 Hitscan weapons with simultaneous damage

A ready weapon with a target in range hits on that tick. Damage is summed per target from
start-of-tick state and applied afterwards, so results never depend on unit order and two
units can kill each other. Shell flight time and misses are presentation for now (tracers);
real projectiles arrive with artillery, where flight time is the point.

## 014 Effects are client-only

Flashes, tracers, explosions and smoke are driven by the sim's event list (shot, death) but
simulated on the client with floats and `Math.random`. They can differ between machines
without affecting the game. The event list is output only and is not part of the state hash.

## 015 The map is generated from the seed, in the sim, with integers

`src/sim/map.ts` builds the heightfield and a terrain type per 4-unit cell (open, forest,
water, cliff, ford) from the seed using integer noise only. The worker and the renderer
both run it, so the map never travels over the wire and can never differ between machines.
Layout is semi-authored: the river, its five fords and the cleared deployment areas are
placed on purpose, noise fills in the rest. Units belong to a movement class (vehicle,
foot) with its own passability: forest stops vehicles and halves infantry speed. Ground a
class cannot reach from the main area (islands, cliff-ringed plateaus, forest clearings for
vehicles) is treated as impassable for it, so any two passable cells are always connected
and pathfinding never has to handle "no route".

## 016 Flowfields, built lazily, with a straight-line shortcut

One Dijkstra pass (bucket queue, about 5 ms for the 256x256 grid) gives every cell its cost
to a goal; any number of units share it. A field is built the first time a unit of that
order needs it and kept in one of 96 slots while units still follow it. A unit whose
straight line to its own formation slot is walkable ignores the field and walks the line
(rechecked every 16 ticks), which keeps open-ground movement natural and makes fields rare
there. Chasing a target behind an obstacle follows a per-team, per-class "nearest enemy by
walkable route" field, limited to a 30-cell detour and refreshed at most every 2 seconds,
only while someone needs it. Rejected: per-unit A* (cost scales with unit count) and a
navmesh (more code, no gain on a grid map).

## 017 Formations move at the pace of the slowest

A move order arranges the group in a block twice as wide as deep, facing the direction of
travel, vehicles in the front rows, each unit taking the slot that matches where it already
stands. Everyone moves at the slowest member's speed so the shape holds. Mixed groups are
therefore slow; send tanks separately to use their speed. Same trade Age of Empires makes.

## 018 Fog of war is presentation; concealment is simulation

The player commands one army (team 0, red) and sees what it sees: 60 units around each
unit. Fog lives on the client (`src/client/fog.ts`): the sim stays omniscient, which
lockstep needs anyway, and the client hides enemies outside vision. What must affect the
fight is in the sim: a unit standing in forest can only be targeted from within 13 units,
closer than infantry's own range, so a squad in the woods fires first. `?fog=0` lifts the
fog and `?control=all` lets one player order every army, for testing. True line of sight
(ground and buildings blocking sight and fire) is deferred to M4, where buildings make it
matter.

## 019 Frame rate is defended by spending less, automatically

Fabio saw 60 fps drop to the low 40s mid-battle at about 4000 units. The frame cannot be
profiled on real hardware from the cloud, so the fix targets both likely causes without
guessing: effects whose shooter and target are both off-screen are skipped and far ones
thinned (CPU and overdraw), particle emission sheds load as the pool fills, and the render
resolution steps down by a quarter when frames stay slow for two seconds and back up after
twelve smooth ones (GPU fill). `?scale=fixed` pins the resolution.

## 020 Modern battle dynamics are a design pillar

Fabio's call (2026-11-11): keep present-day battle dynamics in mind from the start so the
game stays interesting: chokepoints, urban warfare, and the kinds of units armies use now.
Consequences: maps are built around chokepoints (the M3 river and fords, bridges and towns
in M4); vision is a resource (fog and concealment in M3, spotting and recon in M5); no unit
is good at everything (missile infantry beats tanks from cover, artillery beats static
positions and is hunted by counter-battery, drones give cheap eyes and are countered by air
defence and jamming). The roadmap for M4 to M6 is written around these dynamics.

## 021 Towns sit on the crossings, and the world may change its map

Three of the five fords get a bridge and a settlement on each bank: a town in the centre,
villages north and south. The outer two fords stay bare, so there is always a way around
that costs time instead of blood. Fords are now half speed, which is what makes a bridge
worth holding and worth cutting. Buildings and bridges are part of the terrain grid, so
pathfinding and collisions needed no new code; the price is that the map is no longer
constant. When a building falls or a bridge is cut the passability tables are rebuilt and
all flowfields dropped. That takes a few milliseconds and happens a handful of times per
game. Rejected: structures as big units (they would need their own collision and sight
code and would not block paths).

## 022 A garrison is hard to see and hard to hurt, and the answer is to bring the house down

Close Combat was the reference. Infantry in a building takes a quarter of the damage,
shoots 3 units further, and cannot be targeted from beyond 13 units until it fires (then
it is exposed for 5 seconds). So tanks, which outrange infantry in the open, have to come
close to find a garrison, and infantry attacking a held house loses about four squads for
one. The counter is the tank gun used on the building: on order (Ctrl + right click, which
also works as reconnaissance by fire on a house you only suspect), or automatically when
shooting at a garrison that has shown itself. A building has 220 health per cell of floor
plan; a tank shell does 60. At 60% it shows damage, at zero it collapses: each squad
inside loses half its remaining strength and finds itself in the rubble. Rubble is
permanent, infantry only, half damage and concealed like forest, so a ruined town is
still a position, just a worse one. Capacity is one squad per cell, at most 8.
Artillery will be the second counter in M5.

## 023 Line of sight is real, for the fight and for the fog

A unit can only target what it can see: a line from eye to eye that is not broken by a
standing building, by more than 12 units of forest, or by ground. Height matters twice.
Sight: from a plateau you look down on the plain, but only from its edge, and nobody on
the plain sees onto it. Range: plus half the height difference, capped at +5 and -2, so a
tank on a 9-unit mesa outranges one below by a quarter. The fog of war on the client
follows the same rules with rays cast from the player's units, so what you are shown
matches what your units can shoot. Units keep a target they lose sight of for at most a
second and then look for another. Cost: the sim tick went from 2.5 ms to 3.6 ms at 3000
units in battle and from 12.4 ms to 15.4 ms at 10000, against a budget of 50.

## 024 A town belongs to the army alone in it

Each bank of a crossing is its own district with a capture circle. An army that is the
only one inside gains a point per unit per second, at most ten, and takes the district at
60: six seconds in force, a minute for a lone squad. Two armies inside freeze it, and a
garrison counts, so a town is not taken until its houses are cleared. A held district
pays 10 credits a second. There is nothing to buy yet; the number is on screen so holding
ground already has a score, and M6 gives it a use.

## 025 Bridges are cut by tanks and rebuilt by idle infantry

There are no engineers or construction yet (M6), so repair is the simplest rule that
makes cutting a bridge a decision instead of a one-way door: infantry standing idle
within 14 units of a cut bridge rebuilds it, 12 seconds with five squads, a minute with
one, and not while an enemy squad stands there too. Units on a bridge when it falls are
lost. The two outer fords and the three fords under the towns remain, so the map never
splits in two.

## 026 The default scenario is an assault, and blue stands still

The opening used to be two armies running into each other. It is now the situation the
game is about: blue holds the east bank with infantry in the houses and tanks behind,
red starts west of the central town with no orders. Blue has no brain until M7; it
shoots what it sees and chases what comes close. `?scenario=clash` keeps the old
head-on battle for performance comparisons.
