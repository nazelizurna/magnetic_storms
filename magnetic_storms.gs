/**
 * Магнитные бури → Google Календарь (v2)
 * Источник: NOAA SWPC (бесплатно, без ключа):
 *   1) прогноз Kp на 3 дня
 *   2) наблюдаемый/оценочный Kp (ловит бури, которые прогноз не предсказал)
 *
 * Часовой пояс: Ростов-на-Дону = Europe/Moscow (UTC+3, без перехода на летнее время).
 * NOAA отдаёт время в UTC — скрипт переводит его в московское/ростовское.
 *
 * Установка:
 * 1. script.google.com → Новый проект → вставить код.
 * 2. Project Settings (шестерёнка) → Time zone → (GMT+03:00) Moscow  [или включить
 *    «Show appsscript.json» и указать "timeZone": "Europe/Moscow"].
 * 3. Запустить main(), выдать разрешения.
 * 4. Один раз запустить createDailyTrigger().
 */

const CONFIG = {
  TIMEZONE: 'Europe/Moscow',       // Ростов-на-Дону
  UTC_OFFSET: '+03:00',            // фиксированный сдвиг (летнего времени в РФ нет)
  CALENDAR_NAME: 'Магнитные бури', // '' = основной календарь
  MIN_KP: 4.67,                    // 4.67 = «5−» по записи NOAA = уровень G1. Для G2 поставьте 5.67
  INCLUDE_TODAY: true,             // true = учитывать и уже идущие/прошедшие сегодня интервалы
  SOURCES: [
    'https://services.swpc.noaa.gov/products/noaa-planetary-k-index-forecast.json',
    'https://services.swpc.noaa.gov/products/noaa-planetary-k-index.json'
  ],
  TAG: '[SWPC-AUTO]',
  SCALES_URL: 'https://services.swpc.noaa.gov/products/noaa-scales.json', // оценка G по дням
  MIN_G: 1,                        // минимальный уровень G для суточных событий
  INCLUDE_YESTERDAY: true,         // добавлять вчерашнюю наблюдавшуюся бурю
  DAY_TAG: '[SWPC-DAY]'
};

/**
 * Уровни бурь и цвета событий.
 * Google Календарь поддерживает для событий только 11 фиксированных цветов (произвольный HEX нельзя),
 * поэтому градиент «светло-оранжевый → красный» собран из ближайших доступных:
 *   YELLOW (Banana) → ORANGE (Tangerine) → PALE_RED (Flamingo) → RED (Tomato).
 * G4 и G5 оба красные, их различает значок и название в заголовке.
 */
const LEVELS = {
  1: { name: 'слабая',          icon: '🟡', color: CalendarApp.EventColor.YELLOW },
  2: { name: 'умеренная',       icon: '🟠', color: CalendarApp.EventColor.ORANGE },
  3: { name: 'сильная',         icon: '🔴', color: CalendarApp.EventColor.PALE_RED },
  4: { name: 'очень сильная',   icon: '🟥', color: CalendarApp.EventColor.RED },
  5: { name: 'ЭКСТРЕМАЛЬНАЯ',   icon: '🚨', color: CalendarApp.EventColor.RED }
};

/** Kp → уровень G по шкале NOAA (4.67 = 5− → G1, 8.67 = 9− → G4, 9.0 → G5) */
function kpToG_(kp) {
  if (kp >= 9) return 5;
  return Math.min(4, Math.max(1, Math.round(kp) - 4));
}

function main() {
  const intervals = fetchAll_();
  const storms = mergeStorms_(intervals);
  const cal = getCalendar_();

  // каждое событие в своём try/catch: одна ошибка не должна блокировать остальные
  let ok = 0;
  storms.forEach(s => {
    try { upsertEvent_(cal, s); ok++; }
    catch (e) { Logger.log('Ошибка события %s: %s', localStr_(s.start), e.message); }
  });
  try { addScaleDays_(cal, storms); }
  catch (e) { Logger.log('Ошибка суточных оценок: %s', e.message); }

  const maxKp = intervals.reduce((m, i) => Math.max(m, i.kp), 0);
  Logger.log('Календарь: «%s» | интервалов: %s | макс. Kp: %s | порог: %s | бурь найдено: %s, записано: %s',
    cal.getName(), intervals.length, maxKp, CONFIG.MIN_KP, storms.length, ok);
  if (!intervals.length) throw new Error('NOAA не вернул данных — проверьте журнал выше'); // чтобы сбой был виден в «Выполнениях»
}

