# Revolution

A modern real-time strategy game for the browser: present-day setting, huge battles, cities
as fortresses. Work in progress.

**Play the latest build:** https://tqfbso.github.io/revolution/

The page opens on a battle: two armies of tanks and infantry squads attack each other.
URL options: `?units=6000` army size in total, `?seed=7` a different battle,
`?scenario=roam` three roaming armies instead, `?shadows=0` no shadows, `?lod=0.5` drop
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
