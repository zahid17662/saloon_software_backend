import { db } from "@/db";
import { getSettings } from "@/server/catalog";

export const FALLBACK_SHOP_NAME = "সেলুন";

/** The shop name for the public unlock and admin-login pages (it is also the browser tab title). */
export async function publicShopName(): Promise<string> {
  try {
    return (await getSettings(db)).shopName.trim() || FALLBACK_SHOP_NAME;
  } catch {
    return FALLBACK_SHOP_NAME; // database unreachable: still show the form
  }
}
