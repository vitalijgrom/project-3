/* ---------------------------------------------------------------------------
   Дашборды доступности сайтов и почтовых узлов.
   Данные приходят из Cloudflare-функции /api/monitor, которая ходит в Google
   Таблицу и считает агрегаты силами самого Google (журналы там — сотни тысяч
   строк). Если функция недоступна (локальная статика, обрыв связи) —
   подхватывается снапшот public/data/fallback.json, и об этом говорит баннер.
   --------------------------------------------------------------------------- */
'use strict';

var CONFIG = {
  apiUrl: 'api/monitor',
  fallbackUrl: 'data/fallback.json',
  autoRefreshMs: 5 * 60 * 1000,
  requestTimeoutMs: 20000,
};

/* Подписи причин на случай, если прослойка отдала ключ, которого нет в её же
   списке (старый снапшот рядом с новым кодом). */
var REASON_LABELS = {
  quota: 'Квота Google Apps Script',
  dns: 'DNS не разрешается',
  timeout: 'Тайм-аут',
  tls: 'Ошибка TLS/SSL',
  unreachable: 'Адрес недоступен',
  http: 'Ответ с ошибкой',
  other: 'Прочее',
};

/* Причины, в которых виноват не наблюдаемый узел, а сам мониторинг. */
var MONITOR_REASONS = { quota: true };

/* Корзины задержки. Шаги неравномерные: до секунды разница заметна,
   а всё, что больше пяти секунд, одинаково плохо — там жёсткий лимит в 7 сек. */
var LATENCY_BINS = [
  { min: 0, max: 500, label: 'до 0,5 с' },
  { min: 500, max: 1000, label: '0,5–1 с' },
  { min: 1000, max: 2000, label: '1–2 с' },
  { min: 2000, max: 3000, label: '2–3 с' },
  { min: 3000, max: 5000, label: '3–5 с' },
  { min: 5000, max: Infinity, label: 'от 5 с' },
];

/* Пороги календаря отказов. Доля неудачных проверок в часе. */
var HEAT_BINS = [
  { min: 0, label: '0%' },
  { min: 0.001, label: 'до 5%' },
  { min: 0.05, label: '5–15%' },
  { min: 0.15, label: '15–30%' },
  { min: 0.30, label: '30–60%' },
  { min: 0.60, label: '60–90%' },
  { min: 0.90, label: '90–100%' },
];

var STATE = {
  payload: null,
  scopeKey: '',
  hosts: [],
  meta: null,
  filters: { search: '', state: '', ssl: '', reason: '', problemOnly: false, failsOnly: false },
  sort: { key: 'failRate', dir: 'desc' },
  loading: false,
};

var nf = new Intl.NumberFormat('ru-RU');
var $ = function (id) { return document.getElementById(id); };

/* --- Загрузка ------------------------------------------------------------- */

function fetchJson(url, timeoutMs) {
  var controller = new AbortController();
  var timer = setTimeout(function () { controller.abort(); }, timeoutMs);
  return fetch(url, { signal: controller.signal, headers: { accept: 'application/json' } })
    .then(function (res) {
      if (!res.ok) throw new Error('HTTP ' + res.status);
      return res.json().then(function (data) {
        return { data: data, cache: res.headers.get('x-cache') || '' };
      });
    })
    .finally(function () { clearTimeout(timer); });
}

function load(force) {
  if (STATE.loading) return Promise.resolve();
  STATE.loading = true;
  $('refresh').disabled = true;
  setStatus(STATE.payload ? 'Обновление…' : 'Загрузка данных…');

  var url = CONFIG.apiUrl + (force ? '?refresh=1' : '');

  return fetchJson(url, CONFIG.requestTimeoutMs)
    .then(function (result) {
      if (!result.data || result.data.ok === false || !Array.isArray(result.data.scopes)) {
        throw new Error((result.data && result.data.error) || 'Некорректный ответ прослойки');
      }
      apply(result.data, result.cache, null);
    })
    .catch(function (apiError) {
      // Прослойка недоступна — показываем снапшот, но честно об этом пишем.
      return fetchJson(CONFIG.fallbackUrl, CONFIG.requestTimeoutMs)
        .then(function (result) {
          apply(result.data, '', apiError);
        })
        .catch(function () {
          setStatus('Данные не загрузились');
          showBanner(
            'Не удалось получить данные ни из Cloudflare-прослойки, ни из локального снапшота. ' +
            'Проверьте /api/monitor. Причина: ' + apiError.message
          );
        });
    })
    .finally(function () {
      STATE.loading = false;
      $('refresh').disabled = false;
    });
}

function apply(payload, cacheHeader, apiError) {
  STATE.payload = payload;
  STATE.meta = {
    source: payload.source || 'unknown',
    fetchedAt: payload.fetchedAt || null,
    cache: cacheHeader,
    stale: cacheHeader === 'STALE',
  };

  var known = payload.scopes.map(function (scope) { return scope.key; });
  if (known.indexOf(STATE.scopeKey) === -1) STATE.scopeKey = known[0] || '';

  if (apiError) {
    showBanner(
      'Показан локальный снапшот данных: прослойка /api/monitor недоступна (' + apiError.message + '). ' +
      'При деплое на Cloudflare Pages функция появится автоматически.'
    );
  } else if (STATE.meta.stale) {
    showBanner('Google Таблица сейчас недоступна — показан последний удачный ответ из кэша Cloudflare.');
  } else {
    hideBanner();
  }

  renderHealth();
  renderTabs();
  switchScope(STATE.scopeKey, true);
  setStatus(describeMeta());
  $('foot-meta').textContent = describeSource();
}

