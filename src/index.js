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

const normalizeIncomingEvent = (e) => {
  const when = new Date(e.whenIso || e.date);
  if (!Number.isFinite(when.getTime())) return null;
  if (when.getTime() <= Date.now() + 10000) return null;

  const soundKey = cleanSoundKey(e.soundKey || e?.data?.soundKey || 'silent');
  const eventKey = String(e.eventKey || `${e.title || 'event'}:${when.toISOString()}:${e.prayerKey || ''}:${e.eventType || ''}`);

  return {
    event_key: eventKey,
    prayer_key: e.prayerKey || e?.data?.prayer || null,
    event_type: e.eventType || e?.data?.when || null,
    title: String(e.title || ''),
    body: String(e.body || ''),
    scheduled_at: when.toISOString(),
    sound_key: soundKey,
    data: { ...(e.data || {}), soundKey },
    status: 'pending',
  };
};

app.get('/', (_req, res) => {
  res.json({ ok: true, service: 'Roonaki Push Backend' });
});

app.get('/health', (_req, res) => {
  res.json({ ok: true, time: new Date().toISOString() });
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

    const normalized = (Array.isArray(events) ? events : [])
      .map(normalizeIncomingEvent)
      .filter(Boolean)
      .map((e) => ({ ...e, device_id: device.id }));

    let insertedEvents = 0;
    if (normalized.length) {
      const { error: eventError } = await supabase
        .from('notification_events')
        .upsert(normalized, { onConflict: 'device_id,event_key', ignoreDuplicates: true });
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
