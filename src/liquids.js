// Physical and optical properties of the lab liquids (SI units, ~20 C unless
// noted). sigA / sigS are absorption / scattering coefficients in 1/m for
// R, G, B; they drive Beer-Lambert transmission and Kubelka-Munk colour.
// theta is the contact angle on glass (degrees): > 90 makes a convex meniscus.
//
// Optional behaviour:
//   carb      rising gas bubbles (0..1.5): dissolved CO2, or boiling
//   bubble    typical bubble radius at the surface (m)
//   foam      head height (m) poured with the drink, halfLife of the head (s),
//             foamCol its albedo tint
//   vapor     'steam' (hot, rises) or 'fog' (cryogenic, spills and sinks)
//   magnetic  ferrofluid: a magnet under the beaker raises Rosensweig spikes

export const CATEGORIES = [
  ['Everyday', ['water', 'coffee', 'tea', 'milk', 'wine', 'oj']],
  ['Fizzy', ['sparkling', 'cola', 'lager', 'stout']],
  ['Viscous', ['oil', 'honey', 'maple', 'motor', 'glycerin']],
  ['Exotic', ['mercury', 'ln2', 'ferro', 'blood']],
];

export const LIQUIDS = {
  water: {
    name: 'Water', swatch: '#cfe3ea', rho: 998, nu: 1.0e-6, sigma: 0.072, ior: 1.333, theta: 20,
    sigA: [0.45, 0.07, 0.02], sigS: [0.002, 0.002, 0.002],
    note: 'Low viscosity, high surface tension: long-lived ripples and a sharp capillary wave front.',
  },
  coffee: {
    name: 'Black coffee', swatch: '#2a140a', rho: 1005, nu: 0.45e-6, sigma: 0.052, ior: 1.34, theta: 30,
    sigA: [80, 210, 450], sigS: [4, 4, 4], vapor: 'steam',
    note: 'Hot (~70 C), so thin. Dissolved surfactants lower the surface tension and damp ripples.',
  },
  tea: {
    name: 'Black tea', swatch: '#8a3d10', rho: 1000, nu: 0.5e-6, sigma: 0.068, ior: 1.335, theta: 25,
    sigA: [9, 40, 140], sigS: [0.5, 0.5, 0.5], vapor: 'steam',
    note: 'Clear but strongly absorbing in the blue: amber in thin layers, deep red-brown in bulk.',
  },
  milk: {
    name: 'Whole milk', swatch: '#f2eee4', rho: 1030, nu: 2.0e-6, sigma: 0.047, ior: 1.35, theta: 30,
    sigA: [0.8, 1.3, 2.8], sigS: [12000, 12200, 12500],
    note: 'Fat globules and casein micelles scatter light thousands of times per millimetre.',
  },
  wine: {
    name: 'Red wine', swatch: '#5a0a1e', rho: 990, nu: 1.5e-6, sigma: 0.047, ior: 1.345, theta: 20,
    sigA: [6, 380, 170], sigS: [0.3, 0.3, 0.3],
    note: 'Anthocyanins absorb green; ethanol lowers the surface tension (hence wine tears).',
  },
  oj: {
    name: 'Orange juice', swatch: '#f39a1d', rho: 1045, nu: 2.4e-6, sigma: 0.06, ior: 1.35, theta: 25,
    sigA: [4, 30, 260], sigS: [1400, 1350, 1300],
    note: 'Pulp and cloud particles make it turbid: carotenoids absorb the blue.',
  },

  sparkling: {
    name: 'Sparkling water', swatch: '#d8eef2', rho: 999, nu: 1.0e-6, sigma: 0.07, ior: 1.333, theta: 20,
    sigA: [0.45, 0.07, 0.02], sigS: [0.002, 0.002, 0.002], carb: 1.0, bubble: 0.0006,
    note: 'Supersaturated with CO2: bubbles nucleate at scratches on the glass and grow as they rise.',
  },
  cola: {
    name: 'Cola', swatch: '#3a1206', rho: 1040, nu: 1.0e-6, sigma: 0.065, ior: 1.35, theta: 25,
    sigA: [90, 280, 760], sigS: [1, 1, 1], carb: 0.9, bubble: 0.0006, foam: 0.008, halfLife: 6, foamCol: [0.72, 0.52, 0.36],
    note: 'Caramel colour absorbs everything but red; its fizz head collapses in seconds (no proteins).',
  },
  lager: {
    name: 'Lager', swatch: '#e2a526', rho: 1010, nu: 1.5e-6, sigma: 0.042, ior: 1.34, theta: 20,
    sigA: [1.2, 7, 48], sigS: [1.5, 1.5, 1.5], carb: 0.6, bubble: 0.0005, foam: 0.022, halfLife: 70, foamCol: [0.96, 0.92, 0.82],
    note: 'Proteins and hop compounds stabilise a foam head that drains and coarsens over a minute or two.',
  },
  stout: {
    name: 'Nitro stout', swatch: '#1c0f09', rho: 1010, nu: 1.8e-6, sigma: 0.045, ior: 1.34, theta: 20,
    sigA: [240, 520, 950], sigS: [2, 2, 2], carb: 0.35, bubble: 0.0002, foam: 0.016, halfLife: 240, foamCol: [0.86, 0.74, 0.58],
    note: 'Nitrogen bubbles are tiny and barely soluble, giving a dense, long-lived creamy head.',
  },

  oil: {
    name: 'Olive oil', swatch: '#b8a624', rho: 915, nu: 9.0e-5, sigma: 0.032, ior: 1.47, theta: 10,
    sigA: [4, 2.2, 45], sigS: [0.2, 0.2, 0.2],
    note: '90x more viscous than water and a high refractive index: heavy lensing, lazy waves.',
  },
  honey: {
    name: 'Honey', swatch: '#c9820e', rho: 1420, nu: 7.0e-3, sigma: 0.055, ior: 1.49, theta: 30,
    sigA: [8, 42, 200], sigS: [3, 3, 3],
    note: '~7000x water\'s viscosity: every mode is over-damped, so the surface creeps instead of rippling.',
  },
  maple: {
    name: 'Maple syrup', swatch: '#b5651d', rho: 1330, nu: 1.2e-4, sigma: 0.05, ior: 1.47, theta: 25,
    sigA: [5, 26, 105], sigS: [0.4, 0.4, 0.4],
    note: '~66 % sugar: 160x water\'s viscosity. Slow waves that die within a couple of sloshes.',
  },
  motor: {
    name: 'Motor oil', swatch: '#8c5a12', rho: 875, nu: 2.9e-4, sigma: 0.031, ior: 1.48, theta: 5,
    sigA: [14, 55, 260], sigS: [0.3, 0.3, 0.3],
    note: 'SAE 30 at room temperature: ~250x water\'s viscosity and a low surface tension.',
  },
  glycerin: {
    name: 'Glycerin', swatch: '#eef3f3', rho: 1261, nu: 1.1e-3, sigma: 0.063, ior: 1.474, theta: 20,
    sigA: [0.3, 0.12, 0.1], sigS: [0.01, 0.01, 0.01],
    note: 'Crystal clear but 1400x water\'s viscosity; its high index bends the view strongly.',
  },

  mercury: {
    name: 'Mercury', swatch: '#b7bcc2', rho: 13534, nu: 1.15e-7, sigma: 0.485, ior: 1.0, theta: 140, metal: true,
    sigA: [1e6, 1e6, 1e6], sigS: [0, 0, 0], f0: [0.76, 0.77, 0.78],
    note: 'A liquid metal: 13.5x as dense as water, 7x the surface tension, and it does not wet glass.',
  },
  ln2: {
    name: 'Liquid nitrogen', swatch: '#e8f4ff', rho: 807, nu: 1.96e-7, sigma: 0.0089, ior: 1.2, theta: 0,
    sigA: [0.2, 0.1, 0.05], sigS: [0.02, 0.02, 0.02], carb: 1.5, bubble: 0.0012, boil: true, vapor: 'fog',
    note: 'Boiling at -196 C: vigorous bubbling, frost on the glass, and cold fog that spills over the rim.',
  },
  ferro: {
    name: 'Ferrofluid', swatch: '#101012', rho: 1210, nu: 6.0e-6, sigma: 0.026, ior: 1.52, theta: 30, magnetic: true,
    sigA: [90000, 90000, 90000], sigS: [5, 5, 5],
    note: 'Magnetite nanoparticles in oil. Turn on the magnet: spikes appear at the capillary wavelength 2π·√(σ/ρg).',
  },
  blood: {
    name: 'Blood', swatch: '#6d0712', rho: 1060, nu: 3.3e-6, sigma: 0.056, ior: 1.36, theta: 30,
    sigA: [300, 24000, 18000], sigS: [1500, 1450, 1400],
    note: 'Red cells scatter strongly and haemoglobin absorbs all but red. (Newtonian here; see the Blood tab.)',
  },
};

