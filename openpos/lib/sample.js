'use strict';
// ---------------------------------------------------------------------------
// sample.js — per-trade starter data so a new shop can trade immediately.
// Prices are VAT-inclusive whole shillings. kra_item_code values are
// placeholders in the KRA classification format — replace during onboarding.
// ---------------------------------------------------------------------------

const TRADES = {
  duka: { label: 'General shop (duka)', sw: 'Duka ya kawaida' },
  chemist: { label: 'Chemist / Pharmacy', sw: 'Duka la dawa' },
  spirits: { label: 'Wines & Spirits', sw: 'Waini na maziwa' },
  boutique: { label: 'Boutique', sw: 'Butiki' },
  hardware: { label: 'Hardware store', sw: 'Duka la vifaa' },
  restaurant: { label: 'Restaurant (coming)', sw: 'Restoranti (ina kuja)' }
};

// [name, name_sw, unit, cost, price, taxType, flags]
const CATALOG = {
  duka: {
    categories: [
      ['Staples', 'Vyakula'], ['Beverages', 'Vinywaji'],
      ['Household', 'Nyumba'], ['Snacks', 'Vyakula vya harufu'], ['Fresh', 'Tazama']
    ],
    products: [
      ['Brown Sugar 1kg', 'Sukari 1kg', 'pcs', 150, 200, 'std', {}],
      ['Rice 2kg', 'Wali 2kg', 'pcs', 650, 800, 'std', {}],
      ['Maize Flour 2kg', 'Unga wa mahindi 2kg', 'pcs', 160, 210, 'std', {}],
      ['Cooking Oil 1L', 'Mafuta 1L', 'pcs', 280, 350, 'std', {}],
      ['Bread', 'Breadi', 'pcs', 40, 60, 'std', {}],
      ['Milk 500ml', 'Maziwa 500ml', 'pcs', 90, 130, 'std', {}],
      ['Eggs (tray of 30)', 'Mayai (1 chuma)', 'pcs', 280, 350, 'std', {}],
      ['Bar Soap', 'Sabuni', 'pcs', 60, 90, 'std', {}],
      ['Bottled Water 1.5L', 'Maji 1.5L', 'pcs', 40, 60, 'std', {}],
      ['Danish Biscuits', 'Biskuti', 'pcs', 50, 80, 'std', {}],
      ['Black Tea 200g', 'Chai 200g', 'pcs', 250, 320, 'std', {}],
      ['Matches', 'Mkaa', 'pcs', 10, 20, 'exempt', {}]
    ],
    catOf: i => [0, 0, 0, 0, 0, 1, 0, 2, 1, 3, 1, 2][i]
  },
  chemist: {
    categories: [
      ['OTC Medicines', 'Dawa'], ['Prescription', 'Dawa ya preshengeni'],
      ['Devices', 'Vifaa'], ['Personal Care', 'Unyanyasaji'], ['Medical Supplies', 'Vifaa vya matibabu']
    ],
    products: [
      ['Paracetamol 500mg (20s)', 'Paracetamol', 'box', 60, 100, 'std', {}],
      ['ORS Sachet', 'ORS', 'sachet', 30, 50, 'zero', {}],
      ['Amoxicillin 500mg (16s)', 'Amoksisilini', 'box', 180, 250, 'std', { requiresRx: 1, trackBatches: 1 }],
      ['Cough Syrup 100ml', 'Siro ya kichefuchefu', 'btl', 220, 300, 'std', { requiresRx: 1, trackBatches: 1 }],
      ['Insulin Glargine', 'Insulini', 'vial', 1800, 2200, 'std', { isControlled: 1, trackBatches: 1 }],
      ['Condoms (3-pack)', 'Chando', 'pack', 120, 180, 'std', {}],
      ['First Aid Kit', 'Kifaa cha matibabu ya haraka', 'kit', 800, 1200, 'std', {}],
      ['Multivitamins (30s)', 'Vitamini', 'box', 350, 480, 'std', {}],
      ['BP Monitor', 'Kipimo cha shida ya moyo', 'pcs', 3500, 4800, 'std', {}],
      ['Syringe 5ml', 'Mfupa 5ml', 'pcs', 15, 30, 'std', { trackBatches: 1 }]
    ],
    catOf: i => [0, 0, 1, 1, 1, 3, 4, 0, 2, 4][i]
  },
  spirits: {
    categories: [
      ['Beer', 'Bia'], ['Spirits', 'Maji samaki'], ['Wine', 'Waini'],
      ['Tobacco', 'Tembakoo'], ['Soft Drinks', 'Vinywaji visivyo na alkoholi'], ['Snacks', 'Vyakula']
    ],
    products: [
      ['Tusker 650ml', 'Tasika', 'btl', 110, 150, 'std', { ageMin: 21 }],
      ['G4 650ml', 'G4', 'btl', 90, 120, 'std', { ageMin: 21 }],
      ['White Castle 6×650ml', 'White Castle 6', 'pack', 550, 700, 'std', { ageMin: 21 }],
      ['Johnnie Walker Red 700ml', 'Johnnie Walker', 'btl', 4500, 5500, 'std', { ageMin: 21 }],
      ['Rum 1L', 'Ramu', 'btl', 1500, 1900, 'std', { ageMin: 21 }],
      ['Vodka 500ml', 'Vodka', 'btl', 1200, 1500, 'std', { ageMin: 21 }],
      ['Kenyan Red Wine 750ml', 'Waini mwekundu', 'btl', 900, 1200, 'std', { ageMin: 21 }],
      ['Coca-Cola 500ml', 'Coca-Cola', 'btl', 80, 110, 'std', {}],
      ['Cigarettes (carton)', 'Tambaa', 'carton', 3800, 4500, 'std', { ageMin: 18 }],
      ['Snack Mix 200g', 'Vyakula vya picha', 'pack', 50, 80, 'std', {}]
    ],
    catOf: i => [0, 0, 0, 1, 1, 1, 2, 4, 3, 5][i]
  },
  boutique: {
    categories: [
      ['Bags', 'Mikapu'], ['Clothing', 'Vaa'], ['Footwear', 'Viatu'],
      ['Accessories', 'Zana za ziada'], ['Services', 'Huduma']
    ],
    products: [
      ['Handbag', 'Mkopo', 'pcs', 1500, 2500, 'std', {}],
      ['Dress', 'Robi', 'pcs', 2500, 4000, 'std', {}],
      ['Sneakers', 'Viatu vya michezo', 'pcs', 2000, 3200, 'std', {}],
      ['T-Shirt', 'Shati', 'pcs', 400, 700, 'std', {}],
      ['Jeans', 'Mavu', 'pcs', 1200, 1800, 'std', {}],
      ['Socks (3-pack)', 'Mioyo 3', 'pack', 150, 250, 'std', {}],
      ['Belt', 'Betri', 'pcs', 350, 550, 'std', {}],
      ['Perfume', 'Parfimu', 'btl', 1800, 2800, 'std', {}],
      ['Alteration (per job)', 'Haribifu', 'job', 200, 300, 'std', {}]
    ],
    catOf: i => [0, 1, 2, 1, 1, 3, 3, 3, 4][i]
  },
  hardware: {
    categories: [
      ['Building', 'Ujenzi'], ['Fixings', 'Vikanda'], ['Paint', 'Penti'],
      ['Electrical', 'Umeme'], ['Tools', 'Zana']
    ],
    products: [
      ['Cement (50kg)', 'Simenti', 'bag', 1050, 1250, 'std', {}],
      ['Nails 1kg', 'Nyuzi 1kg', 'kg', 220, 300, 'std', {}],
      ['Paint 4L', 'Penti 4L', 'can', 2800, 3500, 'std', {}],
      ['Wire (per metre)', 'Wayi', 'm', 30, 50, 'std', { openPriced: 1 }],
      ['Hinges (pair)', 'Jikiti', 'pair', 60, 100, 'std', {}],
      ['Door Latch', 'Kilango', 'pcs', 150, 230, 'std', {}],
      ['Sand (shovel)', 'Mchanga', 'shovel', 100, 150, 'std', {}],
      ['Water Pipe 3m', 'Paimpi ya maji', 'pcs', 350, 480, 'std', {}],
      ['Drill Bit Set', 'Zana za kuchonga', 'set', 450, 650, 'std', {}],
      ['Plaster of Paris 50kg', 'Plaster', 'bag', 900, 1150, 'std', {}]
    ],
    catOf: i => [0, 1, 2, 4, 1, 1, 0, 0, 4, 0][i]
  },
  restaurant: {
    categories: [['Drinks', 'Vinywaji'], ['Food', 'Chakula']],
    products: [
      ['Chai (cup)', 'Chai', 'cup', 30, 80, 'std', {}],
      ['Coca-Cola 500ml', 'Coca-Cola', 'btl', 80, 120, 'std', {}],
      ['Ugali', 'Ugali', 'pcs', 40, 80, 'std', {}],
      ['Chips & Beef', 'Chips na nyama', 'pcs', 250, 450, 'std', {}],
      ['Nyama Choma 250g', 'Nyama choma', 'pcs', 400, 700, 'std', {}]
    ],
    catOf: i => [0, 0, 1, 1, 1][i]
  }
};

