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
