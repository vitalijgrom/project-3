/**
 * Cloudflare Pages Function — прослойка между дашбордами и Google Таблицей
 * мониторинга.
 *
 * GET /api/monitor           — агрегированные данные (из edge-кэша, если он тёплый)
 * GET /api/monitor?refresh=1 — принудительно обойти кэш и сходить в Google
 *
 * Зачем прослойка:
 *  1. ID таблицы не уезжает в браузер — он живёт только в переменных окружения Pages;
 *  2. ответ кэшируется на edge (Google отдаёт no-store, поэтому кэшируем сами);
 *  3. последний удачный ответ хранится отдельно и отдаётся как stale,
 *     если Google недоступен — дашборд не белеет;
 *  4. журналы весят 630 000 строк, и целиком в браузер они не поедут:
 *     агрегаты считает Google (gviz-запросы с group by), прослойка только
 *     приводит их к стабильной схеме, одинаковой со снапшотом.
 *
 * Переменные окружения (Pages → Settings → Variables):
 *   SHEET_ID   — id таблицы (обязательна в проде)
 *   CACHE_TTL  — время жизни edge-кэша в секундах, по умолчанию 300
 */

const DEFAULT_SHEET_ID = '1QgzU7AnrH6Cu-KWdeio2u4kJadfqhfQJZ04iOM3uMWE';
const DEFAULT_TTL = 300;

/** Ключ, под которым в edge-кэше лежит последний успешный ответ. */
const LAST_GOOD_KEY = 'https://cache.internal/monitor/last-good';

/**
 * Два наблюдаемых контура. Отличаются только именами листов, событий и ключом,
 * под которым имя узла лежит в JSON-контексте журнала, — вся логика общая.
 *
 * `runEvent` — событие начала прохода по списку, а не его завершения. Это
 * знаменатель для «доли сбоев узла», и он обязан быть верхней границей: внутри
 * одного прохода узел проверяется не больше раза, а вот завершающее событие
 * иногда не дописывается (обрыв, лимит времени), и по нему доля сбоев вылезала
 * за 100%.
 */
export const SCOPES = [
  {
    key: 'sites',
    label: 'Сайты',
    unit: 'сайт',
    statusSheet: 'Статус сайты',
    logSheet: 'Логи сайты',
    okEvent: 'Сайт доступен',
    failEvent: 'Сайт недоступен',
    runEvent: 'Единый запуск: вычисление начато (сайты)',
    hostKey: 'url',
    listColumn: 'A',
    problemColumn: 'B',
  },
  {
    key: 'mail',
    label: 'Почтовые узлы',
    unit: 'узел',
    statusSheet: 'Статус почты',
    logSheet: 'Логи почты',
    okEvent: 'Хост доступен',
    failEvent: 'Хост недоступен',
    runEvent: 'Единый запуск: вычисление начато (почты)',
    hostKey: 'host',
    listColumn: 'C',
    problemColumn: 'D',
  },
];

const SETTINGS_SHEET = 'Настройки';

/**
 * Классификация причин недоступности. Порядок важен: «Тайм-аут … • Проверка:
 * проблемный» должен попасть в тайм-аут, а не в общее «прочее», а квоты
 * Google Apps Script важно отделить от настоящих отказов узла — это отказ
 * мониторинга, а не наблюдаемого хоста.
 */
export const REASONS = [
  { key: 'quota', label: 'Квота Google Apps Script', blame: 'monitor', test: /слишком много раз за день|too many times for one day|bandwidth quota|quota exceeded/i },
  { key: 'dns', label: 'DNS не разрешается', blame: 'host', test: /ошибка dns|имя не разрешается/i },
  { key: 'timeout', label: 'Тайм-аут', blame: 'host', test: /тайм-?аут|timeout/i },
  { key: 'tls', label: 'Ошибка TLS/SSL', blame: 'host', test: /ошибка tls|ошибка ssl|ssl error/i },
  { key: 'unreachable', label: 'Адрес недоступен', blame: 'host', test: /адрес недоступен|address unavailable/i },
  { key: 'http', label: 'Ответ с ошибкой', blame: 'host', test: /ответ https?:\s*[45]\d\d/i },
  { key: 'other', label: 'Прочее', blame: 'host', test: /.*/ },
];

