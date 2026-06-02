import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import { supabase } from './supabase.js';
import { startSchedulers, ensureFutureEventsForDevice } from './scheduler.js';

const app = express();
app.use(cors());
app.use(express.json({ limit: '2mb' }));

const PORT = process.env.PORT || 3000;

const cleanSoundKey = (raw) => {
  const s = String(raw || 'adhan').trim().toLowerCase();
  if (s === 'device' || s === 'default') return 'adhan';
  if (s === 'none' || s === 'mute') return 'silent';
  return s.replace(/\.(wav|mp3|caf|aiff|m4a)$/i, '') || 'adhan';
};

const toNumOrNull = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

const normalizeEventType = (raw) => {
  const s = String(raw || 'adhan').trim().toLowerCase();
  return s === 'at' ? 'adhan' : s;
};

const canonicalEventKey = ({ when, prayerKey, eventType, data = {} }) => {
  const dateLabel = data.baseDate || when.toISOString().slice(0, 10);
  return `${dateLabel}:${prayerKey || 'unknown'}:${eventType || 'adhan'}`;
};

const minuteIso = (value) => new Date(value).toISOString().slice(0, 16);
const buildDedupeKey = ({ scheduled_at, prayerKey, eventType }) =>
  `${minuteIso(scheduled_at)}:${prayerKey || 'unknown'}:${eventType || 'adhan'}`;

const normalizeIncomingEvent = (e) => {
  const when = new Date(e.whenIso || e.date);
  if (!Number.isFinite(when.getTime())) return null;
  if (when.getTime() <= Date.now() + 10000) return null;

  const soundKey = cleanSoundKey(e.soundKey || e?.data?.soundKey || 'silent');
  const prayerKey = e.prayerKey || e?.data?.prayer || e?.data?.key || null;
  const eventType = normalizeEventType(e.eventType || e?.data?.when || 'adhan');
  const eventKey = canonicalEventKey({ when, prayerKey, eventType, data: e.data || {} });

  return {
    event_key: eventKey,
    dedupe_key: buildDedupeKey({ scheduled_at: when.toISOString(), prayerKey, eventType }),
    prayer_key: prayerKey,
    event_type: eventType,
    title: String(e.title || ''),
    body: String(e.body || ''),
    scheduled_at: when.toISOString(),
    sound_key: soundKey,
    data: { ...(e.data || {}), soundKey },
    status: 'pending',
    updated_at: new Date().toISOString(),
  };
};

app.get('/', (_req, res) => {
  res.json({ ok: true, service: 'Roonaki Push Backend' });
});

app.get('/health', (_req, res) => {
  res.json({ ok: true, time: new Date().toISOString() });
});

