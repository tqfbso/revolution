# Urban warfare and the city map: plan

Status: plan only, written 2026-11-12. Nothing here is built. The phases are listed in
`ROADMAP.md` under "Urban warfare". Numbers are starting points to be tuned with a duel
tool, not promises.

Fabio, 2026-11-12: "I'm finding the building very easy to destroy, although it seems to
protect units well. Any chance we could add something like building buildings, or using the
destroyed buildings as a fortress (like what happens in war)? Wondering how close we can get
to urban warfare, working with the scenario as it gets destroyed. I'd also like to see a new
map, way more heavier populated with building, houses, etc. Like a proper urban setting...
streets, bus stops, etc. Lots of details."

## 1. What the game does today, and why it feels thin

Read from the code on main at build 5e7dcd8 (`src/sim/map.ts`, `src/sim/sim.ts`, decision
022).

- A building is one health number: 220 per 4 m cell of floor plan. Houses are 2x2 to 3x3
  cells, so 880 to 1,980 health.
- A tank shell does 60 to a building every 3 seconds, a self-propelled gun 120 every 6. One
  tank flattens a small house in 15 shells, which is 45 seconds. Four tanks do it in 11
  seconds. That is the "very easy to destroy" Fabio sees, and the numbers confirm it.
- A building has two states that matter: standing (garrison takes a quarter of the damage,
  shoots 3 units further, is invisible beyond 13 units until it fires) and rubble (half
  damage, concealed, infantry only, permanent). The 60% "shot up" state is a look, not a
  rule.
- Collapse halves every squad inside. An enemy-held building cannot be entered; the only
  way to take it is to kill the garrison from outside or bring the house down.
- Capacity is one squad per cell, 8 at most. Nothing can be reinforced, repaired or
  connected. Idle infantry can rebuild a cut bridge, and that is the only repair in the game.
- The maps are nearly empty of buildings: 38 on the ridge map, 40 on the river map, on a
  1,024 m square. The table holds 512 structures at most.

The consequence: the correct play against any town is to park tanks and guns outside and
delete it. The town then becomes a slightly worse forest. Destruction ends the urban fight
where in a real war it starts it.

## 2. What real urban combat teaches (the parts worth turning into rules)

Sources are listed in section 9. Confidence is high on the four points below; they are
consistent across the sources and across battles from 1944 to 2017.

1. **The defender has the advantage, and each held building has to be dealt with.** John
   Spencer's "eight rules" (Modern War Institute, 2021) put it as: buildings give the
   defender "immediate military-quality defensive positions", the attacker loses his
   advantage in reconnaissance and long-range fire, he must move down streets where he is
   seen, and every held building must be assaulted and cleared because bypassing it leaves
   the flank open.
2. **Explosive force is the only key, and it is a poor one.** The same article lists three
   ways into a fortified building (demolish it from the air, hit it with explosives, send
   men in) and calls each inadequate. For the game this means no single counter should
   solve a held block.
3. **Ruins are still a fortress.** Third battle of Cassino, 15 March 1944: 435 aircraft
   dropped about 1,000 tons of bombs on the town and 750 guns added to it. The paratroopers
   who held it lost half of one battalion and kept the town centre; Allied tanks struggled
   to operate within the ruins; the attack was called off after a week. Flattening the town
   did not open it.
4. **Unsupported armour dies in streets.** Grozny, winter 1994 to 1995 (Lester Grau, 1997):
   cells of three or four men (a rocket gunner, a machine gunner, a sniper) fired from
   basements and from second and third floors, where tank guns could not elevate or depress
   enough to answer. Five or six cells attacked one vehicle at once, aiming at top, rear and
   sides. Columns were trapped by killing the first and last vehicle. Russia wrote off 225
   armoured vehicles in the first month. The fix was to put infantry in front and advance
   house by house, with armour in support.

Two more points are standard doctrine and well attested, stated here from general knowledge
rather than from a page read tonight (confidence moderate to high): defenders knock holes
through party walls ("mouseholing") so that they move inside a block without ever stepping
into the street, and the defender keeps freedom of movement inside the city while the
attacker cannot concentrate.

## 3. What other games do