export function classifyReason(note) {
  const text = String(note || '');
  for (const reason of REASONS) {
    if (reason.test.test(text)) return reason.key;
  }
  return 'other';
}

/* --- HTTP-обвязка --------------------------------------------------------- */

export async function onRequestGet(context) {
  const { request, env, waitUntil } = context;
  const url = new URL(request.url);
  const bypass = url.searchParams.has('refresh');

  const sheetId = env.SHEET_ID || DEFAULT_SHEET_ID;
  const ttl = clampTtl(env.CACHE_TTL);

  const cache = caches.default;
  const cacheKey = new Request(`${url.origin}${url.pathname}`, { method: 'GET' });

  if (!bypass) {
    const hit = await cache.match(cacheKey);
    if (hit) return withHeaders(hit, { 'x-cache': 'HIT' });
  }

  try {
    const payload = await loadMonitor(sheetId);
    const fresh = json(payload, {
      'cache-control': `public, max-age=60, s-maxage=${ttl}`,
      'x-cache': bypass ? 'BYPASS' : 'MISS',
      'x-data-source': 'google-sheets',
    });

    // Кладём и в обычный ключ (истекает по TTL), и в «последний удачный» (живёт дольше).
    waitUntil(cache.put(cacheKey, fresh.clone()));
    waitUntil(
      cache.put(
        new Request(LAST_GOOD_KEY, { method: 'GET' }),
        json(payload, { 'cache-control': 'public, max-age=86400' })
      )
    );

    return fresh;
  } catch (err) {
    const stale = await cache.match(new Request(LAST_GOOD_KEY, { method: 'GET' }));
    if (stale) {
      return withHeaders(stale, {
        'x-cache': 'STALE',
        'x-data-source': 'google-sheets-stale',
        'cache-control': 'no-store',
      });
    }
    return json(
      { ok: false, error: String(err && err.message ? err.message : err) },
      { 'cache-control': 'no-store' },
      502
    );
  }
}

/** Preflight — дашборд может жить на другом домене, чем эта функция. */
export function onRequestOptions() {
  return new Response(null, {
    status: 204,
    headers: {
      'access-control-allow-origin': '*',
      'access-control-allow-methods': 'GET, OPTIONS',
      'access-control-max-age': '86400',
    },
  });
}

/* --- Загрузка и агрегация ------------------------------------------------- */

/**
 * Собирает весь ответ. Девять gviz-запросов уходят параллельно: четыре на
 * каждый контур плюс лист настроек.
 */
export async function loadMonitor(sheetId) {
  const [settings, ...scopes] = await Promise.all([
    query(sheetId, SETTINGS_SHEET, 'select A, B, C, D'),
    ...SCOPES.map((scope) => loadScope(sheetId, scope)),
  ]);

  const config = {};
  for (const scope of SCOPES) {
    config[scope.key] = {
      watched: column(settings, scope.listColumn),
      problem: column(settings, scope.problemColumn),
    };
  }

  // Проблемные узлы помечены в настройках вручную — переносим флаг на узлы.
  for (const scope of scopes) {
    const flagged = new Set(config[scope.key].problem.map(normalizeHost));
    for (const host of scope.hosts) {
      if (flagged.has(host.id)) host.problem = true;
    }
  }

  const days = new Set();
  for (const scope of scopes) for (const day of scope.daily) days.add(day.date);
  const sorted = Array.from(days).sort();

  return {
    ok: true,
    source: 'google-sheets',
    fetchedAt: new Date().toISOString(),
    period: {
      from: sorted[0] || null,
      to: sorted[sorted.length - 1] || null,
      days: sorted.length,
    },
    scopes,
    config,
  };
}

