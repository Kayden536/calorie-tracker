import { importRows } from "./generic.js";

function splitCsvLine(line) {
  const cells = [];
  let current = "";
  let quoted = false;
  for (let i = 0; i < line.length; i += 1) {
    const char = line[i];
    if (char === '"') {
      if (quoted && line[i + 1] === '"') { current += '"'; i += 1; }
      else quoted = !quoted;
    } else if (char === ',' && !quoted) {
      cells.push(current.trim()); current = "";
    } else current += char;
  }
  cells.push(current.trim());
  return cells;
}

export function importCsv(text, source = "user-csv-import") {
  const lines = String(text || "").split(/\r?\n/).filter(line => line.trim());
  if (lines.length < 2) return [];
  const headers = splitCsvLine(lines[0]).map(h => h.replace(/^"|"$/g, ""));
  const rows = lines.slice(1).map(line => {
    const values = splitCsvLine(line);
    return Object.fromEntries(headers.map((header, index) => [header, values[index] ?? ""]));
  });
  return importRows(rows, source);
}
