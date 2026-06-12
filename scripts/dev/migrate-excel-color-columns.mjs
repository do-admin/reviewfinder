/**
 * One-off migration: rename/remove theme-color columns in client data.xlsx files.
 *
 * Before: "Farbe - Primary" | "Farbe - Primary Vordergrund (Schriftfarbe)" | "Farbe - Secondary" | "Farbe - Accent"
 * After:  "Farbe - Brand (Buttons)" | "Farbe - Akzent (Highlights)"
 *
 * Text-on-color foregrounds are now auto-derived in sync-theme-to-globals.mjs.
 * Secondary is no longer PO-controlled (dropped from template; derived in code).
 *
 * Usage: node scripts/dev/migrate-excel-color-columns.mjs <path-to-xlsx> [...more]
 */
import fs from 'fs';
import path from 'path';
import XLSX from 'xlsx';

const RENAME = new Map([
  ['Farbe - Primary', 'Farbe - Brand (Buttons)'],
  ['Color - Primary', 'Color - Brand (Buttons)'],
  ['Farbe - Accent', 'Farbe - Akzent (Highlights)'],
  ['Color - Accent', 'Color - Accent (Highlights)'],
]);

const REMOVE = new Set([
  'Farbe - Primary Vordergrund (Schriftfarbe)',
  'Color - Primary Foreground',
  'Farbe - Secondary',
  'Color - Secondary',
]);

function migrateWorkbook(filePath) {
  const wb = XLSX.readFile(filePath, { cellStyles: true });
  let touched = false;

  for (const sheetName of wb.SheetNames) {
    const ws = wb.Sheets[sheetName];
    if (!ws || !ws['!ref']) continue;
    const range = XLSX.utils.decode_range(ws['!ref']);

    const removeCols = [];
    for (let c = range.s.c; c <= range.e.c; c++) {
      const headerAddr = XLSX.utils.encode_cell({ r: range.s.r, c });
      const cell = ws[headerAddr];
      if (!cell || cell.v == null) continue;
      const header = String(cell.v).trim();

      if (REMOVE.has(header)) {
        removeCols.push(c);
        continue;
      }
      const renamed = RENAME.get(header);
      if (renamed) {
        cell.v = renamed;
        if (cell.w) cell.w = renamed;
        touched = true;
      }
    }

    if (removeCols.length > 0) {
      removeColumns(ws, removeCols);
      touched = true;
    }
  }

  if (!touched) {
    console.log(`  · no changes: ${filePath}`);
    return;
  }

  const backup = `${filePath}.bak-${Date.now()}`;
  fs.copyFileSync(filePath, backup);
  XLSX.writeFile(wb, filePath, { cellStyles: true });
  console.log(`  ✓ migrated: ${filePath} (backup: ${path.basename(backup)})`);
}

function removeColumns(ws, colsToRemove) {
  const range = XLSX.utils.decode_range(ws['!ref']);
  const dropSet = new Set(colsToRemove);
  const keepCols = [];
  for (let c = range.s.c; c <= range.e.c; c++) {
    if (!dropSet.has(c)) keepCols.push(c);
  }

  const newWs = {};
  for (let r = range.s.r; r <= range.e.r; r++) {
    keepCols.forEach((oldC, newC) => {
      const oldAddr = XLSX.utils.encode_cell({ r, c: oldC });
      const newAddr = XLSX.utils.encode_cell({ r, c: newC });
      if (ws[oldAddr] !== undefined) newWs[newAddr] = ws[oldAddr];
    });
  }
  newWs['!ref'] = XLSX.utils.encode_range({
    s: { r: range.s.r, c: 0 },
    e: { r: range.e.r, c: keepCols.length - 1 },
  });
  if (ws['!cols']) {
    newWs['!cols'] = keepCols.map((c) => ws['!cols'][c]).filter(Boolean);
  }

  for (const key of Object.keys(ws)) delete ws[key];
  for (const key of Object.keys(newWs)) ws[key] = newWs[key];
}

const files = process.argv.slice(2);
if (files.length === 0) {
  console.error('Usage: node scripts/dev/migrate-excel-color-columns.mjs <xlsx> [...more]');
  process.exit(1);
}
for (const f of files) {
  if (!fs.existsSync(f)) {
    console.warn(`  ! not found: ${f}`);
    continue;
  }
  migrateWorkbook(f);
}
