# Revolution

A modern real-time strategy game for the browser: present-day setting, huge battles, cities
as fortresses. Work in progress.

**Play the latest build:** https://tqfbso.github.io/revolution/

The page opens on a skirmish: you (red) and the AI (blue) each start with a headquarters,
six trucks and a patrol. URL options: `?ai=easy`, `?ai=hard` or `?ai=off` (the default is
normal), `?demo=1` to watch the AI play both sides, `?speed=4` to run the game faster,
`?seed=7` a different map, `?scenario=assault` the old attack on a held town (`clash` and
`roam` are stress tests, sized with `?units=6000`), `?shadows=0` no shadows, `?lod=0.5` drop
detail sooner (or `2` to keep it longer), `?renderer=webgl` force the WebGL2 fallback.

## Controls

| Action       | Input                                     |
| ------------ | ----------------------------------------- |
| Select       | Left drag (box), left click, Shift to add |
| Select all   | Ctrl+A                                    |
| Move         | Right click (breaks off any fight)        |
| Attack       | Right click an enemy unit                 |
| Attack-move  | A then click, or Alt + right click        |
| Stop / clear | X / Esc                                   |
| Pan          | WASD, arrow keys, or mouse at screen edge |
| Zoom         | Mouse wheel                               |
| Rotate       | Q / E, or middle-mouse drag               |

## Development

```
npm ci
npm run dev        # local dev server
npm test           # unit tests, including the determinism test
npm run lint && npm run format:check && npm run typecheck
npm run build      # production build in dist/
```

Every merge to `main` runs CI and deploys to GitHub Pages.

## Docs

- [Architecture](docs/ARCHITECTURE.md)
- [Roadmap](docs/ROADMAP.md)
- [Decisions](docs/DECISIONS.md)
