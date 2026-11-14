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
