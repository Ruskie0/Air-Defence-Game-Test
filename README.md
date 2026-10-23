# Air Defence

A realistic 3D integrated air defence game in the browser. Radars run the radar range equation with
terrain masking, clutter and jamming; every sensor feeds one fused track picture; LR and MR SAMs,
SHORAD, two CIWS guns, EW (GNSS jammer, radar decoy, EMCON) and two CAP fighters defend an airbase
against drones, cruise missiles, bombers, SEAD with anti-radiation missiles, a stand-off jammer and
ballistic missiles.

Two modes: a **ten-day campaign** (buy and deploy units between days on a budget earned from what
still stands, against an enemy that learns from what worked) and the **sandbox** (a fixed defence
against six scripted raids plus a spawn panel).

## Play

```sh
npm install
npm run dev
```

Open the printed URL. Press `?` in the game for how to play. Keys: Space pauses, 1 to 5 set time
compression (1x to 16x), Esc clears the selection or cancels a placement. `?mode=sandbox` skips the
menu, `?mode=campaign&seed=123` starts a campaign with a given seed, `?seed=123` alone changes the
sandbox seed.

Every push to `main` builds and deploys to GitHub Pages through `.github/workflows/pages.yml`
(Settings, Pages, Source: GitHub Actions).

## Build and test

```sh
npm run build      # typecheck and bundle to dist/
npm run sim        # headless sandbox report: every raid, every threat's fate (no browser)
npm run campaign   # headless ten-day campaign with an automatic commander (no browser)
npm run playtest   # headless browser run through the sandbox raids, screenshots in playtest/
npm run playtest:campaign  # headless browser run through a campaign day via the planning screen
```

See [docs/DESIGN.md](docs/DESIGN.md) for the simulation model and the roadmap.