function describeMeta() {
  if (!STATE.meta || !STATE.meta.fetchedAt) return 'Данные загружены';
  var d = new Date(STATE.meta.fetchedAt);
  if (isNaN(d.getTime())) return 'Данные загружены';
  var time = d.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
  var date = d.toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit' });
  return 'Данные от ' + date + ', ' + time;
}

function describeSource() {
  if (!STATE.meta || !STATE.payload) return '';
  var parts = [];
  parts.push(STATE.meta.source === 'google-sheets' ? 'Источник: Google Таблица' : 'Источник: локальный снапшот');
  if (STATE.meta.cache) parts.push('edge-кэш: ' + STATE.meta.cache);

  var period = STATE.payload.period || {};
  if (period.from && period.to) {
    parts.push('журнал: ' + shortDate(period.from) + ' — ' + shortDate(period.to) +
      ' (' + nf.format(period.days) + ' ' + plural(period.days, 'день', 'дня', 'дней') + ' с проверками)');
  }

  var checks = STATE.payload.scopes.reduce(function (acc, scope) { return acc + scope.totals.checks; }, 0);
  parts.push('проверок: ' + nf.format(checks));
  return parts.join(' · ');
}

function setStatus(text) { $('status').textContent = text; }

function showBanner(text) {
  var banner = $('banner');
  banner.textContent = text;
  banner.hidden = false;
}
function hideBanner() { $('banner').hidden = true; }

/* --- Контуры и фильтры ---------------------------------------------------- */

function activeScope() {
  if (!STATE.payload) return null;
  var found = null;
  STATE.payload.scopes.forEach(function (scope) {
    if (scope.key === STATE.scopeKey) found = scope;
  });
  return found;
}

/** Достраиваем узлы производными полями — считать их в рендере дороже. */
function enrich(scope) {
  return (scope.hosts || []).map(function (host) {
    var reasons = host.reasons || {};
    var dominant = '';
    var max = 0;
    Object.keys(reasons).forEach(function (key) {
      if (reasons[key] > max) { max = reasons[key]; dominant = key; }
    });

    var runs = host.runs || 0;
    return {
      id: host.id,
      host: host.host,
      online: host.online,
      state: host.state || '—',
      ssl: host.ssl || '—',
      latency: typeof host.latency === 'number' ? host.latency : null,
      note: host.note || '',
      checkedAt: host.checkedAt || '',
      problem: !!host.problem,
      fails: host.fails || 0,
      runs: runs,
      failRate: runs ? (host.fails || 0) / runs : 0,
      reasons: reasons,
      reasonKey: dominant,
      reasonLabel: dominant ? reasonLabel(dominant) : '',
      topNote: host.topNote || '',
      liveReason: host.reason || '',
    };
  });
}

function reasonLabel(key) {
  var scope = activeScope();
  var found = '';
  if (scope) {
    (scope.reasons || []).forEach(function (reason) {
      if (reason.key === key) found = reason.label;
    });
  }
  return found || REASON_LABELS[key] || key;
}

function visibleHosts() {
  var f = STATE.filters;
  var needle = f.search.trim().toLowerCase();
  return STATE.hosts.filter(function (host) {
    if (f.state === 'online' && host.online !== true) return false;
    if (f.state === 'offline' && host.online !== false) return false;
    if (f.ssl && host.ssl !== f.ssl) return false;
    if (f.reason && !host.reasons[f.reason]) return false;
    if (f.problemOnly && !host.problem) return false;
    if (f.failsOnly && !host.fails) return false;
    if (needle) {
      var haystack = (host.host + ' ' + host.ssl + ' ' + host.note + ' ' + host.topNote).toLowerCase();
      if (haystack.indexOf(needle) === -1) return false;
    }
    return true;
  });
}

function switchScope(key, force) {
  if (!force && key === STATE.scopeKey) return;
  STATE.scopeKey = key;
  var scope = activeScope();
  STATE.hosts = scope ? enrich(scope) : [];
  resetFilters(false);
  buildFilterOptions();
  markTabs();
  render();
}

function buildFilterOptions() {
  var scope = activeScope();
  var ssl = unique(STATE.hosts.map(function (host) { return host.ssl; })).sort(function (a, b) {
    return a.localeCompare(b, 'ru');
  });
  fillSelect($('f-ssl'), ssl.map(function (value) { return { value: value, label: value }; }), 'Любой', STATE.filters.ssl);

  var reasons = (scope && scope.reasons ? scope.reasons : []).map(function (reason) {
    return { value: reason.key, label: reason.label };
  });
  fillSelect($('f-reason'), reasons, 'Любая', STATE.filters.reason);
}

function fillSelect(select, options, allLabel, current) {
  select.textContent = '';
  select.appendChild(new Option(allLabel, ''));
  var values = [];
  options.forEach(function (option) {
    select.appendChild(new Option(option.label, option.value));
    values.push(option.value);
  });
  select.value = values.indexOf(current) !== -1 ? current : '';
}

function resetFilters(rerender) {
  STATE.filters = { search: '', state: '', ssl: '', reason: '', problemOnly: false, failsOnly: false };
  $('f-search').value = '';
  $('f-state').value = '';
  $('f-ssl').value = '';
  $('f-reason').value = '';
  $('f-problem').checked = false;
  $('f-fails').checked = false;
  if (rerender) render();
}

/* --- Сводка и вкладки ----------------------------------------------------- */

