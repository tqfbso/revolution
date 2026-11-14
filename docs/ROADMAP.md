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
matters more than it should in AI against AI games; the AI does not yet use smoke to cover an assault on easy and normal; game length is untested
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
bridge chokepoints and a fix for the slowdown when zoomed in followed in the same thread:

- Zoomed-in slowdown (decision 068): puffs at the lens fade out, full-detail units have a
  budget, soldiers cast fewer shadows, the stats overlay shows where CPU time goes.
- The ridge map (decision 069): no river, four ways across (road over a ridge, forest
  belt, ravine, farmland), mirror-symmetric, seven towns. Default for the skirmish; the
  river map is on the Map menu.

## AI follow-up (built, awaiting Fabio's test)

Fabio, 2026-11-12: easy is still too hard. Decision 070: a smaller, later, more cautious
easy and recruit; the AI builds depots beside its stockpiles (it was starved of supplies
on the ridge map); its squads ride to the attack in carriers.

## Graphics sprint 2 (built, awaiting Fabio's test)

- Dressed ground: fields, streets, yards, dirt roads, props; pitched roofs and roof
  clutter; camera angle that changes with zoom; land past the map edge (decision 071).
- Sound pass 2: layered small arms, echo that grows with distance, a far-battle bed,
  wind and birds (decision 072).

## Easier easy, and battle alerts (built, awaiting Fabio's test)

Fabio, 2026-11-13: balance is right, easy still unbeaten, and the map is too big to see
an attack elsewhere. Decision 073.

- Easy and recruit react late, scout less, do not concentrate fire and stay away from a
  place where they were beaten
- Alerts for attacks off screen (base, town, forces, supply trucks) and for enemy troops
  found by a recon drone: banner, tone, spoken line, minimap ping, edge arrow; Backspace
  jumps to the latest

## Soldiers sprint (built, awaiting Fabio's test)

Fabio, 2026-11-13: the soldiers are the weakest thing on screen. Decision 075.

- A jointed figure at true proportions with helmet, plate carrier, pouches, pack, knee
  pads, boots and rifle; a simpler jointed figure at middle distance
- Stances: running with a real stride, standing at the low ready, kneeling at the halt,
  kneeling or prone to fire, scouts lying up; eased from one to the next
- A flash at each rifle's own muzzle, with recoil
- One neutral uniform, built from a palette so each faction can be dressed later

## Soldiers, second pass (built, awaiting Fabio's test)

Decision 090. Real body shapes in place of boxes at close and middle distance, kit, a
carbine, heads that turn; edge wear and crease dirt on soldiers and vehicles; ambient
occlusion and a colour grade on `normal` and `high`.

## Surveillance cameras (built, awaiting Fabio's test)

Fabio, 2026-11-13. Decision 076.

- Engineers leave cameras (V): cheap, unseen by the enemy, a small circle of sight, a
  contact alert when enemy troops walk in
- A jammer truck blinds cameras in its bubble and gives them away; a camera given away is
  pulled down by any enemy ground unit that reaches it; jammed drones show through the fog
- Not yet: the AI placing cameras of its own; cameras on the minimap

## Urban warfare (U1 built; U2 storming and the U3 city map built, awaiting Fabio's test)

Fabio, 2026-11-12: buildings are too easy to destroy; wants ruins used as fortresses,
something like building buildings, fighting through a city as it is destroyed, and a
dense city map with streets, bus stops and lots of detail. The full plan, with the
research behind it, the performance budget and the open questions, is in `URBAN.md`.

- U1 Buildings that die slowly (BUILT 2026-11-13, decision 074): four states (intact,
  damaged, gutted, ruin), each still a position; building classes two to six times
  tougher; tank guns break walls, artillery brings structures down; a ruin cannot be
  destroyed further; the garrison's losses come in two steps
  Retuned 2026-11-14 (decision 095) after Fabio found the city too hard to destroy:
  buildings about half as tough, and collateral damage (stray rounds, shell bursts,
  vehicles that blow up, the fight inside)
- U2 Hold and take a block. BUILT 2026-11-13 (decision 086): storming an enemy-held
  building, with breaches and smoke taking away the defender's edge; the AI storms too.
  Still to do (Fable 5.2 with Sonnet 5.5 for the interface): fortify, repair, barricades,
  linked buildings with mouseholes, "garrison this block"