/** Загружаем все источники и объединяем (при совпадении времени берём максимум Kp) */
function fetchAll_() {
  const byTime = {};
  CONFIG.SOURCES.forEach(url => {
    try {
      const rows = fetchKp_(url);
      Logger.log('%s → %s строк', url, rows.length);
      rows.forEach(r => {
        const k = r.start.getTime();
        if (!byTime[k] || r.kp > byTime[k].kp) byTime[k] = r;
      });
    } catch (e) {
      Logger.log('Ошибка источника %s: %s', url, e.message);
    }
  });
  return Object.keys(byTime).map(k => byTime[k]);
}

function fetchKp_(url) {
  const resp = UrlFetchApp.fetch(url, { muteHttpExceptions: true });
  if (resp.getResponseCode() !== 200) throw new Error('HTTP ' + resp.getResponseCode());
  const data = JSON.parse(resp.getContentText());
  const out = [];

  data.forEach(row => {
    let time, kp;
    if (Array.isArray(row)) {                 // формат [time_tag, kp, ...]
      if (row[0] === 'time_tag') return;      // строка заголовка
      time = row[0];
      kp = parseFloat(row[1]);
    } else {                                  // формат объектов
      time = row.time_tag;
      kp = parseFloat(row.kp !== undefined ? row.kp : row.Kp);
    }
    if (!time || isNaN(kp)) return;

    let iso = String(time).replace(' ', 'T');
    if (!/Z$|[+-]\d\d:?\d\d$/.test(iso)) iso += 'Z'; // NOAA отдаёт UTC
    const start = new Date(iso);
    if (isNaN(start.getTime())) return;
    out.push({ start: start, end: new Date(start.getTime() + 3 * 3600 * 1000), kp: kp });
  });
  return out;
}

/** Склеиваем подряд идущие 3-часовые интервалы выше порога */
function mergeStorms_(intervals, fromOverride) {
  let from = fromOverride || new Date();
  if (!fromOverride && CONFIG.INCLUDE_TODAY) {
    // начало текущих суток по Ростову (00:00 МСК), независимо от настроек проекта
    const ymd = Utilities.formatDate(from, CONFIG.TIMEZONE, 'yyyy-MM-dd');
    from = new Date(ymd + 'T00:00:00' + CONFIG.UTC_OFFSET);
  }

  const storms = [];
  let cur = null;

  intervals
    .filter(i => i.kp >= CONFIG.MIN_KP - 0.01 && i.end > from) // -0.01: GFZ отдаёт 4.667, а не 4.67
    .sort((a, b) => a.start - b.start)
    .forEach(i => {
      if (cur && i.start.getTime() <= cur.end.getTime()) {
        cur.end = i.end;
        cur.kpMax = Math.max(cur.kpMax, i.kp);
      } else {
        if (cur) storms.push(cur);
        cur = { start: i.start, end: i.end, kpMax: i.kp };
      }
    });
  if (cur) storms.push(cur);
  return storms;
}

/**
 * Дневные оценки NOAA (noaa-scales.json): ключи "-1" = вчера (наблюдалось),
 * "0" = сейчас, "1","2","3" = сегодня и следующие дни (прогноз).
 * Событие на весь день создаётся, только если точных Kp-интервалов на этот день нет.
 */