function renderHealth() {
  var container = $('health');
  container.textContent = '';

  STATE.payload.scopes.forEach(function (scope) {
    var totals = scope.totals;
    var down = totals.offline;
    var item = node('div', { className: 'health__item health__item--' + (down ? 'down' : 'ok') });

    var body = node('div', { className: 'health__body' });
    body.appendChild(node('p', { className: 'health__name' }, scope.label));
    body.appendChild(node('p', { className: 'health__meta' },
      down
        ? 'не отвечают: ' + nf.format(down) + ' из ' + nf.format(totals.hosts)
        : 'отвечают все ' + nf.format(totals.hosts) + ' ' + plural(totals.hosts, 'узел', 'узла', 'узлов')));
    item.appendChild(body);

    var value = node('div', { className: 'health__value health__value--' + (down ? 'down' : 'ok') },
      share(totals.up, totals.checks));
    item.appendChild(value);

    bindTooltip(item, function () {
      return {
        value: share(totals.up, totals.checks) + ' удачных проверок',
        label: scope.label + ' — за весь период наблюдения',
        meta: nf.format(totals.checks) + ' проверок · ' + nf.format(totals.runs) + ' запусков · ' +
          nf.format(totals.down) + ' сбоев',
      };
    });

    container.appendChild(item);
  });
}

function renderTabs() {
  var tabs = $('tabs');
  tabs.textContent = '';

  STATE.payload.scopes.forEach(function (scope) {
    var tab = node('button', { className: 'tab', type: 'button', role: 'tab' });
    tab.dataset.scope = scope.key;
    tab.appendChild(node('span', {}, scope.label));
    tab.appendChild(node('span', { className: 'tab__count' }, nf.format(scope.totals.hosts)));
    tab.addEventListener('click', function () { switchScope(scope.key, false); });
    tabs.appendChild(tab);
  });
  markTabs();
}

function markTabs() {
  Array.prototype.forEach.call(document.querySelectorAll('#tabs .tab'), function (tab) {
    tab.setAttribute('aria-selected', tab.dataset.scope === STATE.scopeKey ? 'true' : 'false');
  });
}

/* --- Рендер --------------------------------------------------------------- */

function render() {
  var scope = activeScope();
  if (!scope) return;
  var hosts = visibleHosts();

  renderKpis(scope, hosts);
  renderBoard(scope, hosts);
  renderReliability(hosts);
  renderReasons(scope, hosts);
  renderLatency(hosts);
  renderSsl(hosts);
  renderTimeline(scope);
  renderHeat(scope);
  renderEvents(scope);
  renderTable(scope, hosts);
}

function renderKpis(scope, hosts) {
  var totals = scope.totals;
  var fails = sum(hosts, 'fails');
  var runs = hosts.length ? hosts[0].runs : 0;
  var offline = hosts.filter(function (host) { return host.online === false; }).length;
  var latencies = hosts.filter(function (host) { return host.latency !== null; })
    .map(function (host) { return host.latency; });
  var filtered = hosts.length !== STATE.hosts.length;

  // Без фильтра доступность берём точную — по журналу целиком. Под фильтром
  // журнал по узлам не разложен, поэтому знаменатель оцениваем как
  // «узлов × запусков»: пропущенные проверки при этом считаются удачными.
  var expected = hosts.length * runs;
  var ratio = filtered
    ? (expected ? 1 - fails / expected : 0)
    : (totals.checks ? totals.up / totals.checks : 0);

  var uptime = $('kpi-uptime');
  uptime.textContent = filtered
    ? (expected ? share(expected - fails, expected) : '—')
    : share(totals.up, totals.checks);
  uptime.className = 'kpi__value kpi__value--hero' +
    (ratio ? (ratio < 0.95 ? ' kpi__value--down' : ' kpi__value--ok') : '');
  $('kpi-uptime-hint').textContent = filtered
    ? 'оценка по отобранным узлам: ' + nf.format(fails) + ' сбоев на ' + nf.format(expected) + ' проверок'
    : nf.format(totals.checks) + ' проверок за ' + nf.format(totals.runs) + ' запусков';

  $('kpi-hosts').textContent = nf.format(hosts.length);
  $('kpi-hosts-hint').textContent = filtered
    ? 'из ' + nf.format(STATE.hosts.length) + ' под наблюдением'
    : nf.format(hosts.filter(function (host) { return host.online === true; }).length) + ' отвечают · ' +
      nf.format(hosts.filter(function (host) { return host.problem; }).length) + ' помечены проблемными';

  var offlineEl = $('kpi-offline');
  offlineEl.textContent = nf.format(offline);
  offlineEl.className = 'kpi__value' + (offline ? ' kpi__value--down' : ' kpi__value--ok');
  $('kpi-offline-hint').textContent = hosts.length
    ? pct(offline / hosts.length) + ' наблюдаемых узлов'
    : ' ';

  $('kpi-latency').textContent = latencies.length ? nf.format(median(latencies)) + ' мс' : '—';
  $('kpi-latency-hint').textContent = latencies.length
    ? 'медленнее всех — ' + nf.format(Math.max.apply(null, latencies)) + ' мс'
    : 'нет отвечающих узлов';

  $('kpi-fails').textContent = nf.format(fails);
  $('kpi-fails-hint').textContent = fails
    ? 'худший узел — ' + worstHost(hosts)
    : 'ни одного отказа в журнале';
}

function worstHost(hosts) {
  var worst = hosts.reduce(function (best, host) {
    return !best || host.fails > best.fails ? host : best;
  }, null);
  return worst ? worst.host + ' (' + nf.format(worst.fails) + ')' : '—';
}