app.get('/api/admin/logs', async (req, res) => {
  try {
    const adminSecret = process.env.ADMIN_SECRET || '';
    const provided = req.headers['x-admin-secret'] || req.query.secret || '';
    if (!adminSecret || provided !== adminSecret) {
      return res.status(401).json({ ok: false, error: 'unauthorized' });
    }

    const limit = Math.min(Number(req.query.limit || 50), 200);
    const { data, error } = await supabase
      .from('push_delivery_logs')
      .select('created_at, install_id, prayer_key, event_type, scheduled_at, ticket_status, receipt_status, error')
      .order('created_at', { ascending: false })
      .limit(limit);

    if (error) throw error;
    res.json({ ok: true, logs: data || [] });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.get('/api/admin/events', async (req, res) => {
  try {
    const adminSecret = process.env.ADMIN_SECRET || '';
    const provided = req.headers['x-admin-secret'] || req.query.secret || '';
    if (!adminSecret || provided !== adminSecret) {
      return res.status(401).json({ ok: false, error: 'unauthorized' });
    }

    const limit = Math.min(Number(req.query.limit || 100), 300);
    const { data, error } = await supabase
      .from('notification_events')
      .select('scheduled_at, prayer_key, event_type, sound_key, status, attempts, sent_at, last_error')
      .order('scheduled_at', { ascending: false })
      .limit(limit);

    if (error) throw error;
    res.json({ ok: true, events: data || [] });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.post('/api/devices/register', async (req, res) => {
  try {
    const { installId, expoPushToken, platform, timezone, settings = {}, events = [] } = req.body || {};
    if (!installId || !expoPushToken) {
      return res.status(400).json({ ok: false, error: 'installId and expoPushToken are required' });
    }

    const coords = settings.coords || settings.location || {};
    const lat = toNumOrNull(settings.latitude ?? coords.latitude);
    const lon = toNumOrNull(settings.longitude ?? coords.longitude);
    const selectedMuezzin = cleanSoundKey(settings.muezzinSelectedId || settings.selectedMuezzinId || 'adhan');

    const devicePayload = {
      install_id: String(installId),
      expo_push_token: String(expoPushToken),
      platform: platform || null,
      timezone: timezone || settings.timezone || 'Asia/Baghdad',
      latitude: lat,
      longitude: lon,
      calculation_method: settings.calculationMethod || null,
      selected_city_id: settings.selectedCityId || null,
      selected_muezzin_id: selectedMuezzin,
      notification_prefs: settings.notificationPrefs || {},
      volume_settings: settings.volumeSettings || {},
      time_adjustments: settings.effectiveTimeAdjustments || settings.timeAdjustments || {},
      raw_settings: settings || {},
      enabled: true,
      last_seen_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };

    const { data: device, error: upsertError } = await supabase
      .from('devices')
      .upsert(devicePayload, { onConflict: 'install_id' })
      .select('*')
      .single();

    if (upsertError) throw upsertError;

    // Prevent duplicates from old app/backend versions:
    // every fresh register replaces all future pending events for this device.
    // Sent/history rows stay untouched.
    await supabase
      .from('notification_events')
      .delete()
      .eq('device_id', device.id)
      .eq('status', 'pending')
      .gte('scheduled_at', new Date(Date.now() - 2 * 60 * 1000).toISOString());

    const pushStartsAfterDaysRaw = Number(
      settings.pushStartsAfterDays ?? settings.localNotificationDays ?? 0
    );
    const pushStartsAfterDays = Number.isFinite(pushStartsAfterDaysRaw)
      ? Math.max(0, Math.min(30, pushStartsAfterDaysRaw))
      : 0;
    const minPushTime = Date.now() + pushStartsAfterDays * 24 * 60 * 60 * 1000 - 2 * 60 * 1000;

    const normalized = (Array.isArray(events) ? events : [])
      .map(normalizeIncomingEvent)
      .filter((e) => e && new Date(e.scheduled_at).getTime() >= minPushTime)
      .map((e) => ({ ...e, device_id: device.id }));

    let insertedEvents = 0;
    if (normalized.length) {
      const { error: eventError } = await supabase
        .from('notification_events')
        .upsert(normalized, { onConflict: 'device_id,event_key' });
      if (eventError) throw eventError;
      insertedEvents = normalized.length;
    }

    // Also let the backend generate future events from the saved device profile.
    // This is what keeps notifications long-term even when the app is not opened.
    let generatedEvents = 0;
    try {
      generatedEvents = await ensureFutureEventsForDevice(device);
    } catch (e) {
      console.log('[Roonaki Push] generation warning:', e.message);
    }

    res.json({ ok: true, deviceId: device.id, receivedEvents: insertedEvents, generatedEvents });
  } catch (e) {
    console.log('[Roonaki Push] register error:', e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.post('/api/devices/disable', async (req, res) => {
  try {
    const { installId } = req.body || {};
    if (!installId) return res.status(400).json({ ok: false, error: 'installId is required' });
    const { error } = await supabase
      .from('devices')
      .update({ enabled: false, updated_at: new Date().toISOString() })
      .eq('install_id', String(installId));
    if (error) throw error;
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.listen(PORT, () => {
  console.log(`[Roonaki Push] running on port ${PORT}`);
  startSchedulers();
});