async function loadScope(sheetId, scope) {
  const [status, hourly, events, failures] = await Promise.all([
    query(sheetId, scope.statusSheet, 'select A, B, C, D, E, F'),
    query(
      sheetId,
      scope.logSheet,
      'select year(A), month(A), day(A), hour(A), C, count(A)' +
        ' where C = ' + literal(scope.okEvent) + ' or C = ' + literal(scope.failEvent) +
        ' group by year(A), month(A), day(A), hour(A), C' +
        ' order by year(A), month(A), day(A), hour(A)'
    ),
    query(
      sheetId,
      scope.logSheet,
      'select year(A), month(A), day(A), B, C, count(A)' +
        ' group by year(A), month(A), day(A), B, C' +
        ' order by year(A), month(A), day(A)'
    ),
    query(
      sheetId,
      scope.logSheet,
      'select D, count(A) where C = ' + literal(scope.failEvent) + ' group by D'
    ),
  ]);

  const series = buildSeries(hourly, scope);
  const summary = buildEvents(events, scope);
  const failed = buildFailures(failures, scope);
  const hosts = buildHosts(status, failed.hosts, summary.runs);

  // Итог считаем по журналу, а не по последнему статусу: проверок могло и не быть.
  let up = 0;
  let down = 0;
  for (const point of series) {
    up += point.up;
    down += point.down;
  }

  return {
    key: scope.key,
    label: scope.label,
    unit: scope.unit,
    statusSheet: scope.statusSheet,
    logSheet: scope.logSheet,
    hosts,
    series,
    daily: summary.daily,
    events: summary.events,
    reasons: failed.reasons,
    totals: {
      hosts: hosts.length,
      online: hosts.filter((host) => host.online === true).length,
      offline: hosts.filter((host) => host.online === false).length,
      checks: up + down,
      up,
      down,
      runs: summary.runs,
      skipped: summary.skipped,
      warnings: summary.warnings,
    },
  };
}

/** Часовой ряд: `[{ date, hour, up, down }]`, отсортированный по времени. */
function buildSeries(table, scope) {
  const buckets = new Map();

  for (const cells of rows(table)) {
    const date = ymd(cells[0], cells[1], cells[2]);
    const hour = int(cells[3]);
    if (!date || hour === null) continue;

    const key = date + ' ' + hour;
    let point = buckets.get(key);
    if (!point) {
      point = { date, hour, up: 0, down: 0 };
      buckets.set(key, point);
    }

    const count = int(cells[5]) || 0;
    if (text(cells[4]) === scope.okEvent) point.up += count;
    else point.down += count;
  }

  return Array.from(buckets.values()).sort(
    (a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.hour - b.hour)
  );
}

/**
 * Дневная разбивка по событиям журнала. Отсюда берутся число запусков
 * (знаменатель для надёжности узлов) и пропуски по общему лимиту.
 */
function buildEvents(table, scope) {
  const byDate = new Map();
  const totals = new Map();
  let runs = 0;
  let skipped = 0;
  let warnings = 0;

  for (const cells of rows(table)) {
    const date = ymd(cells[0], cells[1], cells[2]);
    const level = text(cells[3]);
    const event = text(cells[4]);
    const count = int(cells[5]) || 0;
    if (!date || !event) continue;

    let day = byDate.get(date);
    if (!day) {
      day = { date, up: 0, down: 0, runs: 0, skipped: 0, warnings: 0, events: 0 };
      byDate.set(date, day);
    }

    day.events += count;
    if (event === scope.okEvent) day.up += count;
    else if (event === scope.failEvent) day.down += count;
    else if (event === scope.runEvent) { day.runs += count; runs += count; }
    if (SKIP_EVENT.test(event)) { day.skipped += count; skipped += count; }
    if (level === 'ПРЕДУПРЕЖДЕНИЕ') { day.warnings += count; warnings += count; }

    const key = event + ' / ' + level;
    const total = totals.get(key) || { event, level, count: 0 };
    total.count += count;
    totals.set(key, total);
  }

  return {
    daily: Array.from(byDate.values()).sort((a, b) => (a.date < b.date ? -1 : 1)),
    events: Array.from(totals.values()).sort((a, b) => b.count - a.count),
    runs,
    skipped,
    warnings,
  };
}