function renderBoard(scope, hosts) {
  var container = $('chart-board');
  container.textContent = '';

  $('board-sub').textContent = 'По листу «' + scope.statusSheet + '»' +
    (hosts.length && hosts[0].checkedAt ? ', обновлён ' + stamp(lastCheck(hosts)) : '');

  if (!hosts.length) {
    container.appendChild(node('p', { className: 'empty' }, 'Под фильтр ничего не попало'));
    $('board-legend').textContent = '';
    return;
  }

  // Недоступные — вперёд: с них начинают разбор.
  var sorted = hosts.slice().sort(function (a, b) {
    return rank(a) - rank(b) || b.failRate - a.failRate || a.host.localeCompare(b.host, 'ru');
  });

  var board = node('div', { className: 'board' });
  sorted.forEach(function (host) {
    var kind = host.online === true ? 'ok' : host.online === false ? 'down' : 'idle';
    var chip = node('div', { className: 'chip chip--' + kind });
    chip.tabIndex = 0;
    chip.appendChild(node('span', { className: 'chip__mark' },
      host.online === true ? '✓' : host.online === false ? '✕' : '?'));
    chip.appendChild(node('span', { className: 'chip__name' }, host.host));
    if (host.problem) chip.appendChild(node('span', { className: 'chip__flag' }, '⚑'));

    bindTooltip(chip, function () {
      return {
        value: host.state + (host.latency !== null ? ' · ' + nf.format(host.latency) + ' мс' : ''),
        label: host.host,
        meta: (host.note || 'без примечания') +
          ' · SSL: ' + host.ssl +
          ' · сбоев в журнале: ' + nf.format(host.fails) + ' (' + pct(host.failRate) + ')',
      };
    });
    board.appendChild(chip);
  });
  container.appendChild(board);

  var counts = { ok: 0, down: 0, idle: 0 };
  hosts.forEach(function (host) {
    counts[host.online === true ? 'ok' : host.online === false ? 'down' : 'idle'] += 1;
  });

  var legend = $('board-legend');
  legend.textContent = '';
  [
    { key: 'ok', label: 'Доступен', color: 'var(--ok)' },
    { key: 'down', label: 'Недоступен', color: 'var(--down)' },
    { key: 'idle', label: 'Состояние неизвестно', color: 'var(--idle)' },
  ].forEach(function (entry) {
    if (!counts[entry.key]) return;
    var item = node('div', { className: 'legend__item' });
    var swatch = node('span', { className: 'legend__swatch legend__swatch--dot' });
    swatch.style.background = entry.color;
    item.appendChild(swatch);
    item.appendChild(node('span', {}, entry.label + ' — '));
    item.appendChild(node('span', { className: 'legend__value' }, nf.format(counts[entry.key])));
    legend.appendChild(item);
  });
  var flagged = hosts.filter(function (host) { return host.problem; }).length;
  if (flagged) {
    var item = node('div', { className: 'legend__item' });
    item.appendChild(node('span', {}, '⚑ помечен проблемным в настройках — '));
    item.appendChild(node('span', { className: 'legend__value' }, nf.format(flagged)));
    legend.appendChild(item);
  }
}

function rank(host) {
  return host.online === false ? 0 : host.online === null ? 1 : 2;
}

function lastCheck(hosts) {
  return hosts.reduce(function (latest, host) {
    return host.checkedAt > latest ? host.checkedAt : latest;
  }, '');
}

/**
 * Горизонтальные бары. Категории номинальные, поэтому длина кодирует величину,
 * а цвет — только смысл («это отказ», «это вина мониторинга»).
 */
function renderBars(container, items, options) {
  var opts = options || {};
  container.textContent = '';

  if (!items.length) {
    container.appendChild(node('p', { className: 'empty' }, opts.empty || 'Под фильтр ничего не попало'));
    return;
  }

  var max = items.reduce(function (m, item) { return Math.max(m, item.value); }, 0) || 1;
  var wrap = node('div', { className: 'bars' });

  items.forEach(function (item) {
    var row = node('div', { className: 'bar-row' + (item.value === 0 ? ' bar-row--muted' : '') });
    row.tabIndex = 0;

    var label = node('span', { className: 'bar-row__label' });
    label.appendChild(node('span', { className: 'bar-row__labeltext' }, item.label));
    label.title = item.label;

    var track = node('div', { className: 'bar-row__track' });
    var fill = node('div', { className: 'bar-row__fill' + (item.tone ? ' bar-row__fill--' + item.tone : '') });
    fill.style.width = Math.max((item.value / max) * 100, item.value > 0 ? 1 : 0) + '%';
    track.appendChild(fill);

    row.appendChild(label);
    row.appendChild(track);
    row.appendChild(node('span', { className: 'bar-row__value' },
      opts.format ? opts.format(item) : nf.format(item.value)));

    bindTooltip(row, function () {
      return {
        value: opts.tipValue ? opts.tipValue(item) : nf.format(item.value),
        label: item.label,
        meta: opts.meta ? opts.meta(item) : '',
      };
    });

    wrap.appendChild(row);
  });

  container.appendChild(wrap);
}

function renderReliability(hosts) {
  var items = hosts.slice()
    .sort(function (a, b) { return b.failRate - a.failRate || a.host.localeCompare(b.host, 'ru'); })
    .map(function (host) {
      return {
        label: host.host,
        value: host.failRate * 100,
        host: host,
        tone: host.failRate === 0 ? '' : host.reasonKey && MONITOR_REASONS[host.reasonKey] ? 'warn' : 'down',
      };
    });

  renderBars($('chart-reliability'), items, {
    format: function (item) { return pct(item.host.failRate); },
    tipValue: function (item) {
      return nf.format(item.host.fails) + ' ' + plural(item.host.fails, 'сбой', 'сбоя', 'сбоев') +
        ' из ' + nf.format(item.host.runs);
    },
    meta: function (item) {
      return (item.host.reasonLabel ? 'чаще всего: ' + item.host.reasonLabel : 'отказов не было') +
        ' · сейчас: ' + item.host.state;
    },
  });
}

