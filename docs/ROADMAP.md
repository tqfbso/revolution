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
command card), shell holes as cover and missiles with flight time (M10), and nobody
commands blue yet, so it uses none of this with intent (M7).

## M6 Economy and base (done)

- Three resources: supplies from stockpiles that run out (more trucks, more income), fuel
  from wells that pump at a fixed rate (more wells, more fuel), credits from held towns
- The logistics truck hauls and builds. 26 resource sites, the same on both banks, the
  richest behind the settlements
- Five base buildings, production queues with rally points, a unit limit set by depots
  (600 at most; since decision 067 800 army points), two technology steps paid for in credits
- Command card: build, produce, research, stop, hold position, hold fire. Resource bar,
  idle-truck button, victory and defeat when a headquarters falls
- New default opening, the skirmish: your base and a patrol against a dug-in east bank

Moved out of M6: blue's base buildings are visible from the start (M7, with an enemy that
builds); a target-priority screen (dropped, see
decision 040); hotkeys for production and a build menu (M10).

## M7 Skirmish AI (done)

- An opponent that plays the economy: trucks on sites, depots at new sites, production,
  technology. It is a player, not a script: it gives the same commands you do and sees
  only what its units see (`src/sim/ai.ts`, decisions 044 to 051)
- Scouting, an army built against what it has seen of yours, town garrisons in the houses
  that face the crossing, a reserve that answers alarms, raids on trucks
- A field army that picks an objective and the crossing to reach it by (it goes round a
  held bridge town rather than through it), looks at the far bank before it crosses,
  shells the houses you hold before it goes in, feeds new units into a fight, breaks off
  when beaten and comes back with more
- Four difficulty levels, chosen on screen (or `?ai=recruit|easy|normal|hard|off`, easy
  is the default), that differ
  in tempo and judgement, not in free resources. `?demo=1` shows the AI playing itself
- The skirmish starts even: nobody holds a town, blue builds its own fortress
- Units shell an enemy base building in range without being told to
- Enemy base buildings are unknown until one of your units sees them
- A first balance pass: each unit beats something and fears something for equal money
  (`tools/matchups.ts`)

Known weak spots, to revisit with play feedback: which side of the map you start on
matters more than it should in AI against AI games; the AI does not yet use carriers to
move infantry or smoke to cover an assault on easy and normal; game length is untested
by a human.

## M8 Fortifications (done)

Fabio, 2026-11-11: "Would be great to be able to build around the city, like walls, barbed
wire etc." The fortress used to be whatever houses happened to stand at a crossing; now a
player (and the AI) can make one.

- Six field works, one 4 m cell each, built by trucks and by the new engineer squad along
  a line dragged on the ground: wall and gate (stop everything, block sight at ground
  level; the gate opens for its owner only), barbed wire (stops infantry; armour drives
  over the enemy's and flattens it), tank obstacle (stops vehicles, not men), trench and
  sandbags (cover for infantry in the open; right click to man them)
- Pathfinding goes round a work when there is a way round and otherwise leads to it;
  units that can breach it do so on arrival, the rest wait for a gap
- Breaching: tank guns and artillery shoot works down, engineers lay charges (the only
  quick answer to tank obstacles). Right click an enemy work to order it
- The AI keeps a few engineer squads that lay belts of wire, obstacles and sandbags in
  front of the towns it holds and at its end of bare fords, mans the sandbags with
  garrison troops that find no house, buys engineers and guns when it has seen your
  works, and sends them against the works in its way when it attacks
- Decisions 053 to 057

Left out on purpose: minefields (an invisible killer needs a way to find and clear it,
and the engineer has enough to do for now; revisit after play); works inside a town's
streets are possible only where the ground is open; the AI builds no walls or gates and
does not dig trenches; trucks of the AI do not build works.

## Pacing pass (done, between M8 and M9)

Fabio, 2026-11-12: too quick to think about laying fortifications. Longer fights (ground
units 1.7x tougher), works build twice as fast, heavy units slower to produce, later and
smaller first AI attacks on easy and normal, game speed 0.75x/1x and Space to pause with
orders allowed. Decision 058.

## M9 Visual realism (built, awaiting Fabio's test)

Moved ahead of the factions on 2026-11-12 (Fabio agreed). The look was the furthest thing
from the goal while the game underneath was already fun; textures, lighting and effects
are what put the frame rate at risk, so better to find out before three rosters exist; and
factions built on placeholder looks would have to be painted twice. Decision 059.

- Ground of four blended surfaces (grass, earth, rock, asphalt) with detail and relief,
  cart tracks between the bases and the towns, and wear that the battle writes into it:
  vehicles churn their routes to mud, shells tear the turf
- A river with depth, ripples and a reflected sky; light from the whole sky; cloud
  shadows drifting over everything; two kinds of tree
- Worn paint, camouflage, mud and rust on vehicles; stained plaster and reflecting
  windows on houses
- Smoke, fire and explosions with shape and light
- A first pass at sound: gunfire, explosions, artillery heard from far off
- Unit symbols that fade in when zoomed out, so camouflage does not cost readability
- Three graphics levels, chosen on screen (`?quality=low|normal|high`)

All textures and sounds are made in code at start-up (decision 060): nothing to download,
no licences to track.

Not verified in the cloud, where the browser has no graphics card: the frame rate at
3,000 and 4,000 units on each graphics level, the WebGPU path, bloom on `high`, and what
the sounds are like to the ear. The sounds were written without being heard.

## Production and army rules (built, awaiting Fabio's test)

Fabio, 2026-11-12: battles were decided by tank count; wants soldiers and drones close to
free and fast, vehicles slower, tanks slower still, aircraft slowest. Decision 067: army
points instead of unit slots, new prices and times, missile teams and drones at tier 1,
close-range rockets for infantry, a Repeat toggle, a rewritten AI mix. A new map without
bridge chokepoints and a fix for the slowdown when zoomed in follow in the same thread
(parts B and C), before M10 Factions.

## M10 Factions

- Three asymmetric factions with distinct units and tech
- Original names, per-faction equipment and paint, audio

## M11 Polish for v1

- Authored or CC0 models replacing procedural ones, animation
- Menus, settings, save/replay

## Later

- Lockstep multiplayer (the sim is already built for it), lobbies, replays
