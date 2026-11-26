// The list of everything the frontend may call. A name that is not here cannot be invoked, so this
// file is the whole public surface of the API. Every function keeps doing its own auth and zod
// validation (see src/actions/*), exactly as the old Next.js Server Actions did.

import * as auth from "@/actions/auth";
import * as catalog from "@/actions/catalog";
import * as payouts from "@/actions/payouts";
import * as reads from "@/actions/reads";
import * as sales from "@/actions/sales";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Handler = (...args: any[]) => Promise<unknown>;

export class BadArgs extends Error {
  constructor() {
    super("bad arguments");
    this.name = "BadArgs";
  }
}

/** A positive integer id from the URL, validated here because reads take a plain number. */
const idArg = (fn: (id: number) => Promise<unknown>): Handler => {
  return async (id: unknown) => {
    if (typeof id !== "number" || !Number.isSafeInteger(id) || id <= 0) throw new BadArgs();
    return fn(id);
  };
};

export const registry: Record<string, Handler> = {
  // auth
  "auth.unlockShop": auth.unlockShop,
  "auth.loginAdmin": auth.loginAdmin,
  "auth.logoutAdmin": auth.logoutAdmin,
  "auth.changeAdminPin": auth.changeAdminPin,
  "auth.changeShopCode": auth.changeShopCode,
  "auth.checkShopSession": auth.checkShopSession,
  "auth.barberLogin": auth.barberLogin,
  "auth.barberLogout": auth.barberLogout,
  "auth.checkBarberSession": idArg(auth.checkBarberSession),
  // sales
  "sales.createSale": sales.createSale,
  "sales.voidMySale": sales.voidMySale,
  "sales.listSales": sales.listSales,
  "sales.adminVoidSale": sales.adminVoidSale,
  "sales.addPastSale": sales.addPastSale,
  // catalog
  "catalog.addBarber": catalog.addBarber,
  "catalog.updateBarber": catalog.updateBarber,
  "catalog.addCategory": catalog.addCategory,
  "catalog.updateCategory": catalog.updateCategory,
  "catalog.addService": catalog.addService,
  "catalog.updateService": catalog.updateService,
  "catalog.updateSettings": catalog.updateSettings,
  // payouts
  "payouts.getPayoutsView": payouts.getPayoutsView,
  "payouts.addPayout": payouts.addPayout,
  "payouts.deletePayout": payouts.deletePayout,
  // page reads
  "read.catalog": reads.readCatalog,
  "read.home": reads.readHome,
  "read.barber": idArg(reads.readBarber),
  "read.barberLogin": idArg(reads.readBarberLogin),
  // Any other value (a malformed URL id arrives as 0) means "no such sale", after the shop-session check.
  "read.receipt": async (id: unknown) => reads.readReceipt(typeof id === "number" && Number.isSafeInteger(id) && id > 0 ? id : 0),
  "read.shopName": reads.readShopName,
  "read.backup": reads.readBackup,
};