function renderReasons(scope, hosts) {
  // Суммируем по отобранным узлам, чтобы карточка честно слушалась фильтров.
  var counts = {};
  hosts.forEach(function (host) {
    Object.keys(host.reasons).forEach(function (key) {
      counts[key] = (counts[key] || 0) + host.reasons[key];
    });
  });

  var order = (scope.reasons || []).map(function (reason) { return reason.key; });
  Object.keys(counts).forEach(function (key) {
    if (order.indexOf(key) === -1) order.push(key);
  });

  var items = order.filter(function (key) { return counts[key]; }).map(function (key) {
    return {
      label: reasonLabel(key),
      value: counts[key],
      key: key,
      tone: MONITOR_REASONS[key] ? 'warn' : 'down',
    };
  }).sort(function (a, b) { return b.value - a.value; });

  var total = items.reduce(function (acc, item) { return acc + item.value; }, 0);

  renderBars($('chart-reasons'), items, {
    empty: 'Отказов под фильтром нет',
    tipValue: function (item) { return nf.format(item.value) + ' (' + pct(item.value / total) + ')'; },
    meta: function (item) {
      return MONITOR_REASONS[item.key]
        ? 'Отказ мониторинга: узел, скорее всего, был жив'
        : 'Отказ на стороне узла';
    },
  });
}

function renderLatency(hosts) {
  var values = hosts.filter(function (host) { return host.latency !== null && host.online === true; })
    .map(function (host) { return host.latency; });

  var items = LATENCY_BINS.map(function (bin) {
    return {
      label: bin.label,
      value: values.filter(function (value) { return value >= bin.min && value < bin.max; }).length,
      tone: bin.min >= 3000 ? 'down' : bin.min >= 2000 ? 'warn' : 'ok',
    };
  });

  renderBars($('chart-latency'), items, {
    empty: 'Нет отвечающих узлов под фильтром',
    tipValue: function (item) {
      return nf.format(item.value) + ' ' + plural(item.value, 'узел', 'узла', 'узлов');
    },
    meta: function () {
      return values.length
        ? 'медиана ' + nf.format(median(values)) + ' мс, всего ' + nf.format(values.length)
        : '';
    },
  });
}

function renderSsl(hosts) {
  var counts = {};
  hosts.forEach(function (host) { counts[host.ssl] = (counts[host.ssl] || 0) + 1; });

  var items = Object.keys(counts).map(function (key) {
    return {
      label: key,
      value: counts[key],
      tone: /^ок$/i.test(key) ? 'ok' : /нет https/i.test(key) ? 'warn' : '',
    };
  }).sort(function (a, b) { return b.value - a.value; });

  renderBars($('chart-ssl'), items, {
    tipValue: function (item) {
      return nf.format(item.value) + ' ' + plural(item.value, 'узел', 'узла', 'узлов');
    },
    meta: function (item) {
      if (/^ок$/i.test(item.label)) return 'Сертификат проверен и валиден';
      if (/нет https/i.test(item.label)) return 'Узел отвечает только по HTTP';
      return 'Проверить сертификат не удалось';
    },
  });
}

function renderTimeline(scope) {
  var container = $('chart-timeline');
  container.textContent = '';

  var days = scope.daily || [];
  if (!days.length) {
    container.appendChild(node('p', { className: 'empty' }, 'В журнале нет проверок'));
    $('timeline-legend').textContent = '';
    return;
  }

  var max = days.reduce(function (m, day) { return Math.max(m, day.up + day.down); }, 0) || 1;

  var columns = node('div', { className: 'columns' });
  days.forEach(function (day) {
    var total = day.up + day.down;
    var column = node('div', { className: 'column' });
    column.tabIndex = 0;

    var stack = node('div', { className: 'column__stack' });
    stack.style.height = Math.max((total / max) * 100, total ? 2 : 0) + '%';
    [['up', day.up], ['down', day.down]].forEach(function (pair) {
      if (!pair[1]) return;
      var seg = node('div', { className: 'column__seg column__seg--' + pair[0] });
      seg.style.height = (pair[1] / total) * 100 + '%';
      stack.appendChild(seg);
    });
    column.appendChild(stack);

    bindTooltip(column, function () {
      return {
        value: share(day.up, total) + ' удачных',
        label: longDate(day.date),
        meta: nf.format(total) + ' проверок · ' + nf.format(day.down) + ' сбоев · ' +
          nf.format(day.runs) + ' запусков' +
          (day.skipped ? ' · пропущено ' + nf.format(day.skipped) : ''),
      };
    });
    columns.appendChild(column);
  });
  container.appendChild(columns);

  var axis = node('div', { className: 'columns-axis' });
  var lastMonth = '';
  days.forEach(function (day) {
    var month = day.date.slice(0, 7);
    var tick = node('div', { className: 'columns-axis__tick' },
      month === lastMonth ? day.date.slice(8) : shortDate(day.date));
    lastMonth = month;
    axis.appendChild(tick);
  });
  container.appendChild(axis);

  var legend = $('timeline-legend');
  legend.textContent = '';
  [
    { label: 'Удачные проверки', color: 'var(--ok)', value: scope.totals.up },
    { label: 'Сбои', color: 'var(--down)', value: scope.totals.down },
  ].forEach(function (entry) {
    var item = node('div', { className: 'legend__item' });
    var swatch = node('span', { className: 'legend__swatch' });
    swatch.style.background = entry.color;
    item.appendChild(swatch);
    item.appendChild(node('span', {}, entry.label + ' — '));
    item.appendChild(node('span', { className: 'legend__value' }, nf.format(entry.value)));
    legend.appendChild(item);
  });
  legend.appendChild(node('div', { className: 'legend__item' },
    'Высота столбца — сколько проверок было в этот день'));
}

