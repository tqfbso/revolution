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

## Urban warfare (U1 to U5 built in the main; awaiting Fabio's test)

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
  Fortify and repair came with U4; linked buildings with mouseholes and "garrison this
  block" BUILT 2026-11-28 (decision 166). Still to do: barricades
- U3 Streets. BUILT 2026-11-13 (decision 087): the city map, generated round nine flags,
  436 buildings, streets and street furniture, now the default map. Still to do (Fable
  5.2): columns in corridors, local map updates, rubble that shuts streets and engineers
  that clear it
- U4 The city's look. MOSTLY BUILT 2026-11-13 (decision 091): street rubble, repair and
  fortify, fortified ruins, varied roofs and fronts, materials and signs. Still open: far
  facades and the roof fade. The plan was: (heavy, Fable 5.2 with Sonnet 5.5 for props): block meshes per state,
  the prop kit, far facades, roof fade, against a stated budget
- U5 Urban AI. BUILT 2026-11-14 (decision 110): the computer holds, fortifies and storms
  blocks and uses ruins. The urban units (marksman team, top attack on tanks in streets,
  drone rules) move to the factions (M10)
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
by replaying the orders, not by sending the world). Built (decision 146): units that are
a player's own (by role as they roll out, or by first order), hand-over (Give, Take), roles
changed during the game, names, a team panel, teammates' units in their colour, and marks
on the map with a meaning (Z, then 1 to 3). Built (decision 164): who spent what, in the
team panel and on the end screen. Next: commanders that belong to a player, a role-first
production screen, soft budgets per role if the books show they are wanted.

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
- R4 Weather. BUILT 2026-11-15 as rain, fog and snow that also shorten sight (decision
  125); low sun and light shafts are not built. The plan was: Light and weather presets (medium, Sonnet 5.5). After U3, so the city is lit on
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
4. Civilians: about 400 a map (1,400 since decision 119), fleeing to the edges; each
   death costs the army that caused it resources. No gore. BUILT (decision 102)
   Redrawn as people the size of the soldiers (decision 111).
5. Victory screen: kills, losses, buildings and civilians lost, an MVP per player. BUILT
   (decision 103)
6. Helicopters (capped by helipads, about 3 a pad) and paratroopers (built into a
   reserve, dropped by a transport plane that air defence can shoot down). BUILT
   (decision 106)
7. European city map: BUILT (decision 107). `?map=euro` or Menu > Map: European city. One
   dense city on both banks of a river: four bridges that can be cut, three covered
   crossings that cannot, two parks, a motorway on an embankment, a station.
   Kowloon map (Fabio, 2026-11-20, asked for directly, outside this list): BUILT
   (decision 153). `?map=kowloon` or Menu > Map: Kowloon. Tsim Sha Tsui and Jordan round
   Kowloon Park: towers and tenements on a 48 m grid, the harbour on two sides, no bridges.
   Rebuilt from the real map (decision 160): OpenStreetMap coastline, streets at their real
   widths, the real park with its pools and lake, 1,050 buildings at real size by kind.
8. The computer fighting in cities (U5): BUILT (decision 110). Its sappers fortify the
   houses its garrisons hold, garrisons without houses lie up in the ruins, and the
   player's commanders do both as well. Garrisoning and storming were already there.
9. Night battles: BUILT (decision 113). Menu > Time: night, or `?time=night`. Sight is six
   tenths of the day's except for scouts; whatever is lit (a muzzle flash, a burning
   vehicle, a flare) is seen at daytime range; guns fire flares (I).
10. PvP: versus BUILT (decision 114): red against blue for 2 to 4 players, sides picked in
    the lobby, a side shares its army (2 v 2, duel, uneven sides). NOT built: a
    free-for-all of three or four armies, which needs a map drawn for four corners.
11. Factions (M10), then weather (R4)

## Attack formations (done: pieces 1 and 3 built, 2 measured and removed, 4 not needed)

From the proposal in the "Design tactical attack formations" thread.

- F1 Infantry does not walk at armour it cannot hurt. BUILT (decision 108)
- F2 A staged attack for commanders (overwatch first, squads wait, tanks trail in towns).
  BUILT, MEASURED AND REMOVED (decision 109): it lost more than the attack as it stands in
  all 17 fights tried. `tests/assault.test.ts` holds the bar a new version has to clear.