- **Company of Heroes** (from play knowledge plus one secondary write-up): garrisoned
  squads are protected but not safe. Each window lets one man fire, so a blank wall is a
  blind side that can be approached; attacking from two sides splits the defenders' fire.
  Explosives open new holes. Grenades and flamethrowers clear rooms. Brick protects better
  than wood. The lesson: **direction matters**, and it is cheap to model.
- **Wargame and WARNO** (Eugen): towns are divided into sectors. Infantry occupies a sector,
  is hidden from reconnaissance and fights whoever enters it; expensive vehicles die in
  town as easily as cheap ones; attackers isolate the town, smoke the edge sector, enter
  from the side, and send waves. The lesson: **at large unit counts the block, not the
  room, is the right unit of fighting.**
- **Close Combat** (Fabio's own reference, already behind decision 022): multi-storey
  buildings, men moving room to room, morale. The lesson: the house-to-house fight is
  infantry against infantry at point-blank range, and the game needs a way for that to
  happen at all.
- **Men of War**: every wall is physical and every shell leaves a real hole. Beautiful and
  far too expensive for 3,000 units in a browser; rejected as a model.

## 4. Design

One sentence: **a building stops being a health bar and becomes a position that degrades
through four states, each of which is still worth holding; shelling changes the city
instead of removing it; and the only way to truly take a block is to send infantry in.**

### 4.1 Four states instead of one collapse

| State          | How it gets there   | Garrison protection                 | Height and sight                         | Vehicles                                                      |
| -------------- | ------------------- | ----------------------------------- | ---------------------------------------- | ------------------------------------------------------------- |
| Intact         | start               | takes 25% of damage (as today)      | full: upper floors see and shoot further | blocked                                                       |
| Damaged        | structure below 70% | takes 35%                           | full                                     | blocked                                                       |
| Gutted (shell) | structure below 35% | takes 45%                           | ground floor only; no height bonus       | blocked                                                       |
| Ruin           | structure at zero   | takes 50%, or 35% once dug in (4.3) | none; concealed like forest              | blocked; tracks may cross slowly after engineers clear a lane |

A ruin cannot be damaged further. That single rule is what makes rubble a fortress: once a
block is flat, artillery has nothing left to take away, and the men in it have to be dug
out by infantry.

Collapse casualties stay (the house falls on its garrison), but spread over the two last
steps: a squad loses a quarter of its strength when a building is gutted and a quarter
when it becomes a ruin, instead of half at once.

### 4.2 Much tougher, and two kinds of damage

- Three building classes with their own structure: house (brick or timber, 2 to 3 floors,
  450 per cell), apartment or office block (concrete, 4 to 8 floors, 900 per cell),
  industrial and public (hall, station, town hall, 1,300 per cell). Today everything is 220.
- **Wall damage** (new): each building keeps a strength for each of its four faces.
  Direct fire (tank guns, vehicle cannon, rockets) mostly breaks the face it hits and does
  only a quarter of its damage to the structure. A broken face gives the garrison no extra
  protection against fire from that side (it is treated as one state worse), and it is an
  entrance for an assault (4.5).
- **Structural damage**: artillery, demolition charges and aircraft do full damage to the
  structure. A tank alone now takes about four minutes to gut a house and cannot
  realistically flatten an apartment block; a battery of guns still can, at a cost in time
  and shells, and what it gets is a ruin that still has to be assaulted.

Result for play: tanks become what they are in a real city, a tool that opens walls for
the infantry, and stop being a town eraser. This sits squarely on the army mix pillar
(tank spam must not win, decision 067).

### 4.3 Fortify, repair, barricade ("building buildings")

Free-form construction of new houses in a battle is rejected: it is not what happens in a
war, it would break the mirror symmetry of maps, and it would let a player wall off
streets with indestructible architecture. What does happen in war, and goes in:

- **Fortify** (infantry inside, 40 seconds; engineers 15): sandbagged windows and
  loopholes. Adds a third to the structure, takes one more step off incoming damage, raises
  capacity by half. Shown on the building. Works on every state including ruins; a
  fortified ruin is the "strongpoint" row in the table above.
- **Repair** (engineers or trucks, costs supplies): damaged back to intact, gutted back to
  damaged. A ruin cannot be rebuilt as a house, only fortified.
- **Barricade** (engineers, on a street cell next to a building or ruin): a field work in
  the M8 system made of rubble and wrecked cars. Stops vehicles, gives infantry cover.
  Breached like a wall.
- **Rooftop post** (any squad in a building of 4 floors or more): a recon-grade view over
  lower roofs. Lost when the building is gutted.
- The existing works (wire, tank obstacles, sandbags, trenches) become placeable on
  streets and squares, which decision 057's notes listed as missing.

### 4.4 Blocks and mouseholes

- Buildings that share a wall are **linked** at map generation (a small neighbour table
  per structure).
- A garrison ordered into a linked neighbour moves through the wall: it never appears
  outside and cannot be shot on the way. Opening a link costs a squad 20 seconds once
  (engineers 8), and both sides can use an open link.
- A **block** is a group of linked buildings. "Garrison this block" spreads the selected
  squads across it, and the AI thinks in blocks. This is the Wargame sector, built out of
  individual houses, so the charm of single buildings stays.
- Effect: a held block is one position whose defenders shift to the threatened face
  unseen, and an attacker who takes the corner house can roll up the row from inside
  instead of crossing the street again.

### 4.5 Storming

- Right click an enemy-held building with infantry: **assault**. The squads close in, and
  those that reach a face fight the garrison at point-blank range.
- The defender fights at 2 to 1. The odds even out through a broken face (4.2), through an
  open mousehole from a house the attacker already holds, when the defenders are under
  smoke or were just shelled (a short "shaken" timer), or when the attackers are
  engineers.
- The loser of a round is pushed into a linked building if he holds one, otherwise out of
  the back. The building changes hands without being destroyed.
- This is the missing verb. Today a town can only be erased; after this it can be taken.

### 4.6 Height, snipers and tanks in streets

- **Top attack.** Rockets and missiles fired from a garrison at a vehicle within 30 m hit
  its weakest armour whatever way it faces, and a tank cannot return fire at a garrison
  closer than 10 m (gun elevation). Extends the existing close-range rocket rule. A tank
  in a street without infantry checking the houses is a kill, as at Grozny.
- **Marksman team** (new unit, two men): long range against infantry, nearly invisible in
  a building, pins the squad it hits for a few seconds (slowed, firing less). Dies to
  anything that finds it. Countered by drones, smoke and by storming the building.
- **Streets are fire lanes.** Line of sight already stops at buildings (decision 023), so a
  straight avenue gives a tank or machine gun a 200 m shot and a side street gives none.
  No new rule; the map makes it matter.
- **Drones.** Recon drones see streets and roofs but never into a building. Strike drones
  get a bonus against garrisons in damaged and gutted buildings (they fly in through the
  holes) and none against intact ones.

### 4.7 The city changes as it is destroyed

- **Rubble spill.** When a building of 4 floors or more becomes a ruin, rubble covers the
  street cells along its faces: wheeled vehicles blocked, tracked vehicles at a quarter
  speed, cover for infantry. Shelling a block shuts the streets beside it, including for
  the side that fired.
- **Clearing.** Engineers clear a spill cell in about 20 seconds. Routes through the city
  are therefore something both sides open and close during the game, which is the
  "multiple routes that create surprises" pillar in a form no fixed map layout can give.
- **Fires and smoke.** A gutted building burns for a few minutes and its smoke blocks
  sight across the street downwind, using the smoke system from M5.
- **Persistent look.** Damage states, spill, scorch marks and smoke columns stay for the
  whole game. A district fought over for ten minutes must look like it.

### 4.8 Left out on purpose

- Rooms and floors as separate fighting spaces (Close Combat, Men of War). At 3,000 units
  the block with four faces gives most of the tactics for a fraction of the cost.
- Civilians. No gore is an agreed rule and they add nothing to the fight.
- Tunnels and sewers. Real and important (Spencer's rule 7), but invisible movement needs
  its own interface. Revisit after the rest is played.
- Building new houses, as argued in 4.3.

## 5. The city map

Working name "Metropolis" (third map on the Map menu; the ridge stays the default until
this one is tuned).

### 5.1 Layout

Same 1,024 m square and the same mirror symmetry across the diagonal as the ridge map, so
the AI's assumptions about mirrored pairs hold.

- **Corners: the two bases**, each in an industrial edge with open yards (base buildings
  need free ground) and a freight depot as the first supply site.
- **Outer ring: suburbs.** Detached houses on garden plots, hedges and garden walls,
  curving streets, a petrol station (fuel site), a school, a supermarket with a car park.
  Good tank ground compared with the centre; the war of movement happens here.
- **Middle ring: mid-rise blocks.** A street grid of perimeter blocks (four to ten linked
  buildings round a courtyard), 4 to 6 floors, shops at street level. Streets 12 m, two
  boulevards 20 m, alleys 4 m for infantry only.
- **Centre: the prize.** A square with the town hall, a railway station with a yard of
  wagons, a park, and three or four tall buildings that overlook everything until they
  are gutted.
- **No single chokepoint.** Two boulevards, a ring road, the rail yard, the park and a
  dozen side streets all lead across. Any of them can be shut by rubble or a barricade
  and reopened by engineers.
- **Districts.** 10 to 12 capture districts instead of 7 (the town table grows from 8 to
  16), each paying credits. Supplies and fuel sit in yards, depots and petrol stations.

### 5.2 Size

Rough count, to be confirmed by the generator: 600 to 800 buildings (20 times today),
around 100 blocks, 6,000 to 10,000 props. The structure table grows from 512 to 1,024 or
2,048; the per-cell index is already 16 bits wide, so that is a constant, not a redesign.

### 5.3 Props ("lots of details")

Two classes, and the split is what keeps this affordable:

- **Props that play** (in the sim, a few new cell types): garden walls and hedges, rows of
  parked cars and buses as light cover that tanks crush, wagons and containers that block
  sight, underpasses. Few kinds, cheap rules.
- **Props that dress** (client only, generated from the seed, like the craters of decision
  031): street lamps, traffic lights, bus stops, benches, bins, signs, billboards, kiosks,
  fences, bollards, awnings, overhead wires, playgrounds, a fountain, road markings,
  manhole covers, puddles, street trees. They react to the battle (knocked flat by a blast
  or a tank, buried by a spill, lit by fires) but never affect it, so they cannot break
  determinism or multiplayer.

### 5.4 Performance budget

Fabio's measured baseline is about 60 fps at 3,000 units and low 40s at about 4,000 in
battle on the open maps. A city adds static geometry and takes units away from view (they
are inside), so the target is: **Metropolis at 2,500 units, normal graphics, no worse than
the ridge map at 3,000.** None of this can be measured in the cloud (no graphics card), so
each line below needs Fabio's overlay numbers before it is believed.

| Item                       | Today                                                                          | Budget for the city                                                                  |
| -------------------------- | ------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------ |
| Building draw calls        | one mesh per building (38)                                                     | one merged mesh per block and state, 150 at most in view                             |
| Building triangles in view | small                                                                          | 1.5 million on normal, half on low                                                   |
| Props                      | none                                                                           | one instanced batch per kind, 25 kinds at most, 10,000 instances, culled by distance |
| Shadows                    | every building                                                                 | buildings always; props only within about 80 m                                       |
| Far detail                 | full                                                                           | beyond about 400 m a block is a box with its facade painted on                       |
| Sim tick                   | about 4 ms at 3,000 units                                                      | under 8 ms; the 50 ms budget is not at risk                                          |
| Map change (a collapse)    | rebuilds all passability, drops every flowfield, "a handful of times per game" | hundreds of times per game: must become local and batched once per second            |
| Fog of war rays            | open ground                                                                    | many more blockers; measure before committing                                        |

### 5.5 Technical risks, in order

1. **Thousands of units in 12 m streets.** Flowfields move crowds well on open ground and
   may jam in corridors three cells wide. Formations have to fold into columns. This is
   the first thing to prototype, before any art, because it decides street widths.
2. **Map changes at city frequency.** The full passability rebuild per collapse (decision 021) was a sound shortcut for 38 buildings and is not for 800.
3. **Renderer load when zoomed in.** Decision 068 already found fill and shadows to be the
   cost up close; a street canyon is the worst case for both.
4. **The AI.** It garrisons houses facing a crossing and shells houses before going in. It
   knows nothing of blocks, storming, street routes or keeping tanks out of canyons. A city
   map with the current AI would be a shooting gallery.
5. **Readability.** Units hidden behind 6-floor blocks at the default camera angle. Needs
   roof fade or outlines through walls for the player's own units.

## 6. Phases

Weights follow the usual scale (light, medium, heavy). Models follow the agreed split:
Fable 5.2 for core systems, Sonnet 5.5 for features, interface and balance.

| Phase                        | What Fabio gets                                                                                                                                                                                       | Weight | Model                                                                                                            |
| ---------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ | ---------------------------------------------------------------------------------------------------------------- |
| U1 Buildings that die slowly | Four states, building classes, wall and structural damage, ruins that cannot be destroyed further, staged collapse losses, damage looks. On the existing maps. Directly answers "too easy to destroy" | Medium | Sonnet 5.5 (the rules sit in code paths that exist); Fable 5.2 only if the per-face line of sight proves awkward |
| U2 Hold and take a block     | Fortify, repair, barricades, linked buildings and mouseholes, "garrison this block", storming                                                                                                         | Heavy  | Fable 5.2 for storming and links; Sonnet 5.5 for commands and the command card                                   |
| U3 Streets                   | Street and alley terrain, column movement in corridors, local map updates, rubble spill and clearing, a grey-box city generator with districts and sites. Playable but ugly                           | Heavy  | Fable 5.2                                                                                                        |
| U4 The city's look           | Block meshes per state, the prop kit, far-distance facades, roof fade, fires and dust, performance work against the budget                                                                            | Heavy  | Fable 5.2 for the renderer structure; Sonnet 5.5 for the prop kit                                                |
| U5 Urban AI and urban units  | AI that holds blocks, fortifies, storms, routes by street, keeps armour out of unscreened streets; marksman team; top attack; drone rules                                                             | Heavy  | Fable 5.2                                                                                                        |
| U6 Tuning after play         | Numbers, from Fabio's games                                                                                                                                                                           | Light  | Sonnet 5.5                                                                                                       |

Status 2026-11-13: U1 built (decision 074). Of U2, storming is built (decision 085); of U3,
the city generator and its streets are built and the city is the default map (decision
086). The rest of both phases is open.

U1 is independent and small enough to go next. U2 needs U1. U3 needs neither and can run
beside U2. U4 needs U3. U5 needs U2 and U3.

## 7. Where this sits against the roadmap

The roadmap's next items are M10 Factions and M11 Polish. Recommendation: **U1 next, then
U2 to U5 before Factions.** Reason, the same as decision 059 for the look: factions triple
the roster, and a roster designed before the urban rules exist would have to be redesigned
around them (each faction should have its own answer to a held block). Cities as
fortresses is also the first fun pillar Fabio named, and it is the least finished one.
The cost is that three factions arrive about five heavy phases later. This is Fabio's
call; nothing is renumbered until he makes it.

## 8. Questions for Fabio

1. Order: urban warfare before factions (recommended), or factions first with only U1
   pulled forward?
2. Storming changes the feel most: towns become takeable intact. Agreed?
3. The city map as a third map, or should it become the default once it is good?
4. Marksman teams: wanted, or is the roster large enough until the factions?

## 9. Sources

- John Spencer, "The Eight Rules of Urban Warfare and Why We Must Work to Change Them",
  Modern War Institute at West Point, 12 January 2021.
  https://mwi.westpoint.edu/the-eight-rules-of-urban-warfare-and-why-we-must-work-to-change-them/
  (rules 1 to 5 read in full; 6 to 8 from a summary)
- Lester W. Grau, "Russian-Manufactured Armored Vehicle Vulnerability in Urban Combat: The
  Chechnya Experience", Red Thrust Star, January 1997.
  https://www.globalsecurity.org/military/library/report/1997/rusav.htm
- J. Rickard, "Third battle of Cassino, 15-22 March 1944", historyofwar.org, 2018.
  https://www.historyofwar.org/articles/battles_cassino_3rd.html
- "Wargame AirLand Battle: Urban fights", gamepressure.com (fan guide, 2016).
  https://www.gamepressure.com/wargameairland/urban-fights/z35842
- "Take Some Cover! Garrisons in RTS games, Part Two", Deadly Danger Dungeon (blog, 2011).
  https://deadlydangerdungeon.blogspot.com/2011/05/take-some-cover-garrisonable-buildings_18.html
- Not checked against a source tonight and stated from general knowledge: WARNO's own
  rules, Men of War's destruction model, mouseholing as doctrine.