function renderHeat(scope) {
  var container = $('chart-heat');
  container.textContent = '';

  var series = scope.series || [];
  if (!series.length) {
    container.appendChild(node('p', { className: 'empty' }, 'В журнале нет проверок'));
    $('heat-legend').textContent = '';
    return;
  }

  var byDate = {};
  var dates = [];
  series.forEach(function (point) {
    if (!byDate[point.date]) { byDate[point.date] = {}; dates.push(point.date); }
    byDate[point.date][point.hour] = point;
  });
  dates.sort();

  var table = node('table', { className: 'heat' });
  var thead = node('thead');
  var headRow = node('tr');
  headRow.appendChild(node('th', { scope: 'col' }, 'Дата'));
  for (var h = 0; h < 24; h++) headRow.appendChild(node('th', { scope: 'col' }, String(h)));
  headRow.appendChild(node('th', { scope: 'col' }, 'За день'));
  thead.appendChild(headRow);
  table.appendChild(thead);

  var tbody = node('tbody');
  dates.forEach(function (date) {
    var tr = node('tr');
    tr.appendChild(node('th', { scope: 'row' }, longDate(date)));

    var dayUp = 0;
    var dayDown = 0;
    for (var hour = 0; hour < 24; hour++) {
      var point = byDate[date][hour];
      var td = node('td');
      if (!point || !(point.up + point.down)) {
        td.className = 'is-empty';
        td.title = longDate(date) + ', ' + hour + ':00 — проверок не было';
      } else {
        var total = point.up + point.down;
        var rate = point.down / total;
        dayUp += point.up;
        dayDown += point.down;
        td.className = 'l' + binOf(rate);
        td.tabIndex = 0;
        bindTooltip(td, function (p, d, hh) {
          return function () {
            var t = p.up + p.down;
            return {
              value: pct(p.down / t) + ' сбоев',
              label: longDate(d) + ', ' + hh + ':00',
              meta: nf.format(t) + ' проверок · ' + nf.format(p.down) + ' неудачных',
            };
          };
        }(point, date, hour));
      }
      tr.appendChild(td);
    }

    tr.appendChild(node('td', { className: 'total' },
      dayUp + dayDown ? pct(dayDown / (dayUp + dayDown)) : ''));
    tbody.appendChild(tr);
  });
  table.appendChild(tbody);
  container.appendChild(table);

  var legend = $('heat-legend');
  legend.textContent = '';
  legend.appendChild(node('span', { className: 'legend__caption' }, 'Доля неудачных проверок в часе:'));
  HEAT_BINS.forEach(function (bin, i) {
    var step = node('span', { className: 'scale-step' });
    var chip = node('span', { className: 'scale-step__chip' });
    chip.style.background = 'var(--d' + i + ')';
    step.appendChild(chip);
    step.appendChild(node('span', {}, bin.label));
    legend.appendChild(step);
  });
  var empty = node('span', { className: 'scale-step' });
  var chip = node('span', { className: 'scale-step__chip' });
  chip.style.background = 'transparent';
  chip.style.boxShadow = 'inset 0 0 0 1px var(--grid)';
  empty.appendChild(chip);
  empty.appendChild(node('span', {}, 'проверок не было'));
  legend.appendChild(empty);
}

function binOf(rate) {
  var index = 0;
  for (var i = 0; i < HEAT_BINS.length; i++) {
    if (rate >= HEAT_BINS[i].min) index = i;
  }
  return index;
}

/* Цвет здесь кодирует уровень записи, а не состояние узла: зелёный и красный
   на этой карточке значили бы «доступен/недоступен» и сбивали бы с толку. */
var LEVEL_TONES = [
  { level: 'ОТЛАДКА', tone: '', color: 'var(--accent)' },
  { level: 'ИНФО', tone: 'idle', color: 'var(--idle)' },
  { level: 'ПРЕДУПРЕЖДЕНИЕ', tone: 'warn', color: 'var(--warn)' },
];

function renderEvents(scope) {
  var tones = {};
  LEVEL_TONES.forEach(function (entry) { tones[entry.level] = entry.tone; });

  var items = (scope.events || []).map(function (event) {
    return {
      label: event.event,
      value: event.count,
      level: event.level,
      tone: tones[event.level] || '',
    };
  });

  renderBars($('chart-events'), items, {
    empty: 'Журнал пуст',
    tipValue: function (item) {
      return nf.format(item.value) + ' ' + plural(item.value, 'запись', 'записи', 'записей');
    },
    meta: function (item) { return 'уровень: ' + item.level; },
  });

  var legend = $('events-legend');
  legend.textContent = '';
  LEVEL_TONES.forEach(function (entry) {
    var total = items.reduce(function (acc, item) {
      return item.level === entry.level ? acc + item.value : acc;
    }, 0);
    if (!total) return;
    var row = node('div', { className: 'legend__item' });
    var swatch = node('span', { className: 'legend__swatch' });
    swatch.style.background = entry.color;
    row.appendChild(swatch);
    row.appendChild(node('span', {}, entry.level + ' — '));
    row.appendChild(node('span', { className: 'legend__value' }, nf.format(total)));
    legend.appendChild(row);
  });
}

