# Roadmap

Goal of v1: a single-player skirmish against AI that is fun for an evening. Each milestone
ends in something playable at the live link.

## M0 Foundation (done)

Repo, CI, auto-deploy. Deterministic sim in a worker, instanced rendering, RTS camera,
selection and move orders, 3000-unit stress test with performance overlay.

## M1 Battlefield

- Map with obstacles (forest, water, cliffs) stored in the sim
- Flowfield pathfinding, formations that hold shape while moving
- Minimap, control groups (Ctrl+1..9), double-click to select type
- Entity create/destroy with a free-list

## M2 Combat

- Unit types (infantry, tank, artillery, anti-air), health, range, damage, armour classes
- Projectiles, hit effects, wrecks
- Attack-move, hold position, target priorities
- Fog of war and line of sight

## M3 Cities as fortresses

- Buildings that can be garrisoned by infantry; garrison bonuses
- Building damage states and destruction by tanks and artillery
- Towns as capturable territory that produces income

## M4 Economy and base

- Resources, harvesting, construction, production queues, tech tiers
- HUD: command card, production, resources

## M5 Skirmish AI

- Build orders, scouting, army composition, attack and defence timing
- Difficulty levels

## M6 Factions

- Three asymmetric factions with distinct units and tech
- Original names, art direction, audio

## M7 Polish for v1

- Models, animation, particles, lighting and shadows, sound
- Menus, settings, save/replay

## Later

- Lockstep multiplayer (the sim is already built for it), lobbies, replays
