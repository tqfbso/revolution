# Roadmap

Goal of v1: a single-player skirmish against AI that is fun for an evening. Each milestone
ends in something playable at the live link.

The order changed on 2026-11-11: combat and the look of the game moved ahead of the
battlefield work. Reason: whether thousands of detailed units can fight at 60 fps decides
everything after it, so it is tested first. Combat has no technical dependency on
pathfinding (on an open map units walk straight at their target); the one thing it needed
from the old "Battlefield" milestone, removing dead units, was built with it.

## M1 Foundation (done)

Repo, CI, auto-deploy. Deterministic sim in a worker, instanced rendering, RTS camera,
selection and move orders, 3000-unit stress test with performance overlay.

## M2 Combat and first real units (done)

- Health, weapons with range and reload, damage by target type, nearest-enemy targeting
- Attack-move, death, wrecks, reuse of freed unit slots
- Main battle tank and infantry squad with real models, lighting, shadows
- Muzzle flashes, tracers, explosions, smoke, burning wrecks
- Three levels of detail and off-screen culling so detail holds at 3000+ units
- Battle scenario: two armies clash

## M3 Battlefield (done)

- Map generated from the seed and stored in the sim: a river with five fords, mesas with
  cliffs and ramps, lakes, forests. Vehicles cannot enter forest, infantry can (slowly)
- Flowfield pathfinding; move, attack-move and chasing all route around obstacles
- Formations that face the direction of travel and hold shape (pace of the slowest,
  vehicles in front)
- Minimap, control groups, double-click to select a type
- You command one army (red). Fog of war: unexplored, explored, visible
- Concealment: infantry in forest is only spotted from close by, so it gets the first shot
- Frame rate: unseen effects skipped, far ones thinned, render scale adapts under load

Moved to M4: true line of sight (ground, forest and buildings blocking sight and fire). It
needs buildings to matter and shares its code with garrison fire.

## Design pillar for M4 to M6: modern battle dynamics

Fabio, 2026-11-11: the game should feel like present-day war from the start, not like tanks
and riflemen with a modern skin. Each milestone below adds a dynamic, not just content:
chokepoints and urban fighting (M4), the sensor-versus-shooter fight and combined arms (M5),
and an economy that makes holding ground matter (M6). See decision 020.

## M4 Cities as fortresses (done)

- A town on both banks of the central crossing and villages at the fords north and south
  of it; the two outer fords stay bare, as the ways around
- Bridges just upstream of those fords: full speed, where a ford is now half speed. Tanks
  can cut a bridge (whatever is on it is lost); idle infantry at the stump rebuilds it
- Infantry occupies buildings. A garrison takes a quarter of the damage, shoots a little
  further, and cannot be seen from beyond 13 units until it fires
- Tanks shell buildings (on order, or by firing at a garrison): shot up at 60% health, then
  rubble that falls on the garrison. Ruins stay for the rest of the game and still give
  infantry cover and concealment; vehicles cannot cross them
- True line of sight in the fight and in the fog of war: buildings, hills and deep forest
  block sight and direct fire; high ground sees over things and shoots further
- Six capturable town districts. A district goes to the army alone in it and pays credits
- New opening scenario: blue is dug in on the east bank, you attack from the west.
  `?scenario=clash` is the old head-on battle

Moved out of M4: artillery against buildings (M5, with artillery itself), spending the
income (M6), and roads as terrain (not needed: the bridges already make the fast routes).

## M5 Combined arms (done)

- Spotting: a unit can fire at what any friendly unit sees. Recon teams see far and hide
  well; everything else is half blind without them
- Anti-tank missile teams: infantry that kills tanks from range and from cover. Armour
  facing (front, side, rear), so flanking pays
- Infantry fighting vehicles and carriers: move squads fast, dismount to fight
- Artillery: shells with flight time, area damage, indirect fire on spotted targets, and
  counter-battery (firing reveals the battery)
- Drones: cheap recon eyes and one-way strike drones. Air defence that shoots them down.
  Electronic warfare vehicles that jam them in a radius
- Smoke shells from the guns: a screen that blinds both sides for 30 seconds, drones
  included. Hold position. Target priorities are built in (each weapon picks what it is
  good against)
- Persistent battlefield scars: craters, scorch marks

Moved out of M5: stances beyond hold position and a target-priority UI (M6, with the
command card), shell holes as cover and missiles with flight time (M9), and nobody
commands blue yet, so it uses none of this with intent (M7).

## M6 Economy and base

- Resources, harvesting, construction, production queues, tech tiers
- Income from held towns, so territory is the economy
- HUD: command card, production, resources

## M7 Skirmish AI

- Build orders, scouting, army composition, attack and defence timing
- Difficulty levels

## M8 Factions

- Three asymmetric factions with distinct units and tech
- Original names, per-faction equipment and paint, audio

## M9 Polish for v1

- Authored or CC0 models and textures replacing procedural ones, animation, sky and terrain
  materials, sound
- Menus, settings, save/replay

## Later

- Lockstep multiplayer (the sim is already built for it), lobbies, replays