function addScaleDays_(cal, storms) {
  let data;
  try {
    const resp = UrlFetchApp.fetch(CONFIG.SCALES_URL, { muteHttpExceptions: true });
    if (resp.getResponseCode() !== 200) throw new Error('HTTP ' + resp.getResponseCode());
    data = JSON.parse(resp.getContentText());
  } catch (e) {
    Logger.log('Ошибка noaa-scales: %s', e.message);
    return;
  }

  const days = {}; // 'YYYY-MM-DD' -> максимальный G
  Object.keys(data).forEach(key => {
    if (key === '-1' && !CONFIG.INCLUDE_YESTERDAY) return;
    const d = data[key];
    if (!d || !d.G || d.G.Scale === null || d.G.Scale === undefined) return;
    const g = parseInt(d.G.Scale, 10);
    if (isNaN(g)) return;
    days[d.DateStamp] = Math.max(days[d.DateStamp] || 0, g);
  });

  Object.keys(days).forEach(date => {
    const g = days[date];
    const p = date.split('-').map(Number);
    const dayStartUtc = Date.UTC(p[0], p[1] - 1, p[2]);
    const dayEndUtc = dayStartUtc + 24 * 3600 * 1000;
    const dayStart = new Date(dayStartUtc);
    const dayEnd = new Date(dayEndUtc);

    const existing = cal.getEvents(dayStart, dayEnd)
      .filter(e => (e.getDescription() || '').indexOf(CONFIG.DAY_TAG) === 0);
    const covered = storms.some(s => s.start.getTime() < dayEndUtc && s.end.getTime() > dayStartUtc);

    if (g < CONFIG.MIN_G || covered) {          // есть точные интервалы → дневное не нужно
      existing.forEach(e => e.deleteEvent());
      return;
    }

    // Сутки NOAA считаются по UTC: 00:00–24:00 UTC = 03:00–03:00 по Ростову
    const L = LEVELS[Math.min(5, g)];
    const title = L.icon + ' Магнитная буря G' + g + ' ' + L.name + ' (оценка на сутки)';
    const desc = CONFIG.DAY_TAG + '\nУровень по шкале NOAA: G' + g +
      '\nОценка NOAA на сутки по UTC: ' + localStr_(dayStart) + ' – ' + localStr_(dayEnd) +
      ' (по Ростову). Точное время не указано.\nИсточник: NOAA SWPC';
    if (existing.length) {
      existing[0].setTime(dayStart, dayEnd);
      existing[0].setTitle(title);
      existing[0].setDescription(desc);
      existing[0].setColor(L.color);
    } else {
      cal.createEvent(title, dayStart, dayEnd, { description: desc }).setColor(L.color);
    }
  });
  Logger.log('Дни из noaa-scales: %s', JSON.stringify(days));
}

function upsertEvent_(cal, storm) {
  const g = kpToG_(storm.kpMax);
  const L = LEVELS[g];
  const title = L.icon + ' Магнитная буря G' + g + ' ' + L.name + ' (Kp ' + storm.kpMax.toFixed(1) + ')';
  const desc = CONFIG.TAG + '\nМаксимальный Kp: ' + storm.kpMax.toFixed(2) +
    '\nШкала NOAA: G' + g +
    '\nВремя (Ростов): ' + localStr_(storm.start) + ' – ' + localStr_(storm.end) +
    '\nИсточник: NOAA SWPC\nhttps://www.swpc.noaa.gov/products/planetary-k-index';

  const existing = cal.getEvents(storm.start, storm.end)
    .filter(e => (e.getDescription() || '').indexOf(CONFIG.TAG) === 0);

  if (existing.length) {
    const ev = existing[0];
    ev.setTime(storm.start, storm.end);
    ev.setTitle(title);
    ev.setDescription(desc);
    ev.setColor(L.color);
    for (let i = 1; i < existing.length; i++) existing[i].deleteEvent();
  } else {
    const ev = cal.createEvent(title, storm.start, storm.end, { description: desc });
    ev.setColor(L.color);
    if (storm.start > new Date()) ev.addPopupReminder(60); // напоминание только для будущих бурь
  }
}

let CAL_CACHE_ = null; // в пределах одного запуска календарь всегда один и тот же

/**
 * Рабочий календарь. Его ID сохраняется в свойствах скрипта, поэтому все вызовы
 * (main, backfill2026 и т.д.) попадают в ОДИН календарь. Раньше календарь искался
 * только по имени, а сразу после создания Google его по имени не находил —
 * и скрипт создавал второй календарь с тем же названием (отсюда дубли).
 */
function getCalendar_() {
  if (!CAL_CACHE_) CAL_CACHE_ = resolveCalendar_();
  return CAL_CACHE_;
}

function resolveCalendar_() {
  if (!CONFIG.CALENDAR_NAME) return CalendarApp.getDefaultCalendar();
  const props = PropertiesService.getScriptProperties();
  const savedId = props.getProperty('CALENDAR_ID');
  let cal = savedId ? CalendarApp.getCalendarById(savedId) : null;
  if (!cal) {
    const found = CalendarApp.getCalendarsByName(CONFIG.CALENDAR_NAME);
    cal = found.length ? found[0] : null;
    if (!cal) {
      cal = CalendarApp.createCalendar(CONFIG.CALENDAR_NAME);
      cal.setTimeZone(CONFIG.TIMEZONE);
    }
    props.setProperty('CALENDAR_ID', cal.getId());
  }
  // Календарь, созданный скриптом, может быть скрыт или не отмечен галочкой в списке слева —
  // события есть, но их не видно. Включаем отображение при каждом запуске.
  try { cal.setHidden(false); cal.setSelected(true); } catch (e) { Logger.log('Не удалось включить отображение: %s', e.message); }
  return cal;
}