// Things you can pour in. amount = volume fraction added per pour.
// ior: refractive index (index differences show as schlieren while mixing).
// nu: kinematic viscosity (m^2/s): sets whether a pour is a turbulent plume or a
// laminar rope, and how the mixture flows.
// buoyancy: 'float' stays in a thin top layer, 'sink' falls and pools,
// 'mix' plumes down and spreads. immiscible liquids keep sharp edges.
export const ADDITIVES = {
  milk: { name: 'Milk', swatch: '#f2eee4', ior: 1.35, nu: 2.0e-6, sigA: [0.8, 1.3, 2.8], sigS: [12000, 12200, 12500], amount: 0.045, rho: 1030, buoyancy: 'mix' },
  cream: { name: 'Cream', swatch: '#f6ecd2', ior: 1.352, nu: 1.5e-5, sigA: [0.6, 1.4, 6], sigS: [26000, 26000, 25500], amount: 0.035, rho: 994, buoyancy: 'float', miscible: true },
  bluedye: { name: 'Blue dye', swatch: '#1d4fd8', ior: 1.336, nu: 1.0e-6, sigA: [52000, 21000, 900], sigS: [0, 0, 0], amount: 0.0012, rho: 1010, buoyancy: 'mix', drops: true },
  reddye: { name: 'Red dye', swatch: '#d61f35', ior: 1.336, nu: 1.0e-6, sigA: [600, 42000, 23000], sigS: [0, 0, 0], amount: 0.0012, rho: 1010, buoyancy: 'mix', drops: true },
  greendye: { name: 'Green dye', swatch: '#1e9e4a', ior: 1.336, nu: 1.0e-6, sigA: [48000, 900, 30000], sigS: [0, 0, 0], amount: 0.0012, rho: 1010, buoyancy: 'mix', drops: true },
  ink: { name: 'Ink', swatch: '#141620', ior: 1.34, nu: 2.0e-6, sigA: [60000, 58000, 50000], sigS: [300, 300, 300], amount: 0.0015, rho: 1020, buoyancy: 'mix', drops: true },
  espresso: { name: 'Espresso', swatch: '#3b1d0c', ior: 1.343, nu: 1.0e-6, sigA: [240, 620, 1300], sigS: [12, 12, 12], amount: 0.05, rho: 1010, buoyancy: 'mix' },
  syrup: { name: 'Grenadine', swatch: '#b0102a', ior: 1.44, nu: 8.0e-6, sigA: [40, 2600, 1500], sigS: [0.2, 0.2, 0.2], amount: 0.04, rho: 1300, buoyancy: 'sink', viscous: true },
  honey: { name: 'Honey', swatch: '#c9820e', ior: 1.49, nu: 7.0e-3, sigA: [8, 42, 200], sigS: [3, 3, 3], amount: 0.05, rho: 1420, buoyancy: 'sink', viscous: true },
  oil: { name: 'Olive oil', swatch: '#b8a624', ior: 1.47, nu: 9.0e-5, sigA: [10, 5, 110], sigS: [0.2, 0.2, 0.2], amount: 0.06, rho: 915, buoyancy: 'float', immiscible: true },
};
