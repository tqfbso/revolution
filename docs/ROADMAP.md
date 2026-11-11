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

## M4 Cities as fortresses

- Towns and villages placed where they matter: at the central crossing, at fords, on roads
- Bridges: fast crossings that can be destroyed and repaired, next to the slow fords
- Buildings that can be garrisoned by infantry; garrison bonuses (cover, sight, ambush)
- Building damage states and destruction by tanks and artillery; rubble still gives cover
- True line of sight: buildings, forest and high ground block sight and direct fire;
  high ground sees and shoots further
- Towns as capturable territory that produces income

## M5 Combined arms

- Spotting: a unit can fire at what any friendly unit sees. Recon teams see far and hide
  well; everything else is half blind without them
- Anti-tank missile teams: infantry that kills tanks from range and from cover. Armour
  facing (front, side, rear), so flanking pays
- Infantry fighting vehicles and carriers: move squads fast, dismount to fight
- Artillery: shells with flight time, area damage, indirect fire on spotted targets, and
  counter-battery (firing reveals the battery)
- Drones: cheap recon eyes and one-way strike drones. Air defence that shoots them down.
  Electronic warfare vehicles that jam them in a radius
- Smoke, hold position, target priorities, stances
- Persistent battlefield scars: craters, scorch marks

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
