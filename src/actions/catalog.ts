// Admin catalog writes: barbers, categories, services, shop settings.
// Every action: (1) requireAdmin on the server (FR-4), (2) zod-validate the untrusted input,
// (3) run the plain function from src/server/catalog.ts. The frontend revalidates its pages after
// each successful call. Failures come back as { ok:false, error } in Bangla.

import { db } from "@/db";
import { requireAdmin } from "@/lib/auth";
import {
  barberInput,
  barberPatch,
  categoryInput,
  categoryPatch,
  idSchema,
  serviceInput,
  servicePatch,
  settingsPatch,
} from "@/lib/schemas";
import type { Barber, Category, Service, Settings } from "@/lib/types";
import { parseInput, runAction, type ActionResult } from "@/server/action";
import * as catalog from "@/server/catalog";


export async function addBarber(input: unknown): Promise<ActionResult<Barber>> {
  return runAction(async () => {
    await requireAdmin();
    const r = await catalog.addBarber(db, parseInput(barberInput, input));
    return r;
  });
}

export async function updateBarber(id: unknown, patch: unknown): Promise<ActionResult<Barber>> {
  return runAction(async () => {
    await requireAdmin();
    const r = await catalog.updateBarber(db, parseInput(idSchema, id), parseInput(barberPatch, patch));
    return r;
  });
}

export async function addCategory(input: unknown): Promise<ActionResult<Category>> {
  return runAction(async () => {
    await requireAdmin();
    const r = await catalog.addCategory(db, parseInput(categoryInput, input));
    return r;
  });
}

export async function updateCategory(id: unknown, patch: unknown): Promise<ActionResult<Category>> {
  return runAction(async () => {
    await requireAdmin();
    const r = await catalog.updateCategory(db, parseInput(idSchema, id), parseInput(categoryPatch, patch));
    return r;
  });
}

export async function addService(input: unknown): Promise<ActionResult<Service>> {
  return runAction(async () => {
    await requireAdmin();
    const r = await catalog.addService(db, parseInput(serviceInput, input));
    return r;
  });
}

export async function updateService(id: unknown, patch: unknown): Promise<ActionResult<Service>> {
  return runAction(async () => {
    await requireAdmin();
    const r = await catalog.updateService(db, parseInput(idSchema, id), parseInput(servicePatch, patch));
    return r;
  });
}

export async function updateSettings(patch: unknown): Promise<ActionResult<Settings>> {
  return runAction(async () => {
    await requireAdmin();
    const r = await catalog.updateSettings(db, parseInput(settingsPatch, patch));
    return r;
  });
}
