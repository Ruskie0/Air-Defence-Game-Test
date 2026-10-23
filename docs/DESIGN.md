# Air Defence: design

A browser-based, 3D, simulation-first air defence game. The player is the air defence commander of a
small defended area (an airbase, a command and reporting centre and a power plant) and fights through
raids of drones, cruise missiles, aircraft, SEAD packages, jammers and ballistic missiles.

The aim is "realistic, not arcade": every sensor and weapon is modelled from first principles closely
enough that real tactics (terrain masking, EMCON, decoys, engage on remote, shoot-look-shoot,
identification discipline) work for the right reasons. Parameters are representative of each class of
system, not copies of any real system.

## Stack

- Vite 7, TypeScript 5.9 (strict), three.js 0.186. No other runtime dependencies.
- `base: './'` so the static build runs from any path (GitHub Pages, a file share, an artifact).
- `src/sim` is pure TypeScript with no DOM or three.js imports, so it can run headless (tests, a
  future server, a worker).
- `src/render` draws the sim with three.js; `src/ui` is plain DOM plus a canvas PPI.

## Simulation core (`src/sim`)

| Module | What it does |
| --- | --- |
| `world.ts` | Owns everything. Fixed 60 Hz step; one seeded RNG stream (`?seed=` in the URL) so a run replays identically for the same inputs. |
| `terrain.ts` | 160 x 160 km procedural heightmap at 500 m: plains around the airbase, a mountain belt to the north cut by two passes, sea to the south. Line of sight samples the path with a 4/3-earth bulge (`d1*d2 / 2Re`), so low flyers drop below the radar horizon as well as behind hills. |
| `radar.ts` | Radar range equation in physical units (Pt, G, lambda, B, NF, L, coherent pulses). Swerling-1 detection, `Pd = Pfa^(1/(1+SINR))`, rolled per dwell. Ground clutter when the beam footprint touches the ground (scaled by terrain relief, reduced by the MTI improvement factor), and a zero-Doppler notch for slow radial speeds in clutter. Rotating radars detect as the beam sweeps past; phased arrays sweep a sector and revisit firm tracks at the track rate. Noise jamming through the antenna pattern with sidelobes and sidelobe cancellers; main-lobe jamming above 10 dB J/N produces a jam strobe. Measurement noise follows the SNR. IFF Mode 5 / Mode 3C interrogation. |
| `tracker.ts` | Central fusion: every report from every sensor is gated and associated to one track picture, filtered with a per-axis constant-velocity Kalman filter (separate horizontal and vertical measurement noise, so a fan-beam radar's poor height barely moves the track; gravity-aided for ballistic tracks), confirmed M-of-N, coasted and dropped. Duplicate tracks are merged. Strobes from separated sensors are cross-fixed into jammer tracks, and only fixes with good crossing geometry are used. Kinematic classification (TBM, fast missile, cruise missile, UAV, fixed wing, civil) waits until the filter's velocity uncertainty is small enough to be sure, so a noisy new track is not called a missile. Classification plus IFF give the identity: hostile, suspect, pending, neutral, friend. A weapon launch observed from a track marks it hostile. |
| `missile.ts` | Interceptor kinematics (boost, drag with altitude, g limit falling with speed and air density, gravity) and zero-effort-miss proportional navigation with lofting. Guidance modes: track-via-missile (LR), active radar homing with engage-on-remote midcourse (MR, AAM) and command to line of sight (SHORAD). Proximity fuze on the closest approach inside each step, Pk falling with miss distance. |
| `sites.ts` | Damageable ground sites, the SAM fire units (launchers, channels, reload, feasibility and predicted intercept point), the radar decoy and the GNSS jammer. |
| `ciws.ts` | Gun system with its own search radar, an alpha-beta fire-control track, a lead solution with drag and gravity drop, and every round flown individually with dispersion and a per-round hit test. |
| `fighter.ts` | CAP fighters: airborne radar (contributes to the picture and gets jammed), Mode 5, AAMs, fuel, RTB and rearm. |
| `entities.ts` | Threat behaviour: GNSS-guided drones, terrain-following cruise missiles, ballistic missiles, ARMs with memory and seeker re-acquisition, bombers with stand-off ALCMs, SEAD fighters using ESM, the stand-off jammer, and civil airliners. |
| `tewa.ts` | Threat evaluation and weapon assignment under the weapons control status (HOLD, TIGHT, FREE): orders threats by time to go, picks the cheapest effective weapon, holds the last MR rounds back from drones, holds fire while a friendly is near the target, and commits CAP forward of the SAM belt. Fire units solve for the earliest predicted intercept point along the target's path (below the missile ceiling and, for ballistic targets, before impact). |
| `scenario.ts`, `threats.ts` | The six-raid sandbox scenario, background civil traffic, and spawn helpers used by the spawn panel. |

### Order of a step

1. Scheduled spawns and raids.
2. Entities move (and threats launch weapons).
3. GNSS jamming updates navigation errors.
4. Every radar dwells, producing reports and strobes.
5. Fusion updates the track picture.
6. Fire units launch queued missiles; TEWA runs once a second.
7. Interceptors guide and fuze; CIWS guns fire and fly their rounds.
8. Dead objects are removed.

## Friendly order of battle

| System | Sensor | Weapon | Notes |
| --- | --- | --- | --- |
| LR SAM | C-band phased array, 120 deg sector facing north, sidelobe cancellers | 16 missiles, 120 km aero, 40 km TBM | Track-via-missile: needs its own radar holding the target for the whole flight. The only TBM defence. |
| MR SAM | X-band rotating 3D radar, 75 km | 18 missiles on three dispersed launchers, 32 km | Engage on remote: fires on any fused track, even with its own radar silent or destroyed. |
| SHORAD | S-band fan-beam search, 25 km | 8 missiles, 10 km | Command guided, one target at a time, needs tracker line of sight. |
| 2 x CIWS | Ku-band search, 9 km | 4500 rpm gun, 1550 rounds | Engages any red object closing inside ~2 km in self defence, even on HOLD. |
| GNSS jammer | | 30 km radius | Drives a random-walk navigation error into GNSS-dependent threats. |
| Radar decoy | | | Radiates the LR radar's signature; ARMs that lose their emitter re-acquire it. |
| EMCON | every radar | | Silent radars are invisible to ESM and break ARM lock, but see nothing. |
| 2 x CAP fighter | X-band airborne radar | 4 AAM each, 70 km | Datalinked to the fused picture, Mode 5, fuel and rearm cycle. |

## Threats

- One-way attack drones: 50 m/s, 0.1 m2, low, GNSS guided (30% with an anti-jam antenna).
- Cruise missiles: 240 m/s, 0.05 m2, terrain following at 40 m through the northern passes or over the sea.
- Strike bombers launching air-launched cruise missiles from 115 km.
- SEAD fighters with ESM and anti-radiation missiles (Mach 3, memory mode, seeker re-acquisition).
- Stand-off jammer on a racetrack 125 km out, barrage noise across 2 to 18 GHz.
- Short-range ballistic missiles re-entering at about 2 km/s.
- Civil airliners on airways (Mode 3C), including one with a failed transponder.

## The sandbox scenario

| Raid | Sim time | Content |
| --- | --- | --- |
| 1 | 0:20 | 8 drones from the north-east |
| 2 | 5:30 | 6 cruise missiles through the passes, timed to arrive with the drones |
| 3 | 15:00 | Stand-off jammer plus a SEAD pair with ARMs |
| 4 | 23:00 | 2 bombers, 8 ALCMs |
| 5 | 32:30 | 4 TBMs on the airbase, LR radar and CRC |
| 6 | 40:50 | Drones from the east, cruise missiles from the sea, TBMs, SEAD, and a dark airliner |

"Launch now" brings the next raid forward. The spawn panel adds any threat from any of eight bearings.

## Campaign (`src/campaign`, `src/ui/campaign-ui.ts`)

The main menu offers a ten-day campaign next to the sandbox. Each day has a planning phase and a battle.

- **Order of battle as data.** `src/sim/catalog.ts` lists every buyable unit type (price, unlock day,
  launchers, channels, reload time) and the `Deployment` the campaign owns between days: each unit's
  position, sector facing, launcher rounds, spare missiles and surviving aircraft. `World` takes a
  deployment and fields it; the sandbox is just `sandboxDeployment()` with unlimited spares.
- **Economy.** The budget each morning comes from what still works (`50 + 65 x airbase + 45 x power
  plant + 25 x CRC` at full health, $185M a day). It buys units, missiles for reloads, spare rounds
  that reload launchers during the day, extra launchers, replacement fighters and repairs (partial
  repairs spend what is left). Selling returns a fifth of the price.
- **Random maps.** Each campaign gets its own map from its seed (`randomLayout` in `terrain.ts`): the
  same ingredients as the sandbox map (a defended plain, a mountain belt on the enemy side cut by two
  passes, sea on the far side) with the whole layout turned to a random bearing and the coast distance,
  belt depth and height, ridge scale, lowland relief and pass shapes varied. Threats from the mountain
  side fly down the passes, raid sectors and the default unit positions turn with the map, and
  `terrain.valleys` gives the renderer the pass centre-lines. The sandbox keeps the classic map.
- **Difficulty.** Recruit, Regular and Veteran scale the enemy's threat budget (0.75x, 1x, 1.3x), our
  income (1.2x, 1x, 0.85x) and the starting budget ($220M, $160M, $130M). The automatic commander wins
  every Recruit campaign it was tried on, about half on Regular, and none on Veteran.
- **Unlocks.** MR, SHORAD, CIWS, early warning radar and GNSS jammer from day 1; decoy and CAP from
  day 2; the LR SAM (the only ballistic missile defence) from day 3. Ballistic missiles first appear on
  day 5 and are always reported the first time.
- **Deployment.** Units stand within 35 km of the airbase on dry, level ground and not on top of an
  asset or another unit; CAP stations within 90 km. The planning screen shows the unit's reach while
  placing and turns LR sectors in 30 degree steps.
- **Raid generator** (`raidgen.ts`). The enemy spends a threat budget of `8 + 7 x day` points on
  packages (drone swarms, cruise missiles, SEAD pairs, stand-off jammers, bombers with ALCMs,
  ballistic missiles), picks approach sectors from learned weights and launches them in waves.
  An airliner with its transponder off crosses on some days from day 3. Intel reports each package with
  a probability that falls from 90% to 60% over the campaign; unreported packages arrive unannounced.
- **Enemy learning.** After each day, package kinds and approach sectors that hit something gain weight,
  ones that did not lose it, and if the big radars radiated more than 80% of the day the enemy plans
  more SEAD.
- **Settlement.** Munitions still in the air when the day ends hit their targets. Destroyed radars
  lose the battery, destroyed launchers are removed, missiles left and spares carry over. The campaign
  is lost when the airbase is destroyed or after two airliner shootdowns, and won after day 10.
  Defended assets take reduced damage (the airbase 0.4x, the power plant 0.7x), since one hit does not
  close an airbase.
- **ARM response.** LR, MR and early warning radars start with "ARM auto" on: the radar goes silent
  while a hostile missile track is closing on it and stays silent until well after its predicted
  arrival. ARMs that lose their emitter fly on memory and look for another emitter (a decoy, or a
  nearby CIWS or SHORAD radar). Under heavy jamming the ARMs may never be tracked, which is the case
  for killing the jammer first.
- **Debrief.** Kills, leakers, missiles and their cost, kills per unit, damage, equipment lost and the
  enemy's lessons.
- **Saving.** The campaign state is plain JSON saved to `localStorage` after every change; storage
  errors are ignored so the game also runs where storage is blocked.

## Roadmap

1. **Mission briefing and scoring.** Rules of engagement per day (initial WCS, an ADIZ, a hostile-act
   definition), debrief with an engagement timeline and the cost exchange ratio.
2. **Deployment depth.** Radar horizon heat map while placing, move and emplace times, relocating units
   between waves.
3. **Command and control depth.** Engagement authority per weapon (centralised or autonomous fire
   units), a datalink with latency and capacity, sector boundaries and handover between systems, kill
   assessment by the operator.
4. **More EW.** Self-protection jammers on strike aircraft, deception (range-gate pull-off, false
   targets), chaff, frequency agility and burn-through tactics, home-on-jam rules.
5. **More systems.** AEW aircraft, passive sensors (ESM network, IRST), counter-drone directed energy,
   decoys for SAM launchers.
6. **Fidelity.** Aspect-dependent RCS tables, multipath at low elevation, debris from intercepts,
   weather and propagation (ducting), missile seeker models with their own detection maths.
7. **Engineering.** Move the sim into a Web Worker, record and replay runs from the seed plus the
   command log, deterministic regression tests on the sim.

## Testing

- `npm run sim -- [simSeconds] [seed] [--log]` runs the sandbox headless in Node (about 6 s for all six
  raids) and prints the fate of every threat by raid, damage to sites, missiles fired and rounds left.
  This is the tool for balancing: the sim is deterministic for a seed, so a change shows up as a diff.
- `npm run campaign -- [seed] [--verbose] [--log-day=N]` plays a whole campaign headless with a simple
  automatic commander (fixed shopping list, default positions, no manual engagements) and prints each
  day's raid, results, losses and budget.
- `scripts/playtest.mjs` and `scripts/playtest-campaign.mjs` build nothing themselves: run
  `npm run build` first. They serve `dist/` with `vite preview` and drive headless Chromium
  (`CHROMIUM_PATH` picks the browser). The first opens the sandbox from the menu and steps through the
  raids; the second buys and places a unit through the planning screen, fights day 1, ends it, checks
  the debrief and the next planning screen, and that a reload offers to continue. Both save screenshots
  to `playtest/` and fail on any page error.

### Balance baseline

Sandbox, seed 20261023, automatic defence only (WCS TIGHT, no player input): 49 kills, 4 leakers, no
fratricide or civil losses. ARMs that lose the silent LR radar re-acquire the nearby CIWS radar, one
ballistic missile in raid 5 gets through to the CRC, and the sea-skimming cruise missiles of raid 6
damage the power plant.

Campaign, automatic commander, seeds 1 to 6: three wins and three losses (airbase destroyed on days 8,
10 and 10), no civil or friendly losses. Its losses come from SEAD under jamming
cover (ARMs never tracked, radars lost) and from ballistic salvoes outside the LR sector or after the LR
radar is gone. A player who kills the jammers with the CAP, places the decoy, faces the LR sector at
the ballistic threat and keeps spares wins more often.
