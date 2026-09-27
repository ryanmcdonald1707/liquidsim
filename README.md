# Coffee — a physically based liquid simulation

A cup of coffee on a wooden table, rendered in real time with WebGL2. Stir it, pour in milk, drop sugar in, knock the table or slide the cup to slosh it.

No build step or dependencies. Serve the folder and open `index.html`:

```sh
npx http-server .     # or: python3 -m http.server
```

Requires WebGL2 with `EXT_color_buffer_float`, which any recent desktop or mobile browser has.

## Controls

| Action | Input |
| --- | --- |
| Stir with the spoon | drag on the coffee |
| Drop a droplet | tap the coffee |
| Slide the cup (sloshing) | drag the cup or saucer, or use the arrow keys |
| Orbit / zoom | drag the background (or right-drag), scroll |
| Stir / milk / sugar / knock / reset | `S` `M` `D` `K` `R` or the buttons |

## What's simulated

**Free-surface waves: exact modal solution for a cylindrical cup** (`src/modal.js`)
The coffee surface is expanded in the eigenmodes of a cylinder, `J_m(k r)·cos/sin(mθ)`, with `k R` the zeros of `J_m'` (no flow through the wall). That gives about 3,000 modes up to `kR = 110`, down to wavelengths of about 2 mm. Each mode is a damped oscillator with the full gravity–capillary finite-depth dispersion relation:

    ω² = (g k + σ/ρ k³) tanh(k H)

Each oscillator is advanced with its exact propagator, so it is unconditionally stable even for the ~170 Hz capillary modes. The following all fall out of the physics:
- the 3.4 Hz fundamental slosh of an 8 cm mug
- capillary ripples running ahead of gravity waves after a drop
- ring waves converging after a knock
- reflections off the wall

Damping per mode comes from bulk viscosity, the inextensible surfactant film on coffee, the wall and bottom Stokes layers, and contact-line losses. Moving the cup applies the fictitious force in the cup's frame, projected onto the m = 1 modes.

**Surface flow** (`src/shaders.js`: `advectVel` … `grad`)
A 2D stable-fluids solver on the GPU runs inside the circular domain:
- free-slip walls with vorticity confinement
- the spoon drags the liquid with it
- spin-down on a ~20 s timescale

The azimuthally averaged swirl is read back and integrated as `dη/dr = u_θ²/(g r)` to produce the vortex dip of stirred coffee. Pouring milk injects a divergent upwelling source, because milk that plunges in resurfaces and spreads, plus turbulence. MacCormack advection keeps the milk clouds sharp.

**Other effects**
- A static capillary meniscus climbs the wall (capillary length ≈ 2.3 mm).
- Floating bubbles are ray-traced thin-film domes (spherical caps) with a meniscus skirt at the foot. They are carried by the flow. They cluster against the wall (capillary attraction up the meniscus) and migrate into the eye of a vortex.
- A wet film is left on the wall when the coffee sloshes. It drains, and a faint tide mark stays at the resting line.

## Rendering

- **Reflections:** reflection rays from the coffee (and from bubbles and the spoon) are traced analytically against the cup's interior cylinder. You see the real cup wall and rim in the liquid, and the window beyond.
- **Black coffee:** Beer–Lambert absorption, strongest at blue wavelengths. The white wall shows through as an amber ring where the liquid thins at the meniscus.
- **Milk:** Kubelka–Munk diffuse reflectance from the mixed absorption and scattering coefficients, so a splash of milk goes café-au-lait by physics, not by a colour ramp.
- **Lighting:** a procedural room — a daylight window with mullions and a tungsten lamp — lights everything. The cup casts analytic soft shadows on the saucer and table, and the rim shadows the inside of the cup.
- **Scene materials:** glazed ceramic, varnished wood and a polished steel teaspoon.
- **Steam:** ray-marched, back-lit by the window with a Henyey–Greenstein phase function.
- **Post-processing:** HDR rendering with 4× MSAA, bloom, an ACES filmic tone map, vignette and grain.
- **Performance:** resolution adapts automatically on slower GPUs.

## Screenshots

| Stirring | Milk | Droplet |
| --- | --- | --- |
| ![stirring](docs/stir.png) | ![milk](docs/milk.png) | ![droplet](docs/drop.png) |