/** Дата/время в часовом поясе Ростова: «05.10 15:00» */
function localStr_(date) {
  return Utilities.formatDate(date, CONFIG.TIMEZONE, 'dd.MM HH:mm');
}

/* ===================== ИСТОРИЯ: все бури 2026 года ===================== */

/**
 * Разовая загрузка прошедших бурь с 1 января 2026 по сегодня.
 * Источник: GFZ Potsdam (kp.gfz.de), бесплатно, лицензия CC BY 4.0.
 * Запустить вручную один раз. Повторный запуск безопасен — дубликатов не будет.
 * Порог и цвета берутся из CONFIG.MIN_KP и LEVELS.
 */
function backfill2026() {
  const start = new Date('2026-01-01T00:00:00Z');
  const end = new Date(Math.min(Date.now(), Date.UTC(2026, 11, 31, 23, 59, 59)));

  const intervals = fetchGfz_(start, end);
  const storms = mergeStorms_(intervals, start);
  const cal = getCalendar_();

  storms.forEach(s => {
    upsertEvent_(cal, s);
    Utilities.sleep(150); // небольшая пауза, чтобы не упереться в лимиты Календаря
  });
  Logger.log('GFZ: интервалов %s, бурь добавлено/обновлено: %s', intervals.length, storms.length);
}

function fetchGfz_(start, end) {
  const iso = d => Utilities.formatDate(d, 'UTC', "yyyy-MM-dd'T'HH:mm:ss'Z'");
  const url = 'https://kp.gfz.de/app/json/?start=' + iso(start) + '&end=' + iso(end) + '&index=Kp';
  const resp = UrlFetchApp.fetch(url, { muteHttpExceptions: true });
  if (resp.getResponseCode() !== 200) {
    throw new Error('GFZ: HTTP ' + resp.getResponseCode() + ' ' + resp.getContentText().slice(0, 200));
  }

  const data = JSON.parse(resp.getContentText());
  const times = data.datetime || data.time || [];
  if (!times.length) Logger.log('GFZ: пустой ответ, поля: %s', Object.keys(data).join(', '));
  const kps = data.Kp || [];
  const out = [];
  for (let i = 0; i < times.length; i++) {
    const kp = parseFloat(kps[i]);
    const st = new Date(times[i]);
    if (isNaN(kp) || isNaN(st.getTime())) continue;
    out.push({ start: st, end: new Date(st.getTime() + 3 * 3600 * 1000), kp: kp });
  }
  return out;
}

/* ===================== ОЧИСТКА ДУБЛЕЙ ===================== */

/**
 * Ищет дубли среди СОБСТВЕННЫХ событий скрипта (по метке в описании) за 2026 год:
 *  1) копии в основном календаре, если рабочий календарь — отдельный;
 *  2) одинаковые события (то же время и название) внутри рабочего календаря.
 * Ваши личные события не затрагиваются.
 */
function findDuplicates_() {
  const from = new Date('2026-01-01T00:00:00Z');
  const to = new Date('2027-01-01T00:00:00Z');
  const target = getCalendar_();
  const def = CalendarApp.getDefaultCalendar();
  const ours = e => {
    const d = e.getDescription() || '';
    return d.indexOf(CONFIG.TAG) === 0 || d.indexOf(CONFIG.DAY_TAG) === 0;
  };
  const list = [];

  if (def.getId() !== target.getId()) {
    def.getEvents(from, to).filter(ours).forEach(e => list.push({ where: 'основной календарь', e: e }));
  }
  const seen = {};
  target.getEvents(from, to).filter(ours).forEach(e => {
    const key = e.getStartTime().getTime() + '|' + e.getEndTime().getTime() + '|' + e.getTitle();
    if (seen[key]) list.push({ where: target.getName(), e: e });
    else seen[key] = true;
  });
  return list;
}

/** Шаг 1: только показать, что будет удалено (ничего не удаляет) */
function previewDuplicates() {
  const list = findDuplicates_();
  Logger.log('Будет удалено событий: %s', list.length);
  list.forEach(x => Logger.log('  [%s] %s | %s', x.where, localStr_(x.e.getStartTime()), x.e.getTitle()));
}

/** Шаг 2: удалить найденные дубли */
function removeDuplicates() {
  const list = findDuplicates_();
  list.forEach(x => { x.e.deleteEvent(); Utilities.sleep(100); });
  Logger.log('Удалено событий: %s', list.length);
}