/**
 * Точные счётчики отказов по узлам за всю историю. Хитрость: gviz не умеет
 * группировать по подстроке, но контекст отказа — это готовый JSON, и разных
 * его значений всего несколько сотен (узел × причина). Один `group by D`
 * отдаёт сразу и разбивку по узлам, и разбивку по причинам.
 */
function buildFailures(table, scope) {
  const hosts = new Map();
  const reasons = new Map();

  for (const cells of rows(table)) {
    const raw = text(cells[0]);
    const count = int(cells[1]) || 0;
    if (!raw || !count) continue;

    let context = {};
    try {
      context = JSON.parse(raw) || {};
    } catch (err) {
      context = {};
    }

    const host = text(context[scope.hostKey]);
    const note = text(context[NOTE_KEY]);
    const reason = classifyReason(note);
    reasons.set(reason, (reasons.get(reason) || 0) + count);

    if (!host) continue;
    const id = normalizeHost(host);
    let entry = hosts.get(id);
    if (!entry) {
      entry = { id, host, fails: 0, reasons: {}, notes: {} };
      hosts.set(id, entry);
    }
    entry.fails += count;
    entry.reasons[reason] = (entry.reasons[reason] || 0) + count;
    if (note) entry.notes[note] = (entry.notes[note] || 0) + count;
  }

  return {
    hosts,
    reasons: REASONS.filter((reason) => reasons.has(reason.key)).map((reason) => ({
      key: reason.key,
      label: reason.label,
      blame: reason.blame,
      count: reasons.get(reason.key),
    })),
  };
}

/** Текущий статус из листа «Статус …», склеенный со статистикой журнала. */
function buildHosts(table, failStats, runs) {
  // В листе статуса встречаются человекочитаемые имена («Connelly») там, где
  // в журнале стоит полный адрес. Подстраховываемся по первой метке домена,
  // но только если она однозначна.
  const byFirstLabel = new Map();
  for (const [id, entry] of failStats) {
    const label = id.split('.')[0];
    byFirstLabel.set(label, byFirstLabel.has(label) ? null : entry);
  }

  const hosts = [];
  for (const cells of rows(table)) {
    const name = text(cells[0]);
    if (!name) continue;

    const state = text(cells[1]);
    const note = text(cells[4]);
    const id = normalizeHost(name);
    const stats = failStats.get(id) || byFirstLabel.get(id) || null;

    hosts.push({
      id,
      host: name,
      online: state.toUpperCase() === 'ДОСТУПЕН' ? true : state.toUpperCase() === 'НЕДОСТУПЕН' ? false : null,
      state,
      ssl: text(cells[2]),
      latency: num(cells[3]),
      note,
      reason: note && state.toUpperCase() === 'НЕДОСТУПЕН' ? classifyReason(note) : null,
      checkedAt: date(cells[5]),
      problem: false,
      runs,
      fails: stats ? stats.fails : 0,
      reasons: stats ? stats.reasons : {},
      topNote: stats ? topKey(stats.notes) : '',
    });
  }

  return hosts.sort((a, b) => a.host.localeCompare(b.host, 'ru'));
}

function topKey(counts) {
  let best = '';
  let max = -1;
  for (const key of Object.keys(counts || {})) {
    if (counts[key] > max) {
      max = counts[key];
      best = key;
    }
  }
  return best;
}

/* --- gviz ----------------------------------------------------------------- */

/**
 * Один запрос к Google Visualization API. Тяжёлые группировки Google считает
 * сам — в ответ приходит несколько сотен строк вместо сотен тысяч.
 */
export async function query(sheetId, sheetName, tq) {
  const src =
    'https://docs.google.com/spreadsheets/d/' + encodeURIComponent(sheetId) + '/gviz/tq' +
    '?tqx=out:json&headers=1' +
    '&sheet=' + encodeURIComponent(sheetName) +
    '&tq=' + encodeURIComponent(tq);

  const res = await fetch(src, {
    headers: { 'user-agent': 'uptime-dashboard/1.0' },
    cf: { cacheTtl: 0, cacheEverything: false },
  });

  if (!res.ok) throw new Error('Google Sheets ответил ' + res.status + ' (лист «' + sheetName + '»)');
  return parseGviz(await res.text(), sheetName);
}

