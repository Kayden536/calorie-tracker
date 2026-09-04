/*
 * MyFitnessPal migration framework.
 * This parser intentionally works with a user's exported file only.
 * It does not scrape MFP or access another user's account.
 *
 * Export formats can change, so this adapter is isolated from the core importer.
 */

import { importRows } from "./generic.js";

export function importMyFitnessPalRows(rows) {
  return importRows(rows, "myfitnesspal-user-export");
}

export function detectMyFitnessPalHeaders(headers = []) {
  const normalized = headers.map(h => String(h).trim().toLowerCase());
  return normalized.some(h =>
    h.includes("food") || h.includes("calories") || h.includes("protein")
  );
}