- F3 Attack style per commander. BUILT (decision 112) as the player's switch: together
  (default), infantry first, armour first.
- F4 The computer uses the drill. NOT BUILT (decision 112): going in together is what wins,
  so that is what every level does.
- Still open from the proposal: halted infantry looking for the nearest house or wood
  (belongs in U5), and a report from the commander of what its drones see at the objective.

## Fixes after the 2026-11-15 games

- Helicopters fight helicopters and hunt when left alone. BUILT (decision 116)
- Concentrate: a commander's troops on one exact spot, key R. BUILT (decision 117)
- Demolish for engineers, key O: charges on buildings, felling woods; people still in a
  house that is brought down die. BUILT (decision 118)
- Helicopters that come down stay down: they fall, burn and lie as scorched wrecks all game.
  BUILT 2026-11-16 (decision 144, client only)
- More civilians: 1,400 a map, most round the flags, one in three sheltering at home.
  BUILT (decision 119)
- Buildings a sixth easier to bring down. BUILT (decision 120)

## Big build of 2026-11-15

- Mid-zoom graphics: blocks drawn as rows of houses with courtyards and furnished roofs,
  the paved ground dressed. BUILT (decision 121)

- Infantry easier to find from mid zoom: flashes and tracers with a floor on their size on
  screen, dust behind marching squads, a soft shade under each. BUILT (decision 122)

## Far facades and see-through buildings (decision 126)

- [x] Squares of the city more than 520 m from the camera are drawn simplified
- [x] Y: buildings between the camera and the street in view fade above the ground floor
      (off by default)

## Free-for-all (decision 124)

- [x] Three or four armies, each for itself, on a map with four corners (`?armies=3|4`,
      Menu: Armies). The others are computers; co-op players share red.
- [ ] People against people in a free-for-all (the lobby knows two sides only)

## Inspiration build order (decision 136, planned)

From the inspiration review of 2026-11-16 (screenshots of another isometric RTS, used for
ideas only: our own look, units and interface). Design and drawings are in the Revolution
Hub, section 4A. Fabio answered the open questions the same day. This comes after the
review fixes and the order-ownership refactor agreed on 2026-11-15, which stay first.

- [x] I1 Deaths you can see (client only, decision 139). A man a squad loses becomes a body: thrown
      away from a high-explosive hit, crumpled where he stood from bullets. Bodies stay all
      game in six to eight poses, mirrored and turned; far ones are one pre-posed instance
      each, and past a budget the oldest far ones are baked into the ground wear texture.
      Also: troops visibly leave carriers by the ramp or tailgate on the existing unload
      event; buildings lose their top floors first as health falls (same thresholds), with
      soot and fire in the windows. No blood.
- [x] I2 Front line (client only, decision 138). A line between your ground and the enemy's, from what
      your army knows (units, garrisons, held flags, enemies seen recently), teeth on the
      enemy side, on the minimap and on the zoomed-out map.
- [x] I3 Lethal open ground and squad gunners (rules, new golden hash, decision 145).
      High-explosive direct fire (tank, missile, helicopter, strike drone) bursts among
      enemy men on foot round its target in the open; rubble and sandbags halve it, a
      trench quarters it, walls stop it. Every rifle and paratroop squad has a light
      machine gun: a third more to men on foot from a rest (a window, a ruin, sandbags, a
      trench), and its fire pins infantry caught in the open (half speed, a quarter slower
      fire, three seconds). Measured against `tests/assault.test.ts`, `tools/pointduel.ts`
      and computer army mixes: equal cost in the open still goes to the squads.
      Follow-up (decision 147): the computer on Normal and Hard, and the player's
      commanders, keep their men out of the open under enemy armour and gunships: house to
      house, apart where there is no house, missile teams hunting. `tools/assaults.ts`.
