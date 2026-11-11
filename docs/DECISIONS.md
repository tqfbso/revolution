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
