/**
 * Обновляет public/data/fallback.json — снапшот агрегатов, который дашборды
 * показывают, если Cloudflare-прослойка недоступна.
 *
 *   node scripts/snapshot.mjs
 *   SHEET_ID=... node scripts/snapshot.mjs
 *
 * Агрегация переиспользуется из самой функции, чтобы схема снапшота и схема
 * живого ответа не разъезжались.
 */
import { writeFile, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadMonitor } from '../functions/api/monitor.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const target = resolve(root, 'public/data/fallback.json');

const sheetId = process.env.SHEET_ID || '1QgzU7AnrH6Cu-KWdeio2u4kJadfqhfQJZ04iOM3uMWE';

const payload = await loadMonitor(sheetId);
payload.source = 'snapshot';

await mkdir(dirname(target), { recursive: true });
await writeFile(target, JSON.stringify(payload) + '\n', 'utf8');

const hosts = payload.scopes.reduce((acc, scope) => acc + scope.totals.hosts, 0);
const checks = payload.scopes.reduce((acc, scope) => acc + scope.totals.checks, 0);

console.log(
  `Снапшот обновлён: ${payload.scopes.length} контура, ${hosts} узлов, ` +
    `${checks.toLocaleString('ru-RU')} проверок → ${target}`
);
