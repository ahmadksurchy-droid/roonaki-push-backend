import adhan from 'adhan';
import moment from 'moment-timezone';

const PRAYER_NAME_KU = {
  Fajr: 'بەیانی',
  Sunrise: 'ڕۆژهەلات',
  Dhuhr: 'نیوەڕۆ',
  Asr: 'عەسر',
  Maghrib: 'مەغریب',
  Isha: 'عیشا',
};

const NOTIFY_PRAYERS = ['Fajr', 'Dhuhr', 'Asr', 'Maghrib', 'Isha'];

const methodMap = {
  MuslimWorldLeague: adhan.CalculationMethod.MuslimWorldLeague,
  Egyptian: adhan.CalculationMethod.Egyptian,
  Karachi: adhan.CalculationMethod.Karachi,
  UmmAlQura: adhan.CalculationMethod.UmmAlQura,
  Dubai: adhan.CalculationMethod.Dubai,
  Qatar: adhan.CalculationMethod.Qatar,
  Kuwait: adhan.CalculationMethod.Kuwait,
  MoonsightingCommittee: adhan.CalculationMethod.MoonsightingCommittee,
  NorthAmerica: adhan.CalculationMethod.NorthAmerica,
  Singapore: adhan.CalculationMethod.Singapore,
  Turkey: adhan.CalculationMethod.Turkey,
  Tehran: adhan.CalculationMethod.Tehran,
};

const toBool = (v) => v === true || v === 'true' || v === 1;
const toNumber = (v, fallback = 0) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
};

const buildPrayerBodyKu = (prayerKey) => {
  const name = PRAYER_NAME_KU[prayerKey] || prayerKey;
  const suffixYE = new Set(['Fajr', 'Dhuhr', 'Isha']);
  const suffixA = new Set(['Sunrise', 'Asr', 'Maghrib']);
  if (suffixYE.has(prayerKey)) return `ئـێـسـتـا کـاتـی بـانـگـی ${name}یە`;
  if (suffixA.has(prayerKey)) return `ئـێـسـتـا کـاتـی بـانـگـی ${name}ە`;
  return `ئـێـسـتـا کـاتـی بـانـگـی ${name}`;
};

const paramsForMethod = (method) => {
  const factory = methodMap[method] || adhan.CalculationMethod.MuslimWorldLeague;
  const params = factory();
  params.madhab = adhan.Madhab.Shafi;
  return params;
};

const getPrayerDate = (prayerTimes, key) => {
  switch (key) {
    case 'Fajr':
      return prayerTimes.fajr;
    case 'Sunrise':
      return prayerTimes.sunrise;
    case 'Dhuhr':
      return prayerTimes.dhuhr;
    case 'Asr':
      return prayerTimes.asr;
    case 'Maghrib':
      return prayerTimes.maghrib;
    case 'Isha':
      return prayerTimes.isha;
    default:
      return null;
  }
};

const addMinutes = (date, minutes) => new Date(date.getTime() + minutes * 60000);

export function generateEventsForDevice(device, daysAhead = 35) {
  const lat = toNumber(device.latitude, NaN);
  const lon = toNumber(device.longitude, NaN);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return [];

  const timezone = device.timezone || 'Asia/Baghdad';
  const coordinates = new adhan.Coordinates(lat, lon);
  const params = paramsForMethod(device.calculation_method);
  const volumeSettings = device.volume_settings || {};
  const prefs = device.notification_prefs || {};
  const adjustments = device.time_adjustments || {};
  const soundKey = device.selected_muezzin_id && device.selected_muezzin_id !== 'device'
    ? device.selected_muezzin_id
    : 'adhan';

  const start = moment.tz(timezone).startOf('day');
  const events = [];

  for (let i = 0; i < daysAhead; i++) {
    const day = start.clone().add(i, 'days');
    const jsDate = new Date(day.year(), day.month(), day.date(), 12, 0, 0);
    const prayerTimes = new adhan.PrayerTimes(coordinates, jsDate, params);

    for (const prayerKey of NOTIFY_PRAYERS) {
      const base = getPrayerDate(prayerTimes, prayerKey);
      if (!base) continue;
      const adjusted = addMinutes(base, toNumber(adjustments[prayerKey], 0));
      const dateLabel = day.format('YYYY-MM-DD');
      const prayerName = PRAYER_NAME_KU[prayerKey] || prayerKey;

      if (toBool(volumeSettings[prayerKey])) {
        events.push({
          eventKey: `${dateLabel}:${prayerKey}:adhan`,
          prayerKey,
          eventType: 'adhan',
          title: 'ڕوونــاکــی',
          body: buildPrayerBodyKu(prayerKey),
          whenIso: adjusted.toISOString(),
          soundKey,
          data: { type: 'prayer', prayer: prayerKey, key: prayerKey, when: 'adhan', soundKey },
        });
      }

      if (toBool(prefs.pre5)) {
        events.push({
          eventKey: `${dateLabel}:${prayerKey}:pre5`,
          prayerKey,
          eventType: 'pre5',
          title: 'ڕوونــاکــی',
          body: `٥ خـولـەک مـاوە بـۆ بـانـگـی ${prayerName}`,
          whenIso: addMinutes(adjusted, -5).toISOString(),
          soundKey: 'silent',
          data: { type: 'prayer', prayer: prayerKey, key: prayerKey, when: 'pre5', soundKey: 'silent' },
        });
      }

      if (toBool(prefs.post20)) {
        events.push({
          eventKey: `${dateLabel}:${prayerKey}:post20`,
          prayerKey,
          eventType: 'post20',
          title: 'ڕوونــاکــی',
          body: `٢٠ خـولـەک تـێـپـەڕیـوە لـە بـانـگـی ${prayerName}`,
          whenIso: addMinutes(adjusted, 20).toISOString(),
          soundKey: 'silent',
          data: { type: 'prayer', prayer: prayerKey, key: prayerKey, when: 'post20', soundKey: 'silent' },
        });
      }
    }
  }

  const now = Date.now() + 30000;
  return events.filter((e) => new Date(e.whenIso).getTime() > now);
}
