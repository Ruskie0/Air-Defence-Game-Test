# Air Defence Sandbox: design

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
| `tracker.ts` | Central fusion: every report from every sensor is gated and associated to one track picture, filtered with an alpha-beta filter (gravity-aided for ballistic tracks), confirmed M-of-N, coasted and dropped. Duplicate tracks are merged. Strobes from separated sensors are cross-fixed into jammer tracks. Kinematic classification (TBM, fast missile, cruise missile, UAV, fixed wing, civil) plus IFF give the identity: hostile, suspect, pending, neutral, friend. A weapon launch observed from a track marks it hostile. |
| `missile.ts` | Interceptor kinematics (boost, drag with altitude, g limit falling with speed and air density, gravity) and zero-effort-miss proportional navigation with lofting. Guidance modes: track-via-missile (LR), active radar homing with engage-on-remote midcourse (MR, AAM) and command to line of sight (SHORAD). Proximity fuze on the closest approach inside each step, Pk falling with miss distance. |
| `sites.ts` | Damageable ground sites, the SAM fire units (launchers, channels, reload, feasibility and predicted intercept point), the radar decoy and the GNSS jammer. |
| `ciws.ts` | Gun system with its own search radar, an alpha-beta fire-control track, a lead solution with drag and gravity drop, and every round flown individually with dispersion and a per-round hit test. |
| `fighter.ts` | CAP fighters: airborne radar (contributes to the picture and gets jammed), Mode 5, AAMs, fuel, RTB and rearm. |
| `entities.ts` | Threat behaviour: GNSS-guided drones, terrain-following cruise missiles, ballistic missiles, ARMs with memory and seeker re-acquisition, bombers with stand-off ALCMs, SEAD fighters using ESM, the stand-off jammer, and civil airliners. |
| `tewa.ts` | Threat evaluation and weapon assignment under the weapons control status (HOLD, TIGHT, FREE): orders threats by time to go, picks the cheapest effective weapon, and commits CAP forward of the SAM belt. |
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

## Roadmap: the mission layer

The prototype is a single sandbox. The next layers, in order:

1. **Mission briefing and scoring.** A mission is a JSON file: defended assets with values, the friendly
   order of battle, the enemy raid plan, rules of engagement (initial WCS, ID criteria such as an
   ADIZ and a hostile-act definition), and win/loss conditions (asset survival, civil losses,
   interceptor budget). Debrief with an engagement timeline and the cost exchange ratio.
2. **Deployment phase.** Before the clock starts, place radars and launchers on the terrain with
   line-of-sight and coverage previews (radar horizon heat map, weapon engagement zones), choose the LR
   sector boresight, set CAP stations and the decoy position.
3. **Campaign.** A sequence of missions where losses, expended missiles and reloads carry over, and
   the enemy adapts (more SEAD if you radiate, more low-level routes if the passes are covered).
4. **Command and control depth.** Engagement authority per weapon (centralised or autonomous fire
   units), a datalink with latency and capacity, sector boundaries and handover between systems, kill
   assessment by the operator.
5. **More EW.** Self-protection jammers on strike aircraft, deception (range-gate pull-off, false
   targets), chaff, frequency agility and burn-through tactics, home-on-jam rules.
6. **More systems.** AEW aircraft, passive sensors (ESM network, IRST), counter-drone directed energy,
   relocatable launchers with move/emplace times, decoys for SAM launchers.
7. **Fidelity.** Aspect-dependent RCS tables, multipath at low elevation, debris from intercepts,
   weather and propagation (ducting), missile seeker models with their own detection maths.
8. **Engineering.** Move the sim into a Web Worker, record and replay runs from the seed plus the
   command log, deterministic regression tests on the sim.

## Testing

`scripts/playtest.mjs` builds nothing itself: run `npm run build` first. It serves `dist/` with
`vite preview`, opens it in headless Chromium, closes the help screen, steps the sim straight through the
raids, prints the state every simulated minute, saves screenshots to `playtest/` and fails on any page
error.
