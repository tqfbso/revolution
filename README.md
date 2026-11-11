# Revolution

A modern real-time strategy game for the browser: present-day setting, huge battles, cities
as fortresses. Work in progress.

**Play the latest build:** https://tqfbso.github.io/revolution/

Add `?units=6000` to the URL to change the stress-test size, `?seed=7` for a different
world, `?renderer=webgl` to force the WebGL2 fallback.

## Controls

| Action       | Input                                     |
| ------------ | ----------------------------------------- |
| Select       | Left drag (box), left click, Shift to add |
| Select all   | Ctrl+A                                    |
| Move         | Right click                               |
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