/** gviz отдаёт JS-обёртку `/*O_o*\/google.visualization.Query.setResponse({...});` */
function parseGviz(body, sheetName) {
  const start = body.indexOf('{');
  const end = body.lastIndexOf('}');
  if (start === -1 || end === -1) throw new Error('Неожиданный формат ответа gviz');

  const data = JSON.parse(body.slice(start, end + 1));
  if (data.status === 'error') {
    const reason = (data.errors || []).map((e) => e.detailed_message || e.message).join('; ');
    throw new Error((reason || 'gviz вернул ошибку') + ' (лист «' + sheetName + '»)');
  }
  if (!data.table) throw new Error('В ответе gviz нет таблицы (лист «' + sheetName + '»)');
  return data.table;
}

/** Строки таблицы как массивы «сырых» значений ячеек. */
function rows(table) {
  return (table.rows || []).map((row) => (row.c || []).map((cell) => (cell ? cell.v : null)));
}

/** Один столбец листа настроек — непустые значения по порядку. */
function column(table, letter) {
  const index = (table.cols || []).findIndex((col) => col && col.id === letter);
  if (index === -1) return [];
  return rows(table)
    .map((cells) => text(cells[index]))
    .filter(Boolean);
}

/**
 * Экранирование строкового литерала для языка запросов gviz: одинарная
 * кавычка удваивается, как в SQL.
 */
function literal(value) {
  return "'" + String(value).replace(/'/g, "''") + "'";
}

/* --- Приведение значений -------------------------------------------------- */

const SKIP_EVENT = /пропуск/i;
const NOTE_KEY = 'примечание';
const GVIZ_DATE = /^Date\((\d+),(\d+),(\d+)(?:,(\d+),(\d+),(\d+))?\)$/;

/** gviz нумерует месяцы с нуля — приводим к обычному `YYYY-MM-DD`. */
function ymd(year, month, day) {
  const y = int(year);
  const m = int(month);
  const d = int(day);
  if (y === null || m === null || d === null) return '';
  return y + '-' + pad(m + 1) + '-' + pad(d);
}

function pad(value) {
  return value < 10 ? '0' + value : String(value);
}

/**
 * Дату оставляем локальной строкой без часового пояса: таблицу заполняет
 * скрипт в своём поясе, и сдвигать его в UTC значило бы врать о времени
 * проверки.
 */
function date(value) {
  const match = GVIZ_DATE.exec(text(value));
  if (!match) return null;
  const [, y, m, d, hh, mm, ss] = match;
  return (
    Number(y) + '-' + pad(Number(m) + 1) + '-' + pad(Number(d)) +
    ' ' + pad(Number(hh || 0)) + ':' + pad(Number(mm || 0)) + ':' + pad(Number(ss || 0))
  );
}

function text(value) {
  if (value === null || value === undefined) return '';
  return String(value).trim();
}

function int(value) {
  const parsed = num(value);
  return parsed === null ? null : Math.trunc(parsed);
}

function num(value) {
  if (value === null || value === undefined || value === '') return null;
  const parsed = typeof value === 'number' ? value : Number(String(value).replace(/[^\d.-]/g, ''));
  return Number.isFinite(parsed) ? parsed : null;
}

function normalizeHost(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/^[a-z]+:\/\//, '')
    .replace(/^www\./, '')
    .replace(/\/+$/, '');
}

function clampTtl(raw) {
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return DEFAULT_TTL;
  return Math.min(Math.max(Math.trunc(parsed), 30), 3600);
}

function json(payload, headers = {}, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'access-control-allow-origin': '*',
      ...headers,
    },
  });
}

function withHeaders(response, headers) {
  const next = new Response(response.body, response);
  for (const [key, value] of Object.entries(headers)) next.headers.set(key, value);
  return next;
}
