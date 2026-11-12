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
but cannot replace losses. One unit counts as one, whatever it is: prices already tell a
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