- U3 Streets. BUILT 2026-11-13 (decision 087): the city map, generated round nine flags,
  436 buildings, streets and street furniture, now the default map. Still to do (Fable
  5.2): columns in corridors, local map updates, rubble that shuts streets and engineers
  that clear it
- U4 The city's look. MOSTLY BUILT 2026-11-13 (decision 091): street rubble, repair and
  fortify, fortified ruins, varied roofs and fronts, materials and signs. Still open: far
  facades and the roof fade. The plan was: (heavy, Fable 5.2 with Sonnet 5.5 for props): block meshes per state,
  the prop kit, far facades, roof fade, against a stated budget
- U5 Urban AI and urban units (heavy, Fable 5.2): an AI that holds, fortifies and storms
  blocks; marksman team; top attack on tanks in streets; drone rules
- U6 Tuning after play (light, Sonnet 5.5)

Order agreed with Fabio on 2026-11-13 (morning): U1, then the soldiers and the cameras,
then co-op (if approved), then U2 to U5, then the factions, so that each faction's roster
is designed around the urban rules instead of being redesigned for them.

That order changed the same evening: see "Strategic command" below, which now comes
before co-op and before U2.

## Co-op (two players confirmed over a real network 2026-11-14; three and four built, decision 093)

Decision 092. Host-clock lockstep over WebRTC, invite link, build check, hash check every
two seconds, shared pause and speed, either side plays on alone after a drop. Roles, first
layer: picked in the lobby, shown to both, marked on the production screen; ping (Z) and
the partner's view on the minimap. Rejoining a game in progress is built (decision 100,
by replaying the orders, not by sending the world). Next: orders that know who gave them
(unit handover, "my units", soft budgets per role), role-first screens.

## Strategic command (built; a deliberate change of order)

Fabio, 2026-11-13 evening: wants to command the war instead of the firefight. Larger
battles, less clicking through barracks, no forgotten units, sub-commanders who run a
mission by themselves, a screen that does not overlap itself, and an economy that lets
him build more while making battles harder to fight far from home.

Why this goes ahead of co-op and U2, which were next: the chaos is in single player
today and needs no netcode to fix; and "one team, several people each with a job" is the
co-op roles feature. Sub-commanders and a shared production screen are the same plumbing
with the computer in the second seat, so co-op gets cheaper, not later for nothing.

1. Screen layout (built, decision 077): zones that never overlap, a production queue of
   fixed slots, and a button with its key for every order that was a key you had to know
   (attack-move, smoke, mount, dismount, the engineers' camera)
2. War production centre (built, decision 078): one screen for every factory, bulk
   orders spread across them, "keep N of these", and new units sent straight to a town
3. Logistics economy (built, decision 079): income doubled, paid for by supply range
   (units far from a depot, a held town or a linked truck fire at half rate), rations
   for two minutes, mending in supply, upkeep for a standing army. Control groups are
   visible as chips (decision 080)
4. Sub-commanders (built, decision 082): up to eight commanders, each with troops and a
   mission (attack, hold, defend, patrol, screen), run by a staff made of the skirmish
   AI's own parts inside the deterministic rules, so a second player can take a
   commander's seat later. A mission board shows every commander, its strength and
   state, and the idle units nobody commands; losses can be replaced by themselves

Then, as before: U2 storming and the city map (generated around the flags, where troops
gather), the soldiers' second pass (with R1 and R2 below), co-op roles, U4 to U6 (with R5
and R6), the factions. R3 and R4 are placed in "Rendering upgrades" below.

## Rendering upgrades from the Saltline study (planned, slotted into existing work)

Fabio, 2026-11-13: linked a first-person shooter built inside a single artifact
("Saltline") as a mark for how far graphics can be pushed, and agreed to adopt everything
that transfers. Its source was read; the findings are in decision 085. It draws at most 18
robots in one small yard, so its character and level techniques do not carry to thousands
of units. What carries is whatever costs per pixel or is paid once when a model is built.
It is GLSL on WebGL; here each item is rewritten for TSL on WebGPU, with the WebGL2
fallback kept working. Nothing below touches the sim or the golden hash.

Each item rides with the work it belongs to, in this order:

- R1 Ambient occlusion and a grade pass. BUILT 2026-11-13 (decision 090), without
  automatic exposure. The plan was: With the soldiers' second
  pass. Half-resolution occlusion from depth with a depth-aware blur, then one grade pass:
  automatic exposure, a film curve, a little vignette, grain and sharpening. On `normal`
  and `high`; `low` stays as it is. The point is contact: soldiers, vehicles and houses
  that sit on the ground instead of floating over it