- [x] I4 Formations (decision 148). A Movement button on any selection (comma key) and on
      every commander: Auto, Convoy, Wedge, Line, Vee, Echelon, Block. Auto is a convoy on
      roads and into towns (vehicles in file at a fixed gap, squads on both pavements, the
      first pair ahead of the lead vehicle, a tank closing the file when there are trucks)
      and the army's doctrine in the open (alliance wedge, Russia line, China vee). Any
      shape can be forced, convoy in a field included, and commanders keep the shape they
      are given. The shape is kept on the way, not only at the end.
      Not built yet from the first sketch: a line that turns to face a known enemy, echelon
      chosen by the open flank, infantry first in woods, bounding overwatch near contact,
      herringbone or coil at a halt (a convoy halts in the old block).
- [x] I5 Ground-floor collapse and fire (decision 150). No floor orders. What hits a building
      from far off or from above (shells, rockets, a tank across the square) takes it from
      the top, as before. What hits it at arm's length (a tank within 8 of the wall,
      charges, a vehicle blowing up against it) takes the same health and the ground floor
      too, which is three quarters of it: when the ground floor is gone the building
      pancakes. A ground floor half gone is alight; the fire takes a floor every six
      seconds, turns the garrison out unhurt when it has the whole house, and burns out
      forty seconds later. Fire does no damage. Times to level from range and with charges
      are to the second what they were (`tools/level.ts`); battles cost the city what they
      did (`tools/toll.ts`, eight games before and after).
- [x] I6 Mortars, rooftops, ambush (decision 155). A mortar team for every army (the one
      new kind of unit); a Roof order with reach and top attack on tanks, at the price of
      exposure (Shift + R); an ambush stance that holds fire until a vehicle enters a drawn
      circle (Shift + H, drag).
- [x] I7 Air strikes for the three big armies only, on a long cooldown, each with its own
      flavour (one guided bomb, a stick of bombs, a drone swarm). Today's civilian fine is
      the only penalty (Fabio: the cost today is fine). Decision 154: tier 3 and a standing
      headquarters, 200 supplies / 150 fuel / 250 credits, four minutes between strikes;
      Shift+J; the computer uses them on Normal and Hard.
- [x] I8 The rebels (decision 162). The No faction choice in the menu became the rebel army,
      which gives the game its name: one of the big three has invaded and the country has
      risen. Faction 0 stays as a hidden base table for tests and the golden hash
      (`?army=none`). Cheap, quick fighters, rocket teams, technicals, rocket and gun trucks
      on pickups, hobby and racing drones; no helicopters, paratroops or air strikes. They
      live off the people: hidden among them in any town where people still live, told
      where the enemy is in such a town, joined by volunteers in the towns they hold, a
      quarter faster on foot through any town, and their sappers lay roadside bombs.
      Departed from the first sketch here in two things, both on Fabio's word that they
      "still need to have the same units, in a sense": a few captured tanks, dear and slow
      to come by, and a rocket truck where the others have guns.

## M10 Factions

- [x] Three factions (decision 123): Western alliance, Russia, China. Each is its own
      version of the same kinds of unit (toughness, reach, rate of fire, price, time to
      build, names), lacks one kind, and has its own base coat. Chosen in the Menu or with
      `?army=` and `?foe=`; the computer builds each faction's army to its strengths.
- [ ] Units only one faction has (new models), per-faction buildings and tech, audio

## M11 Polish for v1

- Authored or CC0 models replacing procedural ones, animation. IN PROGRESS 2026-11-20:
  phase 1 BUILT (decision 156): each army's own ground vehicles, written by hand in code,
  and vehicles that lean with the ground and rock on firing. Phase 2 BUILT (decision 158):
  each army's own helmets, packs and rifles, a machine gun and a rocket in every squad,
  mortar and missile teams that serve true-size weapons, stride tied to ground covered.
  Phase 3 BUILT (decision 159): each army's own gunship, lifter, jet, transport and two
  drones, rotors and propellers that turn, aircraft that bank into turns and dip the nose,
  helicopter wrecks of the army that lost them. Models job complete bar Fabio's play test.
  Made cheap 2026-11-21 (decision 161): full detail only under the camera, boxes far off;
  zoomed out the game now draws half the triangles of the build before the new models.
- Menus and settings: BUILT 2026-11-15 (decision 127). The v1 interface: glass HUD with the
  commander board always on screen, main menu, new battle screen, settings, glass lobby and
  end screen. Still to do: save/replay

## Later

- Lockstep multiplayer (the sim is already built for it), lobbies, replays
