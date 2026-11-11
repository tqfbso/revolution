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

## M2 Combat and first real units (done, performance check on real hardware pending)

- Health, weapons with range and reload, damage by target type, nearest-enemy targeting
- Attack-move, death, wrecks, reuse of freed unit slots
- Main battle tank and infantry squad with real models, lighting, shadows
- Muzzle flashes, tracers, explosions, smoke, burning wrecks
- Three levels of detail and off-screen culling so detail holds at 3000+ units
- Battle scenario: two armies clash

## M3 Battlefield

- Map with obstacles (forest, water, cliffs) stored in the sim
- Flowfield pathfinding; chasing and attack-move route through it
- Formations that hold shape while moving
- Minimap, control groups (Ctrl+1..9), double-click to select type
- Fog of war and line of sight

## M4 Cities as fortresses

- Buildings that can be garrisoned by infantry; garrison bonuses
- Building damage states and destruction by tanks and artillery
- Towns as capturable territory that produces income

## M5 Combat depth

- More unit types (artillery, anti-air, transports), armour facing, projectiles with flight time
- Hold position, target priorities, stances
- Persistent battlefield scars: craters, scorch marks

## M6 Economy and base

- Resources, harvesting, construction, production queues, tech tiers
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