/**
 * ПОЛНЫЙ СБРОС И ПЕРЕСБОРКА — запустите, если в календаре дубли или бардак.
 * 1) удаляет ВСЕ календари с именем CONFIG.CALENDAR_NAME (даже если их несколько);
 * 2) удаляет события скрипта (по метке) во всех ваших остальных календарях;
 * 3) заново грузит историю 2026 (backfill2026) и актуальные бури (main).
 * Ваши личные события в основном календаре не затрагиваются.
 */
function rebuildAll() {
  // 0) сначала убеждаемся, что NOAA отвечает — иначе ничего не удаляем
  if (!fetchAll_().length) throw new Error('NOAA не вернул данных — ничего не удалено, повторите позже');

  let cals = 0, evs = 0;
  const from = new Date('2026-01-01T00:00:00Z');
  const to = new Date('2027-01-01T00:00:00Z');
  const isOurs = e => {
    const d = e.getDescription() || '';
    return d.indexOf(CONFIG.TAG) === 0 || d.indexOf(CONFIG.DAY_TAG) === 0;
  };
  CalendarApp.getAllOwnedCalendars().forEach(c => {
    if (CONFIG.CALENDAR_NAME && c.getName() === CONFIG.CALENDAR_NAME) {
      c.deleteCalendar(); cals++; return;            // календарь скрипта удаляем целиком
    }
    c.getEvents(from, to).filter(isOurs).forEach(e => { e.deleteEvent(); evs++; }); // в остальных — только события скрипта
  });
  CAL_CACHE_ = null;
  PropertiesService.getScriptProperties().deleteProperty('CALENDAR_ID');
  Logger.log('Удалено календарей: %s | событий скрипта в основном календаре: %s', cals, evs);

  Utilities.sleep(3000); // даём Google время обработать удаление

  // 1) СНАЧАЛА актуальные и будущие бури — это главное
  main();
  // 2) потом история 2026; её сбой не должен ломать будущие события
  try { backfill2026(); }
  catch (e) { Logger.log('История 2026 не загружена: %s (актуальные бури уже добавлены)', e.message); }
  Logger.log('Пересборка завершена');
}

/**
 * Диагностика: запустите вручную и посмотрите журнал.
 * Покажет Kp на ближайшие 48 ч (время Ростова), найденные бури, состояние календаря,
 * события в нём и число триггеров. Ничего не создаёт и не удаляет.
 */
function diagnose() {
  const now = new Date();
  const intervals = fetchAll_().sort((a, b) => a.start - b.start);
  const horizon = new Date(now.getTime() + 48 * 3600 * 1000);

  Logger.log('Сейчас (Ростов): %s | часовой пояс проекта: %s', localStr_(now), Session.getScriptTimeZone());
  Logger.log('Kp на ближайшие 48 ч (время Ростова), порог %s:', CONFIG.MIN_KP);
  intervals.filter(i => i.end > now && i.start < horizon).forEach(i =>
    Logger.log('  %s – %s | Kp %s %s', localStr_(i.start), localStr_(i.end), i.kp,
      i.kp >= CONFIG.MIN_KP - 0.01 ? '← БУРЯ' : ''));
  Logger.log('Бурь выше порога: %s', mergeStorms_(intervals).length);

  const cal = getCalendar_();
  Logger.log('Календарь «%s» (id %s) | скрыт: %s | отмечен: %s',
    cal.getName(), cal.getId(), cal.isHidden(), cal.isSelected());
  const evs = cal.getEvents(now, new Date(now.getTime() + 72 * 3600 * 1000));
  Logger.log('Событий в календаре на 72 ч: %s', evs.length);
  evs.forEach(e => Logger.log('  %s | %s', localStr_(e.getStartTime()), e.getTitle()));

  const trig = ScriptApp.getProjectTriggers().filter(t => t.getHandlerFunction() === 'main');
  Logger.log('Триггеров для main(): %s %s', trig.length, trig.length ? '' : '← НЕТ ТРИГГЕРА, запустите createDailyTrigger()');
}

/** Запустить один раз. Бури меняются быстро, поэтому запуск каждые 3 часа */
function createDailyTrigger() {
  ScriptApp.getProjectTriggers()
    .filter(t => t.getHandlerFunction() === 'main')
    .forEach(t => ScriptApp.deleteTrigger(t));
  ScriptApp.newTrigger('main').timeBased().everyHours(3).create();
}
