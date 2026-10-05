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

  storms.forEach(s => upsertEvent_(cal, s));
  addScaleDays_(cal, storms);

  const maxKp = intervals.reduce((m, i) => Math.max(m, i.kp), 0);
  Logger.log('Интервалов в данных: %s | макс. Kp в данных: %s | порог: %s | бурь добавлено/обновлено: %s',
    intervals.length, maxKp, CONFIG.MIN_KP, storms.length);
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

function getCalendar_() {
  if (!CONFIG.CALENDAR_NAME) return CalendarApp.getDefaultCalendar();
  const found = CalendarApp.getCalendarsByName(CONFIG.CALENDAR_NAME);
  if (found.length) return found[0];
  const cal = CalendarApp.createCalendar(CONFIG.CALENDAR_NAME);
  cal.setTimeZone(CONFIG.TIMEZONE);
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
  if (resp.getResponseCode() !== 200) throw new Error('GFZ: HTTP ' + resp.getResponseCode());

  const data = JSON.parse(resp.getContentText());
  const times = data.datetime || data.time || [];
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

/** Запустить один раз. Бури меняются быстро, поэтому запуск каждые 3 часа */
function createDailyTrigger() {
  ScriptApp.getProjectTriggers()
    .filter(t => t.getHandlerFunction() === 'main')
    .forEach(t => ScriptApp.deleteTrigger(t));
  ScriptApp.newTrigger('main').timeBased().everyHours(3).create();
}
