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

## 027 Armour has a front, and a missile team is the unit that makes that matter

Vehicles carry a hull direction in the sim. It follows the direction of travel, and a
standing vehicle swings it toward what it is shooting at (a tank needs about a second and a
half for a quarter turn). A hit within 60 degrees of the nose meets the front plate, within
60 of the tail the rear, anything else the side. A tank lets through 70% from the front,
115% from the side, 180% from behind; the carrier 100, 120, 150. So tank against tank head
on takes six hits instead of four, and from behind three. The missile team is built around
this: three men, 34 range against the tank gun's 26, a missile every seven seconds doing 150. Three missiles into the front, two into the side, one into the engine deck. It cannot
hurt infantry at all, which is its weakness and the reason it needs riflemen around it.
Because a lone tank turns to face its attacker, flanking only pays when the target is
already busy with something else: that is the combined-arms rule the milestone is after.
Missiles are still instant hits; a missile with flight time that smoke or a kill on the
team can defeat is a later refinement. Rejected: a separate turret direction in the sim
(the turret is presentation only; only the hull decides armour).

## 028 Carriers: two squads a vehicle, mount on order, dismount on contact

The infantry fighting vehicle moves at 0.4 against the squad's 0.16, carries two squads
(rifle or missile teams) and has an autocannon that is the best infantry killer in the
game and nearly useless against a tank. A carried squad is out of play: it cannot be
seen, shot or ordered, and does not shoot. Mounting: right click a carrier, or select
squads and carriers together and press L, and each squad walks to the nearest carrier
with a free seat while the carriers wait. Dismounting: U, or by itself when a carrier that
is free to fight (idle or on an attack-move) has an enemy in range; the squads then take
over the carrier's attack-move on foot. Under a plain move order (Alt + right click) the
carrier keeps its squads aboard and drives through. If the carrier is killed loaded, each
squad aboard loses half its strength. Two squads per vehicle is a game number, not a real
one: with one squad per vehicle a mechanised army would need as many carriers as squads
and the screen would be all vehicles.

## 029 Artillery kills what stands still and is soft; it only suppresses armour

The self-propelled gun reaches 110 units (a tank gun 26), cannot hit anything closer than
25, and fires a shell every six seconds. A shell flies for 1.5 seconds plus one per 40
units, lands within 1.5 units plus 1/32 of the range of where it was aimed, and hurts
everything within 5 units, friend or foe, half as much at the rim as in the middle. Against
armour the radius is a third of that: splinters do nothing to a tank, a near-direct hit
does 50. The first balance run had shells doing blast damage to tanks and a battery wiped
out a tank regiment queuing at a crossing in a minute; real artillery does not do that and
it made every other weapon pointless. Walls keep three quarters off a garrison, but a
shell landing on a building does twice the damage of a tank round to the building itself,
so guns are the second answer to a held town (decision 022) and they can cut bridges.
Guns fire standing still, never chase, and have two modes: by themselves at spotted
targets (other guns first, then what is not moving, then the nearest; never at a target
with friendly troops within 9 units), or on order at a point on the ground or a building
(Ctrl + right click), seen or not, until told to stop. On order there is no safety check:
shelling your own men is possible. Shells in flight are part of the sim state.

## 030 Being seen is a state of the unit, and firing a gun sets it

Indirect fire needed the sim to know what an army has located, not just what each unit is
aiming at. Every unit carries `spotted`: the tick until which its enemies know where it
is. It is set for 1.5 seconds whenever an enemy unit has it as a target in sight, and for
12 seconds on a gun each time it fires (sound ranging and radar, abstracted). That second
rule is counter-battery: a battery that fires is shelled by every enemy gun in range
within seconds unless it moves, and one that moved is lost again after 12 seconds. The
client draws spotted enemies through the fog. One value per unit, not one per pair of
armies: in a three-way game what one enemy spots the other also knows. Accepted for now;
a per-army bit mask is the fix if three-way games become real. Recon units and drones
(next part) only have to set the same state.

## 031 Craters and burn marks stay for the whole game, on the client only

Each shell leaves a crater and each destroyed vehicle a scorched patch: soft-edged discs
in one instanced draw call, 4000 of them, oldest reused. They are presentation: no cover
and no movement cost in the sim. Shell holes as infantry cover would be right for the
setting but costs a terrain rewrite per shell; it can come back with the polish milestone.

## 032 Units see less than they can shoot at; recon is what closes the gap

Until now every unit noticed enemies at 44 units. Now each type has its own sight: tank
30, carrier 32, rifle squad 36, missile team 38, gun 26, air defence 44, recon team 75,
recon drone 55. A unit engages what it sees itself, or what the army has spotted (decision 030) within 44 units and in its line of fire. Concealment used to be absolute beyond 13
units; now a concealed unit that someone has spotted can be shot by everyone who has a
line to it. That is the job of the recon team: two unarmed men who see 75 units, find
hidden troops from 24 instead of 13, and are themselves concealed everywhere, as if always
in cover. A missile team in a wood is safe from a tank at 20 units until a recon team
looks at it. Sensors (recon teams and drones) report everything in view twice a second;
other units only report their own target, and only if they see it with their own eyes, so
a unit kept alive in the reports only by other shooters drops out when the spotter dies.
The fog of war on the client now uses the same sight per type. Cost: the scan has two
more rejections per candidate; the battle tick went from 15.7 to 16.9 ms at 10000 units.

## 033 Drones, and the two things that stop them

Drones are units of a third movement class, air: they fly straight over water, forest
and houses, are seen by and see everything in range without a line of sight (forest and
buildings still conceal what is in them), do not collide with ground units, do not hold
towns and are not hurt by shells. The recon drone (sight 55, unarmed) is the eye the guns
need behind a town. The strike drone flies into the nearest vehicle or gun it knows about
(men only if there is nothing else), does 170 to a tank regardless of facing, and is gone.
Tanks, missile teams and guns cannot touch a drone; rifle squads and carriers do a little;
the air-defence vehicle (range 40, a hit every 0.6 seconds, a strike drone dies to one) is
the real answer and is useless against everything else. A swarm bigger than what the air
defence can shoot on the way in gets through: that is intended.

The jammer is the second answer and the signature piece. Every enemy drone within 45
units of it has no link: a recon drone reports nothing (and on the client lifts no fog), a
strike drone loses its target and one of its 12 health every 0.15 seconds, so it crashes
after about 29 units of flight, short of the middle of the bubble. The bubble is drawn on
the ground, amber for yours and red for the enemy's, and jammed drones flicker. The price:
a jammer that is actually jamming something is located by its own emissions for five
seconds each time (it becomes spotted), so guns can shell it. The loop this makes: drones
find and kill; air defence and jammers stop drones; the jammer shows itself by working;
guns kill the jammer; firing shows the guns. Rejected: jamming as a toggle the player
manages (one more button, and the trade-off is already there in where the vehicle stands).

## 034 Smoke belongs to the guns, and blinds both sides

Smoke is how an attacker crosses open ground under missile teams, and without it the
ford and the town are a shooting gallery for whoever sits still. It is a shell type for
the artillery (F: one smoke shell per selected gun at the pointer), not a button on every
tank: that keeps it a planned act with a flight time, gives the guns a second job, and a
battery lays a wall while a single gun lays a puff. A shell fills the cells within two
cells of where it lands for 30 seconds. More than one cell of smoke stops every line of
sight, for both sides, and whatever stands in smoke cannot be seen from outside it at
all, drones overhead included, so it is also the cheap answer to being watched from the
air. Shells and jamming ignore it. Smoke cells are sim state (in the map, with a list in
the world for the hash). Rejected: smoke that only hides its owner (not how smoke works,
and no decision in it), and vehicle smoke launchers (a panic button per unit, for M9 if
at all).

