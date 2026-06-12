/**
 * One-off / idempotent: websites[].business.address -> business.legalAddress
 * (Impressum-only; does not touch schema.org "address" keys under metadata).
 * Run: node scripts/migrate-business-address-to-legal.mjs
 */
import fs from 'fs';
import path from 'path';

const DATA = path.join(process.cwd(), 'src', 'data');

function migrateBusiness(b) {
  if (!b || typeof b !== 'object' || !b.address) return false;
  if (!b.legalAddress) b.legalAddress = b.address;
  delete b.address;
  return true;
}

function walkWebsites(data) {
  if (Array.isArray(data)) {
    for (const site of data) {
      if (site?.business) migrateBusiness(site.business);
    }
  } else if (data && typeof data === 'object' && Array.isArray(data.websites)) {
    for (const site of data.websites) {
      if (site?.business) migrateBusiness(site.business);
    }
  }
}

const dirs = fs.readdirSync(DATA, { withFileTypes: true });
for (const d of dirs) {
  if (!d.isDirectory() || d.name === 'current' || d.name === '_template') continue;
  const p = path.join(DATA, d.name);
  for (const f of fs.readdirSync(p)) {
    if (f === 'websites.json' || (f.startsWith('websites-') && f.endsWith('.json'))) {
      const filePath = path.join(p, f);
      const raw = fs.readFileSync(filePath, 'utf-8');
      const data = JSON.parse(raw);
      walkWebsites(data);
      fs.writeFileSync(filePath, JSON.stringify(data, null, 2) + '\n');
    }
  }
}
// _template
const templatePath = path.join(DATA, '_template', 'websites.json');
if (fs.existsSync(templatePath)) {
  const data = JSON.parse(fs.readFileSync(templatePath, 'utf-8'));
  walkWebsites(data);
  fs.writeFileSync(templatePath, JSON.stringify(data, null, 2) + '\n');
}
console.log('Migrated business.address -> business.legalAddress under src/data.');