// Mock KRA item classification codes (12-digit format). Replace per product
// during onboarding once the shop's real KRA classification is known.
function kraCode(catIndex, seq) {
  const cat = String(1100 + catIndex * 7).padStart(4, '0');
  const sub = String(10 + (seq % 40)).padStart(4, '0');
  return `${cat}${sub}0001`.slice(0, 12);
}

function barcodeFor(i) {
  return `6009400000${String(100 + i)}`;
}

/**
 * Build the sample-data row sets for a trade.
 * @returns {{categories:Array, products:Array}}
 */
function buildSample(trade) {
  const spec = CATALOG[trade] || CATALOG.duka;
  const categories = spec.categories.map(([name, name_sw]) => ({ name, name_sw: name_sw || '' }));
  const products = spec.products.map(([name, name_sw, unit, cost, price, taxType, flags], i) => ({
    name,
    name_sw: name_sw || '',
    unit,
    cost,
    price,
    taxType,
    sku: `${String(trade).slice(0, 3).toUpperCase()}-${String(i + 1).padStart(3, '0')}`,
    barcode: barcodeFor(i),
    kraItemCode: kraCode(spec.catOf(i), i),
    categoryId: spec.catOf(i) + 1,
    requiresRx: flags.requiresRx || 0,
    isControlled: flags.isControlled || 0,
    trackBatches: flags.trackBatches || 0,
    openPriced: flags.openPriced || 0,
    ageMin: flags.ageMin || null
  }));
  return { categories, products };
}

module.exports = { TRADES, CATALOG, buildSample };
