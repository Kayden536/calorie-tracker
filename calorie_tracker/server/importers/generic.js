import { normalizeImportedFood } from "./normalizer.js";

export function importRows(rows, source = "user-import") {
  if (!Array.isArray(rows)) throw new Error("Import must contain an array of rows.");
  return rows
    .map(row => normalizeImportedFood(row, source))
    .filter(food => food.name);
}

export function importJson(json, source = "user-import") {
  const rows = Array.isArray(json) ? json : (json.foods || json.items || json.rows || []);
  return importRows(rows, source);
}