Hold position (H) is the one stance in M5: the unit shoots what comes into range and
never leaves its spot to chase. It is what missile teams in a wood and tanks behind a
crest need, and it ends with the next move order. Other stances and a priority UI wait
for the command card in M6; target priority itself is automatic (decision 032's table).

## 035 Three resources with three different shapes

Fabio's reference for the economy is Age of Empires 2: many workers, and the choice of
where to put them. A single harvester and one resource would not give that. So there are
three resources, and each grows in a different way, so that each asks a different question.
Supplies sit in stockpiles on the map; a truck takes 20 a trip (five seconds to load), so income grows with the
number of trucks and the shortness of the drive, and a stockpile runs out (8000 by the
headquarters, 12000 a long drive north and south, 16000 behind each settlement on your
bank, 88000 a side in all, about one full army). Fuel comes from wells that pump three a
second into a small tank: more trucks on a well bring nothing once it is drained, so fuel
grows only with the number of wells held, and tanks cost fuel. Credits come from towns
(decision 024), and pay for technology and the clever units. The result: trucks decide how
fast you build, wells decide how much armour, towns decide how modern, and the rich sites
are where the fighting is. Rejected: one resource (no allocation decision), and four or
more (bookkeeping without a new question).

First numbers, from a scripted opening on the real map: a truck on a stockpile next to the
base brings about 1.8 supplies a second, so a rifle squad costs one truck half a minute.
The first version (40 a trip, three seconds to load) stripped both home stockpiles in
eight minutes with 14 trucks and left nothing to decide. A town now pays 3 credits a
second instead of the 10 of decision 024, which was set when credits bought nothing: at
10, one town paid for the second tier in thirty seconds.

## 036 One truck hauls and builds

The logistics truck is the villager: it hauls from a site to the nearest depot or
headquarters and back until told otherwise, and it puts up and repairs base buildings.
One type, so every truck sent to build is a truck not hauling, which is the allocation
decision in its smallest form. It is unarmed and dies to anything, so raiding the trucks
is a way to win. A truck whose stockpile runs out drives on to the next one within 160
units by itself; one with nothing left to do stops, and the resource bar counts idle
trucks. Up to five trucks work on a building at once.

## 037 Buildings are paid for at once and keep a ring of free ground

Five buildings: headquarters (trucks, technology, unloading), supply depot (unloading,
room for 40 more units), barracks, motor pool, drone workshop. The price is taken when the
plot is chosen, as in Age of Empires, so money cannot be spent twice. A plot needs open,
nearly level ground and one free cell all around it. That ring is a rule with a purpose:
buildings can never touch each other or the terrain, so they can never close a ford or wall
the map in two (the pathfinder treats cut-off ground as impassable, which would be a
disaster), and units always have a way around. It also rules out walls as a defence;
defence is garrisons, terrain and guns. A unit standing on a new plot is moved off it. A
destroyed building leaves rubble, like a house (decision 022).

## 038 The unit limit comes from depots, 600 at most

A headquarters lets an army field 60 units, each depot 40 more, up to 600: three times an
Age of Empires population, which is the size of battle the game is built for. Depots are
cheap; the point is that they are targets. An army that loses its depots keeps its units
but cannot replace losses. (Superseded by 067: units now count in army points.) One unit counts as one, whatever it is: prices already tell a
tank from a rifle squad.

## 039 Technology is bought with credits, so territory pays for it

Tier 1: rifle squads, recon teams, carriers, trucks. Tier 2 (400 supplies, 300 credits,
40 seconds): tanks, missile teams, air defence, recon drones, the drone workshop, further
headquarters. Tier 3 (800 supplies, 200 fuel, 800 credits, 60 seconds): guns, strike
drones, jammers. Credits only come from towns, so an army that holds no town stays at
tier 1 however many trucks it has. That ties the technology race to the towns, which is
where the roadmap wanted the economy to push the fighting.

## 040 Hold fire is a stance; the priority screen is dropped

Hold position (decision 034) stays an order that the next move ends. Hold fire is a
stance: it stays until lifted (G, or the card), and a unit under it never picks a target
by itself, though it still obeys an order to shell a point or a building. It is for
missile teams waiting in ambush and for recon that should not be given away by its
escort. A screen for target priorities was planned and is dropped: the built-in priorities
(decision 032) have not been wrong often enough in play to justify a screen per unit type.

## 041 The opening is a skirmish against a fortress

The default scenario gives both armies a base. Red has a headquarters, six trucks, twelve
rifle squads, four carriers and two recon teams; blue holds its three settlements with a
fifth of `?units` (600 by default), dug in as in the assault, behind them a small base.
Blue still has no commander, so it neither builds nor attacks: until the AI milestone the
game is "build the army that cracks the east bank", with no clock. A headquarters that
falls ends the game for its owner (a banner, nothing more yet). `?scenario=assault` keeps
the old opening.

## 042 The client rebuilds base buildings in its own copy of the map

The client has always derived the map from the seed instead of receiving it. Base
buildings are the first structures that appear during play, so every snapshot lists them
and the client adds each to its copy in the order the sim created it; ids, picking, the
fog and the minimap then agree with no second code path. The price: the client's map can
no longer be rewound, so Reset reloads the page.

## 043 Right click moves or attacks; attack-move is C then click

Fabio, 2026-11-11: units could not be told to attack a unit, and once they met the enemy
they could not be pulled out, because the default right click was an attack-move that
stops to fight whatever it meets. Now a right click on the ground is a plain move (units
still fire on the way, they just keep going, so a fight can always be broken off), and a
right click on a visible enemy unit is a new attack order: the units chase that unit,
shoot it, and the order ends when it dies or is lost (followed up to three times further
than the nearest enemy is looked for; the click itself tells the army where it is). Guns
shell the spot the enemy stands on instead, units that cannot hurt it just move there.
Attack-move is C then left click, or Alt + right click. Same for the minimap: right click
moves, Alt + right click attack-moves.

River check, same day: ground units cannot end up on water, cliff or buildings in any
scenario we run (tests/orders.test.ts keeps watch); the only ways across are the fords and
the bridges. Drones fly over by design. Fabio's screenshots then showed tanks and recon
sitting in what looked like deep river: the fords were wide and below the water surface.
See decision 044.

The attack-move key is C, not A: A pans the camera left, and a stuck armed state turned
later left clicks into move orders.

## 044 Fords are shallow strips

At a ford the river bed now rises just above the water surface (and cells deeper than
0.6 units are water), so a ford is a narrower muddy strip that reads as crossable ground,
not as river with units wading in it. Every seed still has crossings for vehicles and
foot, with or without the bridges.

## 044 The AI is a player outside the simulation

The opponent lives in `src/sim/ai.ts` but is not part of `step()`. Once a tick the worker
asks it for commands and puts them on the same list as the player's; the sim cannot tell
the two apart. Three things follow. It can do nothing a human cannot (no spawning, no
free resources, no orders to units it does not own: a test checks this). Its state is not
in the world hash and does not need to be: it is a pure function of the worlds it has
seen, integer-only with its own random numbers, so in lockstep multiplayer every client
runs it and gets the same commands. And it can be swapped, run twice (`?demo=1`), or left
out (`?ai=off`) without touching the sim. Supersedes the "nobody commands blue" part of
decision 041.

## 045 The AI sees what its units see

It knows the map, including where both armies set up (so does anyone who has played
once). Of the enemy it knows only units the sim marks as spotted, and units standing
unconcealed right next to its own; garrisons, troops in forest and recon teams stay
hidden from it exactly as from the player. What it saw it remembers per 16-unit square,
fading over minutes, and where it has not looked for three minutes it assumes a defence
that grows with the clock. So scouting pays for it as for a human: a town it has seen
empty is attacked early, one it has not seen is treated with respect. Difficulty changes
tempo and judgement (how many trucks, how sure it wants to be before it attacks, whether
it raids, whether it builds against what it saw), never its information or its income.

## 046 The AI's army thinks in objectives, crossings and strong points

Military units belong to town garrisons, scouts, a reserve, or one of two forces (the
field army and a raiding party). A force has an objective (a town, an outlying depot, the
enemy base) chosen by value against expected resistance, and a route to it: on the far
bank it weighs every crossing by distance, by the enemy known to stand behind it and by
whether a held settlement bars it, so a defended bridge town is turned by a ford unless
the town itself is the objective. It moves from way point to way point and waits for its
line to close up, so it arrives as an army. At the objective it reduces strong points
first: tanks and guns shell the houses known to be held, then the infantry goes in and
stays as the garrison. A beaten force remembers the strength that was not enough and
does not try that objective again with less. The strong-point list is the hook for
fortifications (M8): walls and trenches go on the same list and the rest already works.

## 047 An even start replaces the fortress opening

Both armies now start with a headquarters, six trucks, twelve rifle squads, four carriers
and two recon teams, and no town belongs to anyone. The fortress of decision 041 was a
stand-in for an opponent; with one, a prebuilt garrison of 600 on top of a growing
economy would decide the game before it starts. The AI builds its fortress itself:
its first infantry goes into the houses of its three settlements, which also takes them.
`?scenario=assault` keeps the attack on a held bank.

## 048 Units shell enemy base buildings unasked

A unit with siege damage and no enemy unit to shoot at fires on the nearest enemy base
building it can reach and see. Before this a base was only shelled on an explicit order,
so an attack-move into an undefended base stood among the buildings and did nothing.
Town houses and bridges still need an order: they belong to nobody, and levelling them is
a decision. Hold fire suppresses it like any other fire.

## 049 First balance pass: every unit has something it beats and something it fears

With both sides paying prices, equal money was matched head to head in
`tools/matchups.ts`. Before the pass rifle squads beat tanks for the same money and
nothing punished a pure infantry army. Changed: tank shells do more to infantry and
light vehicles; rifle fire does less to armour; carriers are sturdier and better against
men on foot; missiles hit harder; a rifle squad costs 80 supplies (was 60), a missile
team 110 and 20 credits. Result for equal money: tanks beat rifles and carriers,
missile teams beat tanks and carriers, rifles beat missile teams, carriers beat rifles.
Houses still turn this over for infantry, which is the point of a town. Pacing of a
whole game is still a guess until Fabio has played against the AI.

## 050 The AI looks at the far bank before it crosses, and reinforces a fight

The field army checks what it knows of the far side when it reaches a crossing: if the
enemy there is more than it can take it tries another crossing once, then goes home.
An enemy-held town is assumed to hide a garrison that grows with the length of the
game, so the AI stops throwing its first platoon at houses it cannot see into. New units
join an army that is already fighting instead of waiting for the next attack, and an
army that is winning its fight does not break off because of losses on the way.

## 051 An enemy base building is unknown until you see it

The client draws an enemy base building, marks it on the minimap and lets you click it
only once one of your units has seen any part of it; after that you keep seeing what
happens to it, as with town houses. The sim is unchanged and so is the AI, which was
already bound to what its units see (decision 045). Scouting now has a purpose for the
player too. `?control=all` and `?demo=1` show everything.

## 052 A recruit level, and easy is the default

Fabio's first game against the AI (2026-11-12): it works, and it is hard to beat. A new
lowest level, recruit, runs a third of normal's economy, never keeps more than 70 units,
leaves you alone for 22 minutes and attacks only with three times what it expects to
meet. Against a player who does nothing it takes the towns but not the base. Easy was softened a little
(fewer trucks and factories, at most 140 units, first attack at 17 minutes) and is now what the game opens
on; normal is one click away. The levels still differ only in tempo and judgement.

## 053 Field works are cells, not structures

A wall, a gate, a run of wire, a tank obstacle, a trench or a sandbag position takes one
map cell and lives in the world per cell. Structures are rectangles fixed with the map,
there are at most a few hundred of them and each one is a target with a garrison; a
player who rings a town needs hundreds of small pieces placed anywhere. The player drags
a line and gets one work per cell, joined edge to edge so a diagonal wall does not leak.
A work is paid for when ordered (refunded in full if taken down before it is built) and
has no effect until its builders finish it.

## 054 A work in the way is expensive, not impassable

Passability tables keep the rule that everything a unit may stand on is one connected
area. A sealed wall would break that rule and strand every order across it. So for
pathfinding a work that blocks a class is a cell of very high cost: a route never crosses
one while any way round exists on the whole map, and when none exists the route leads to
the wall. There the unit breaches if its weapon can and waits if not, with its order
kept, so the squad behind a tank follows it through the hole. Short chases after a
target never cross works.

## 055 Passability per army, because of gates

A gate is a wall to everyone but its owner. Passability and flowfields are therefore
looked up by layer (army and movement class). While no gate stands anywhere all armies
share the same tables and the same flowfields, so the common case costs what it did; the
first gate splits the tables (6 ms to rebuild instead of 2.5).

## 056 What stops what, and what opens it

Walls and gates stop everything and block sight at ground level (not from a hill, not
for drones). Wire stops men of every army, its owner's too; armoured vehicles crush the
enemy's by driving over it. Tank obstacles stop vehicles only. Trenches and sandbags
stop nothing: a squad in one takes a third of the damage from direct fire and less from
shells, and a trench hides it as a wood does. Tank guns and shells bring down walls and
wire; obstacles shrug off most of both and need the engineer's charge, which is also the
fastest way through a wall. A trench cannot be destroyed. Engineers are a Barracks unit
from the first tier, weak in a firefight, so breaching has to be covered.

## 057 The AI's belts have gaps

The AI fortifies with belts, not rings: wire with tank obstacles behind it across the
enemy's approach to a town it holds, a two-cell gap every seven cells, sandbags behind
the gaps. Gaps keep its own army and trucks moving without gates, cannot shut it in, and
are what real obstacle belts are for: they do not stop an attack, they decide where it
comes through. A human can build a sealed ring with gates; the AI gets through one by
breaching. No minefields in this milestone: an invisible killer needs detection and
clearing rules first.

## 058 A slower game by longer fights, not slower units

Fabio, 2026-11-12: the game felt too quick to plan fortifications. Movement and the economy
stay as they are; what changes is how fast things die and how soon fights begin.

- Ground units have 5/3 the health (`TOUGHNESS_NUM/DEN` in units.ts): the same as 40% less
  damage per shot, without rounding the small whole-number damage tables. Drones keep their
  health (jamming drains it at a fixed rate); strike drones hit 5/3 harder, so they stay
  one-shot munitions and a tank still takes two. Buildings and field works are unchanged,
  so assaulting a wall costs the same, while the men and tanks around it last longer.
- Field works build in half the time. Tank, artillery, EW, IFV and air defence take
  longer to produce (tank 22 to 32 s, artillery 26 to 38 s). Prices and income unchanged.
- First attacks come later on easy (20 min) and normal (12 min), normal raids from 14 min
  with four IFVs instead of six. Recruit and hard are untouched.
- Game speed 0.75x or 1x (menu, remembered) and Space to pause. These only change how
  often ticks run, never what a tick does, so lockstep is unaffected. Orders given while
  paused wait in the queue and all start on the first tick after resuming; the screen
  counts them.

## 059 The look before the factions

Fabio, 2026-11-12, on the coordinator's proposal: the visual realism pass moves ahead of
the factions (it was the first half of the old "M10 Polish"). Three reasons. The look is
the biggest gap to the goal now that the game underneath is fun. Surface detail, lighting
and effects are the frame-rate risk, and it is cheaper to meet it with one roster than
with three. And three rosters built on placeholder paint would be painted twice. Menus,
save/replay and authored models stay last, as M11.

## 060 Textures and sounds are made in code

Every texture is baked at start-up from tileable noise (`src/client/textures.ts`): a
height field per surface, its slopes as the normal map, a tone and a roughness channel.
They only add detail; colour still comes from vertices, so one texture serves every
building or every vehicle. No downloads, no licences, nothing to keep in the repository,
and a quality level can ask for smaller ones. The price is that they are plausible
rather than photographic. Photo textures (CC0, from ambientCG or Poly Haven) can replace
any one of them later behind the same four channels.

## 061 One function shades the world

`Fog.shade()` already multiplied every surface by the fog of war. Cloud shadows live in
the same function, so ground, roofs, hulls and trees darken together as a cloud passes,
at the cost of one texture read. The ground keeps a second, writable texture of wear
(512 x 512, one texel per two world units): tracks are drawn into it at start-up, and
the battle adds to it. It is display only; the sim does not know it and replays do not
need it.

## 062 Three graphics levels instead of a list of switches

`low` keeps the flat look from before this milestone and costs about what it did: no
surface detail, no cloud shadows, no reflections, small shadow map. `normal` is the
default. `high` adds what only strong graphics cards should pay for. The level is chosen
on screen, remembered, and applied by reloading, because every material is built for it.
`?shadows=0` and `?lod=` still work on top.

## 063 Paint without texture coordinates

Vehicles, men, houses and field works are merged boxes with a colour per vertex and no
texture coordinates. Their detail is laid on from position instead
(`src/client/surface.ts`). Buildings and works use world position: across a wall and up
it, so streaks run down, and flat over roofs. Units use the model's own space with an
offset per unit, so each of sixteen patterns travels with its vehicle: three-tone
camouflage on whatever is paint (told from rubber and steel by its brightness), chips
and grime, mud thrown over the running gear, dust on top, and rust and ash when it
burns out. The per-unit number rides in the whole part of the tint's fourth value, whose
fraction is still the burn. Window glass is a vertex flag that lowers roughness, so the
sky shows in it.

## 064 Camouflage for the eye, symbols for the player

Hulls in camouflage and mud are harder to see, which is the point of them and bad for
play. So the readability layer grows with the realism: past a camera distance of 250 a
map symbol fades in over every visible unit (frame in the army's colour, glyph per type,
brighter when selected), a constant size on screen, one draw call. Close up there are
none and the markings on the vehicles do the work.

## 065 Effects with shape, weight and wind

Particles were soft round dots. They are now four ragged puffs on one sheet, each sprite
turning slowly; fire cools from yellow-white to dull red as it ages; smoke is carried by
the same wind as the clouds and darkens under them; clods and plates are thrown up and
fall back. An explosion is a ground flash, a fireball, its black smoke, debris and a ring
of dust. The particle budget (6000 of each kind) and the thinning of far and unseen
effects are unchanged, so the cost is one texture read per sprite pixel. On `high` a
bloom pass lets fire and flashes bleed light; it is the one part that costs a full-screen
pass, which is why it is not in `normal`.

## 066 Sound is synthesised, and distance does the work

Eight sounds (rifle burst, autocannon, tank gun, howitzer, missile, explosion, shell
impact, collapse), three takes each, are computed at start-up from noise and sine waves:
no files and no licences, like the textures. What sells them is the path to the ear, which
is the point the camera looks at, raised with the zoom. A sound arrives late (170 world
units a second), loses its treble with distance and is panned by where it is on screen,
so the same howitzer sample is a crack beside you and a dull late thump from across the
map. Things out of sight are still heard, quieter and duller: a battle you cannot see is
information a commander would have. Each tick only the loudest few of each kind start,
and small arms may not take the last voices, so a blast is never crowded out. Volume is
on screen and remembered. These are first-pass sounds, written without being able to
listen to them; recorded CC0 samples can replace any of the eight buffers.

## 067 The army limit counts points, and tanks are scarce on purpose

Fabio, 2026-11-12: battles were decided by tank count, so the only play was to build
tanks. The cause was in the rules: every unit took one of the 600 slots, a tank was worth
four rifle squads in a fight, and a motor pool turned out tank strength faster than a
barracks turned out infantry strength. The fix is four rules that work together.

- The limit is in army points, 800 at most (a headquarters 60, a depot 40). A squad, a
  drone, a missile team, an engineer, a recon team and a truck are 1 point; carriers, air
  defence and jammers 2; guns 4; a tank 5. A full limit holds at most 160 tanks, and a
  mixed army of about 60 tanks, 65 other vehicles and 340 squads and drones.
- Production time and price follow the weight of the thing, as in life: a squad 5 s and 40
  supplies, an engineer 7 s, a missile team 8 s, a drone 6 s, a carrier 25 s, a tank 55 s
  and 320 supplies plus 160 fuel, a gun 50 s. Fuel is the brake on armour: one well
  sustains about one tank a minute.
- Missile teams and recon drones are tier 1 (the drone workshop with them), strike drones
  tier 2: the answer to armour exists from the first minute.
- Rifle squads do 4 times their damage to a vehicle within 8 m: a tank that drives into a
  town or a wood with no infantry of its own pays for it. The tank itself got a stronger
  hull (280 base health, was 240) and a harder-hitting gun against men (75, was 50), since
  at the new price it has to be worth having.
- Buildings have a Repeat toggle (command 26): while it is on, the last unit queued is
  queued again whenever the queue is empty and the army can pay, so 5 s squads do not mean
  constant clicking.

The AI wants a mix of roughly 48 rifles, 18 missile teams, 12 carriers and 10 tanks by
head count at tier 2, builds a motor pool for every barracks, and counts the limit in
points. In headless games an army at minute 14 on hard is about 175 rifle squads, 75
missile teams, 50 carriers and 6 tanks. Duels on open ground (`tools/pointduel.ts`): one
tank beats eight squads and loses to ten; three tanks beat fifteen; four tanks and twelve
squads lose to twenty squads and six missile teams, which is the counter working.

## 068 Zoomed in, the cost is fill and shadows, so cap those

Fabio: the frame rate drops when the camera is close. In a software-rendered browser the
unit and effect code costs 1 to 2 ms a frame at any zoom, while the draw cost rises as the
camera comes down and a shadow pass was a quarter of it (1.4 million triangles with
shadows, 0.7 million without, 2000 units). Real GPU timings are still Fabio's to report, so
the stats overlay now shows where the CPU time goes (units, effects, draw submit) and the
camera distance. Three changes, none of them visible at normal play:

- Puffs of smoke and fire the camera is inside of, or right up against, fade out and stop
  being drawn: a sprite that fills the screen is a full-screen blend per layer.
- The number of units drawn in full detail has a budget (120 on low, 300 normal, 500 high);
  the near distance shrinks until the count fits and grows back when there is room.
- Soldiers cast shadows only at full detail (five meshes a squad); vehicles keep theirs one
  level further out.

## 069 A second map with no river: the ridge

Fabio, 2026-11-12: on the river map the battle is too direct, the bridges decide it and
the ending is obvious. The ridge map (`generateMap(seed, 'ridge')`, the default for the
skirmish; `?map=river` or the Map menu brings the old one back) has no water at all. The
armies start in the south-west and north-east corners, 800 m apart, and four ways lead
across, mostly out of sight of each other:

- the road, through a town on each side and over a ridge in the middle with a town on top;
  the ridge is a plateau 8 m high with cliffs, a ramp on each long side and a slope at its
  south-east end, and whoever stands on it sees far;
- a forest belt in the north-west: infantry cross it anywhere, unseen; vehicles only on two
  tracks and the rides that join them;
- open farmland in the south-east: fast, cut by hedgerows with gaps, overlooked by the ridge
  and by a knoll on each side;
- a dry ravine between forest and ridge, sunk five metres between sheer walls, hidden
  behind a berm.

Seven towns (three a side and the one on the ridge) and 22 resource sites; the richer sites
and half the wells are on the flanks or shared on the centre line, so holding a flank pays
in fuel, which is what tanks cost (decision 067).

The map is laid out in two axes, A from the north-west corner to the south-east and B from
one army to the other, and every rule depends on A and |B| only, with symmetric noise: it is
an exact mirror image of itself across the diagonal. That ends "which side you start on
matters" for this map. Only the town on the ridge is not mirrored.

The AI needed no new machinery: the map lists its four ways as `lanes`, in the shape of
the river map's crossings (a forming-up point at each end, the settlement there if any),
and the AI uses them as it used fords: it picks one by distance, known enemy and enemy
towns, plus a large random part on this map so that no two attacks need come the same way,
and it sends raids by a way the army did not take. It pickets and wires its ends of the
ravine and the farmland like bare fords. Without a river, "its bank" is the half of the map
nearer its headquarters.

## 070 An easier Easy, depots at the stockpiles, squads in carriers

Fabio, 2026-11-12: the balance is right, but the easy opponent is still too hard. Three
changes to the AI (`src/sim/ai.ts`), none to the rules of the game:

- Depots beside stockpiles. On the ridge map the AI hauled supplies up to 60 m to its
  headquarters; a truck there brought in about 70 supplies a minute, against 200 with a
  depot next to the pile. It sat at zero supplies with thousands of credits unspent. It now
  puts a depot within 30 m of the richest stockpile it works from far off, and a rich army
  held back by its unit limit builds two depots at a time. On normal the army reaches 240
  points at minute 12 where it had 125.
- Easy and recruit are slower and smaller on purpose, since the fix above would otherwise
  have made them stronger: easy keeps 110 army points (was 220) and 7 trucks, orders a unit
  only on every third think, holds the town at its gate and one more until it has attacked
  once, does not go over the middle of the map before minute 24 (the old rule had a hole:
  an attack on a town of its own side could carry on to the enemy base at once, and the
  town on the ridge counted as its own side), and rests five minutes between attacks.
  Recruit: 70 points, 6 trucks, its gate town only, eight minutes of rest. No level gets
  free resources or sees through fog, as before (decision 045).
- Carriers. When the field army sets out, squads board the fighting vehicles it has (two
  each). They get out when enemy ground troops are within 52 m, at the objective, or at
  home after a retreat. The army still moves at the pace of whoever walks: a variant where
  the carried half drove ahead and the rest followed lost more headless games than it won.
  Not on recruit.

## 071 The land is dressed by the renderer alone

Fabio after M9 and the ridge map: "the visuals don't look great". Screenshots said why:
empty olive ground, flat-roofed boxes on a slab of asphalt, a steep camera, and the void
past the map edge. Lighting changes alone moved little. So, on normal and high detail:

- Ground. Two textures drawn once at load from the map (`src/client/land.ts`): crop
  parcels in six kinds on the open low ground, and a layer of made things: a street with
  pavements, kerbs, centre line and crossings through each town, yards and door paths,
  dirt roads along the lanes units use, soft darkening under woods and around walls.
  Battle wear still goes on top.
- Props (`src/client/clutter.ts`): hedges, bushes, bales, rocks, fences, poles, street
  lamps, sheds, bus shelters, wood stacks and grass tufts, instanced per 128 m chunk;
  the small kinds are hidden when zoomed out. They are cleared under anything built.
- Houses: small ones get tiled or slate roofs, gabled or hipped, with chimneys; flat roofs
  collect vents, tanks and aerials; all get a plinth, a string course and a door canopy,
  the taller ones balconies.
- Camera: 35 degrees when close, 56 when far (was fixed), so a close look shows walls and
  a horizon instead of roofs.
- Grass sheets continue past the map edge; ACES tone mapping; a stronger sun against a
  weaker sky for contrast.

All of it is cosmetic. Props block nothing, give no cover and are not in the simulation,
so the golden hash stands and multiplayer stays in step. That is also the limit: a hedge
that does not stop a bullet is a small lie, accepted because cover from field boundaries
belongs with the urban work (docs/URBAN.md), not here. Low detail keeps the old ground.

Measured with 3,000 units in view on software rendering (real frame rates are Fabio's to
report): 155 draw calls and 640k triangles on normal, 167 on high, 79 and 550k on low.

## 072 Sound, second pass: layers, echo, and a bed for what has no voice

Fabio on the first pass: "ok, not great". Still no files: asset hosts are blocked and
synthesis keeps the licence question closed. What changed in `src/client/sound.ts`:

- Small arms are layered: a crack, the body of the report, a low thump, a tail. Distance
  already strips the top end, so close fire now snaps and far fire is the thump alone.
  Seven takes instead of three: ragged squad bursts, a pair, a single shot, a machine gun.
- Echo. One shared convolver with a made impulse: four slaps off woods and slopes, then a
  dark wash. Each voice sends more of itself there the further away it is.
- A far-battle bed. There are 36 voices and at most a few new ones a tick, so a hundred
  rifles were three sounds. Every shot that gets no voice (too far, or crowded out) now
  adds to a level that fades a loop of crackle and rolling thuds in and out. Big fights
  sound big, including the ones off screen.
- Ambience: wind in two loops of unequal length, louder from high up; a few birds near
  the ground that stop when the firing starts.

None of it can be heard in the cloud. Checked offline: every buffer renders finite at
the expected level, and the page starts sound without errors. Whether it sounds right is
Fabio's call; the levels to turn are `BED`, the echo send in `at()`, and the bird gain.

## 073 An easy opponent that plays worse, and alerts for what happens off screen

Fabio, 2026-11-13, after an hour on easy without a result: the balance is right, easy
should be a little less clever, and the map is too big to notice an attack elsewhere.

Easy and recruit were already small and late (decision 070). Making them smaller again
would only shorten the game, so this time the judgement drops instead. Four new entries in
`AI_TUNING`:

- `react`: an intrusion must last 24 seconds (recruit 40) before the reserve moves, half
  that for its own base. Normal and hard answer at once.
- `eyes`, `drones`, `patrol`: easy keeps the two recon teams it starts with and one drone
  that changes place every 90 seconds, and sends no team to hide in sight of your base.
- `focus`: off for easy and recruit. Strike drones fly at the nearest vehicle instead of
  the most valuable one, and only the guns shell a strongpoint, not the tanks as well.
- `sulk`: beaten at a town or at your base, easy leaves it alone for 20 minutes (recruit
  for an hour) instead of coming back with more. Its own side of the map it still
  fights for.

Alerts are client only (`src/client/alerts.ts`), read from the events the sim already
sends, so the golden hash stands:

- Four kinds of "under attack" (base, town, forces, supply trucks), each raised once per
  160 m square for about 50 seconds, and never two of a kind within a few seconds. A
  fight on screen raises nothing.
- "Contact" when a recon drone has enemy troops in sight that nobody had seen for 25
  seconds, grouped by square: forty soldiers are one line that names the heaviest thing
  among them. A jammed drone reports nothing.
- Each alert is a banner, a tone, a spoken line (the browser's own voice; quiet when the
  sound is off), a ping on the minimap and an arrow at the screen edge. Backspace, or a
  click on any of them, goes there; Backspace again goes to the one before.

Not done: watchtowers were considered and dropped at Fabio's wish; deployable cameras
feed the same Contact alert in a later step (`Alerts.watchers`).

## 074 Buildings that die slowly (U1)

Fabio, 2026-11-12: buildings are too easy to destroy. One tank flattened a house in 45
seconds, so towns were erased, not fought over. This is phase U1 of `URBAN.md` (4.1, 4.2),
built on the maps that exist.

- **Three classes** by ground plan and height (`buildClass` in map.ts): house (up to three
  floors) 450 structure per cell, apartment or office block (four floors and up) 900,
  hall (nine cells or more, low) 1,300. It was 220 for everything. Base buildings and
  bridges keep their own numbers.
- **Four states** from the structure left (`stageOf`): intact, damaged below 70%, gutted
  below 35%, ruin at zero. The garrison takes 25, 35 and 45 percent of a hit; a ruin is
  rubble, which halves it as before and cannot be damaged at all. A gutted building has
  no upper floors: no height in sight or range.
- **Two kinds of damage.** Direct fire (tank guns, vehicle cannon, missiles) hits the wall
  on the face it comes from (`faceToward`, `World.sWall`, four per building) and does a
  quarter of its damage to the structure. Shells from the guns and engineers' charges go
  into the structure whole. A breached face protects one state worse against fire from
  its side, and from that side only.
- **Losses in two steps:** a quarter of each squad inside when the building is gutted
  (they stay in the shell), a quarter when it falls (they are left in the rubble).
  It was half at once.

Measured: one tank breaches a house wall in under half a minute and guts the house in
about four; four tanks need a minute and a half to bring a small house down (was 12
seconds). Normal against normal still ends in 16 minutes on seeds 1 and 3, so the AI's
attacks did not stall.

The client shows each state: scorched and holed when damaged, a roofless shell with
ragged walls when gutted, a ragged hole and a spill of masonry at a breached face. Two
new events (`EV_GUTTED`, `EV_WALL`) carry the dust and the noise. The golden hash moved
to 3890551401.

Not in U1, by the plan: fortifying and repairing houses, linked buildings, storming,
top attack, rubble in the streets (U2 and U3). A breached face is not yet an entrance.

## 075 Soldiers are jointed figures posed on the CPU

Fabio, 2026-11-13: the game looks better, and the soldiers are the big gap. They were a
stack of fifteen boxes that slid over the ground with a small bob.

A soldier is now eleven rigid pieces (torso, head, two thighs, two shins, two upper arms,
two forearms, rifle) modelled in metres at true proportions and scaled to the map
(`src/client/soldiers.ts`). Each frame the client blends a pose from seven key stances,
places the joints, and writes every piece into its own instanced batch. The arms are
solved to the rifle (two bones, elbow kept clear of the ground when prone), and the hips
sit as low as the lowest knee or foot allows, which keeps feet on the ground through a
stride and puts a knee on it when a man kneels.

Why on the CPU and not in a vertex shader: a shader rig would be one draw call instead
of seven, but it would need its own material, its own shadow path and its own instance
attributes, on a WebGPU path that cannot be tested in the cloud. Posing on the CPU keeps
soldiers on exactly the material, shadows and upload path the vehicles already use.
Measured headless: 3,000 soldiers on screen cost about 2 ms of CPU a frame at either
level of detail. A man is about 450 triangles near (was 190) and 96 at middle distance
(was 36); full detail is capped at 4,096 men at once and the rest of a crowd falls to
the simple figure.

What a squad does is decided on the client from what it already knows (moving, shot
recently, has a target), so the sim and the golden hash are untouched:

- moving: everyone runs, rifle at the port
- halted: most take a knee, one or two stay standing
- in a fight: some kneel and fire, some go prone, one fires standing
- a missile crew kneels by its launcher; scouts lie prone whenever they stop

Each rifle flashes at its own muzzle in short bursts after the squad's shot, with a small
recoil. Uniforms come from a palette (`Uniform`, default `NEUTRAL`: olive drab, no
nation's pattern); the factions milestone builds one rig per faction with its own.

Not done: death and wound animation (men still drop out of the squad as it loses
health), taking cover behind a specific wall or tree, crawling, and stances that follow
the sim's cover value. The figure is still made of boxes: it reads as a soldier from the
RTS camera, not in a close-up.

## 076 Surveillance cameras, and a jammer that finds them

Fabio, 2026-11-13: wants to deploy cameras that watch part of the map, stealthy, found
only by a jammer truck or similar.

A camera is not a unit. It is a row in a small table of the world (64 slots: owner,
position, the tick until which the enemy knows of it), so nothing can target it, no
damage table knows it, and it costs no army points.

- Placing: `CMD_CAMERA` (V, or the button on an engineer squad). Each engineer squad
  named leaves one where it stands: 20 supplies, at most 12 per army, not within 14 units
  (about 55 m) of another of yours, not from inside a house or a carrier. It does not
  interrupt what the squad was doing.
- Watching: twice a second a camera reports enemy ground troops within 38 units (about
  145 m, half a recon team's reach) that it has a line of sight to, by the same rule as
  a recon team (concealed troops only from close in). It does not see drones.
- Stealth: enemy troops do not find a camera, at any distance.
- The counter: a camera inside an enemy jammer's bubble reports nothing, and is known to
  that army for as long as it stays there plus 30 seconds. A known camera comes down when
  an enemy ground unit gets within 5 units of it. Jamming a camera gives the jammer away,
  as jamming a drone does.
- The jammer also has a fix on every drone it jams (they show through the fog while it
  has them), which is the "reveals drones" half of the ask.

On the client the player's cameras show with a thin ring for their circle (red while
blinded), lift the fog there, and feed the contact alert of decision 073; a lost camera
raises an alert. Enemy cameras are drawn only while known, with a red mark.

The AI places no cameras yet. Its jammers blind and reveal the player's, and its troops
pull down the ones they pass. The golden hash did not move: its scenario has no camera
and no jammed drone, and free camera slots are not hashed.

## 077. A screen cut into zones (2026-11-13)

Fabio: "some elements of the page are in front of others and are hard to see", and the
production box "breaks as we click to build more units when the box stretches".

Every panel was placed by itself with a fixed offset, so they met as soon as one grew.
Now the screen has zones that cannot meet: a bar along the top (resources left; pause,
speed, help and a Menu holding opponent, map, sound, graphics and new game right), a
column down the left (performance, towns), alerts bottom left, the minimap bottom right,
and what is selected with its command card bottom centre at a fixed width between them.

- The performance readout is one line (frame rate, units, build) until clicked or F3;
  the choice is remembered. The build id stays visible because that is how a test
  session is tied to a commit.
- A production queue is eight slots of one size, drawn whether filled or not, with the
  army-limit warning on a line of fixed height. Nothing below moves when an order lands.
- Orders that were only keys are buttons that show their key and explain themselves on
  hover: attack-move (C), smoke (F, now also "press, then click"), mount (L), dismount
  (U), deploy camera (V). Fabio played a whole game without finding the cameras. Unit
  buttons say what the unit is for.
- Help is a scrolling sheet in the middle instead of a block down the left edge.

Client only; the golden hash did not move.

## 078. Orders to the army, not to a building (2026-11-13)

Fabio: "If I want a game with lots of units its hard to be coming back to the barracks
... how about a centralised place to manage unit creation? not sure how to execute and
make sure they come out in the right place".

The war production centre (P) is a sheet listing every unit by the factory type that
makes it. What it changes is who an order is addressed to: the army, per unit kind.

- `CMD_ORDER` adds to a per-team, per-kind count of units on bulk order (999 at most).
  Twice a second the economy hands them out: the kind whose turn it is goes on the
  queue of the finished factory of the right type with the shortest queue, as long as
  that queue holds fewer than two. So three barracks fill an order three times as fast,
  and a factory finished later joins in by itself.
- Paid as each unit goes on a queue, not when ordered. An order is an intention the
  player can give ahead of the money; taking it back costs nothing.
- Kinds take turns. A kind the army cannot afford holds the others up until it can be
  paid (or for 20 seconds, then they pass for a round). Without this two hundred cheap
  squads on order would eat every supply as it arrived and the one tank would never
  be built.
- `CMD_KEEP`: a number to keep in the field. Once a second, what is alive plus what is
  on a queue is compared with it and the shortfall becomes the order. Ending it drops
  the unstarted orders too.
- `CMD_DEST`: where new units of a kind go: the factory's rally point (as before), a
  town, or a commander (slot reserved for the sub-commanders). This answers "the right
  place": the place is chosen per kind, once, not per building.

The per-building queue, Repeat and rally point stay, and the AI still uses them. The
state is in the world (`orders`, `keep`, `dest`, `orderTurn`, `orderWait`) and in the
hash, so it is lockstep-safe. Golden hash 3142039993 (the new arrays are hashed; the
battle in the golden scenario plays out as before).

## 079. The brake moves from the factory to the battlefield (2026-11-13)

Fabio: resources come slowly, which "is good in a way to avoid unit explosion, but if we
make battles harder to win or even to be fought (for example, by having to traverse long
distances) we could be more careful at the same time we build more units".

Slow income was the only limit on army size. It is replaced by three that act on the map.

- Income doubled: a truck carries 40 (was 20), wells pump 6 a second into a tank of 600,
  towns pay 5 credits a second (was 3). Stockpiles hold twice their table value so they
  last as long as before.
- Supply range (`src/sim/logistics.ts`). Sources: a finished depot or headquarters
  (150 units), a held town (its radius plus 70), and a truck (52) while it stands within
  260 of one of the first two. A truck is the last link, never a line by itself: lose
  the depot behind it and it carries nothing. Each ground unit has 120 seconds of
  rations, refilled at four a second in supply, run down at one a second outside it. At
  nothing: reload doubled, vehicles at 60% speed. In supply, with full rations and
  nothing to shoot at, a unit mends over about 150 seconds.
- Upkeep: every army point above 60 costs 4 supplies a minute, charged every 3 seconds.
  An army that cannot pay is at zero and stays there; there is no second punishment. The
  natural result is that army size is bounded by income, with no hidden penalty spiral.
- An army with no depot and no town at all (the set-piece scenarios, the stress test) is
  off the system: it neither starves nor mends.

Why these numbers. On the ridge map a gate town is 170 from its base and Ridgetop 229
from a gate town. Infantry walks that in 72 seconds, so it arrives with a minute of
rations: enough to take the town, which then feeds it. A strike that goes past the
towns starves; an advance town by town with a truck behind it does not. That is the
"be more careful" Fabio asked for, without making the map bigger.

Aircraft and trucks are exempt (a drone is its own logistics; a truck is the logistics).
The supply map is 64 by 64 squares per team, rebuilt once a second from hashed state, so
it is not hashed itself; rations are.

The AI: `Tuning.wagons` (0, 1, 2, 3 by level) trucks leave their hauling and follow the
field army while it is out, and go back when it is home. Easy has too few trucks to
spare any, so its attacks arrive hungry: that makes easy easier, on purpose.

Measured headless after the change (ridge map): easy alone still sits at 110 points and
first attacks at minute 24; hard beats easy in 10 minutes; a normal mirror game now runs
about 44 minutes (seed 1), because both sides rebuild faster than they kill until the
stockpiles run dry around minute 30. Upkeep was raised from 2 to 4 after the first round
because at 2 it was under a tenth of a developed economy's income. Golden hash 3901124625.

On screen: the supply area on the minimap, upkeep and an "Out of supply N" button in the
top bar, an alert when the first units run out, the count in the selection line.

## 080. Control groups you can see (2026-11-13)

Fabio asked whether groups exist. They did (Ctrl + 1..9, recall, double tap), unseen.
Added: group 0, Ctrl + Shift + number adds the selection to a group, and a chip per
existing group above the command card showing its number and size; a click recalls it.

## 081. Rifles do not hurt buildings, but an order never leaves them standing (2026-11-13)

Fabio: "soldiers can't destroy buildings, they just hang around". Not a pathing bug. An
attack-structure order dropped every unit without a siege weapon, units without one never
fire on a base building by themselves, and the order needed Ctrl + right click. Now a
plain right click on an enemy base building is the order, units that cannot damage it
attack-move up to it, and the player is told what can (engineers, missiles, tanks, guns).
Whether rifle squads should carry a slow demolition charge is left to Fabio.

## 082. Sub-commanders: missions are state, the staff is a player (2026-11-13)

Fabio wants to command the war, not the firefight: give a group a commander and a
mission and have it run itself, on the enemy AI's brain, deterministic for co-op.

Two halves, split the way the computer player already is:

- Game state (`src/sim/commanders.ts`, hashed): per unit the commander it answers to
  (`cmdr`), per team eight commanders with a mission (attack, hold, defend, patrol,
  screen), a place, a flag "replace losses" and an establishment per unit kind. Three
  commands: assign, mission, reinforce. A second player could give these as well as the
  first, which is all co-op roles needs from this.
- The staff (`src/sim/staff.ts`): an outside player like the AI. It reads that state and
  hands in ordinary commands once a second. It owns a hard-level `Ai` and uses its parts
  unchanged: `perceive` (the memory of where the enemy is), `marchOrders` (a body that
  closes up before it moves on), `press` (the lower half of the AI's assault: smoke,
  breaching, shelled strong points; split out of `assault` for this), `billet` (infantry
  into houses; split out of `garrisons`), `follow`, `mount`, and the AI's own rule for
  breaking off. The AI's behaviour did not change in the split.

What each mission does. Attack: form up if scattered, close up 60 m short, assault, hold
what was taken; break off when beaten, guns laying smoke, fall back to the nearest held
town or the base, and go in again only at 75 per cent of its best strength (so: when
reinforced, or told again). Hold: never falls back. Defend: hold, sortie against an
enemy seen within 110 m, give ground to more than twice its strength, return when the
place is quiet (after 90 s it goes to look instead of trusting a stale memory). Patrol:
between where it stood and the point. Screen: a line of pickets across the way from
home, which pulls back from anything stronger than itself.

Reinforcements. "Send to: commander" in the production centre; or "replace losses", where
the economy orders whatever the establishment is short of (the larger of that and any
"keep N", never both) and the next unit of that kind off any line joins the commander.
New arrivals count as part of the body once within 50 m of it.

Rules for the player's hands: an order given to a unit directly takes it out of its
commander's (the client sends the release first); a selection box over mixed troops
leaves commanded ones out, and so does Ctrl + A.

Measured headless, ridge map, hard AI opposite: 6,000 units with eight commanders average
9.8 ms a tick (7.5 ms without), the staff itself 0.03 ms a tick. Golden hash 2524715586.

Not done: no marker over commanded troops in the 3D view (the minimap has one); the
staff has not been tuned in full games against the AI; commanders do not coordinate
with each other.

## 083. After the first test of commanders (2026-11-13)

Fabio, playing build dccd279. Rifle squads get a siege value of 2 (a tank gun is 60):
"they still don't attack enemy buildings" settled the question 081 left open. Reports
that are not attacks (a commander's news, troops out of supply, a hint about an order)
are their own alert kind, blue and spoken as written; they used the army-attack kind,
which said "forces under attack". A box now selects commanded troops like any others:
leaving them out read as a selection bug. Every commander row shows "+ Add N selected"
when troops that are not its own are selected. Golden hash 665890359.

## 084. Pennants over commanded troops, and an attack that waits for its tail (2026-11-13)

Two gaps decision 082 listed. Troops under a sub-commander carry a small pennant with
its letter in its colour (eight colours, the same chip on the mission board), drawn by
the map-symbol batch at every zoom, so the player sees on the battlefield which troops
are not his to forget about. And an attack now waits at its last way point, 60 m short
of the objective, until 85 per cent of its line has closed up, new arrivals within
220 m counted in; it stops waiting after a minute from the moment half were there, and
at once if it comes under fire. The board says "Gathering for the attack". Before, it
went in when half had arrived, so a mixed body attacked with its vehicles and the
infantry walked into the aftermath. The staff is not hashed state: the golden hash is
unchanged.

## 085. What to take from Saltline, and what not (2026-11-13)

Fabio linked a first-person shooter that lives in one artifact as a mark for our
graphics. Its source was read rather than judged from the screen. It is Three.js r180 on
the WebGL renderer with no downloaded assets, as we have none. It looks as it does
because it spends everything on very little: one yard of 80 by 60 m merged into a few
meshes, at most 18 enemies (ten drones, eight four-legged machines), a camera a metre
from every surface, and no human figure anywhere. So it has no answer for our soldiers,
and nothing of its rigs or level building scales to 4,000 units.

What it does well and we do not yet: a long chain of screen passes (occlusion and light
shafts at half resolution, six-level bloom, automatic exposure, a grade, grain,
sharpening); about thirty surfaces written as shaders and baked at start-up into colour,
height, roughness and normals; wear computed from the curvature of each model when it is
built; signage drawn as canvas text; and a governor that trades resolution, shadow
updates and finally the graphics level for frame time.

The rule for choosing: take what costs per pixel or once per model, leave what costs per
object or per extra view. That gives R1 to R6 in the roadmap, each attached to work
already planned instead of a graphics milestone of its own, because a sprint of looks
with no content under it changed little last time (graphics sprint 2: content on the
ground did the work, not light values). Left out: planar reflections, motion blur, its
rigs, its sound engine. Nothing here is copied; its code is GLSL injected into stock
materials, ours is TSL nodes, so each technique is written again.

## 086. Storming a held building (U2, first part) (2026-11-13)

Infantry ordered into a building the enemy holds now fights its way in instead of standing
at the door. The order is the one the player already knows (right click the building); the
sim marks the squads that reach the wall as storming and resolves the fight twice a second:
each side loses men in proportion to the other's strength, with the defender's edge
depending on the building (7 to 4 for a hall, 6 to 4 for a block, 5 to 4 for a house) and
gone altogether when at least half the attackers come through a breached wall or smoke
lies on the building. Engineers count four riflemen in the assault, other squads with a
siege value two. When the last defender falls the attackers move in and hold it.

Measured, rifle squads against four in an intact block: 14 take it and 13 survive, 10
take it and 7 survive, 8 fail. Through a breach 10 take it without loss worth the name.
24 take an intact block held by 8. So the rule of thumb in the help text: three to one,
or less with a breach or smoke first. That is the point of the system: the tank's job in
a town is to open the wall, not to level the block (U1 made levelling slow).

The AI storms too: when the objective it presses is a building it has seen held, it sends
the nearest foot squads within 90 m, and only once 13 are there (9 with a breach or a
gutted shell), so it does not feed squads in one at a time.

Client: shots and dust at the building while the fight is on, "Garrison being stormed"
as an attack alert, "Building taken" as a note.

Not done from the U2 list in URBAN.md: fortifying and repairing, barricades, linked
buildings and mouseholes, "garrison this block". Engineers alone are weak stormers (four
to six fail against four); they are a multiplier, not an assault force.

## 087. The city map, built round the flags (U3, first part) (2026-11-13)

A third map layout, `city`, now the default (`?map=ridge` and `?map=river` still work, and
the menu offers all three). Fabio asked for towns generated round the flags, dense and
full of detail, with longer routes so that supply and sub-commanders matter, and no
bridge to fight over.

Nine flags: West End and East End (the home districts), Millbrook and Foundry Row,
Southfield and Eastfield, and on the diagonal between the armies City Centre, Northgate
and Station. Each is a grid of blocks 36 m square with 12 m streets between them; the
blocks are drawn from a table (courtyard block, slabs, a quad, a hall, a row of houses, a
park, a car park) and the centre has towers and halls. Arterial roads join the districts,
with houses and shops along them; outside is hedged farmland and woods. 436 buildings
on seed 1, against about 60 on the ridge. The west half is generated and mirrored, as on
the ridge. Bases sit in opposite corners, 24 cells clear round each; the way from base to
base is about a third longer than on the ridge and there are five lanes for the AI.

What it costs. MAX_STRUCTS went from 512 to 1024 and MAX_TOWNS to 16. The client drew one
mesh a building; it now merges the buildings of each 128 m square into one mesh and
remerges a square (two a frame at most) when a building in it changes state. Streets,
pavements, kerbs, centre lines and patches are painted into the ground marks; lamps,
parked cars, vans, bins and bus shelters are instanced props.

A hitch found and fixed on the way: every squad and truck with its own goal had its own
flowfield built in the tick it asked, about 3 ms each, and a city full of distinct goals
(buildings to garrison, field works to dig) asked for up to 62 in one tick. Fields are
now built three a tick at most; the rest walk straight for a tick or two until theirs is
made. Headless, two normal AIs, 40 minutes on the city: worst tick 199 ms before, 31 ms
after, mean 2.1 ms. 3,000 units fighting in the centre: 2.2 ms a tick, the same as on
the ridge. This changes who gets a field when, so the golden hash is now 2071988442.

Not done from the U3 list in URBAN.md: column movement in streets, rubble spilling into
the street and being cleared, local map updates. Vehicles are not held to the streets by
rule; the blocks do that. Roofs are all one colour and there is no signage (R5, R6 with
U4). The client frame rate on this map has only been checked in software rendering here:
it needs Fabio's machine.

## 088. Strike drones take turns (2026-11-13)

Fabio, after the city build: everything is good except that drones wipe out tanks in two
seconds. Measured with `tools/droneduel.ts` on open ground, counted from the moment the
drones come into the tanks' view: 8 strike drones killed 4 tanks in 3.9 seconds, 16 in
4.0, 32 in 2.8. A tank took two drones, all of them arrived together, and one air-defence
vehicle (a kill every 0.6 seconds) had no time to matter: 16 drones still killed all four.

Drones stay cheap and quick to build (the army mix of decision 059), so what changes is
how fast they kill, not what they cost:

- A tank's roof takes four strike drones, not two (75 in the table, 125 after the pacing
  factor, against 467 health). Carriers still take two, guns, air defence, jammers and
  trucks one.
- They attack in turn. The first drone to come within 13 of a target starts lining up on
  it, which takes 2.5 seconds; after every hit the next one waits 5 seconds. Drones
  waiting circle the target at that distance and the one whose turn it is starts its dive
  just before the wait is over. If nobody takes a turn within 2 seconds (shot down on the
  way in) the lining up starts again. One value per unit, `strikeAt`, holds this.
- The owner is told when the lining up starts: event `EV_STRIKE`, on the client a banner
  and a spoken "Drones inbound" even when the tank is on screen, with the swarm visibly
  circling over it.

Measured after: a tank dies about 19 seconds after the drones come into view (first hit
at 4), four tanks to 16 drones in 25 seconds, to 32 in 21. Eight drones on four tanks
kill none (they spread two a tank). With one air-defence vehicle the four tanks lose
nothing to 16 drones and are all lost to 32, which kill the air defence first (it still
dies to one); with two, one of the four tanks survives 32. A jammer stops any
number, as before. So the answers are the ones that existed, and there is now time for
them to work: air defence or a jammer with the tanks, smoke on them (a drone cannot see
into it), or driving under the cover of either while the drones circle.

Not done: tanks have no smoke launchers or active protection of their own (smoke comes
from the guns), and the AI neither escorts its tanks on purpose nor masses drones on the
air defence first. The golden hash is now 495916327.

## 089. The frame governor and the performance test (R3) (2026-11-13)

The old rule lowered the resolution whenever frames ran slow. That is the right cure for
a graphics card out of fill rate and no cure at all for a processor busy posing units or
a card busy with shadow geometry, and nobody knew which of the three the drop to the low
40s at 4,000 units was. The cloud cannot say: its browser has no graphics card.

So the governor (`src/client/governor.ts`) finds out before it acts. Each second it looks
at the frame time and at how much of it was this thread's own work. Work above 70% of the
frame means the processor: it shortens the distances at which units drop a level of
detail and never touches the resolution. Otherwise it tries one resolution step and
watches: a card out of fill rate speeds up in step with the pixels taken away, and if
less than a quarter of that shows, the pixels go back and the scene gives instead (shadow
map every third frame, post effects off, detail range, small props). Detail returns in
reverse order after ten smooth seconds; if its return breaks the frame rate again the
wait doubles, so a load on the edge does not flicker. The overlay (F3) says what the
limit is and what was given up.

Before any of that: a pixel budget per graphics level (2.1, 5.2 and 8.3 million pixels),
so `normal` on a high-density laptop screen no longer draws every device pixel, and below
`high` the sun's shadow map is redrawn every second frame, with the light moved only when
it is redrawn so the old map stays valid in between.

The measurement itself is a button, Menu then "Performance test": twenty seconds at the
view on screen, switching one cost off at a time (half the pixels, shadows frozen, post
off, units hidden, buildings hidden), then a table and one sentence naming the limit.
That is the diagnosis the roadmap asked for, run on the machine it is about.

What the cloud could measure on the city map (software rendering, so only counts and
processor time mean anything): the whole centre in view is 101 draw calls and 553,000
triangles, less than a 3,000-unit battle on the ridge. The city's static geometry is not
the risk; shadows across it and the fight inside it are, which the test will show.

## 090. Soldiers with bodies, wear from the shape of a model, occlusion and a grade (R1, R2) (2026-11-13)

Fabio named the soldiers the weakest thing on screen, and the first sprint (decision 075)
gave them joints and stances but left them made of boxes. Three things, built together
because each needs the others to show.

**Bodies.** `src/client/shape.ts` adds a loft: a smooth skin over a stack of rings, each an
ellipse or something squarer. A man is now a torso with shoulders and a waist, tapered
thighs, calves into boots, a neck, a head under a curved helmet, upper arms with a round
shoulder, forearms into gloves; over that a plate carrier, three magazine pouches, a
radio with its aerial, hip pouches, a pack and bedroll, a headset and glasses, and a
carbine with optic, magazine, stock and suppressor. About 1,200 triangles up close. The
middle distance, where most soldiers are seen from an RTS camera, was six boxes without
arms or a head; it is the same man at a quarter of the points, with two straight arms
that reach for the rifle (eight pieces, about 300 triangles). The squad's far block has a
head. The army's colour sits on both sleeves, a name tape and the back of the helmet.
At the halt and out of a fight each man turns his head across his own arc in his own time.

**Wear (R2).** The study this came from stored how convex each corner is per vertex. That
cannot work on models made of boxes: a box has no vertices inside its faces, so a face
would be worn all over or not at all. Instead every vertex carries where it is inside its
own box and the box's half size, in wear widths; the pixel shader then knows its distance
to the nearest edge exactly, anywhere on a face. Paint chips to primer and steel in a
ragged band along every edge, dark steel and rubber polish pale, cloth frays and fades.
A second value marks creases, set when a model is assembled: a vertex lying against the
skin of a neighbouring part, or a narrow ring between wider ones (a waist, an ankle),
holds dirt and little light. All of it is paid once at start-up and rides on every
instance for free. Vehicles got it by changing the two builders they are all made from.

**Occlusion and grade (R1).** `src/client/post.ts`: on `normal` and `high` the scene is
drawn to a target, ambient occlusion is worked out from depth at half resolution (8 or 16
samples) and multiplied in, `high` adds its glow and a sharpen, and a grade finishes the
picture: a mild S-curve, shadows a little cool and highlights a little warm, a vignette,
fine grain. `?ao=0` leaves the occlusion out; the governor drops the whole chain when the
frame rate needs it. `low` draws straight to the screen as before.

Left out: automatic exposure. It needs the average brightness of the last frame, which is
a read-back or a chain of shrinking passes, for a camera that never goes indoors.

Not verified in the cloud: the cost of the occlusion pass on a real graphics card (the
performance test of decision 089 measures it: "no post effects"), and whether its noise
shows at half resolution without a blur pass. If it does, the fix is the depth-aware blur
three.js ships, at the price of one more full-screen pass.

## 091. The city is destroyed and held: street rubble, fortified ruins, baked materials, signs (U4, R5, R6) (2026-11-13)

Fabio's urban ask: buildings too easy to remove from the map, ruins
that can be used as fortresses, building and reinforcing structures, a city full of detail.

**Rules (sim, `src/sim/urban.ts`).**

- A building of four floors or more that falls throws rubble into the ring of street
  cells round it (55% of them, drawn from the world's own random numbers). Rubble is a
  field work that belongs to no army: infantry climbs over it, no vehicle crosses
  it, shells barely move it, engineers clear it with charges (right click it). Shelling a
  block shuts the streets beside it for whoever fired as much as for the enemy. The AI
  does not count rubble as enemy works and treats it as a wall when it looks for a gap.
- Repair / fortify (B, or the button on the card, then right click a building; trucks
  alone need no button). Trucks and engineers first mend the structure and the breached
  walls, for supplies; engineers then fortify it, 15 seconds for one squad, up to three
  squads at once. A gutted shell can be fortified as it stands: that is the fortress ruin.
- A fortified building holds half as many men again, lets a quarter less fire through its
  walls (a fortified ruin shelters at 35% where a bare ruin gives 50%), and takes a
  quarter less structural damage. Fortification is lost when the building collapses. Not
  while the enemy is inside. The AI does not fortify yet: that is U5.

**Materials (R5, `src/client/surfaces.ts`).** Eight surfaces (plaster, brick, precast
panels, clay tiles, corrugated sheet, roofing felt, sacking, broken masonry) are each a
small shader drawn once at start-up, read back, their heights turned into normals on the
processor (so the result is the same whichever way up a graphics card reads back) and
stored as the layers of one array texture. A number per vertex picks the layer, so the
city is still one material. Walls and roof slopes are mapped along their length and up
their rise: brick courses lie level and tiles run in rows under the ridge whichever way a
roof faces. If the bake fails or takes more than four seconds every layer stays the plain
plaster made on the processor; `?bake=0` forces that, and `?city=plain` goes further and
draws every wall with the old single texture, without the layers at all. The land's own textures (grass,
asphalt, rock) still come from `textures.ts`; moving them is not worth a second system.

**Signs (R6, `src/client/signs.ts`).** One sheet of 64 cells painted with canvas text at
start-up, then streaked, scratched and chipped: shop fascias, enamel street plates, roof
hoardings. Every name is invented. A sign is a flat panel in the building's own mesh that
shows its cell, so signs cost no draw calls and fall with the building.

**Look.** Roofs: tiled gables with dormers or a cross gable, low hipped zinc roofs, a
set-back glazed top storey, rows of sheet gables on halls, flat roofs with their clutter.
Fronts: brick or plaster houses, panel blocks with piers, a dressed ground floor on tall
houses, shops with glass, a fascia and often an awning, drainpipes. A fortified building
shows sandbags along the foot of every wall and in its breaches, boarded windows, and
positions on a flat roof; a fortified ruin has a sandbag nest on the heap inside and a
sheet propped over one corner.

Left out of U4 as planned in URBAN.md: far-distance facades and the roof fade when the
camera is over a held building. Neither is needed until the frame rate or readability
asks for it. Not verified in the cloud: the bake on a real graphics card under WebGPU
(checked only on the software WebGL path), and the cost of the array texture lookup.

## 092. Co-op: two browsers, one army, the host's sim as the clock (2026-11-13)

Fabio's signature feature: two people share one team against the computer, anyone can do
anything, each has a role. This is the foundation and a first, light layer of roles.

**How the two games stay the same game.** Nothing of the battle is sent, only orders. The
host's sim runs on its own clock exactly as a game alone does. For every tick it runs it
reports a frame: the tick number and the players' orders that went in on it. The guest's
sim has no clock: it runs the ticks it is sent, with those orders, and nothing else. The
computer opponent and the sub-commanders run inside both sims and need no network at all.
The guest's own orders go to the host and come back in a frame.

Why this and not the textbook "both wait for both" lockstep: with a host clock the host
never stalls on a slow partner, the guest simply runs a little behind and catches up (up
to 24 ticks in one go after a hitch); and either side can carry on alone when the other
drops, because each holds the whole world. The price is that the guest's orders are late
by one round trip (typically 50 to 150 ms) and the host's are not. For two friends on one
team that is the right trade; it would not be for opponents.

**Finding each other without a server.** WebRTC, peer to peer. The meeting point is the
free public PeerJS broker (`0.peerjs.com`), which also lends relay servers for networks
that block direct connections. The host gets an address (`rev-` and eight characters),
the invite link is the game's own address with `?join=` and that. The game is still only
static files on GitHub Pages. Limits, stated plainly: the broker is a free service run by
someone else, with no promise of being up; its relays are best effort, so two people both
behind strict company or mobile networks may fail to connect; the link dies with the
host's tab. If it proves unreliable the fix is our own tiny broker, which is a server.

**Starting.** Menu, "Co-op: invite a partner" reloads the host into a lobby that shows
the link. When the guest opens it the two compare build ids (different builds would
drift, so they are refused with instructions to reload), the host sends its map, seed and
opponent, and both build the game. The guest may load slower: frames wait for it.

**Staying honest.** Every two seconds both sims hash the whole world on the same tick and
swap the numbers. A difference puts a red line on both screens: out of sync, start again.
There is no repair. `tests/lockstep.test.ts` plays the worker's loop on both sides with
frames passed as text and checks hash for hash, and that one dropped order is caught.

**Pause, speed, leaving.** One clock, so pause and speed are the host's; the guest's
Space and speed control ask the host, and both screens follow. If the host leaves, the
guest's sim runs what it had received and goes on alone on its own clock. If the guest
leaves, the host plays on; when the guest opens the link again the host is offered a
restart together (a game cannot be joined half way: that needs the whole world sent, and
is the next piece of work if drops turn out to be common).

**Roles, first layer.** Each player picks a role in the lobby (Armour, Infantry, Air and
drones, Economy, or Everything). Both see both roles; the production screen marks the
rows that are yours and your partner's. Z rings a point on both minimaps; the partner's
view is a cyan box on the minimap. Nothing is locked. Left for the next step, because it
needs the sim to know who gave an order: handing units over, per-player budgets, and
selecting "my" units.

**`?net=local`** replaces the network with a channel between two tabs of one browser: for
trying co-op alone and for the automated two-page check.

Not verified in the cloud: a real connection through the broker (the sandbox cannot reach
it), two different browsers (Chrome against Safari could differ in some corner of integer
arithmetic we have not hit; the hash check will say so at once), and play over a bad line.

Also in this change, asked for after the drone rebalance (088): on Normal and above the
computer adds one air-defence vehicle for every four tanks it means to field, and one
more jammer from tier 3, so its armour does not go out without cover against drones.

## 093. Co-op for three and four: a lobby, a star of links, a stronger computer (2026-11-14)

Fabio's two-player test over a real network worked, and three people wanted to play.

**The star.** The host's sim stays the only clock (092). Every guest holds one link, to the
host; the host sends each tick's frame to all of them, takes orders from any of them, and
passes on where each one looks and what each one points at, with the seat it came from.
Seat 0 is the host, guests sit in 1 to 3 (`MAX_PLAYERS = 4`). Hashes are compared host to
guest on every link; two guests in step with the host are in step with each other.

**The lobby.** One invite link serves everyone. A guest who opens it is told he is in and
how many are; the host sees the list with each role and presses Start. (Before, the game
began the moment the one guest arrived; with a third player that moment cannot be guessed.)
A fifth player is told the game is full.

**A slow player holds nobody up.** This comes with the host clock: the host never waits
for a guest. A guest who falls behind runs ticks faster until he is level (`follow`), tells
the host in his ping how far behind he is, and the host's status line names anyone more
than two seconds late. A guest silent for twelve seconds is dropped and the others play on;
if the host goes, each guest continues alone on his own clock (their worlds part from there).

**The computer.** The players share one army and one economy, so a third player adds
attention, not material. `tuningFor(level, humans)` gives the computer 35% more per player
beyond two: trucks, factories and army size up, first attack and the rest between attacks
down, a quicker hand on production, one more squad per garrison. The number of players is
fixed at the start and goes to every sim in `init`, so it cannot desync. One or two players
get the level exactly as it stands: the golden hash and the two-player game are untouched.

**Not built:** joining a game in progress, a relay between guests if the host leaves,
per-player ownership of units.

## 094. A map grid, attacks that close up out of sight, and a Move mission (2026-11-14)

Three asks from the first three-player evening.

**Grid.** Eight by eight squares, A to H west to east and 1 to 8 north to south (128 m
each): the reference the mission board already used for places outside towns, now drawn.
Always on the minimap; on the battlefield with K or the Grid button (lines over the
ground, the name of each square four times in it, remembered between games). A co-op ping
(Z) now also reports "Player 2 pings C4" to everyone, spoken. `src/client/grid.ts`.

**Attack.** A commander's attack closed up 60 m from the middle of its objective, which
in a town is among the houses: it stood waiting for stragglers in the enemy's sights. It
now closes up 75 m outside the edge of the town (or from the point): beyond a tank's sight
(44) and reach (40), and up to 90 m further back if the enemy is known to stand at that
place. It waits for 70% of its line (was 85%), 20 seconds at most once half are up (was
60), and not at all once anyone in it is shot at. A march stuck near a way point moves on
after 30 seconds (was 75).

**Move** (`M_MOVE`, T with the commander's troops selected). Plain move orders to the
place itself: nobody stops to fight on the way (moving units do not fire in this sim), no
houses, no breaking off. Once there the troops stand and shoot at what comes at them. It
is for manoeuvre; Attack and Hold remain the missions that fight for a place.

The golden hash is unchanged (919328295): the computer player does not use the staff.

## 095. Buildings come down sooner, and a battle wrecks the street it is fought in (2026-11-14)

Fabio, after playing the city: buildings are now too hard to destroy, and he wants more
destruction, including collateral damage from battles nearby. (He asked for tougher
buildings two days ago, 074. Both are right: the numbers of 074 were set for the four-cell
houses of the ridge map, and the houses of the city map average nine cells. At 450 a cell
and a quarter of a tank's shell reaching the structure, a lone tank needed fourteen minutes
for an ordinary city house.)

**Tougher by class, not by the acre.** Structure per cell 200, 400, 600 (was 450, 900,
1300); walls per cell of face 120, 220, 320 (was 200, 400, 600). Direct fire does half its
damage to the structure (was a quarter). A lone tank guts an ordinary city house in about
two minutes and levels it in three; four tanks need 45 seconds. A building looks damaged
at 80% (was 70%), so the first marks show sooner. Artillery: 160 a shell (was 120).

**Collateral damage.** Nobody has to order it:

- _Stray rounds._ A shot at a target in the open that has a building behind it, up to five
  cells on and in a fan a little to either side, also hits that building (`strayFire`,
  `UnitKind.stray`). Along a street that is the fronts on both sides. Bullets and light
  cannon (rifle and engineer squads 5, fighting vehicle 3) shoot a building up, as far as
  the damaged state, and wear its wall at half that rate: they cannot gut it. Shells,
  missiles and warheads (tank 30, missile team 20, strike drone 40) have no such limit and
  also catch a building their target is standing against.
- _Shell bursts._ Every building the burst reaches takes its share, full under the shell
  and half at the rim, as the men in the open always did (`blastStructures`). Before, only
  the building under the shell was hurt.
- _Vehicles that blow up._ A vehicle killed in a street does 60 to the buildings within
  six metres of it.
- _The fight inside._ Storming a held building costs it 16 a second while it lasts.

**What stays.** A ruin is still rubble that gives cover and can be fortified; a gutted
shell is still a position. A fortified building still loses a quarter less, to collateral
too, so fortifying matters more now that everything else is softer. Rifle squads ordered
onto a building, or firing at its garrison, do what they did.

**Measured.** Hard against hard on the city for 45 minutes, two seeds: 8 and 14 buildings
marked or worse before; 19 and 52 after, most of them shot up, 5 and 8 levelled. The
computer fields few guns, so a player with tanks and artillery will see more. Step time
unchanged (2.7 ms a tick mean; the lookups are a handful of cells per shot). New event
`EV_STRAY` (25) for the dust on the wall. Golden hash 1641703504.

**Not built:** fire that spreads, damage to street furniture and trees, an AI that shells
a held block on purpose (U5).

## 096. Normal becomes the middle level, and co-op adds far less to the computer (2026-11-14)

**What Fabio said:** after a three-player co-op session on normal: "normal was way too hard... needs some calibration".

**What was measured** (headless, city map, seed 1, the computer against an idle opponent):

| Level                    | Army points at minute 12 | at minute 15 | at minute 20 | First attack |
| ------------------------ | ------------------------ | ------------ | ------------ | ------------ |
| Easy                     | 108                      | 110          | 110          | minute 24    |
| Normal, before           | 325                      | 548          | 786          | minute 13    |
| Normal, 3 players before | 339                      | 606          | (won at 17)  | minute 9     |
| Hard                     | 419                      | 702          | (won at 15)  | minute 7     |
| Normal, now              | 248                      | 320          | 322          | minute 17    |
| Normal, 3 players now    | 246                      | 356          | 360          | minute 17    |
| Normal, 4 players now    | 248                      | 368          | 398          | minute 17    |

Two things were wrong. Normal was the computer at full stretch: seven times easy's army, at the 800 point cap that the players share. And decision 093's 35% per extra player (trucks, factories, army, sooner and more frequent attacks) made normal with three players play like hard, although three players have no more material than one.

**Decided:**

- Normal is the middle of the ladder: 320 army points (easy 110, hard 800), 14 trucks, 5 factories, first attack at minute 16, 2.5 minutes between attacks, raids from minute 18, 8 seconds before it answers an intrusion, 6 minutes away from a place where it was beaten, production on every second think. It keeps counters, raids, focus fire and its full field works.
- Co-op: 12% more trucks and army per player beyond two, nothing else. No sooner, no more often, no extra factories or garrison.
- Easy, recruit and hard are untouched. With one or two players easy, recruit and hard play exactly as before.

**Checked:** new normal against easy, six games of 45 minutes (three seeds, both sides): normal wins five in 27 to 44 minutes and is far ahead in the sixth (303 points and 6 towns against 56 and 3). New normal against hard, three seeds: hard wins two in 23 minutes and is far ahead in the third (660 points and 7 towns against 86 and 2).

**Not known:** whether a human team finds the new normal right; this is set from Fabio's one report and the computer playing itself. The step from normal to hard is now large (320 to 800 points); a level between them is the obvious next thing if normal becomes too easy.

## 097. Troops given to a commander from all over the map go to the objective (2026-11-14)

Fabio: troops in different parts of the map put under one commander walked back to one
spot and then moved oddly. Two causes in the staff. A new mission for scattered troops
began with a way point at the middle of where they all stood, so troops already at the
objective walked back from it (83 m in the test) and the guns and drones made for an
empty field. And troops added to a commander in the field were sent to where its body
was, not to where it was going (149 m back in the test).

Now the largest lot standing together is the body and the plan is made for it (`core`);
everyone else is joining and goes straight to where the body is going (`rally`): the
place it holds, the place an attack closes up outside its objective, the place it fell
back to. Whoever is already nearer the objective than that stays where he is until the
body goes in. An attack waits up to 45 seconds (not 20) at its closing-up place while
such troops are still within 300 m of it. Golden hash unchanged: the computer player does
not use the staff.

## 098. Richer maps, and flags that pay supplies and fuel (2026-11-14)

Fabio: resources run out quickly. Every number could simply have been raised; instead
most of the new income comes from ground held, so territory is worth fighting for.

- Every stockpile holds half as much again (`STOCK_SCALE` 3, was 2).
- Two more stockpiles a side on the city and ridge maps, between the base and each flank
  (`MAX_SITES` 48, was 32).
- A held flag pays 2 supplies and 1 fuel a second on top of its 5 credits
  (`TOWN_SUPPLIES`, `TOWN_FUEL`): about what two trucks bring in, it never runs dry, and it
  goes to whoever takes the flag. The resource bar shows "Flags N +S/min".

**Checked:** the computer on normal still stands at 320 army points from minute 13 and
attacks at minute 17 (city, seed 1): it was never short of supplies, the players were.
Golden hash 1160432643 (the stockpiles of the test's map are larger).

## 099. Commanders report every step of a mission, and obey a new order at once (2026-11-14)

Fabio runs commanders by ear: "I like the voice feedback once the commander reached its
objective, lets me manage without looking", but it came only some of the time; and
commanders were "slow to respond to orders".

**Why the voice was patchy.** Four causes, all on the client.

- Only two events were ever reported: an attack taking its objective and a Move arriving.
  Hold, Defend, Patrol and Screen never said they were in position.
- A commander's line was a note like any other, and a note within 6 seconds of another in
  the same 160 m square was thrown away, banner and all. "Building taken" during the
  storming of a town did that to "Alpha has taken Northgate" as a rule.
- The voice dropped any line within 3 seconds of the last one, so two commanders arriving
  together, or one arriving during an attack warning, lost the second line.
- The reports were one chain of else-ifs: one line per commander per snapshot.

**Now.** `src/client/reports.ts` works every commander's lines out the same way from the
snapshot: order received ("Alpha attacking Northgate, D4"), forming up outside, going in,
in position (every mission), has taken, has held, in contact / under attack with the grid
square, taking heavy losses (below 60% of its best strength), down to its last troops
(30%), falling back, regrouping, needs reinforcements, back up to strength, resuming, no
troops left. Each names the commander and the place with its grid square. A commander
stays off the air for 4 seconds after a line unless the next is urgent, and repeats a
kind of line only after 30 to 60 seconds. Commander lines bypass the note rationing
(`AlertBook.add`). `src/client/voice.ts` is a queue for the browser's voice: lines wait
their turn, urgent first, and go stale (25, 12, 6 seconds by level) instead of piling up;
at most 2 acknowledgements or 4 normal lines wait; a voice stuck "speaking" for 12
seconds is reset. Attack warnings are urgent but only worth saying within 4 seconds.

Co-op: the game does not record who gave an order, so each client remembers the orders
it sent; a change of orders it did not send within 6 seconds is somebody else's. A
player hears their own commanders; of a partner's, only the urgent lines are shown, and
silently. "Reinforcements arrived" is not reported as such: the staff counts troops in
when they are assigned, so the line is "back up to strength".

**Why orders were slow.** Measured with 50 units: quiet, nine in ten were under way 3.5 s
after the order; in a fight with the enemy not on the way to the new place, 20 to 42 s,
and some walked toward the enemy first. Causes in the staff: it thought once a second;
the march is an attack-move, so troops in contact stood and shot it out before going;
squads were sent to mount carriers under fire and both waited; troops still on their way
to the body kept walking to the old place until they stopped.

**Now** (`src/sim/staff.ts`): the staff thinks for a commander on the tick its order
arrives (`Staff.heard`); if any of the line is shooting at an enemy that is not nearer
the new place than itself, the line makes the first 70 m as a plain move (`disengage`),
then the march picks it up; an enemy on the way is still fought through; nobody mounts
under fire; joiners turn round at once (`Post.turn`). Same test: under 3 s in every case.
Golden hash unchanged (the computer player does not use the staff); the two-page co-op
run stays in sync.

## 100. A dropped co-op player comes back into the running game (2026-11-14)

Until now a lost connection ended that player's game: the others played on and the most
the host could do was restart for everyone.

**Decided: replay, not a copy of the world.** The host keeps a record of every tick that
had orders in it (`GameLog` in `src/client/replay.ts`; nearly all ticks have none). A
player who opens the invite link while the game runs is given the free seat, the same
game settings, and the record in pieces. His sim starts at tick 0 and plays it through
flat out, without pictures, sounds or hash reports, until it is within ten seconds of the
others; then it follows like any guest and the hashes are compared again. Sending the
world itself would have been quicker for him, but the world is not all of the state: the
computer player, the staff and several caches live outside it, and a copy that missed one
of them would drift apart silently. A replay is right by construction, because it is
exactly what lockstep already does.

- Only a seat someone left can be taken (the computer's strength was set by the number
  of players at the start), by anyone with the link, with any role.
- The host must stay: if the host goes, everyone plays on alone as before.
- A guest whose line dropped sees a "rejoin their game" button (it reloads the page).
- A line is given up after 12 seconds of silence on two checks running, as before, but a
  check after a stall of this page itself no longer counts, and a player coming back has
  90 seconds' grace while his page loads the map.
- Only the host announces pause and speed; a player coming back is told how they stand.

**Cost:** catching up takes as long as the sim needs to run the game so far: measured
headless, 0.7 ms a tick in a quiet game, so about a minute for every 25 to 30 minutes
played, more in a heavy battle. A notice shows the percentage.

**Checked:** `tests/lockstep.test.ts` (the record cut up and put together again is the
game tick for tick; a late player's world hashes equal to the host's), and three headless
browsers over `?net=local`: one closed, opened the link again, caught up, 14 hashes
compared with the others and none different. Not checked: over the real broker between
machines. Golden hash unchanged (nothing in the sim changed).

## 101. The computer skirmishes: small parties out all the time, big attacks rarer (2026-11-14)

Fabio: he would like the computer "more in favour of skirmishes instead of larger
battles, like small units coming and provoking". Until now it sat still between its big
attacks, apart from one raid by carriers on the trucks (normal and hard, late).

**Decided:** skirmishing parties (`Tuning.probes`, forces 2 and up in `ai.forces`). A
party is a handful of whole squads from the reserve and, from five squads up, one
carrier. It goes to a flag the enemy holds or nobody does, a stockpile on his side, or a
place where a few of his troops were seen in the last two minutes; never his base, never
where another party is going, and nowhere it expects to meet much more than twice its
own strength. It stays a minute, fight or no fight, and comes home; it also breaks off as
soon as it is down to 70% (an army holds on to 50%). It reuses the raid's machinery
(march, press, break off, fall back to the staging area).

| Level   | Parties out at once | From minute | One sets out every | Squads | Pause between big attacks |
| ------- | ------------------- | ----------- | ------------------ | ------ | ------------------------- |
| Recruit | 0                   |             |                    |        | 8 min (as before)         |
| Easy    | 1                   | 10          | 4 min              | 3      | 5 min (as before)         |
| Normal  | 3                   | 6           | 90 s               | 5 + 1  | 5 min (was 2.5)           |
| Hard    | 4                   | 3           | 45 s               | 7 + 1  | 2 min (was 45 s)          |

Easy's single party only answers the player (a flag he holds, a place he was seen): it
takes no empty ground, so easy stays as small as decision 070 made it.

**A consequence to watch:** a party that finds a flag empty takes it (six squads need ten
seconds), so on normal and hard an unguarded flag does not stay yours. That is the
provocation asked for, and it makes garrisons matter, but it is also more pressure than
normal had this morning.

**Checked** (headless, city map): normal still stands at 320 army points and makes its
first big attack at minute 17. Normal beats easy on three seeds (in 22 to 25 minutes;
before, 27 to 44), hard beats normal on two (25 and 34 minutes). Golden hash unchanged
(the pinned run has no computer player).

## 102. Civilians: 400 people in the houses, who run, can be hit, and cost the army that hits them (2026-11-14)

Fabio asked for civilians to make the city feel lived in, about 400 a map, with no gore,
and for casualties to be paid in resources so that players feel them.

**What a civilian is.** Not a unit. A number, a place, a home and a state, in arrays of
their own (`src/sim/civilians.ts`, at most 512). They do not block anyone, are not
targeted by anyone, cost no pathfinding of their own and are not in the unit count. At
the start the map puts 400 of them (or three a house, if that is fewer) into its houses,
from a random stream of its own so that the rest of the map is as it was.

**They run.** The map is cut into squares of 16 m. A shot fired or landing in a square
marks it dangerous for a few seconds. Once a second, a civilian at home looks at his own
square and its neighbours; if one is dangerous, or his house has come down, he leaves.
Everyone in the open follows one flow field to the nearest edge of the map (rebuilt every
30 seconds, since buildings fall), at a run slower than a soldier's, and is gone when he
gets there. The figures are drawn only where the player can see.

**They can be hit.** A shot whose line passes within 2 m of someone in the open kills him
one time in eight; a blast (grenade, rocket, drone) kills those within 5 m; a shell kills
in the open by its burst, and a shell on a house kills half of those still inside and
sends the rest running. Nobody aims at them: all of it is stray fire and collateral.

**No gore.** The figure falls, lies for a few seconds and sinks into the ground. No blood,
no sound of its own.

**The bill.** Each death costs the army that fired 100 supplies and 40 credits, at once.
Supplies may go below zero (down to -1500), so an army with empty stores still pays, by
building nothing until it has earned its way back. The player gets a "Civilians killed by
our fire" alert, and the towns panel counts those still in town, those who got out, and
those killed by each side.

**Checked.** Headless, city map, 30 minutes, normal against normal, three seeds: 5 to 6
killed, about 185 got out, about 200 still at home; the sim costs the same per tick as
before (1.9 to 2.1 ms against 2.2). Two computer players rarely fight in the housing
blocks; a player who shells a held block will pay far more. The knobs are
`CIVILIAN_SUPPLIES`, `CIVILIAN_CREDITS` and `STRAY_ODDS`.

**Golden hash** changes to 287657647: civilians are part of the world and of its hash
(state, deaths, where the runners are), so that co-op machines agree on them.

## 103. The end of a game shows what it cost, and names the best player of a shared army (2026-11-14)

Until now a game ended with one line on a banner. Fabio asked for a victory screen with
kills, losses, buildings destroyed, civilians lost, and an MVP for each co-op game.

**The sim keeps the score** (`World.stats`, the `STAT_*` numbers in `sim/world.ts`), so
every machine of a shared game shows the same one, and a player who rejoins has it too,
since his sim plays the whole game through. For each army: units destroyed, units lost,
and the army points of both. For the map: city buildings brought down. Civilians were
already counted (decision 102). A strike drone that went in is spent, not lost.

**Who gets a kill in a shared army.** Every order a player sends now carries his place
(`by`, 0 to 3). A unit he orders himself fights on his account from then on, until
another player orders it: its kills and its loss are his. Orders from a staff or from
the computer carry no name and change nothing, so troops handed to a commander stay with
the player who handed them over. Units nobody has ordered (fresh from the factory, a
garrison left alone) count for the army only. The MVP is the player whose units destroyed
the most army points; a tie goes to whoever lost less.

**The screen** (`client/debrief.ts`) comes up when a headquarters falls: Victory or
Defeat, how long the battle lasted, the two armies side by side (units destroyed, points
destroyed, units lost, flags held, civilians killed), buildings and civilians in a
sentence, and in co-op a line per player with his role. It stays up to date if the
player keeps watching. "New game" starts again.

**Not in the hash.** The score and the names on units decide nothing in the game, so
they are left out of the world hash and the golden hash is unchanged (a test pins that a
name on an order changes nothing).

## 104. Buildings come apart in a battle: a second, larger cut (2026-11-14)

Fabio, after playing 095: buildings must be destroyed more easily still; it takes too long
for a battle to do any meaningful damage. So the same levers again, further.

- Structure per cell 90, 180, 280 (was 200, 400, 600); walls 60, 110, 160 (was 120, 220,
  320). A lone tank marks an ordinary city house with its third shell, guts it in about 50
  seconds and levels it in 80 (two and three minutes after 095). Four tanks level a small
  house in ten seconds.
- A building looks damaged at 90% (was 80%) and is gutted at 40% (was 35%), so the first
  hits show.
- Bullets and light cannon now gut a building; they stop at 10% of its structure
  (`LIGHT_FLOOR_PCT`), so only shells, charges and warheads level it. Fighting vehicle
  stray 4 (was 3).
- Stray rounds carry eight cells past the target (was five). A shell cracks buildings out
  to one and a half times its killing radius. A vehicle that blows up does 100 within nine
  metres (was 60 within six).
- Storming costs the building 8 a second (was 16), which against the new strength is about
  what it was.

Ruins and gutted shells are still positions, and fortifying still takes a quarter off.

**Measured.** Hard against hard on the city: after 45 minutes on seed 1, 85 of 444
buildings are marked or worse and 21 levelled (19 and 5 after 095); on seed 2, 117 of 552
after 30 minutes. Golden hash 476858902.

## 105. Guns stop shelling a house once nobody is left in it (2026-11-14)

Fabio: on a commander's attack on a town, tanks sometimes go on shooting at buildings
with nobody there, until they are given another order.

Two causes. A house seen with enemy troops in it was remembered as held for three minutes
after the last sighting, whatever became of them, and stayed a strong point of the town
for that long. And the order to bring a house down has no end of its own: once the house
left the list of strong points, the staff simply stopped looking at the tanks working on
it, so they fired until it fell (reproduced: four tanks of four still shelling an empty
house 30 seconds on). When the town was declared taken in that state the staff never
looked at them again.

Now the computer and the staff forget a house the moment it is empty and they have eyes
on it (`perceive`), and whoever is still shelling a house that is not the current strong
point is stopped (`ceaseFire` in `src/sim/ai.ts`, called by the computer's assault, the
staff's attack, and on every new mission). Base buildings are still shelled empty or not.
Golden hash unchanged.

## 106. Helicopters limited by their pads, paratroops dropped from a reserve (2026-11-14)

Roadmap item 6. Fabio's brief: helicopters capped by helipads at about three a pad, "not
necessarily expensive but limited by landing space", in a transport and an attack role;
paratroopers built into a waiting reserve and dropped as a second step by a plane that
air defence can shoot down, and dear. All of it has to fit the army-mix pillar: aircraft
are the slowest and scarcest things an army has.

**Four new kinds** (`sim/units.ts`, 12 to 15; `KIND_COUNT` is now 16, all the slots there
are). The attack helicopter flies at twice a tank's speed, outranges a tank gun and kills
a tank in six salvos, with no armour at all: two air-defence vehicles shoot it down in
about four seconds, a street full of rifles or an autocannon wears it down. The transport
helicopter carries four squads with the load and unload orders carriers already have.
Paratroopers are a rifle squad and a half. The transport plane is not a unit anyone
orders: `validUnits` drops it from every order, the client never selects it.

**Landing space is the limit** (`sim/economy.ts`). The new Helipad (tier 2, 3 by 3) both
builds helicopters and holds `HELIS_PER_PAD` = 3. A helicopter at the head of a pad's
queue waits while the army has as many as its finished pads hold, the same way a unit
waits at the army limit. They cost a tank's fuel and about a minute each, 4 and 3 army
points. Lose a pad and the helicopters stay up, but no more are built until there is room.

**Paratroops** (`sim/air.ts`). Trained at the Barracks from tier 2 (90 supplies, 90
credits, 14 seconds, 2 army points), they do not walk out of the door: `World.paraReserve`
counts them, up to 16, and they count against the army limit while they wait. The drop is
one new order, `CMD_PARADROP` (team, x, y): a plane appears on the edge of the map nearest
the army's start with up to eight squads aboard as real units riding in it, flies straight
at the point at 22 m a second, puts them out scattered within 9 m (each on ground it can
stand on, unable to fire for three seconds), turns and leaves by the edge it came from.
Only air defence can hurt the plane; shot down on the way in, everyone aboard dies with
it. On the ground paratroops are ordinary infantry with two minutes of rations, so a drop
far from the army is a raid, and a drop the army reaches in time is a bridgehead.

**Smaller rules.** Jamming is now for drones only (`IS_DRONE`): a helicopter has a crew
aboard. Out of a helicopter that is shot down a quarter of each squad gets out (half out
of a ground carrier). Rifles, autocannon and engineers can now hit helicopters; nothing
on the ground but air defence reaches the plane.

**The computer** (`sim/ai.ts`). Normal keeps 2 attack helicopters and hard 3: it builds
one helipad after its drone workshop from minute 10, buys the helicopters by the head, and
they go out with the field army behind its line. Normal trains 4 paratroop squads for one
drop from minute 15 and every 6 minutes after, hard 8 from minute 9 every 4; easy and
recruit have no air at all. A drop goes to a flag the enemy holds or a stockpile on his
side, away from his base and from wherever his troops were seen; the squads take the
place, hold it, and move to the next one in reach when it is quiet. And it counters: a
helicopter seen counts as two drones and a transport plane as three when it decides how
much air defence to build.

**The player.** J, or the "Paratroops N (J)" button that appears in the top bar while
there is a reserve, then a click on the map or the minimap. A banner and a spoken line
say when a plane comes in ("Enemy transport plane: air defence!") and when paratroops
land. The helipad's card shows the landing space used. In co-op the "Air and drones" role
covers the three new kinds.

**Determinism.** The drop is a command, the reserve and the helicopter counts are world
state and in the hash, the scatter comes from the world's generator. The golden hash
changes (476858902 to 1084769414) because the hash now includes those fields.

**Not done.** The computer does not use transport helicopters. Helicopters do not have to
return to a pad to rearm. There is no fighter cover: the plane's only enemy is air
defence.

## 107. The European city: one dense city on a river, bridges balanced by covered crossings (2026-11-14)

Roadmap item 7 (Fabio: "much denser, big parks, an elevated highway, a river with a few
bridges balanced by tunnels, a central station, fighting inch by inch"). A fourth map layout,
`euro` (`?map=euro`, or Menu > Map: European city). The city map stays the default until
Fabio has played both.

- **One city, not nine towns.** A band of blocks five deep on each bank of a river that runs
  down the mirror line of the map, on one street grid. 680 buildings against the city map's
  444, in about a third of the map; the rest is fields, a village and a road net behind each
  bank. The limit of 1024 structures leaves about 340 for bases.
- **The river cannot be forded.** Seven crossings: four bridges (cut and mended like the river
  map's) and three places where the river runs under the ground in a culvert, under the
  cathedral square in the middle and in the fields at both ends. Real tunnels would need a
  second level of pathfinding; a culvert gives the same play (a crossing no gun can cut) for
  none of that cost. Cutting all four bridges sends the fight to the square and the flanks; it
  never seals a bank. A test shuts every bridge and two of the three culverts and still finds
  a way for vehicles.
- **Bridges are squares.** The river runs along the diagonal, the streets along the axes, so a
  street reaches the river at a corner and meets its mirror image there. A bridge is therefore
  a square of eleven cells with four streets on it, drawn as a stone bridge square with
  balustrades over the water.
- **The motorway** is an embankment nobody can cross (cliff cells), one in each half, with a
  deck drawn on top (`map.decks`, scenery only). Four streets pass under it, two are shut by
  it. It breaks the long view down the bank and makes moves along the bank go through gates.
- **Parks** are woods and lawns with paths: infantry ground with a rich supply site in the
  middle of each, a short walk from the river.
- Thirteen flags: four quarters on each bank facing the crossings, a station quarter and a
  village behind them, and the shared Cathedral Square.

The AI needed no change to play it: the map names its seven crossings as lanes. A hard
against normal game ran to a finish in 26 minutes at 2.9 ms a tick mean.

No change to the other maps (the city map's hash is the same before and after) and none to
the golden hash.

## 108. Infantry does not walk at armour it cannot hurt (2026-11-14)

Formations piece 1 (proposal in the "Design tactical attack formations" thread; Fabio:
infantry dies first, running at tanks). The cause was not the march formation but what
happened at first contact: every unit dropped its place and walked at the nearest enemy until
that enemy was inside its own range, so rifle squads (range 15) ended up in front of their
own tanks (26) and missile teams (34), walking at tanks they do 3 a shot to.

- **A table of what can hurt what.** Kind A is effective against kind B if it kills it in 45
  shots or fewer. Rifle squads, engineers and IFVs are not effective against a tank; squads
  and engineers are not against an IFV or a helicopter.
- **A unit shoots whatever is in range, as before, but walks only at what it can hurt.** An
  idle squad that sees a tank stays where it is. A squad on an attack-move marches on to
  where it was sent and neither chases the tank nor stops for it.
- **It picks a target it can hurt first**, unless one it cannot hurt is much nearer (24 m).
  A squad shoots the enemy squad, not the tank beside it.
- **Told to attack a tank, it goes** (the attack order is the player's decision).
- **Point blank is the exception.** Rifle squads and paratroops rush a vehicle that has come
  within 18 m of them and close to 6, where their rockets do four times the damage (decision
  from the rebalance). A tank that drives into infantry still pays; one that stands off does
  not get swarmed, and has to be answered with missile teams, tanks, guns or drones.

Applies to everyone: direct orders, commanders, the computer.

Checked against the army-mix pillar: 15 rifle squads and 10 missile teams (25 points) beat 5
attacking tanks (25 points) on open ground with 16 of 25 left. Two computer games ran to a
finish. Golden hash 1084769414 -> 1843229346.

## 109. The staged attack was measured and not built (2026-11-14)

Formations piece 2 was a drill for a commander's attack: recon ahead, missile teams (and
tanks in open country) set an overwatch at stand-off range, the squads wait until the enemy
armour is dead, smoke has landed or 40 seconds are up, then infantry leads in a town with the
tanks 25 m behind. It was built in full and run against the attack as it stands after
decision 108 (the whole body goes in together, each unit halting at the range of its own
weapon). Same seed, same armies, one commander against a town; army points lost, and seconds
until the town was secured ("lost" = the commander broke off beaten):

| Fight                                                              | As it stands    | Staged          |
| ------------------------------------------------------------------ | --------------- | --------------- |
| Hill town, 2 tanks + 3 squads, against 12 squads + 5 missile teams | 3 of 18, 53 s   | 5 of 18, 67 s   |
| The same with 2 tanks of its own                                   | 2 of 28, 49 s   | 9 of 28, 72 s   |
| Hill town, 3 fighting vehicles + 4 squads                          | 1 of 17, 53 s   | 7 of 17, 71 s   |
| Hill town, 8 squads, no armour                                     | 0 of 27, 53 s   | 1 of 27, 52 s   |
| Hill town from far off, 3 tanks, missile teams only                | 2 of 17, 94 s   | 17 of 17, lost  |
| City quarter, 3 tanks + 6 squads                                   | 6 of 33, 87 s   | 12 of 33, 172 s |
| City quarter, 2 tanks + 2 fighting vehicles + 6 squads             | 3 of 33, 72 s   | 29 of 33, lost  |
| City quarter, 5 tanks + 6 squads + 2 missile teams                 | 9 of 39, 91 s   | 21 of 39, lost  |
| City centre, 4 tanks + 3 fighting vehicles + 8 squads              | 16 of 60, 117 s | 25 of 60, lost  |

Seventeen fights were run; the staged attack lost more in every one. Tanks trailing the
squads in a town made it worse again wherever the body had tanks (second row: 9 lost becomes
11; the no-armour row: 1 becomes 3). Recon sent ahead on its own, with nothing else changed,
cost one or two points more in 15 of the 17, the drone being the first of them.

Why, in this game's rules:

- **Fire is spread over whoever is in sight.** Sent ahead alone, five missile teams are the
  only thing two tanks have to shoot at, and they die before the squads arrive. Going in
  together, the tanks shoot at twenty things while every missile team shoots at them.
- **There is no stand-off uphill or in a street.** A missile reaches 34 and a tank gun 26,
  but a tank on higher ground gains up to 5 and the team below loses 2, and among houses
  nobody sees anybody until about 25. The overwatch position the drill needs often does not
  exist.
- **Squads cannot hurt a tank, so a tank in front of them is cover, not a liability.** Rifle
  fire does nothing to it, and since decision 108 the squads no longer run past it at the
  enemy's armour. Holding the tanks back hands the squads the fire the tanks would have
  taken for free.
- **The attack already sorts itself by range.** Missile teams stop and fire from furthest
  back, tanks from 26, squads close only with what they can hurt. That is the support by
  fire the drill was meant to add, without the wait.

So nothing of the drill ships: no overwatch, no wait, no trailing tanks, no recon sent ahead.
Decision 108 was the fix for infantry dying first. `tests/assault.test.ts` pins five of the
fights above with room to spare, so that a later change to the attack has to do at least as
well. Pieces 3 (drill presets per commander) and 4 (the computer uses the drill) are shelved
with it; what is still worth having from them is noted in the roadmap.

## 110. The computer in a city: sandbagged houses and held ruins (U5) (2026-11-14)

Roadmap item 8. Before this the computer already put its garrisons into houses a few squads
to a house, moved them out of a house about to fall, stormed houses the enemy held (with a
breach and smoke where it had them) and left a garrison in a town it took. What it could not
do was use what decision 091 gave the player: fortified houses and ruins.

- **Its sappers fortify the houses its garrisons hold.** When they have no wire or
  obstacles to lay, they sandbag and loophole the houses its own men are in, the ones facing
  the enemy first, one house at a time: 15 seconds for one squad. A fortified house holds
  half as many men again, lets a quarter less fire through and takes a quarter less damage
  (decision 091). Hard does up to five houses a town, Normal two, Easy and Recruit none.
- **A garrison that has lost its houses lies up in the ruins**, three squads to a ruin, a
  dug-in ruin first, instead of standing in the street. A ruin halves what reaches the men
  in it. The sappers then dig that ruin in (35% reaches them instead of 50%).
- **The player's commanders do the same.** On Hold, Defend and after taking a place, a
  commander's squads use the ruins the same way, and its engineers sandbag the houses and
  ruins its squads are in, one after another. They only fortify: mending a damaged house
  costs supplies, and a commander does not spend the player's supplies unasked.

Not built, and why:

- **Armour kept behind the infantry in streets, and attacks routed by street.** Decision 109
  measured tanks trailing the squads in a town: the body lost more every time. In this
  game's rules a tank among squads is cover for them.
- **Marksman teams and top attack on tanks in streets** (the "urban units" half of U5).
  New units belong with the factions (M10), where each roster gets its own answer to a held
  block.

Three computer games ran to a finish (European city, the city, the ridge). Golden hash
unchanged: the sim's rules did not change, only who gives which orders.

## 111. Civilians are people the size of the soldiers (2026-11-14)

Fabio: the civilians were too big beside the soldiers and too boxy. They were: six boxes
1.7 map units tall, where a soldier stands 0.62, so a civilian was 2.7 times a rifleman.

- **Same scale as the soldiers** (0.62 units for 1.8 m). Adults vary a little in height and
  one in seven is a head shorter.
- **Built like the soldiers**: skins over rings, so they have shoulders, a waist, calves and
  a head with hair. No helmet, no kit, no weapon.
- **Three kinds**: a jacket, a long coat with a bag, a hooded top with a rucksack. Skin, hair
  and trousers go with the kind; the clothes above the waist take one of eight muted
  colours as before.
- **They run**: each kind has two strides, swapped five and a half times a second, with a
  small bounce at each footfall.
- **Cost**: under 700 points a figure, six instanced batches in place of one. At 400
  civilians that is at most 280,000 points, and only those in sight are drawn.

Client only: nothing in the sim changed.

## 112. Attack style is the player's switch, not a drill (F3 and F4) (2026-11-14)

Formations pieces 3 and 4 were written before decision 109 found that the staged attack
loses to going in together. What is left of them, built honestly:

- **Each commander has an attack style**, a button on its row that cycles through three:
  **together** (the default: everyone goes in at once, which lost the fewest troops in
  every fight measured), **infantry first** (vehicles keep 25 m behind the squads until the
  squads are within 22 m of the objective) and **armour first** (the squads keep 25 m
  behind the vehicles). The tooltip says what each costs.
- **Why offer what measures worse:** the measurement was against tanks and squads. A player
  who knows a town is full of missile teams may rather lose squads than tanks, and one who
  is short of squads may rather risk the tanks. That is a judgement about what he can
  afford to lose, which is the player's to make, and it costs nothing when left alone.
- **The four presets of the proposal are three.** "Rush" was the present attack under
  another name, and "combined" was the staged drill, which is not built.
- **The computer does not use a drill (F4).** It attacks together on every level, because
  that is what wins. Making Hard stage its attacks would have made Hard easier.

The style is two bits of the commander's flags, set by a new command (`CMD_STYLE`), so it
is in the state hash and travels to every player in co-op like any other order. Disbanding
a commander clears it. Golden hash unchanged.

## 113. Night battles: you see what is lit (2026-11-14)

Roadmap item 9. A night battle is a choice at the start (Menu, Time: night, or
`?time=night`), not a clock that runs during a game: a day and night cycle would change the
rules under a plan half carried out.

- **Shorter sight.** At night every unit sees and shoots six tenths as far as by day
  (`NIGHT_SIGHT_PCT`). The reconnaissance team and its drone are the exception: night
  optics are what they are for, and at night they are worth having.
- **Light gives you away.** A unit is _lit_, and seen at full daytime range, when it has
  fired in the last 2.5 seconds (its muzzle flash), stands within 14 m of a vehicle that
  has been burning for less than 45 seconds, or is under a flare. So the first to fire is
  the first to be shot at from beyond his own sight, and a tank burning in a street shows
  the squads round it.
- **Flares.** Any gun fires one in place of a shell (key I, or the Flare button; the
  nearest selected gun fires). It hangs 30 seconds and lights 42 m around, both sides
  alike. The computer and the player's commanders fire one over the objective when an
  assault goes in and renew it while the assault lasts. At most 16 hang at once.
- **Weapon range is unchanged**: guns that are given a target (a lit one, or one a scout
  sees) still reach it. Cameras and the spotter rules are as by day.
- **Readability.** The night is moonlit, not black: ground, buildings and troops stay
  legible, team colours and icons are as by day, and fire stands out. Muzzle flashes are
  twice the size, wrecks burn visibly for as long as the sim counts them a fire, and the
  two flares nearest the camera are real lights. The fog of war follows the same rules as
  the sim: the short sight, plus circles for flares, flashes and fires.

In the sim: `World.night`, set by `CMD_NIGHT` on the first tick; `World.lit`, recomputed
every 4 ticks only at night; flares are part of the state hash only at night. By day not
one instruction differs, so the golden hash is unchanged. Co-op carries the choice in the
host's game settings. A 30 minute Hard against Hard game on the city map runs at the same
cost by night as by day (1.6 ms a tick).

## 114. Versus: red against blue, sides in the lobby (2026-11-14)

Roadmap item 10, on the co-op netcode unchanged: the host's sim is the clock, only orders
travel, hashes are compared every two seconds, a player who drops can come back.

- **The lobby has a mode.** The host chooses "Together against the computer" (co-op, as
  before) or "Versus". In a versus game every player picks a side, red or blue. A newcomer
  is put on the side that is short of a player; the game starts once each side has one.
- **A side is a shared army.** Players on the same side command the same army exactly as
  in co-op (roles, pings and each other's view on the minimap, all within the side). So two
  a side is 2 v 2, one a side is a duel, and 2 v 1 or 3 v 1 are allowed.
- **No computer.** Both armies start alike (same troops, stores and headquarters on the
  mirrored start plots). Both have their sub-commanders: every sim runs the staff of both
  armies, and each player's screen shows his own side's.
- **Each side sees only its own fog of war.** `?fog=0` is dropped in a versus game; pings
  and camera positions from the other side are not shown.
- **Night, the map and the seed** are the host's, as in co-op.

**Not built: a free-for-all of three or four armies.** Every map is laid out for two
sides: mirrored terrain, two start plots, two sets of base resource sites, towns placed
to be equally far from both. Four armies need maps drawn for four corners and a victory
rule for several survivors; putting two more bases on a two-sided map would hand the
middle seats a worse game. With two players a versus game is already the free-for-all.
A four-corner map is the piece to build next for this.

In the code: `Config.versus` and a team per seat travel with the game settings; the
client's "my army" (`ME`, `UnitView.playerTeam`) is set from the seat instead of being 0;
the worker creates no AI and a second staff. Nothing in the sim changed: golden hash
unchanged. `tests/versus.test.ts`: equal starts, blue's commanders, lockstep with orders
from both sides.

## 115. Graphics polish 3: a city that is lit at night, and a river that reads as water (2026-11-14)

Fabio asked for another layer of polish with the overnight run. What was already there
(bloom, grade, ambient occlusion, cloud shadows, fire glow, rubble, baked materials) was
left alone; this adds what the screenshots showed was missing.

- **Lit windows at night.** One window in eight has a light on behind it, warm and each a
  little different. It costs no geometry and no new vertex attribute: the mark is carried
  in the window's gloss (0.9 instead of 1), and the building material adds an emissive
  term at night. When a house is damaged or brought down its windows are rebuilt as holes,
  so its lights go out with it.
- **Street lamps at night.** Two lamps in three burn: a pool of warm light on the pavement
  and a glow at the head. Two flat additive quads a lamp, one instanced mesh for the whole
  map, no real lights, so the cost does not grow with what is being lit.
- **Bloom at night on Normal as well as High**, and stronger: at night lamps, windows,
  flares, tracers and fires are the picture. The frame governor can still switch the whole
  post pipeline off if the frame rate needs it.
- **Softer shadow edges** (PCF soft, a small radius by day and a larger one by moonlight).
- **The river.** From the camera's height it was a dark ditch. The sky now lies on it,
  more where the ripples tilt, so the surface moves and reads as water.

Before and after: `/mnt/project-files/overnight-4/polish-*.png`. Client only: nothing in
the sim changed. `?quality=low` gets none of it, as before.

Left for a later pass, seen in the same screenshots: the river banks follow the map cells
and so run in a zigzag; trees are still the simple low-poly crowns; large flat roofs are
plain from above.

## 116. Helicopters fight helicopters, and hunt when left alone (2026-11-15)

Fabio: "helicopters are not very proactive and dont engage other helicopters... maybe they
should."

- **They could not.** The attack helicopter's damage against anything that flies was 0, so
  two of them hovered side by side. It now does 35 a salvo to an attack or a transport
  helicopter (five salvos, about ten seconds, to bring one down), and picks a helicopter in
  reach before a ground target unless that one is some 30 nearer. Drones and the transport
  plane are still out of its reach: drones are air defence's and the jammer's business.
- **They waited.** A helicopter only engaged what came within 44 of it. One that stands
  without orders now hunts (`huntHelis` in `sim/sim.ts`): every second it looks for the
  nearest enemy its army knows of within 110 of where it was left (an enemy helicopter:
  within 220, and before anything else), flies there fighting, and goes back to where it
  was left when nothing is known any more. Where it was left is kept in `aimX/aimY` under
  the new `FLAG_HUNT`; any order ends the hunt, and Hold (H) or hold fire keeps it at home.
  The computer's helicopters do the same.
- A helicopter and an air-defence vehicle are an even fight one against one, so a hunt into
  air defence costs helicopters: the leash is short of the usual distance between two
  armies' lines, and Hold is the player's answer.

Golden hash unchanged (no helicopters in it). Tests in `tests/air.test.ts`.

## 117. Concentrate: a commander's troops on one exact spot, now (2026-11-15)

Fabio: "Commander actions on attack are still a bit hit and miss... sometimes we need a
troop concentration in one spot and it takes ages, requiring us to remove the units from
the commander so we can better direct them. Any chance we could do something different
here without ruining the commander experience?"

An attack is slow on purpose: it forms up, marches at the pace of the slowest, closes up
out of sight of the objective, and then takes a town, not a point. All of that is right
for taking a grid square and wrong for "everyone to that corner". The answer is not to
make the attack quicker (that is the staged attack of decision 109 in reverse) but a
second order beside it:

- **Concentrate** (`M_FOCUS`, mission 7; R with the commander's troops selected, or the
  button on the board, then a click). Everything the commander has goes to the exact spot
  clicked. One order per kind of mover, so tanks, carriers and helicopters go at their own
  speed and nobody is held to a squad's pace. No forming up, no closing up outside, no
  waiting for stragglers.
- Further out than 70 a unit moves without stopping to shoot; inside 70 it attack-moves,
  so the last stretch is fought and the body arrives fighting. From more than 200 away and
  out of contact the squads ride in whatever carriers the commander has, and get out when
  they are there or when the enemy is near.
- On the spot the body stands close (within about 20 plus 2 per square root of its number)
  and shoots at what it sees. Whoever chased something comes back when he has nothing
  left to shoot at. Guns stop 70 short, from where they reach everything round the spot.
- It never falls back and never goes into the houses: with this order the player has
  taken the decision of where the troops stand. Giving the commander its mission again
  (Attack, Hold, ...) hands the thinking back.
- The troops stay the commander's throughout: replacement of losses, reports ("Alpha
  concentrating on D4", "Alpha massed at D4"), the board and co-op ownership all work as
  for any mission.

Measured (`tests/commanders.test.ts`): eight squads, four carriers and three tanks, 310
from the spot, twelve of fifteen within 30 of it after 44 seconds; the same troops ordered
to attack the same spot take 85. Only the staff changed, and the golden hash has no
commanders in it: unchanged.

Not done: a concentration does not split a commander (all of it goes); the computer does
not use it.

## 118. Demolish: engineers fell woods, and a house brought down kills who is in it (2026-11-15)

Fabio: "could we add the idea for engineers to destroy scenarios? like trees, buildings,
etc? Collateral damage to civilians would be big when destroying buildings, but that's a
great gameplay feature."

Engineers could already lay charges against a building or a bridge (Ctrl+right click) and
breach field works; nothing said so, trees could not be touched, and the people in a house
taken apart without a shot fired near it walked out unharmed. Three changes:

- **One order, one button.** Demolish (O with engineers selected, or the card button),
  then a right click on the target. A building or a bridge: charges, as before (a squad
  does 90 every 2.5 seconds; two squads bring an average city house down in about ten).
  A wood: felling. A wall, wire, an obstacle, street rubble: charges and cutters; one of
  your own works is simply taken down.
- **Felling** (`sim/demolish.ts`, `CMD_FELL` 38, `JOB_FELL`). Every forest cell within
  two cells of the one clicked becomes open ground, two seconds of work a cell for one
  squad: a patch about 20 m across in 40 seconds, half that with two squads. Open ground
  is open ground: vehicles cross it, nothing hides in it, the view goes through. A lane
  through a wood for the tanks, a field of fire in front of a position, an ambush taken
  away. Trees do not grow back. The cells are world state (`felled`, in the hash once
  there are any) and reach the client in the snapshot, so a player who rejoins sees the
  same map.
- **The people inside** (`civiliansBuried`). When the floors of a house come down
  (gutted) or it falls, half of those still at home die and the rest run, and the army
  that did it pays for each as for any other civilian. Civilians leave a house when there
  is shooting near it, so in an ordinary street fight most are gone by then; charges give
  no warning, and neither does a tank taking a house apart from up the street on a Ctrl
  click. To know whose it was, every hit on a structure now carries its army (`structBy`).
  A house that falls with nobody to blame kills nobody.

Golden hash unchanged. Tests: `tests/demolish.test.ts`. Checked in a headless browser on
the ridge map: before and after in `/mnt/project-files/nov15-fixes/fell-*.png`.

Not done: shells and tank guns do not knock trees down; the computer's engineers do not
fell or demolish on their own; street trees, fences and lamps on the city maps are
drawing only and stay.

## 119. More civilians, most of them round the flags, and not all of them run (2026-11-15)

Fabio: "we also need a bit more civilians per map... we are killing at most 2-4 per
match, which is unreal in a big urban battle."

Measured first (`tools/toll.ts`, hard against hard, city, 30 minutes): 8 dead on seed 1
and 1 on seed 2, of 400. Two reasons: there were few of them (fewer than one a house),
and every one of them left at the first shot within a street or two, long before anything
dangerous happened to the house.

- **1,400 a map instead of 400** (`CIVILIANS`; `MAX_CIVILIANS` 2048), or as many as the
  houses hold on the small maps (ridge 373, river 512).
- **By the size of the house and where it stands.** A house holds one person and one more
  for every four cells of floor over all its storeys, twelve at most; twice that inside a
  flag's circle and half as much again out to twice the circle (`homeRoom`). People are
  drawn into houses in proportion to that room, never more than a house holds. The blocks
  round a flag, where the fighting is, are where the people are.
- **One in three stays** (`SHELTER`). They sit in the cellar while the shooting goes on
  outside and come out only when the house itself is shelled, gutted or brought down
  (decision 118), which is when they die. So what a battle does to the houses now decides
  what it does to the people in them, and shelling a held block has a price.
- The cost of a death is unchanged (100 supplies and 40 credits to the army that fired).

Measured after, same games: 19 and 43 dead on the city map (seeds 1 and 2), 67 on the
European city. That is about 50 to 70 supplies a minute for each side in a computer's
game; a player who shells housing will pay more. Sim cost unchanged within noise (1.5 to
1.75 ms a tick at about 1,100 units; civilians at home are looked at once a second).

Golden hash 1843229346 to 4027169720 (the same world now has more people in it).

To watch: if the bill is too heavy for the way Fabio plays, lower `CIVILIAN_SUPPLIES`
before the number of civilians; if deaths are still too few, `SHELTER` 2.

## 120. Buildings a sixth easier to bring down (2026-11-15)

Fabio, after the second cut (decision 104): "Destruction is almost there... we need just
slightly more easiness to destroy buildings, not too much, we are almost there."

One lever, one small step: the structure of a building per cell of ground plan goes from
90/180/280 (house, block, hall) to 75/150/235 and its walls per cell of face from
60/110/160 to 50/90/135. About a sixth less of both. Nothing else moves: the stages
(marked at 90%, gutted at 40%), stray fire, what bullets may and may not do, fortifying
and the ruins as positions are as they were.

What it means: a lone tank guts an average city house (nine cells) in about 42 seconds
instead of 50 and levels it in about 67 instead of 80; two engineer squads bring one down
in about eight seconds of charges instead of ten. In a computer's game on the city map
(hard against hard, 30 minutes, seed 1, `tools/toll.ts`) 91 of 444 buildings were marked
or worse against 75 before; on seed 2 the two battles went differently enough that the
count did not move (92 against 100), which is the size of step that was asked for.

Golden hash 4027169720 to 3501695057.

If it is still short of what Fabio wants, the next step of the same size is 62/125/195
and 42/75/112; the other levers are in decision 104.

## 121. The town from mid zoom: houses in a row, not crates (2026-11-15)

Fabio: "mid zoom is still boxy", and the night battles showed his machine has room.

Looked at first (city map, camera 150 and 280 out): every big building was one box under
one dark slab, with roof clutter 0.7 across on a roof 15 across, standing in bare beige
paving. The camera looks down at 45 to 56 degrees there, so roofs and ground are most of
what is seen.

- **Blocks are rows of houses** (`src/client/blocks.ts`). A building 10 or more across is
  drawn as houses side by side, each with its own colour, eaves a little higher or lower
  than the next, and its own roof: tiled gable with dormers, twin gables with a valley,
  slate mansard, flat roof, set-back top storey. Firewalls and chimneys stand between
  them. The deepest (14 and up) are mostly a ring of houses round a courtyard that is
  really open. The sim knows none of it: footprint, outer walls and counted floors are
  unchanged, so cover, sight and damage are as they were.
- **Flat roofs are furnished to their size** (`flatStuff`): a stair head, cooling plant
  and ducts, skylights, solar panels, tanks, aerials, parapets with a coping.
- **The paved ground is dressed** (`Land.forecourts`): car parks with marked bays and
  cars, gardens with town trees and hedges, fenced earth yards, squares in two tones of
  slab. Drawn and propped only; units go through it as before.
- **Broadleaf crowns are lumpy**, not balls (same triangle count).
- **Panes are two faces, not boxes** (`boxOrSlab`): anything 0.06 thin or less. A town
  has tens of thousands of windows and this pays for everything above.

Measured (headless, camera 280 over the centre, peak triangles a frame with the shadow
pass): city 1.54M before, 1.25M after; European city 2.28M before, 1.57M after. So the
richer town is cheaper to draw than the plain one. Real frame rate is Fabio's to report.

Not done here: vehicles and base buildings were left as they are; far facades and the
roof fade are item 6 of the same run.

## 122. Finding the infantry from mid zoom without making it bigger (2026-11-15)

Fabio wants realistic proportions (no oversized men) and asked for other ways to find
infantry from mid zoom. Offered: brighter fire, dust, a rim light or outline. He chose the
first two and ruled the outline out for now: "having the glow around them might be too
much with the number of units we have on the field at once". A soft contact shadow was
allowed if cheap.

- **A muzzle flash is never smaller than about three and a half pixels, a tracer never
  thinner than a pixel and a quarter** (`FLASH_PX`, `TRACER_PX` in effects.ts). Up close
  nothing changes: the floor only bites where a flash had shrunk below it, from about
  camera distance 100 outward. Tracers also burn up to a third brighter from far off and
  last a frame or two longer. So a firefight is a patch of sparkle and streaks at any
  zoom, which is what the eye needs to find.
- **Squads on the move raise dust** (`Effects.dust`): a pale puff that hangs for two or
  three seconds and drifts with the wind, much less on paving, none in water. Rationed
  over the whole field (about 420 puffs a second at most, so about 1,200 live sprites
  however many squads march), and switched off by `dustiness` when the weather is wet.
- **A soft patch of shade under each squad** that is too far off for a real shadow: one
  flat quad a squad, one draw call.

No outline, no rim light, no change of size. Render only; golden hash untouched.

Checked in a staged fight of 40 squads a side at camera distance 150 and 190: flashes
and tracers read clearly where before the tracers were dotted hairlines; the dust shows
as a pale trail behind a marching platoon. How it reads on a real screen at 60 frames a
second is Fabio's to say; the three numbers above are the levers.

## 123. Factions are versions of one roster, not three rosters (M10, 2026-11-15)

Three armies: the Western alliance, Russia and China (`src/sim/factions.ts`).

**What a faction is.** The same sixteen kinds of unit, each in the faction's own version:
percent changes to hit points, speed, reload, damage, blast, jamming, price and build
time, plus or minus a few units of range and sight, its own name, and one kind it does
not field at all. Everything that read the one table (`KINDS[kind]`) now asks
`kindOf(w, unit)`; prices come from `unitPrice(w, team, kind)`. Faction 0 is the plain
table, so every test, scenario and measurement made before M10 is unchanged (golden hash
3501695057 holds). `CMD_FACTION` sets a team's faction on the first tick; it is part of
the hash only when set.

**Why versions and not new units.** A unit that only one side has needs a model, a
counter, a place in the AI, in the commanders' staff and in the co-op roles. Three times
that is a milestone of its own and would have taken the whole run. Versions give each army
a different feel and a different best plan for one day's work, and the table is the
place to add true one-faction units later.

**The three.**

- Western alliance: fewer, better, dearer. Heavy tank (+15% hp, +2 range and sight, +30%
  price), tougher infantry that sees further, precision gun (+15 range, slower, smaller
  blast), dear loitering munition that hits harder, the best gunship. No jammer.
- Russia: mass. Assault tank at 78% price that fires 15% faster with less armour, rocket
  battery (short, fast, wide), air defence with +8 reach, heavy jammer, armoured gunship.
  No transport helicopter.
- China: numbers and drones. Infantry at 85% price and 75% time, swarm drone at 60%,
  wheeled carrier that is fast and seats three, truck gun, hardy engineers, light cheap
  gunship. No paratroopers.

The computer builds to its faction: `share` scales how much of each kind it wants.

**Balance.** `tools/factionduel.ts` plays hard computer against hard computer for 25
minutes. Three rounds of tuning, 132 battles on ridge and city. Last measured round (48
battles, each faction in 32): alliance 16, Russia 12, China 20, followed by a small nudge
to Russia up and China down that was not measured again. The side that starts in the
first corner won 31 of 48, so the map counts for more than the faction. Good enough to
play; not proof of balance between people.

**On screen.** `?army=nato|russia|china|none` is red, `?foe=` is blue; default alliance
against Russia. Menu: Army and Enemy. The host's choice goes to guests with the rest of
the lobby settings. Names and prices in the card and the production panel are the
faction's; a kind it lacks has no button. Each faction has a base coat (olive drab, dark
green, sand khaki) carried in the per-instance seed, so no new draw calls. Team colour
markings stay red and blue: who is whose matters more than which army it is.

Not done: units unique to a faction, faction buildings, voices. Scenarios other than the
skirmish stay on the plain table.

## 124. Free-for-all: up to four armies, a map with four corners (2026-11-15)

**What.** `?armies=3` or `4` (Menu: Armies) starts a skirmish in which every army is on
its own side: red is the player (and co-op partners), blue, gold and green are computers
that fight the player and each other. It is played on a new map, `four` ("four
corners"), which can also be played with two.

**The map** (`generateFour` in map.ts). One eighth of the ground is made and mirrored, so
it is the same seen from every corner. A base in each corner; a village for each army
between its base and the middle; a settlement half way along each edge, between two
neighbours; the largest settlement on a low hill in the middle: nine flags. Copses
everywhere, cleared round the bases and settlements, on the two tracks that cross in the
middle and on each diagonal, so every base can be reached several ways. Each army has
the same seven sites near home; the edges and the middle hold the rest.

**The sim.** `MAX_TEAMS` is 4. Nothing else in the sim needed to change: it never knew
two sides, only "not my team". `skirmishCommands(map, armies)` founds as many bases as
asked for and as the map has corners for. Games of two or three armies hash as they
always did (golden 3501695057 holds): the fourth army's state goes into the hash only
when it is in the game.

**Who fights whom.** The computer was written for one enemy: it has a front, a far bank,
a base to take. It keeps that, and picks the enemy: the army before it in the round (0
for 3, 3 for 2, 2 for 1, 1 for 0), so everyone has exactly one army coming for him. Its
units still shoot whoever comes near. When that enemy's headquarters falls it picks the
next (`fallen` in ai.ts), and the player's commanders do the same. With three armies one
pair shares a west or east edge, and the computer's sense of "forward" is east-west, so
that one forms up beside its base, not in front of it; it still attacks.

**Winning.** You lose when your headquarters falls, and win when the last enemy one
does. A banner says when one enemy is out and how many are left.

**Checked.** `tools/ffa.ts`: four hard computers for 30 minutes run at 21 times real time
on a container core; armies of 300 to 800 points fight over all nine flags, and in the
three-army game the survivor of the first fight turned on the next army when its enemy
fell. tests/ffa.test.ts: four corners, equal sites, every base and flag reachable on foot
and by vehicle, four headquarters, determinism.

**Not done.** People against people in a free-for-all: the lobby and Versus know red and
blue only. Factions for gold and green follow blue's in turn and cannot be picked.

## 125. Weather: rain, fog and snow, and they shorten sight (R4, 2026-11-15)

`?weather=rain|fog|snow` (Menu: Weather), chosen when the game starts like the time of
day, and sent to co-op and versus guests with the other settings.

**In the sim** (the roadmap had R4 as render-only; this goes one step further because
fog you can see through is decoration). `CMD_WEATHER` on the first tick sets
`w.weather`; everyone then sees a percentage as far as on a clear day: rain 85, snow 80,
fog 55 (`WEATHER_SIGHT_PCT`). It multiplies with the night's 60%. Scouts and recon drones
see through the dark but not through the weather. Nothing else changes: no slower
movement, no grounded aircraft. A clear game hashes as it always did.

**On screen** (`src/client/weather.ts`), all decided when the materials are built, so a
clear day costs nothing:

- Sky, haze and light per weather: a grey lid, a weak sun with soft shadows, more light
  from the sky. Fog brings the haze in to 50 to 760 units.
- Snow lies on what faces the sky (ground, roofs, tree crowns), in drifts from two scales
  of noise, thin on streets and where wheels have worn the ground.
- Rain darkens everything a fifth and makes the ground shine.
- The rain and the snow themselves: 2,600 streaks or 2,000 flakes (fewer on `low`, more
  on `high`) in a box that follows the camera, each wrapped to the other side when it
  leaves. One draw call, no allocation.
- No dust trails in rain or snow. The fog of war lifts as far as the sim says units see.

Checked in a headless browser on the city and the ridge map: see the screenshots of the
run. Frame cost on a real card is Fabio's to measure; the levers are the particle counts.

Not done: sound of rain and wind, low sun, light shafts, weather that changes during a
battle, any effect on movement.

## 126. Far facades, and a see-through for buildings that is off by default (2026-11-15)

The two things left over from U4 (URBAN.md 5.4 and 5.5).

**Far facades.** Each building keeps a second, simplified geometry (`farParts`): walls and
roofs as they are, every row of windows as one painted band, and nothing smaller than
2.4 m (chimneys, dormers, roof furniture, signs). The buildings of a 128 m square are
merged into a far mesh beside the full one, and `StructureView.view` shows one or the
other by the distance from the camera to the square: far beyond 520 m, with 25 m of
slack so that a square on the line does not flicker. At that distance a window is two
pixels. Measured on the city map, whole city in view from 800 m, shadows off: 1.379
million triangles before, 1.136 million after (18% fewer), same draw calls; with shadows
the buildings are drawn twice, so the saving is larger. Side by side the two pictures
cannot be told apart at that distance. `?far=0` turns it off to compare.

**See-through (the "roof fade").** From closer than about 175 m, parts of buildings that
lie between the camera and the point it looks at (a strip 15 to 19 m either side, up to
50 m toward the camera) are drawn as a sparse screen of dots above the ground floor. It
is a discard in the building material, driven by three uniforms; no extra draw calls, no
change to picking or the sim.

It works, and it is **off by default** (Y turns it on, remembered; `?cutaway=0` removes
it from the shader altogether). Reason: in this game a half-missing building means a
damaged one, and a block eaten away by the fade reads as that at first glance. Fabio to
try it and say whether it should be on, changed (whole building fades, or an outline of
his own troops through walls instead), or removed. Shadows of faded parts are dotted too.

## 127. The v1 interface: quiet glass, with the commanders always on screen (2026-11-15)

Fabio chose from a canvas of five directions: option E for the battle (glass pills with a
commander table), option A (plain glass) for the screens outside a battle.

**In a battle.** No bars: dark see-through pills over the battlefield in fixed zones.
Resources top left, with flags (a square per town, in its owner's colour) and the armies
in the field (colour, power, struck through when its headquarters has fallen, so three or
four armies read at a glance). The game's buttons top right, with a clock. Under them the
commander board, always there (M hides it, remembered): one row per commander with
mission, objective and state, grid square, strength and units; the orders of the row that
is open sit under the table. Alerts bottom left with their grid square, the selection and
its orders bottom centre, the minimap bottom right.

**No blur.** Glass normally blurs what is behind it; behind this glass is a picture that
changes every frame, and blurring it costs frame rate. The pills are flat tints. The
interface costs the same as the old one: the same timers redraw the same elements, only
when their text changes.

**Text that does not fit is never cut silently** (`src/client/ticker.ts`). It runs past
once like a news ticker, then rests with an ellipsis, and runs again under the pointer.
The boards redraw several times a second, so what has run is remembered by field: a line
at rest stays at rest, one in mid-run carries on.

**Outside a battle** (`src/client/menu.ts`). The game opens on a main menu: Skirmish,
Co-op with friends, Versus, Settings, How to play. The new battle screen holds what the
Menu dropdown held: map, armies, time, weather, both powers, opponent; it remembers the
last choices. Nothing of the battle is built until one is asked for, and it is asked for
as before, by the address: any link or test flag that names a battle (`?map=`, `?ai=`,
`?scenario=`, `?join=`…) skips the menu, so every old link works. The in-game menu keeps
sound, graphics, the performance test, Restart battle and Main menu. The lobby and the end
of a game are the same glass; the end screen has a column per army in a free-for-all.

Not done: the score counts three armies (`STAT_TEAMS`), so a fourth shows dashes. Changing
that moves the score's layout in the sim state and wants its own change.

## 128. A commander falls back a short way, and goes in again by itself (2026-11-15)

Fabio: the fall back is too aggressive, the troops end up too far from the objective.

**Why it was far.** A commander that broke off went to the nearest friendly town or to the
base (`anchor` in `src/sim/staff.ts`). On the city maps that is minutes of marching, so a
commander that lost a fight left the battle. And an attack only went in again at 75% of
the strength it started with; it breaks off at 45%, so without reinforcements it never
did.

**Now.** It falls back `FALL_BACK` (110) past the edge of its objective: out of what the
place sees (44) and shoots (40), close enough to go again. The way back is the way it
came, if it stood well outside the place when the order was given, otherwise toward the
nearest friendly ground. A known enemy on that spot moves it `FALL_STEP` (40) further, up
to three times, then to friendly ground as before. An attack that is not reinforced goes
in again after `REGROUP_WAIT` (a minute) when what it knows of the place is something it
can take on, and after a minute and a half with no enemy in sight it goes to look, as the
other missions always did. Each time it goes back in on its own and is thrown out again it
waits twice as long (up to four times), so a place it cannot take does not eat it a bite
at a time. A new order resets that.

Golden hash unchanged: the staff is not part of the sim state.

## 129. Gunships with a commander fight as its escort (2026-11-15)

Fabio: helicopters behave oddly in a commander group, they rarely engage.

**Why.** Everything in a body that does not fight in the line is placed by `follow`
(`src/sim/ai.ts`). Attack helicopters fell in with the jammers and scouts: kept within 16
of the middle of the body by a plain move order every second. The middle is behind the
line, a gunship reaches 28, so the enemy was nearly always out of reach, and one that did
get a shot was called back. The hunting of decision 116 does not apply: that is for a
helicopter without orders, and these had a new one every second.

**Now** (`escort`). Each gunship of a body that has no target goes for the nearest enemy
the army knows of within `ESCORT_REACH` (150) of the middle of the body that it can hurt,
a helicopter before anything on the ground, by attack-move, so it fights what it meets on
the way. One already on its way to about that place is left alone. With nothing to go for
it comes back over the body (`ESCORT_LEASH` 26). The computer player's own gunships go
through the same code and gain the same.

Not done: they do not look where the air defence is before they go. Golden hash unchanged.

## 130. Way points: Shift + right click queues the next place (2026-11-15)

Fabio: way points for movement, with Shift + right click, to pick a route.

**In the sim, not in the client.** A route has to survive the player looking elsewhere,
play the same on every machine in co-op and replay from the command log, so it is game
state (`World.routes`, `routeOf` per unit), fed by `queue: true` on a move or attack-move.

**The rule.** Troops that stand still just go. Troops on the move finish the leg they are
on, then go to the queued place, and so on, up to `ROUTE_MAX` (16) places. A route belongs
to the body it was given to: it moves on when three quarters of it have finished the leg
(or three seconds after half have), so the quick wait for the slow at each corner and the
formation is made again for each leg. Part of the body given its own way point leaves and
gets its own route. Any order that is not a way point (move, stop, attack, mount, a
commander taking the unit) drops the rest of the route. A queued attack-move becomes one
when its turn comes: Alt + Shift + right click.

**On screen** (`src/client/routes.ts`). While troops on a route are selected, a green line
runs over the ground from them through the place they are making for to every way point,
with a diamond on each. It is drawn through buildings: in a city the route is the thing to
see. Nothing is drawn for troops that are not selected.

**Hash.** Routes are mixed into the hash only while there are any, so the golden hash
holds. Not done: way points on the minimap, queued orders other than moves (attack this,
then that; garrison), and the computer does not use them.

## 131. Trucks build a list of buildings one after the other (2026-11-15)

Fabio: several buildings in one command; the trucks follow on and build them in sequence.

**What was there.** Shift kept the building in hand so that several could be placed, but
every placement sent the whole crew to the newest plot at once: the first ones were left
as foundations nobody was working on.

**Now.** A placement with Shift is `queue: true` on the build order. The plot is taken and
paid for at once, as before (the player sees what is spent and where it will stand), but
trucks that are at work on a building finish it and then go on to the next on their list,
in the order placed (`buildNext`, `buildLen` per truck, `BUILD_QUEUE` 8). Trucks with
nothing in hand start at once. The same for Shift + right click on a building of one's
own that wants work (unfinished or damaged). A building on the list that is already done,
or gone, when its turn comes is skipped. A placement without Shift, or any other order,
drops the list.

**On screen.** The selected trucks' list is drawn like a route (decision 130): a line
from the truck to the building in hand and on to each one waiting.

Not done: paying for a building only when work on it starts, which would let a player
plan more than can be afforded now. The computer does not use lists. Golden hash unchanged
(a list is hashed only while a truck has one).

## 132. The Western alliance has a jammer again, a light one (2026-11-15)

Fabio, the day the factions went in: "the jammer unit has disappeared". It had not broken:
decision 123 gave each faction one kind it does not field, and the alliance's was the
jammer. The alliance is the default army, so to the player the unit was simply gone, and
with it the only thing short of air defence that stops drones, which are a large part of
this game. Asked, Fabio chose a light jammer over the standard one or none.

The alliance's jammer: "Light jammer", three quarters of the ring (jam 75%), a quarter
dearer (cost 125%), and the computer builds fewer of them (share 70%). Russia keeps the
strongest (130%). The alliance now lacks no kind; its price is that everything costs more.
Not measured again with `tools/factionduel.ts`: a jammer that is weaker and dearer than
the plain one is a small push up for the alliance, which stood in the middle of the last
measured round.

## 133. Rain is a hint in the air; the wet ground carries it (2026-11-15)

Fabio, after a whole game in the rain: too intense on the eyes, a bit dizzying.

The rain of decision 125 was 2,600 bright streaks falling at 34 through a box round the
camera: a streak crossed the screen in a few frames, so the whole picture flickered, all
game long. Now: 520 streaks (a fifth), falling at 19, shorter and thinner, nearly the grey
of the sky at 13% opacity (was 34%), with less wind, and none nearer the lens than 22 m,
where they are largest and fastest. To keep the weather readable without them the ground
is a little darker and shinier (roughness -0.4, was -0.32). Sight in the sim is unchanged.
Snow is unchanged: it falls slowly and nobody has complained.

## 134. The commander board is cards, each with its own add button (2026-11-15)

Fabio found the board of decision 127 confusing: six columns of equal weight, and the
order he gives most, handing the selected units to a commander, sat in a separate row of
name chips under the table. He chose option 5 of the design canvas.

- One card per commander, always in the same order. Line one is a sentence: name, what
  it is doing, where ("Charlie falling back from Millbrook"). Line two is its health:
  five strength pips, its number of units, and a tag only when something is wrong (no
  troops, needs reinforcements, replacements coming, in contact, no orders). The grid
  square stands on the right in amber. The mission and percent columns are gone: the
  sentence says the first, the pips the second.
- While units are selected, every card that would gain some shows an amber "+ N". One
  click assigns them. A right click anywhere on the card does the same, as a right click
  on the ground moves them. With nothing selected the buttons are not there. The row of
  name chips is gone.
- A click on a card opens it in place: the missions first, then Go to, Replace losses and
  Attack style as plain words, with Stand down and Disband behind More.
- Idle units and New commander share one line at the foot.
- Not taken from the mock: its line at the top ("9 units selected, press plus...").
  It would push every card down the moment a selection is made, under the pointer.
- A commander whose staff has no launch strength on record yet shows full pips, not
  none: it has lost nothing.

Client only (`src/client/missions.ts`, CSS in `index.html`); the sim and the golden hash
are untouched. The ticker rule of decision 127 holds for the sentence.

## 135. Distant soldiers are still figures (2026-11-16)

From the performance review (finding 1): between 120 and 340 m every man was posed limb by
limb on the CPU, eight instances a man, for figures 3 to 8 pixels tall. That was most of
the frame at 4,000 units.

- A third band inside the middle level. From 135 m (`UnitView.lodStill`, scaled by the
  governor's detail lever like the others) out to `lodFar`, a man is one instance of a
  pre-posed figure: stand, kneel and lie, each at ease and aiming, and an eight-frame
  stride for the run (`STILLS`, `stillPose` in `soldiers.ts`).
- The still figures are baked at start from the very pieces and posing code of the
  middle level, so crossing the line changes at most the angle of a knee: no pop, same
  proportions, same paint and wear, no new material.
- Like the near level, the jointed middle band has a budget (`midBudget`, 300 units): in a
  crowd the still figures come closer, never nearer than 80 m (a man is about 11 px
  there).
- Muzzle flashes come from each pose's baked muzzle, so firing still shows.
- If a pose's batch is full, the man is posed in pieces as before; nothing vanishes.

Measured in the cloud (`units.update` alone, clash scenario, camera 160 m out): 3,000
units 6.3 to 2.4 ms, 4,000 units 8.5 to 1.5 ms; per-frame upload 5.8 to 1.0 MB. The
shader-posed rig (review's proper fix) is still the foundation for authored animation.
Client only; the sim and the golden hash are untouched.

## 136. The inspiration build order (2026-11-16)

Fabio sent screenshots of another isometric RTS as inspiration, mainly for the look. We
take ideas only; its art, interface and units are not copied. The review (Hub, section
4A) found the cause of his main complaint in the code: a rifle squad is one unit drawn as
several men, a rocket takes part of its health, and the men that health no longer covers
stop being drawn. Nobody falls, and the squad beside it is untouched because only
artillery has a blast. So a hit reads as a miss.

Fabio's answers, the same day:

- No faction becomes a guerrilla army. Faction 0 stays as the base table under the tests.
- Today's civilian fine is enough; no extra penalty.
- Bodies stay all game, in several poses.
- Both the floor-by-floor look and the ground-floor collapse, without floor orders. The
  weapon decides which floor it hits; the ground floor is a share of the same health, so
  average destruction times hold.
- Air strikes for the three big armies only; the guerrilla is balanced by other means.
- A machine gunner in every rifle squad rather than a new team.
- A formation button with defaults: convoy on roads and streets, doctrine shapes in the
  open, either forced on any selection or commander.
- New from Fabio: a front line drawn on the minimap and the zoomed-out map.

Order: drawing-only work first (deaths, dismount, floors, front line), then the rules
that change how infantry fights (blast in the open, squad gunners), then formations, the
ground-floor collapse, mortars and rooftops, air strikes, and the guerrilla last, with
the unique units and authored models. All of it after the review fixes.

## 137. An order shares its routes, and old routes are kept until they fail (2026-11-16)

From the performance review (finding 2): route fields were 57% of sim time in a real game,
and 93% of the fields built were near-copies of one already built or rebuilds of one just
thrown away.

- A unit on a move order routes to a cell near the middle of the 4 x 4 cell (16 m) square
  its own spot lies in (`routeGoal` in `sim.ts`), then walks the last stretch straight.
  Where that cell is more than a square from the spot, or not in plain sight of it, the
  unit routes to its own spot as before; if it gets to the shared cell and cannot see its
  spot, it asks for its own route then.
- A change to the ground (a house falls, a base building goes up, a work is built or
  breached, trees are felled) no longer wipes every route. Routes are marked stale and
  still followed; one is redrawn only when a unit on it finds its next step blocked or
  reaches its end (the unit waits a tick if this tick's budget of three is spent).
- The three "ground changed" flags moved from module scope into the world.

Measured with `tools/simbench.ts`, hard AI against hard AI, 25 minutes, seed 1: city fields
built 7,479 to 3,953, mean tick 1.22 to 0.85 ms, ticks over 5 ms 6.9% to 2.6%; four armies
17,142 to 8,533 fields, 2.09 to 1.36 ms, 16.3% to 5.5%. Co-op rejoin replays the game, so
it gets about a third faster. Units move the same way to the eye; the golden hashes moved
on purpose.

## 138. The front line (2026-11-16)

Fabio asked for a military front line, traced where the battle is, on the minimap and in
a clearer form on the zoomed-out map (roadmap I2). Built client only; the sim and the
golden hash are untouched.

How it is traced (`src/client/front.ts`): the map is cut into 64 by 64 squares of 16 m.
Each army's presence is summed into them: its ground units (a vehicle counts double), its
base buildings (40 m around each), and the towns it holds, which claim their circle plus
90 m, so two armies' towns a street or two apart already have a line between them while
towns across an empty map do not. For enemies only what the
player knows counts: troops in sight now (in a building only once their fire gave them
away), base buildings already found, and the towns, whose owners every player sees
already. A square where enemy troops were seen keeps them in memory, fading to half in
40 s, and is cleared the moment it is in sight and empty. So the line never shows what the
fog hides, but it does not vanish the instant a scout looks away. Presence is blurred
(three box passes, about 55 m), saturated so a big army does not push the line back to the
weaker one's gate, and eased over time so the line glides. The line is where your presence
equals that of the strongest enemy there, traced by marching squares, only where both
sides are present, joined into paths and smoothed. Teeth every 28 m point to the enemy
side and take the colour of the army met there, so with three or four armies each stretch
shows whom it faces. About a millisecond, four times a second.

How it is drawn: on the minimap a line in your colour on a dark casing with small
triangles; on the battlefield a ribbon laid over the ground, thicker the further out, that
fades in between 280 m and 420 m of camera distance (the game opens at 260 m), so it is a map symbol for the
strategic view and never sits on a close fight. Flat colour, no glow. `?front=0` turns it
off.

## 139. Deaths you can see (2026-11-16)

Roadmap I1, from decision 136. Drawing only: the sim, its rules and the golden hash are
untouched, so a shared game stays in step whatever each player's screen shows.

- **Bodies.** When a squad's health no longer covers a man, the man who drops out leaves a
  body where he stood (`dropMen`, `layFallen` in `units.ts`; `bodies.ts`). Eight poses
  (`DEAD` in `soldiers.ts`: face down, on the back, on either side, curled, in mid-stride),
  each turned its own way and with the rifle beside him, baked whole at start from the
  same pieces the living men are drawn with: one instance a body. Near (under 120 m) the
  full figure, out to 340 m the middle one, then a small dark shape to 640 m.
- **All game.** Bodies are kept in 64 m squares and the instance lists are rewritten only
  when the camera moves, a body lands or one is in the air; a still camera over a field of
  the dead costs nothing on the CPU. A square keeps 4,096 bodies, then the oldest there
  gives way. Roadmap I1 said far ones would be baked into the ground wear past a budget:
  not needed at these numbers, so not done; each thrown body still marks the ground where
  it lands.
- **Thrown.** A man killed within a moment of a tank round, missile, helicopter rocket,
  strike drone, artillery shell landing near him, or (weaker) an autocannon burst, is
  thrown away from the blast and turns over in the air before he lands in his pose, with
  dust where he comes down. A man shot falls where he stood. No blood, nothing torn.
- **Fog.** Your own dead show at once; the enemy's only once your troops see the spot.
- **Dismount.** On the unload event the men of each squad climb out of the back of the
  carrier one after another (0.2 s apart) and run to their places; out of a helicopter
  they come down from it. The squad is in play at once, as before.
- **Burning down from the top.** Between the sim's damaged line (90 %) and gutted line
  (40 %) a building now shows how far it has burnt (`brokenLevel` in `structures.ts`):
  first the roof goes, then a storey per step, with ragged walls where the lost storeys
  stood, charred beams, the roof in heaps on the floor that held and soot up the face.
  Flames come out of the windows of the top storey left and off the broken top, hot after
  each storey goes, then smouldering; a gutted shell burns out over two minutes. The
  thresholds and times are the sim's own, so destruction takes exactly as long as before.
- Civilians who die still fade after a while, as before (their own figures).

Measured in the cloud (clash, 4,000 units): rewriting the body lists while the camera moves
costs 0.3 ms with 2,000 bodies in view and 1.0 ms with 10,000 in view; with the camera
still, nothing. On the GPU a body costs what a living man at the same distance costs.

## 140. One description of a game, and every order signed with its army (2026-11-16)

The architecture review's findings F1 and F2, fixed together because the second needs the
first.

**A Match** (`src/sim/match.ts`) is the whole of what is being played: seed, map, scenario,
night, weather, every army (its faction, and whether players, the computer at a level, or
nobody runs it) and every player by seat (his army, his role). Before, that was spread over
some twenty address flags read in `main.ts`, fourteen optional fields of the worker's `init`
message, four worker globals (`ais`, `staff`, `rival`, `me`) and a two-sided lobby config,
all of which had to agree by convention. Now the address is read into a Match in one place
(`src/client/setup.ts`, which also writes one back), the menu and the lobby build one, the
host sends it whole to the guests (checked on arrival by `validMatch`), and `createGame`
builds the world, a computer for every army that is the computer's and a staff for every
army of players. The worker's `init` is the Match and a seat. The third and fourth armies'
factions can now be named (`?foe2=`, `?foe3=`); unnamed they follow the second's as before.

**Every order carries its sender**: the seat (`by`), the army (`army`) and the tick of the
picture the player was looking at (`seen`). Nobody says the first two of himself: the sim
that takes an order in signs it (the player's own alone, the host's in a shared game), and
the computers' and staffs' orders are signed as they are handed in. **Every sim checks a
signed order before applying it** (`admit` in `src/sim/guard.ts`): only that army's units,
carriers and buildings obey, nothing that is the game's own setup is taken, and a unit born
on or after `seen` is left out, which closes the old hole of an order reaching whatever
reused a dead unit's number. The host-side check of PR #98 (`authorize`) is now the door
that signs and calls the same `admit`; there is one ownership rule, not two.

What did not change, and how we know: an unsigned order is the game's own (scenario
openings, tests) and is applied as before, so every existing test and the golden hashes
are untouched. The old worker loop is kept word for word in `tests/legacy.ts`, and
`tests/match.test.ts` plays six kinds of game on both loops, the new one signing and
checking every order of every player, computer and staff, and compares the worlds hash for
hash. Nine longer games (up to twelve minutes, all modes) were compared the same way before
merging: identical. In those games the check never refused a computer's or a staff's order.

Consequences: `?control=all` and the stress-test button send unsigned orders and are taken
only in a game alone. In a shared game nobody, the host included, can conjure troops or
order another army. The lobby still offers two sides; the Match and the wire no longer
assume it, which is what human free-for-all and per-player ownership needed.

## 141. Damage by target profile, and a list of maps (2026-11-16)

Architecture review F3 (first half) and F4 (the registry).

The damage table was a row of sixteen numbers per unit, one per target kind, so a new kind
of unit meant a new column written by hand into every row. The sixteen columns were only
ten different ones: rifle squads, recon teams, engineers and paratroops take the same from
every weapon, so do air defence, the jammer and the truck, and so do the two helicopters.
Each kind now names its **profile** as a target (`PROFILE_*` in `src/sim/units.ts`) and
each row gives its damage against the ten profiles (`vs`). `damage[target kind]` is filled
in from that when the table loads, so every reader of it is unchanged and so is every
number: the full table of every faction was compared before and after, and the golden
hashes pass untouched. A new kind names a profile and needs no column; a kind that should
take damage differently gets a profile of its own, one number per row.

The maps are a list (`MAPS` in `src/sim/map.ts`: id, name, the menu's line, how many armies
it has a base for). The menu's choices, the names on the lobby and the end screen, the
check of a Match from another player and the map a free-for-all is sent to all read it. A
new map is a generator, a case in `generateMap` and a row.

Left for later, on purpose. The table of kinds is still full (`KIND_SLOTS` 16): making room
for a seventeenth resizes world arrays and moves the golden hash, so it waits for the first
new unit. The client's parallel per-kind tables (models, icons, sounds, production buttons)
are best folded into one row per kind by the thread that builds per-faction models, which
rewrites most of them anyway.

## 142. A route is searched only as far as it is needed (2026-11-16)

The review's third route fix. A move order's field is seeded with its goal and searched
(`growField` in `path.ts`) only until the cell of the unit that needs it is settled, then
half as far again and 60 cells more; a unit standing on a cell the search has not reached
carries it on. Dijkstra settles cells in order of cost, so the costs and the way out of
every settled cell are exactly those of a full search: the golden hashes did not move, and
25-minute AI games end on the same hash. `tests/fields.test.ts` checks it cell by cell.
The inner loop also skips bounds checks away from the map's edge.

Measured (`tools/simbench.ts`, hard vs hard, 25 minutes, seed 1): city mean tick 0.87 to
0.73 ms, ticks over 5 ms 2.7% to 1.7%; four armies 1.33 to 1.08 ms, 5.3% to 3.1%. Since
the review: city 1.22 to 0.73 ms, four armies 2.09 to 1.08 ms.

## 143. Gameplay loose ends: engineers that demolish, gunships that dodge air defence (2026-11-16)

Four small gaps left over from earlier decisions, none touching damage rules:

- **The computer's engineers lay charges** (decision 118 said they did not). In `press`, once
  its infantry is within 45 m of the house under attack, the engineers of the force go in
  with the charge order on that house, next to the guns and tanks. Houses only; the house is
  the strong point it already chose (one the enemy is known to hold), so empty houses are not
  razed for nothing. Sub-commanders use the same code. Woods are still not felled by the
  computer.
- **Gunships avoid known air defence.** `AA_AVOID` 52 m (the guns reach 40, a gunship's
  rockets 28). Hunting helicopters (`huntHelis`, so also the player's idle ones) will not take
  a target within that of air defence their army has in sight. The computer's escorting
  gunships (`escort`) also remember air defence seen for 90 s, skip prey under it or on the
  way past it, and fly out of the reach of any they find themselves in. Helicopters under a
  direct player order do what they are told.
- **Way points on the minimap.** The routes of the selected troops are drawn there in the
  same green with a diamond on each way point (`RouteView.polylines`, `Minimap.drawRoutes`).
- **The fourth army's score.** `STAT_TEAMS` is 4, so the victory screen counts all four
  armies instead of dashes. The score is not in the hash.

Golden hashes unchanged. Tests: `tests/commanders.test.ts` (air defence, charges),
`tests/score.test.ts` (fourth army).

## 144. Helicopters that come down stay down (2026-11-16)

Fabio liked the bodies that stay all game (decision 139) and asked for the same for downed
helicopters. Client only, the sim and the golden hashes are untouched. A shot-down aircraft
used to vanish (the sim frees a wreck's slot after a while and `units.ts` never drew a dead
aircraft). Now `src/client/wrecks.ts` keeps its own record: on the death event a gunship or
lift helicopter falls the last metres with a smoke trail, hits the ground (a second blast, a
scorched patch, a thud) and lies there for the rest of the game, smouldering for 50 s and
then cold. Three ways to lie (on its side, nose in with the tail snapped off, upright and
broken), each with a bent rotor blade beside it, built from the flying model's own parts
(`buildHelicopterWrecks`) and scorched by the same burn paint as tank wrecks. No glow.
Enemy wrecks show once the spot is explored. At most 512 are kept (oldest replaced); the
list is rewritten only on a fall, a new wreck or every half second for the fog, and costs
nothing with none. Drones and the transport plane are not covered.

## 145. Open ground kills: bursts and the squad machine gun (2026-11-17)

I3 of the inspiration review. Fabio's ask: men caught in the open by a tank round or a
helicopter's rockets should die and be thrown, so that crossing open ground under those
guns is something a player avoids. Before this only artillery had a blast: a tank round
hurt the one squad it was aimed at, and five squads walked up to a tank and killed it.

**Bursts.** `UnitKind.burst` (radius) and `burstDamage` (at the target, half at the rim):
tank 3.5 and 30, attack helicopter 4 and 25, missile team 3 and 20, strike drone 4 and 35.
A direct-fire shot at a target that is not behind walls hurts every enemy squad on foot
within the radius besides the target (`burstMen` in `sim.ts`). Rubble and sandbags halve
it, a trench quarters it, men in a building are not touched, and neither are the shooter's
own army: tanks fire into a melee all game, and friendly fire there would punish the
player for what the computer aims. Damage to buildings is untouched (decision 120 stands).

**The gunner.** `UnitKind.gunner` on rifle squads and paratroopers. From a rest (inside a
building, on rubble, sandbags or a trench) the squad does a third more to men on foot
(`REST_PCT`). Its fire pins a squad on foot that is neither behind walls nor on such a
cell for `PIN_TICKS` (3 s): half speed (`PIN_SPEED`), a quarter longer between shots
(`PIN_RELOAD`). `World.pinned` holds it, hashed only while it runs.

**The first setting was too strong.** Tank 60 at 4.5 let three tanks beat 24 squads at
half their cost and broke `formations.test.ts` (25 points of squads and missile teams
against 5 tanks): the defenders won 5 seeds of 16, 10 before. At 30 and 3.5 they win 9.
The burst is what catches missile teams standing among the squads, so that test is the
one that sets the number.

Measured on open ground (`tools/pointduel.ts`, before to after, survivors):

- 1 tank vs 5 squads: squads win with 2, now the tank wins.
- 3 tanks vs 15 squads (equal army points): squads won with 8, now the tanks win with 1.
- 3 tanks vs 24 squads (half the tanks' cost): squads 21 left, now 18.
- 3 tanks vs 11 squads and 4 missile teams (equal points): 12 left, now 10.
- 4 tanks and 12 squads vs 32 squads: the squads won with 16, now the tanks' side wins with 4.
- 4 tanks and 12 squads vs 20 squads and 6 missile teams: 15 left, now 7.
- Equal cost, one kind each (`tools/matchups.ts`): squads beat tanks with 91% of their
  worth left, now 75%.
- 2 helicopters vs 12 squads: 65 s to kill them, now 49 s; vs 24 squads 237 s, now 149 s.
- 30 squads vs 30 squads: 75 s, now 87 s (both sides pinned).

So tanks are worth having against infantry in the open and still lose to the same money
in squads, and missile teams remain the answer. Three 30-minute hard-vs-hard games (city,
seeds 1 to 3) still field 0 to 5 tanks among 500 to 800 points and no side stalls.

Pinned tests moved on purpose: `assault.test.ts` allows 6 lost (5) against three tanks
and 19 of 39 (14) against five tanks in the city, since streets under tank guns are open
ground; `formations.test.ts` asks for more than 5 defenders left (10). New
`tests/blast.test.ts`. Golden hash 2037256287, golden games re-pinned.

The screen (client only): men killed by a burst are thrown from it through the I1 path,
with a small flash, thrown earth and a scar; a pinned squad lies flat.

Not done: the computer does not yet avoid open ground or spread out under armour; no
suppression from vehicle machine guns; the unit card does not name the machine gun.

## 146. A shared army: whose units are whose, hand-overs, names and marks (2026-11-17)

The roadmap's next step for co-op ("orders that know who gave them: unit handover, my
units, role-first screens"), possible since every order is signed with its seat (140).

Every unit of a shared army is one player's or nobody's in particular (`World.owner`). A
new unit goes to the player whose role covers its kind (`DUTY_KINDS` in `units.ts`; players
with the same role take turns). One that is nobody's becomes his who first orders it
himself. After that only a hand-over moves it: `CMD_GIVE` (to a teammate, to oneself, or
back to nobody). Roles are part of the game now: they begin as the lobby set them and
change by `CMD_DUTY`, so every machine agrees, including one that plays the game through
to rejoin (the host sends the match as it began and the returning player's new role goes
in as an order). Ownership decides nothing in the rules: any player may order any unit of
his army, which was Fabio's condition. It is not in the hash (like `seat` and `born`, it
follows from the orders); `tests/team.test.ts` checks a game with hand-overs and role
changes against one without, hash for hash. The score credits a unit's owner, or, for a
unit that is nobody's, whoever last ordered it.

On screen (`src/client/team.ts`): a team panel with each player's name, colour, role, and
how much of the army is his; Give and Take for the selection; Go to a teammate's view; the
player's own role as a menu. A teammate's units carry a thin ring in his colour and show
in it on the minimap (a switch turns both off). A box drawn over a crowd takes one's own
units and nobody's and leaves teammates' alone; a box or a click on theirs alone still
takes them. Players give a name in the lobby (cleaned to letters, digits and a few marks,
12 long, checked on arrival like every message). Z marks the ground for the team: a pole,
a ring and a label on the battlefield, a ring on the minimap, a spoken line with the grid
square; 1, 2 or 3 just after makes it Attack here, Defend here or Help me here.

Left for later: who spent what (bulk orders are paid when a factory takes them up, so the
spender is not known there yet), commanders that belong to a player in the sim (today the
board remembers its own orders), and a role-first production screen beyond the marks on
its rows.

## 147. The computer keeps out of the open (2026-11-17)

The follow-up decision 145 left open. Since I3 a tank round or a gunship's rockets burst
among squads in the open, and the computer still walked its infantry up a street at five
tanks in a block. Three things, all in what the computer orders (`takeCover` in `ai.ts`),
none in the rules: no damage value and nothing about buildings changes.

**Into the houses.** A squad on foot within reach of an enemy tank, fighting vehicle or
attack helicopter its army knows of (the weapon's range and 8 m more, 14 m for a
helicopter) goes into the nearest standing house with room, within three cells of it;
failing that onto rubble, into a trench or behind sandbags. It fights from there. After 20
seconds it bounds to the next house nearer the objective. With none ahead it goes on in
the open for 30 seconds before it looks again, so an attack never sits down for good in
front of a tank nobody can reach. Under a gunship it stays in while the walls hold:
nobody outruns a helicopter. This runs on the march, in the assault, for the reserve and
on a retreat, which now goes back from house to house (`fallBack`) instead of across the
open with its back to the guns.

**Missile teams hunt.** They do not hide from armour: they are the answer to it, and they
outrange it. They do go indoors from a gunship, which they cannot hurt. And the computer
trains three more missile teams in a hundred units for every tank it has seen (at most
twelve), whatever else the enemy fields; before, only an enemy that was mostly armour got
that answer.

**Apart where there is no house.** A squad halted in the open under those guns with
another closer than 4.5 m steps 4 m away from it (`spreadOut`): a tank round reaches 3.5
and a march formation stands 2.6 apart. A missile team with a vehicle in its sights
stays put.

Normal and Hard only (`Tuning.cover`); Easy and Recruit fight as before, so the easy
levels get no harder. The player's commanders use the computer's assault and march, so
their squads do the same.

Measured with `tools/assaults.ts` (new): one commander against a held place, 14 fights by
4 seeds, army points lost, before to after:

| Fight (seed 3)                                              | Before          | After         |
| ----------------------------------------------------------- | --------------- | ------------- |
| Hill town, 2 tanks + 3 squads                               | 3 of 18         | 1             |
| Hill town from far off, 3 tanks                             | 6 of 17         | 2             |
| Hill town, 2 gunships + 4 squads                            | 19 of 19, lost  | 5, taken      |
| Open country, 3 tanks + 5 squads                            | 4 of 21         | 4             |
| Open country, 2 gunships + 3 squads                         | 18 of 19, lost  | 5, taken      |
| City quarter, 3 tanks + 6 squads                            | 4 of 33         | 1             |
| City quarter, 2 tanks + 2 fighting vehicles + 6 squads      | 3 of 33         | 0             |
| City, 5 tanks + 6 squads + 2 missile teams (the pinned one) | 19 of 39, 256 s | 3, 101 s      |
| The same with no tanks of its own                           | 14 of 35        | 11            |
| City, 2 gunships + 2 tanks + 6 squads                       | 28 of 29, lost  | 17, not taken |

All 56 fights: 516 points lost before, 208 after; 12 places not taken before, 3 after (all
three the last row: infantry with nothing that can shoot a helicopter down holds out in
the houses and does not take the place, which is right).

What was tried and left out, in the manner of decision 109:

- **Missile teams hiding from tanks like the squads.** In a house without a line of
  sight they shot at nothing and the commander broke off beaten (the pinned city fight
  went from 3 lost to 8, and one seed of it was lost outright).
- **Idle missile teams sent straight at the nearest known vehicle** rather than at the
  objective with the line. No difference worth the code: 208 lost against 212. They
  already stop and fire from furthest back.
- **Stepping apart for missile teams that have a target.** In a street the step loses
  the shot; the pinned city fight went from 3 lost to 11.
- **Wider or narrower settings.** Two or four cells of reach, 12 or 35 seconds in a
  house, more or less dread of a tank's range: all within a few points of each other.

Full games, Hard against Hard on the city map, seeds 1 to 4, one side with the drill and
one without (`NOCOVER=0` or `1` in `tools/aimatch.ts`): the side with it lost 7,600 army
points in eight games, the side without 8,043, and each won two. Whole games swing on
much else, and Hard fields few tanks; the drill does not stall them (with both sides using it two of
four games were over in 19 minutes, with neither none was inside 30).

`tests/cover.test.ts` is new. `tests/assault.test.ts`: the limits come down to 3, 4, 4
and 9 points (6, 6, 7 and 19), and a gunship fight is pinned. One commander test lifted
"the enemy army" away by the ids it had just added, three of which were the slots of dead
raiders: three tanks stayed and hunted the commander, and the test passed by luck. It
now lifts every enemy, and waits longer for squads that survive the retreat and walk home.
The golden world hash does not move (no rule changed); the two golden games are re-pinned
because the computers in them play differently.

Not done: the drill cannot widen a formation on the move (spacing is a rule of the
simulation and belongs to I4 Formations), so squads still march 2.6 m apart and step
apart only once halted. Routes are not planned through cover: the men take the cover
that is beside the route. The computer still attacks a place held by gunships without air
defence of its own.

## 148. Formations and convoys: a shape for every move, kept on the way (2026-11-17)

I4 of the inspiration build order (136). Fabio's answers: convoy by default on roads and in
towns, the army's doctrine in open ground, Auto by default with a Movement button on
selections and on commanders to override.

Until now a move order ended in a block and promised nothing about the way there. Every
move now has a shape (`src/sim/formations.ts`):

- **Convoy.** Vehicles in file, 9 m centre to centre, fighting vehicles first; with three
  or more of them and anything soft in the file, the rearmost closes it as a rear guard.
  Squads walk in pairs on both sides of the vehicles, 3.5 m out, three pairs to a vehicle;
  the first pair walks 6 m ahead of the lead vehicle, so men look round a corner before a
  hull does. Squads there is no vehicle for follow in two files. A convoy halts in the old
  block (vehicles in front).
- **Wedge, line, vee, echelon.** Armour in front, the squads behind it in the same shape,
  everything else (trucks, guns, air defence, jammers, aircraft) in lines at the back.
  Ranks of eleven at most. The body stands in the shape where it stops.
- **Block.** What a move always was. Keeps no shape on the way.

**Auto** chooses: a convoy when the place ordered is in a town or within two cells of a
street or a square, otherwise the army's doctrine: Western alliance a wedge, Russia a line,
China a vee. The wedge (the standard US movement formation) and the line (the Soviet and
Russian battle line of tanks with the carriers behind) are doctrine; the vee for China is
a choice for the game, to give it a silhouette and a fire sack of its own, and is not a
claim about how the PLA fights. An army with no faction keeps the block everywhere, so
every test, every scenario and the golden hash (2037256287) play to the bit as before;
it becomes the guerrilla army in I8 and gets its own way of moving there.

The choice is made from where the body is sent, not from where it stands: a body leaving a
town for a field forms up as it comes out, and one sent into a town across a field goes in
file from the start (a road march). It is made once per order.

**How the shape is kept.** Not by paths. One unit, the guide, follows the route; every
other keeps station on a lead: behind it at a gap (the file), at a fixed offset on the map
from the guide (the open shapes), or at an offset in the lead's own frame (the squads
beside a vehicle, who turn the corner with it). A unit walks straight to its place when it
has a clear line to it and closes up at its own top speed; the guide walks at seven
eighths of the slowest unit's pace so that the slowest can close up at all. A unit with no
clear line to its place, or whose lead is dead, has stopped, has been sent elsewhere or
has stopped to fight on an attack-move, goes on to its own spot by the route, as every
unit did before: nobody is ever left waiting on a lead. State per unit: `shape`, `march`
(the number of the order; only units of one march follow each other), `lead`, `berth`,
`offA`, `offB`, all hashed, and only for units that have them.

**Orders.** `CMD_SHAPE` 43 (units, shape) is kept by the units until changed and applies
from their next move order. `CMD_MARCH` 44 (team, slot, shape) is kept by a commander in
three spare bits of `cFlags`; a commander's shape goes before what its troops were told.
Both are checked like every other order: only an army's own units and commanders.

**Cost.** A march in a shape goes at seven eighths of the pace of one in a block. In
the pinned games (computers, with factions) the city game has 57 dead after eight minutes
where it had 70 and the four corners game 179 where it had 156: the same order of battle,
not measured for balance. A four army game of 15 minutes costs 1.08 ms a tick where it
cost 0.96. `tests/shapes.test.ts` (14 tests); golden games re-pinned.

Not done: the rest of the first sketch (a line that turns to face a known enemy, echelon
by the open flank, infantry first in woods, bounding overwatch, herringbone at a halt),
the computer choosing shapes on purpose, a drawing of the shape before the order is
given, and any measurement of what convoys do to the computer's attacks in a city.

## 149. Armour that holds a place stands at posts round it (2026-11-17)

Fabio, playing: "when defending a grid inside a city, armour usually gathers together in
the middle of the grid taking too long to respond to small firefights and moving as a big
group".

What the code did: a commander on Hold or Defend sent every vehicle of the line to the
middle of the place (in a town, the square), and on Defend sent everyone who stood idle to
the middle of all the enemy seen within 110 m, whatever had come.

What it does now (`src/sim/staff.ts`, `posts`, `station`, `defend`):

- Each vehicle has a post of its own on a ring round the place (40 m out; three quarters of
  a town's radius, 32 to 46 m). The first post looks away from home, the next to either
  side, the last behind; from the ninth vehicle on they double up 8 m further in. Near each
  point of the ring the cell is taken that is beside a wall and on a street, and not in the
  middle of a crossing. A vehicle keeps its post while the commander keeps its place; a
  post left by a loss goes to the next vehicle that joins.
- On Defend, enemies within 40 m of one another are one contact. Each contact is met by the
  nearest vehicles, as many as make half again its strength, also by those still driving to
  their posts. When that takes more than half the vehicles (or more than two of a small
  body), or there are not enough, it is an attack on the place and the body meets it whole,
  as before, at the strongest contact (not the middle of all of them).
- When the contact is gone the vehicles drive back to their posts. Squads stay in their
  houses for a small contact.

Vehicles have no cover rule in the sim: "beside a wall" keeps them out of the long sight
lines of a crossing and looks right, it does not make them harder to hit. The computer
player's own defence (`ai.ts`) is unchanged. Staff orders are ordinary commands, so no
golden hash moves. Tests: `tests/posts.test.ts`.

## 150. The ground floor and fire (I5) (2026-11-17)

Fabio's ask from the inspiration review: floor by floor, with a collapse from the ground
floor, and no floor orders. His condition, given the day destruction was called "perfect
now": the time and effort to destroy a building stay where they are.

A building keeps one health. What changes is where a hit lands (`src/sim/collapse.ts`):

- From far off or from above (shells, rockets, helicopters, strike drones, a tank across the
  square, stray fire) it comes off the top, exactly as before: the roof, then a storey at a
  time, gutted, down.
- At arm's length it also comes off the ground floor (`sGround`), which is a share of the
  same health (`GROUND_PCT` 75): direct fire from a ground unit within `POINT_BLANK` (8) of
  the wall, an engineer's charge, a vehicle blowing up against it. When the ground floor is
  gone the building pancakes, whatever health it had left (`EV_COLLAPSE` with b = 1,
  `sFell`). Losses inside are the ones a collapse always cost.
- A ground floor under half (`FIRE_PCT`) is alight (`sFire`, `EV_FIRE`). The fire takes a
  floor every six seconds. When it has the whole house the garrison comes out by itself,
  unhurt, and nobody goes in until it has burnt out forty seconds later. Fire does no
  damage to the structure: it clears a house, it does not level one. Mending shores the
  ground floor up with the rest.

Why these numbers. A charge takes three quarters of its damage off the ground floor, so a
building falls to charges on the same charge as before; it now falls flat. A tank at range
is untouched. The one thing that got faster is a tank with its muzzle on the wall: three
quarters of the time (average house 69 s to 51 s, block 136 s to 102 s). That is the
point of the rule and it has a price: 8 is also the distance at which a rifle squad's
rockets do four times their damage.

Measured (`tools/level.ts`, one attacker, four kinds of building): tank at range and
engineers level to the second as before. `tools/toll.ts`, hard against hard on the city, 45
minutes, seeds 1 to 8, before and after (on main at f26d652): buildings marked or worse 1164 and 1229 in all,
ruins 290 and 309, of which 11 pancakes; three of the eight games played out identically,
the rest drifted the way any change moves a game. The computers rarely fight at arm's
length from a wall, so the rule is the player's to use.

On screen (`src/client/structures.ts`): flames out of the windows of every floor the fire
has, soot up the wall over a burnt ground floor for the rest of the game, a pancake as a
stack of floors with the roof on top and a wall of dust and no blast when it goes.

Not built: the computer driving tanks up to a wall on purpose, civilians running from a
fire, fire spreading to the house next door, a spoken report when a garrison is burnt out.
The golden hashes moved (the hash now takes in the ground floor and the fire).

## 151. The corner that won: fuel, not ground (2026-11-17)

The faction balance run (PR #129) found that the army starting in the
first corner (south-west) won about 62% of games between computers, more than any faction
gap. Measured again with the same faction on both sides, hard against hard, 25 minutes, 54
games: city 15 of 18 to the first corner, euro 9 of 18, ridge 8 of 18. So it was the city
map, and there it was four games in five.

**What it was not.** Not the map: the city map is an exact mirror image of itself (terrain,
buildings, sites; checked cell by cell). Not the army's number or the order in which things
are worked out in the sim: with the two armies made to change corners (`SWAP=1` in
`tools/factionduel.ts`) the advantage stayed with the corner, 13 of 18. Not the field works.

**What it was.** Fuel. The computer never decided to put a depot by a well. A well was
worked only if a depot put up for a stockpile happened to stand within 60 m of it, and on
the city map none does by design: the well by the base is 62 m from the headquarters.
Where a stockpile's depot goes was worked out east-west only ("16 m on the side home is
on, along x"), which on a map mirrored across its diagonal is not the same thing from the
two corners. From the south-west it slid depots toward the well up the road; from the
north-east it did not. The north-east army had 23 fuel and no well for the first eight
minutes while supplies piled up to tens of thousands, so it fielded rifles against
carriers and tanks.

**What it does now** (`src/sim/ai.ts`, `economy`):

- A well on its side that no depot reaches (and none is going up for) gets a depot of its
  own, the nearest first: at once when it works no well at all, and again whenever it is
  short of fuel with supplies to spare.
- A stockpile's depot goes on the side that faces home, whichever way home lies.

**After.** Same faction on both sides, 90 games: city 15 of 36 to the first corner, euro 16
of 36, ridge 11 of 18; 42 of 90 in all (47%). With 36 games a map the figure is good to
about 8 points either way, so each map is within chance of even and none is pinned finer
than that.

**What else it changes.** The computer a person plays against starts in the north-east,
the corner that went without. On the city map it now has fuel from the second minute on
every level: on Normal, alone on the map, it has 167 army points at six minutes where it
had 104, with its first tanks then and not at ten. Easy keeps its size but has strike drones and
tanks earlier. The levels were tuned by play with the handicap in; if Normal on the city map is
now too hard, the place to give is `AI_TUNING`, not the wells.

Tests: `tests/ai.test.ts` (both corners of the city map have a well in reach of a depot
and fuel coming in at three minutes; fails on the old code). The ridge test counts what was
built, not who was alive at the end. Golden games re-pinned (the computers' economy moves
from the first minute).

Not done: the rest of the computer's east-west thinking (where it forms up, which side of
a town its wire goes, where the barracks stands by the headquarters) is still along x
only. Measured, it no longer decides games. The ridge map is not quite a mirror image (62
cells differ, round Ridgetop); also within chance.

## 152. The main menu shows the game's own battles (2026-11-17)

Fabio asked for a more impressive picture on the menu. The old one was one shot from the
game's own steep camera: mostly grass, the fight a small patch in the middle.

- Three stills, taken in the game: a rocket salvo over the city centre, the ruins of the
  European city's square, helicopters going down over the city. All by night, the look he
  called "amazing". Nothing is painted in or graded afterwards.
- They are staged, not found: two armies of every arm put a street apart on a square and
  ordered at each other, photographed about a minute in, from a camera lower and closer
  than the game allows (`tools/menushots.mjs` does all of it, so the pictures can be taken
  again whenever the look of the game moves on).
- On the menu they show in turn, 14 seconds each, fading into one another and drifting
  slowly. Only opacity and transform move, so the browser's compositor does the work and
  the menu costs nothing on a weak machine. The second and third are fetched only after
  the first is on the screen. With "reduce motion" or data saving asked for, it is the
  first picture, still.
- Not a live 3D scene behind the menu: the game takes seconds to build its city and would
  make the menu as heavy as a battle. Stills weigh 0.9 MB together.

The other screens (new battle, settings, lobby, end of game) keep one dimmed picture.

## 153. Kowloon: a harbour city of towers round a park (2026-11-20)

Fabio asked for an urban map after Hong Kong, Tsim Sha Tsui and Jordan, with Kowloon Park
as the centre. `?map=kowloon`, Menu > Map: Kowloon (`src/sim/kowloon.ts`).

- The real place is nearly symmetric about the line from the Star Ferry through Kowloon
  Park to Gun Club Hill (harbour west and south, Nathan Road and Austin Road meeting at
  the park's far corner), so it is laid on the map's usual diagonal mirror turned a
  quarter: harbour along the north and west edges, the Star Ferry in the north-west
  corner, the armies at the two inland ends of the waterfront. Each road in one half has
  a twin in the other: Salisbury/Canton, Nathan/Austin, Chatham/Jordan.
- Fifteen flags: six pairs (Granville Road/Jordan, Chungking Mansions/Xiqu Centre, Cultural
  Centre/Harbour City, Signal Hill/West Kowloon, Tsim Sha Tsui East/Yau Ma Tei, Haiphong
  Road/Canton Road) and three shared on the diagonal (Star Ferry, Kowloon Park, Gun Club
  Hill). MAX_TOWNS is 16.
- A street every 12 cells both ways, no bridges, no compound walls across the map: the
  diagonal is open to vehicles in ten separate places and an armoured column still gets
  across with the park, the waterfront and Gun Club Hill all shut (test). Tanks own Nathan
  Road and the waterfront; the side streets between towers belong to infantry upstairs.
- 716 buildings (city 444, European city 684), blocks of Hong Kong kinds: tenements wall to
  wall with a back lane, slab towers, a mall podium with a tower, public housing round a
  playground, a market, a sitting-out garden. Landmarks placed by hand: Star Ferry pier and
  clock tower, the old marine police knoll, Cultural Centre and planetarium, the Peninsula,
  Chungking Mansions, K11, The ONE, Signal Hill and its tower, the park's barracks, sports
  centre and ponds, Gun Club Hill barracks. Names and shapes after the real place; a game
  map, not a survey. Up to 18 floors.
- Drawn the Hong Kong way only on this map (`hk` in structures.ts): flat concrete roofs with
  lift houses and huts, pale tiled walls, windows in bands between the frame's columns (a
  20-floor tower costs what two floors did window by window), air conditioners, and boards
  hung out over the street read top to bottom (sign sheet rows 16 to 19, `SIGN_TALL`).
  Painted, no light of their own. Street plates carry the real street names in English and
  Chinese; every shop is made up.
- Measured in the cloud (software WebGL, so counts not frame rates): whole map 1.57M
  triangles, 341 draw calls (city 1.26M/230, European city 2.26M/481). Sim mean 0.57 ms a
  tick over 30 minutes (city 0.53, European 0.62). Six hard-vs-hard games, 25 minutes
  each: flags held at the end 44 to 46, losses even, no corner advantage.

Not done: footbridges over Nathan Road, double-decker buses and trams, quay walls (the
harbour edge is a bank), lit signs at night (by choice: no glow).