function renderTable(scope, hosts) {
  var body = $('table-body');
  body.textContent = '';

  var sorted = hosts.slice().sort(comparator(STATE.sort));
  $('table-sub').textContent = (sorted.length === STATE.hosts.length
    ? nf.format(sorted.length) + ' ' + plural(sorted.length, 'узел', 'узла', 'узлов')
    : nf.format(sorted.length) + ' из ' + nf.format(STATE.hosts.length) + ' узлов') +
    ' · доля сбоев считается от ' + nf.format(scope.totals.runs) + ' запусков проверки';

  if (!sorted.length) {
    var tr = node('tr');
    tr.appendChild(node('td', { colSpan: 7, className: 'empty' }, 'Под фильтр ничего не попало'));
    body.appendChild(tr);
    return;
  }

  var fragment = document.createDocumentFragment();
  sorted.forEach(function (host) {
    var tr = node('tr');

    var nameCell = node('td');
    if (/^https?:\/\//i.test(host.host)) {
      var link = node('a', { href: host.host }, host.host);
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      nameCell.appendChild(link);
    } else {
      nameCell.appendChild(node('span', {}, host.host));
    }
    if (host.problem) nameCell.appendChild(node('span', { className: 'tag' }, 'проблемный'));
    tr.appendChild(nameCell);

    var stateCell = node('td');
    var kind = host.online === true ? 'ok' : host.online === false ? 'down' : 'idle';
    var pill = node('span', { className: 'pill pill--' + kind });
    pill.appendChild(node('span', { className: 'pill__dot' }));
    pill.appendChild(node('span', {}, host.state));
    stateCell.appendChild(pill);
    stateCell.title = host.note;
    tr.appendChild(stateCell);

    tr.appendChild(node('td', {}, host.ssl));
    tr.appendChild(node('td', { className: 'num' + (host.latency === null ? ' zero' : '') },
      host.latency === null ? '—' : nf.format(host.latency)));

    var failCell = node('td', { className: 'num' + (host.fails ? '' : ' zero') },
      host.fails ? nf.format(host.fails) + ' · ' + pct(host.failRate) : '0');
    tr.appendChild(failCell);

    tr.appendChild(node('td', { className: 'reason' }, host.reasonLabel || '—'));
    tr.appendChild(node('td', { className: 'stamp' }, host.checkedAt ? stamp(host.checkedAt) : '—'));

    fragment.appendChild(tr);
  });
  body.appendChild(fragment);
}

function comparator(sort) {
  var dir = sort.dir === 'asc' ? 1 : -1;
  return function (a, b) {
    var x = a[sort.key];
    var y = b[sort.key];
    if (x === null) x = -1;
    if (y === null) y = -1;
    if (typeof x === 'number' && typeof y === 'number') {
      return (x - y) * dir || a.host.localeCompare(b.host, 'ru');
    }
    return String(x).localeCompare(String(y), 'ru') * dir || a.host.localeCompare(b.host, 'ru');
  };
}

/* --- Мелкие помощники ----------------------------------------------------- */

function sum(list, key) {
  return list.reduce(function (acc, item) { return acc + (item[key] || 0); }, 0);
}

function median(values) {
  if (!values.length) return 0;
  var sorted = values.slice().sort(function (a, b) { return a - b; });
  var mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : Math.round((sorted[mid - 1] + sorted[mid]) / 2);
}

function unique(list) {
  var seen = Object.create(null);
  var out = [];
  list.forEach(function (item) {
    if (item && !seen[item]) { seen[item] = true; out.push(item); }
  });
  return out;
}

/** Доля удачных проверок: у аптайма принято показывать сотые доли процента. */
function share(value, total) {
  if (!total) return '—';
  var percent = (value / total) * 100;
  if (percent >= 99.95 && percent < 100) return '99,95%';
  return percent.toFixed(percent >= 99 ? 2 : 1).replace('.', ',') + '%';
}

function pct(ratio) {
  if (!isFinite(ratio) || ratio <= 0) return '0%';
  var percent = ratio * 100;
  if (percent < 0.1) return '<0,1%';
  // Не округляем 99,8% до «100%»: разница между «почти всегда» и «всегда» здесь
  // и есть содержание показателя.
  if (percent < 10 || (percent > 99 && percent < 100)) return percent.toFixed(1).replace('.', ',') + '%';
  return Math.round(percent) + '%';
}

function shortDate(iso) {
  var parts = String(iso).split('-');
  return parts.length === 3 ? parts[2] + '.' + parts[1] : String(iso);
}

function longDate(iso) {
  var parts = String(iso).split('-');
  return parts.length === 3 ? parts[2] + '.' + parts[1] + '.' + parts[0] : String(iso);
}

/** «2025-12-11 13:36:11» → «11.12, 13:36». Часовой пояс не трогаем. */
function stamp(value) {
  var match = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})/.exec(String(value));
  if (!match) return String(value);
  return match[3] + '.' + match[2] + ', ' + match[4] + ':' + match[5];
}

function plural(n, one, few, many) {
  var mod10 = n % 10;
  var mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return one;
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return few;
  return many;
}

/** Мини-хелпер для DOM: значения всегда кладём через textContent. */
function node(tag, props, text) {
  var el = document.createElement(tag);
  if (props) {
    Object.keys(props).forEach(function (key) {
      if (key === 'className') el.className = props[key];
      else if (key === 'colSpan') el.colSpan = props[key];
      else el.setAttribute(key, props[key]);
    });
  }
  if (text !== undefined && text !== null) el.textContent = text;
  return el;
}

