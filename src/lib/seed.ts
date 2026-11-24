import type { DB } from "./types";

// Initial data from the shop's printed price list (PRD §7).
const MENU: { category: string; services: [string, number][] }[] = [
  {
    category: "Hair Cutting",
    services: [
      ["Hair Cutting", 150],
      ["Hair Wash", 50],
      ["Beard Trimming", 100],
      ["Hair Setup", 100],
    ],
  },
  {
    category: "Hair Color",
    services: [
      ["Hair Shining", 400],
      ["Hair Color Black Revlon", 600],
      ["Hair Color Brown", 600],
      ["Hair Color Begin", 600],
      ["Hair Highlight Color (per step)", 200],
    ],
  },
  {
    category: "Facial",
    services: [
      ["Brightening Facial", 300],
      ["Gold Facial", 600],
      ["Diamond Facial", 700],
      ["Silver Facial", 600],
      ["Acme Facial", 600],
      ["Fruit Facial", 600],
      ["Hydra Facial (mini)", 1200],
      ["Hydra Facial (full)", 1800],
    ],
  },
  {
    category: "Hair Treatment",
    services: [
      ["Hair Treatment", 600],
      ["Hair Spa", 600],
      ["Hair Straight", 2000],
      ["Hair Rebonding", 2500],
    ],
  },
  {
    category: "Body Massage Chair",
    services: [
      ["10 Minute", 100],
      ["20 Minute", 200],
      ["30 Minute", 250],
      ["60 Minute", 400],
    ],
  },
];

/** Dev-only fallback used by `npm run db:seed` when SEED_ADMIN_PIN / SEED_SHOP_CODE are unset. */
export const DEMO_ADMIN_PIN = "0000";
export const DEMO_SHOP_CODE = "1234";
export const DEMO_BARBER_PASSWORD = "barber123";
export const INITIAL_SHOP_CODE_VERSION = 1;

export function createSeed(now = new Date().toISOString()): DB {
  const db: DB = {
    categories: [],
    services: [],
    barbers: ["নাপিত ১", "নাপিত ২", "নাপিত ৩"].map((name, i) => ({
      id: i + 1,
      name,
      commissionPct: 50,
      sortOrder: i,
      active: true,
      hasPassword: true,
      createdAt: now,
    })),
    sales: [],
    payouts: [],
    settings: {
      shopName: "আর্ট ফ্রেন্ডস সেলুন",
      shopAddress: "",
      shopPhone: "",
      receiptFooter: "আবার আসবেন, ধন্যবাদ!",
      paperWidth: "80",
    },
  };

  let serviceId = 1;
  MENU.forEach((group, ci) => {
    const categoryId = ci + 1;
    db.categories.push({ id: categoryId, name: group.category, sortOrder: ci, active: true });
    group.services.forEach(([name, price], si) => {
      db.services.push({ id: serviceId++, categoryId, name, price, sortOrder: si, active: true });
    });
  });

  return db;
}