- R2 Edge wear and cavity dirt from the shape of the model. BUILT 2026-11-13 for
  soldiers and vehicles (decision 090); buildings follow in U4. The plan was: With the
  soldiers' second pass, then vehicles, then buildings in U4. When a model is built, how
  convex or concave each corner is goes into a vertex attribute; the material chips paint
  on outer edges and darkens inner corners. Paid once, free per frame, works instanced
- R3 Frame-time governor. BUILT 2026-11-13 (decision 089), with a performance test on
  the menu that names the limit on the machine it runs on. The plan was: standalone, any time; best before the city
  map raises the load. Measure first whether the drop to the low 40s at 4,000 units is
  the graphics card or the CPU posing units (the stats overlay already splits CPU time).
  Then: a pixel budget per graphics level, the shadow map redrawn every second frame
  below `high`, and a step down in graphics level when render scale alone is not enough
- R4 Light and weather presets (medium, Sonnet 5.5). After U3, so the city is lit on
  purpose. Low sun, overcast and rain as chosen looks, with fog that takes its colour
  from the sun. Analytic fog on every level; light shafts marched through the shadow map
  on `high` only. Render-only: weather that changes sight or movement would be a sim
  feature and is not part of this
- R5 Material sets baked on the graphics card. BUILT 2026-11-13 for the city (decision
  091): eight surfaces as layers of one array texture; the land's textures stay in
  `textures.ts`. The plan was: (medium, Fable 5.2 for the baker, Sonnet
  5.5 for the surfaces). With U4, the city's look. Replaces the canvas bake in
  `textures.ts`: each surface (asphalt, concrete, brick, plaster, corrugated steel,
  painted metal, rust) is a small shader baked at start-up into colour, height and
  roughness, with normals derived from the height, large-scale variation to hide the
  repeat, and a wetness term the weather presets can drive. Still nothing to download
  (decision 060 stands)
- R6 Drawn signage. BUILT 2026-11-13 (decision 091): shop fascias, street plates and
  roof hoardings on one sheet. Road markings already existed. The plan was: (small to medium, Sonnet 5.5). With U4. Street
  signs, shop fronts, house numbers, lane lines and crossings drawn as canvas text and
  shapes into one atlas, then scratched and faded; placed as props that dress and never
  play

Looked at and left out: planar reflections on wet ground (a second render of the scene,
which doubles the draw cost at our unit counts); motion blur (costs readability from an
RTS camera); its enemy rigs and first-person hands (built for 18 actors); its sound
engine (sound is not a focus; music that follows the intensity of the battle is noted
for M11). One idea from its gameplay is noted for U6 and the next AI pass: attack
tokens, where only a few enemies may fire at once, as a way to pace `easy`.

## Build order agreed with Fabio (2026-11-14)

In this order, ahead of M10. Items 6 to 11 are planned only.

1. More resources, and income from held flags. BUILT (decision 098)
2. Co-op rejoin: a dropped player comes back into the running game. BUILT (decision 100)
3. Raiding AI: small squads that probe, harass and pull back; big attacks rarer. BUILT
   (decision 101)
4. Civilians: about 400 a map, fleeing to the edges; each death costs the army that
   caused it resources. No gore. BUILT (decision 102)
5. Victory screen: kills, losses, buildings and civilians lost, an MVP per player. BUILT
   (decision 103)
6. Helicopters (capped by helipads, about 3 a pad) and paratroopers (built into a
   reserve, dropped by a transport plane that air defence can shoot down). BUILT
   (decision 106)
7. European city map: dense blocks, parks, an elevated highway, a river with bridges
   balanced by tunnels and underpasses, a central station
8. The computer fighting in cities (U5): garrisoning, storming, using ruins
9. Night battles: flares, muzzle flashes, fog of war that matters more
10. PvP for up to four players, free-for-all or 2v2, on the co-op netcode
11. Factions (M10), then weather (R4)

## M10 Factions

- Three asymmetric factions with distinct units and tech
- Original names, per-faction equipment and paint, audio

## M11 Polish for v1

- Authored or CC0 models replacing procedural ones, animation
- Menus, settings, save/replay

## Later

- Lockstep multiplayer (the sim is already built for it), lobbies, replays
