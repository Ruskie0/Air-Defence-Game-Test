# Air Defence Sandbox

A realistic 3D integrated air defence game in the browser. Radars run the radar range equation with
terrain masking, clutter and jamming; every sensor feeds one fused track picture; LR and MR SAMs,
SHORAD, two CIWS guns, EW (GNSS jammer, radar decoy, EMCON) and two CAP fighters defend an airbase
against drones, cruise missiles, bombers, SEAD with anti-radiation missiles, a stand-off jammer and
ballistic missiles.

## Play

```sh
npm install
npm run dev
```

Open the printed URL. Press `?` in the game for how to play. Keys: Space pauses, 1 to 5 set time
compression (1x to 16x), Esc clears the selection. `?seed=123` in the URL changes the scenario seed.

Every push to `main` builds and deploys to GitHub Pages through `.github/workflows/pages.yml`
(Settings, Pages, Source: GitHub Actions).

## Build and test

```sh
npm run build      # typecheck and bundle to dist/
npm run sim        # headless balance report: every raid, every threat's fate (no browser)
npm run playtest   # headless browser run through the raids, screenshots in playtest/
```

See [docs/DESIGN.md](docs/DESIGN.md) for the simulation model and the roadmap.