/* --- Тултип --------------------------------------------------------------- */

var tooltip = null;

function bindTooltip(el, getContent) {
  var show = function (event) {
    var data = getContent();
    tooltip.textContent = '';
    tooltip.appendChild(node('div', { className: 'tooltip__value' }, data.value));
    tooltip.appendChild(node('div', { className: 'tooltip__label' }, data.label));
    if (data.meta) tooltip.appendChild(node('div', { className: 'tooltip__meta' }, data.meta));
    tooltip.classList.add('is-visible');
    tooltip.setAttribute('aria-hidden', 'false');
    position(event, el);
  };
  var hide = function () {
    tooltip.classList.remove('is-visible');
    tooltip.setAttribute('aria-hidden', 'true');
  };

  el.addEventListener('mouseenter', show);
  el.addEventListener('mousemove', function (event) { position(event, el); });
  el.addEventListener('mouseleave', hide);
  el.addEventListener('focus', show);
  el.addEventListener('blur', hide);
}

function position(event, el) {
  var rect = el.getBoundingClientRect();
  var x = event && event.clientX ? event.clientX + 14 : rect.left + rect.width / 2;
  var y = (event && event.clientY ? event.clientY : rect.top) - 8;

  tooltip.style.left = '0px';
  tooltip.style.top = '0px';
  var box = tooltip.getBoundingClientRect();

  var left = Math.min(Math.max(8, x), window.innerWidth - box.width - 8);
  var top = Math.min(Math.max(8, y - box.height), window.innerHeight - box.height - 8);
  tooltip.style.left = left + 'px';
  tooltip.style.top = top + 'px';
}

/* --- CSV ------------------------------------------------------------------ */

function exportCsv() {
  var scope = activeScope();
  var hosts = visibleHosts().slice().sort(comparator(STATE.sort));
  var header = ['Узел', 'Сейчас', 'SSL', 'Задержка, мс', 'Примечание', 'Сбоев',
    'Запусков', 'Доля сбоев, %', 'Основная причина', 'Частая ошибка', 'Проверен'];
  var lines = [header.join(';')];

  hosts.forEach(function (host) {
    lines.push([
      host.host, host.state, host.ssl,
      host.latency === null ? '' : host.latency,
      host.note, host.fails, host.runs,
      (host.failRate * 100).toFixed(2).replace('.', ','),
      host.reasonLabel, host.topNote, host.checkedAt,
    ].map(csvCell).join(';'));
  });

  // BOM — чтобы Excel открыл кириллицу без плясок с кодировкой.
  var blob = new Blob(['﻿' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8' });
  var url = URL.createObjectURL(blob);
  var link = document.createElement('a');
  link.href = url;
  link.download = 'monitoring-' + (scope ? scope.key : 'hosts') + '.csv';
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
}

function csvCell(value) {
  var s = String(value === null || value === undefined ? '' : value);
  return /[";\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

/* --- Тема ----------------------------------------------------------------- */

function toggleTheme() {
  var root = document.documentElement;
  var prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
  var current = root.dataset.theme || (prefersDark ? 'dark' : 'light');
  var next = current === 'dark' ? 'light' : 'dark';
  root.dataset.theme = next;
  try { localStorage.setItem('uptime-dashboard-theme', next); } catch (e) {}
}

/* --- Инициализация -------------------------------------------------------- */

function bindControls() {
  var search = $('f-search');
  var debounce;
  search.addEventListener('input', function () {
    clearTimeout(debounce);
    debounce = setTimeout(function () {
      STATE.filters.search = search.value;
      render();
    }, 120);
  });

  $('f-state').addEventListener('change', function (e) { STATE.filters.state = e.target.value; render(); });
  $('f-ssl').addEventListener('change', function (e) { STATE.filters.ssl = e.target.value; render(); });
  $('f-reason').addEventListener('change', function (e) { STATE.filters.reason = e.target.value; render(); });
  $('f-problem').addEventListener('change', function (e) { STATE.filters.problemOnly = e.target.checked; render(); });
  $('f-fails').addEventListener('change', function (e) { STATE.filters.failsOnly = e.target.checked; render(); });

  $('reset').addEventListener('click', function () { resetFilters(true); });
  $('refresh').addEventListener('click', function () { load(true); });
  $('theme').addEventListener('click', toggleTheme);
  $('export').addEventListener('click', exportCsv);

  Array.prototype.forEach.call(document.querySelectorAll('#table thead th[data-sort]'), function (th) {
    th.addEventListener('click', function () {
      var key = th.dataset.sort;
      if (STATE.sort.key === key) {
        STATE.sort.dir = STATE.sort.dir === 'asc' ? 'desc' : 'asc';
      } else {
        STATE.sort.key = key;
        STATE.sort.dir = key === 'failRate' || key === 'latency' ? 'desc' : 'asc';
      }
      Array.prototype.forEach.call(document.querySelectorAll('#table thead th[data-sort]'), function (other) {
        other.removeAttribute('aria-sort');
      });
      th.setAttribute('aria-sort', STATE.sort.dir === 'asc' ? 'ascending' : 'descending');
      var scope = activeScope();
      if (scope) renderTable(scope, visibleHosts());
    });
  });
}

function init() {
  tooltip = $('tooltip');
  bindControls();
  load(false);
  setInterval(function () {
    if (!document.hidden) load(false);
  }, CONFIG.autoRefreshMs);
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
