# Trailer tools

Shoots the launch trailer from the real game, one frame at a time, and cuts it.

The game has a capture mode (`?capture=1`). In it the clock stands still until
`__revolution.step(ms)` is called, which advances the simulation by exactly that
much and draws one frame. `__revolution.film.cine = { pos, target, fov, lod }`
takes the camera away from the player. That is what lets slow cloud graphics
produce smooth 24 fps footage.

## Shooting

    npm run build && npx vite preview --port 4173 --host 127.0.0.1 &
    cd tools/trailer
    node shoot.mjs shots/collapse.mjs --scout --every 2      # stills, to pick a camera
    node shoot.mjs shots/collapse.mjs --cam wide --warm 26 --dur 7 --w 1920 --h 804
    python3 runfinal.py final.txt "--w 1920 --h 804 --resume" 2   # the whole list

Each file in `shots/` sets up a scene (map, armies, orders, timed events) and
one or more cameras. Frames land in `out/<shot>-<cam>-<W>x<H>/`. `--resume`
carries on from the frames already there.

What looks good: cameras 15 to 70 m up, clear day shot from the south-west, or
night with fires and flares. Ground level and fog look poor.

## Cutting

    python3 edit.py wide        # 16:9 with letterbox
    python3 edit.py tall        # 9:16 for social (needs the shots rendered tall)

`edit.py` holds the cut list, the title cards and the sound mix. It expects the
music and sound effects in `audio/` (generated with ElevenLabs, not in the repo).
