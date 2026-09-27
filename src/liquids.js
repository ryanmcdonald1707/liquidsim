// Physical and optical properties of the lab liquids (SI units, ~20 C unless
// noted). sigA / sigS are absorption / scattering coefficients in 1/m for
// R, G, B; they drive Beer-Lambert transmission and Kubelka-Munk colour.
// theta is the contact angle on glass (degrees): > 90 makes a convex meniscus.

export const LIQUIDS = {
  water: {
    name: 'Water', swatch: '#cfe3ea', rho: 998, nu: 1.0e-6, sigma: 0.072, ior: 1.333, theta: 20,
    sigA: [0.45, 0.07, 0.02], sigS: [0.002, 0.002, 0.002],
    note: 'Low viscosity, high surface tension: long-lived ripples and a sharp capillary wave front.',
  },
  coffee: {
    name: 'Black coffee', swatch: '#2a140a', rho: 1005, nu: 0.45e-6, sigma: 0.052, ior: 1.34, theta: 30,
    sigA: [80, 210, 450], sigS: [4, 4, 4],
    note: 'Hot (~70 C), so thin. Dissolved surfactants lower the surface tension and damp ripples.',
  },
  tea: {
    name: 'Black tea', swatch: '#8a3d10', rho: 1000, nu: 0.5e-6, sigma: 0.068, ior: 1.335, theta: 25,
    sigA: [9, 40, 140], sigS: [0.5, 0.5, 0.5],
    note: 'Clear but strongly absorbing in the blue: amber in thin layers, deep red-brown in bulk.',
  },
  milk: {
    name: 'Whole milk', swatch: '#f2eee4', rho: 1030, nu: 2.0e-6, sigma: 0.047, ior: 1.35, theta: 30,
    sigA: [0.8, 1.5, 4], sigS: [12000, 12200, 12500],
    note: 'Fat globules and casein micelles scatter light thousands of times per millimetre.',
  },
  wine: {
    name: 'Red wine', swatch: '#5a0a1e', rho: 990, nu: 1.5e-6, sigma: 0.047, ior: 1.345, theta: 20,
    sigA: [6, 380, 170], sigS: [0.3, 0.3, 0.3],
    note: 'Anthocyanins absorb green; ethanol lowers the surface tension (hence wine tears).',
  },
  oil: {
    name: 'Olive oil', swatch: '#b8a624', rho: 915, nu: 9.0e-5, sigma: 0.032, ior: 1.47, theta: 10,
    sigA: [4, 2.2, 45], sigS: [0.2, 0.2, 0.2],
    note: '90x more viscous than water and a high refractive index: heavy lensing, lazy waves.',
  },
  honey: {
    name: 'Honey', swatch: '#c9820e', rho: 1420, nu: 7.0e-3, sigma: 0.055, ior: 1.49, theta: 30,
    sigA: [4, 28, 150], sigS: [3, 3, 3],
    note: '~7000x water\'s viscosity: every mode is over-damped, so the surface creeps instead of rippling.',
  },
  oj: {
    name: 'Orange juice', swatch: '#f39a1d', rho: 1045, nu: 2.4e-6, sigma: 0.06, ior: 1.35, theta: 25,
    sigA: [4, 30, 260], sigS: [1400, 1350, 1300],
    note: 'Pulp and cloud particles make it turbid: carotenoids absorb the blue.',
  },
  mercury: {
    name: 'Mercury', swatch: '#b7bcc2', rho: 13534, nu: 1.15e-7, sigma: 0.485, ior: 1.0, theta: 140, metal: true,
    sigA: [1e6, 1e6, 1e6], sigS: [0, 0, 0], f0: [0.76, 0.77, 0.78],
    note: 'A liquid metal: 13.5x as dense as water, 7x the surface tension, and it does not wet glass.',
  },
};

// Things you can pour in. amount = volume fraction added per pour.
// buoyancy: 'float' stays in a thin top layer, 'sink' falls and pools,
// 'mix' plumes down and spreads. immiscible liquids keep sharp edges.
export const ADDITIVES = {
  milk: { name: 'Milk', swatch: '#f2eee4', sigA: [0.8, 1.5, 4], sigS: [12000, 12200, 12500], amount: 0.045, rho: 1030, buoyancy: 'mix' },
  cream: { name: 'Cream', swatch: '#f6ecd2', sigA: [0.6, 1.4, 6], sigS: [26000, 26000, 25500], amount: 0.035, rho: 1000, buoyancy: 'float', miscible: true },
  bluedye: { name: 'Blue dye', swatch: '#1d4fd8', sigA: [52000, 21000, 900], sigS: [0, 0, 0], amount: 0.0012, rho: 1010, buoyancy: 'mix', drops: true },
  reddye: { name: 'Red dye', swatch: '#d61f35', sigA: [600, 42000, 23000], sigS: [0, 0, 0], amount: 0.0012, rho: 1010, buoyancy: 'mix', drops: true },
  ink: { name: 'Ink', swatch: '#141620', sigA: [60000, 58000, 50000], sigS: [300, 300, 300], amount: 0.0015, rho: 1020, buoyancy: 'mix', drops: true },
  espresso: { name: 'Espresso', swatch: '#3b1d0c', sigA: [240, 620, 1300], sigS: [12, 12, 12], amount: 0.05, rho: 1010, buoyancy: 'mix' },
  honey: { name: 'Honey', swatch: '#c9820e', sigA: [4, 28, 150], sigS: [3, 3, 3], amount: 0.05, rho: 1420, buoyancy: 'sink', viscous: true },
  oil: { name: 'Olive oil', swatch: '#b8a624', sigA: [10, 5, 110], sigS: [0.2, 0.2, 0.2], amount: 0.03, rho: 915, buoyancy: 'float', immiscible: true },
};
