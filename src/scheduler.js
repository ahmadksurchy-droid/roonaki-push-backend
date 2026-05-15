import cron from 'node-cron';
import { supabase } from './supabase.js';
import { buildPushMessage, sendPushMessages } from './push.js';
import { generateEventsForDevice } from './prayerGenerator.js';

const SCHEDULE_AHEAD_DAYS = Number(process.env.SCHEDULE_AHEAD_DAYS || 35);
let sending = false;
let filling = false;

async function upsertEvents(deviceId, events) {
  if (!events.length) return 0;
  const rows = events.map((e) => ({
    device_id: deviceId,
    event_key: e.eventKey,
    prayer_key: e.prayerKey || null,
    event_type: e.eventType || null,
    title: e.title,
    body: e.body,
    scheduled_at: e.whenIso,
    sound_key: e.soundKey || 'silent',
    data: e.data || {},
    status: 'pending',
  }));

  const { error } = await supabase
    .from('notification_events')
    .upsert(rows, { onConflict: 'device_id,event_key' });

  if (error) throw error;
  return rows.length;
}

export async function ensureFutureEventsForDevice(device) {
  const events = generateEventsForDevice(device, SCHEDULE_AHEAD_DAYS);
  return upsertEvents(device.id, events);
}

export async function ensureFutureEventsForAllDevices() {
  if (filling) return;
  filling = true;
  try {
    const { data: devices, error } = await supabase
      .from('devices')
      .select('*')
      .eq('enabled', true)
      .not('latitude', 'is', null)
      .not('longitude', 'is', null);

    if (error) throw error;

    for (const device of devices || []) {
      try {
        await ensureFutureEventsForDevice(device);
      } catch (e) {
        console.log('[Roonaki Push] future generation failed:', device.install_id, e.message);
      }
    }
  } finally {
    filling = false;
  }
}

export async function sendDueNotifications() {
  if (sending) return;
  sending = true;
  try {
    const nowIso = new Date(Date.now() + 30000).toISOString();
    const oldIso = new Date(Date.now() - 10 * 60 * 1000).toISOString();

    const { data: events, error } = await supabase
      .from('notification_events')
      .select('*, devices!inner(*)')
      .eq('status', 'pending')
      .lte('scheduled_at', nowIso)
      .gte('scheduled_at', oldIso)
      .limit(100);

    if (error) throw error;
    if (!events?.length) return;

    // Safety dedupe: if old rows exist with different event_key but same device/prayer/type/minute,
    // send only one notification and mark the rest as skipped.
    const seen = new Set();
    const sendable = [];
    const skipped = [];
    for (const event of events) {
      const minuteKey = new Date(event.scheduled_at).toISOString().slice(0, 16);
      const sig = `${event.device_id}:${minuteKey}:${event.prayer_key || ''}:${event.event_type || ''}`;
      if (seen.has(sig)) skipped.push(event);
      else {
        seen.add(sig);
        sendable.push(event);
      }
    }

    if (skipped.length) {
      await supabase
        .from('notification_events')
        .update({
          status: 'skipped_duplicate',
          last_error: 'Skipped duplicate event with same device/prayer/type/minute',
        })
        .in('id', skipped.map((e) => e.id));
    }

    if (!sendable.length) return;

    const messages = sendable.map((event) => buildPushMessage(event, event.devices));
    const tickets = await sendPushMessages(messages);

    for (let i = 0; i < sendable.length; i++) {
      const event = sendable[i];
      const ticket = tickets[i];
      const ok = ticket?.status === 'ok';

      await supabase
        .from('notification_events')
        .update({
          status: ok ? 'sent' : 'error',
          sent_at: ok ? new Date().toISOString() : null,
          attempts: (event.attempts || 0) + 1,
          last_error: ok ? null : JSON.stringify(ticket || { error: 'No ticket returned' }),
        })
        .eq('id', event.id);

      if (!ok && ticket?.details?.error === 'DeviceNotRegistered') {
        await supabase
          .from('devices')
          .update({ enabled: false })
          .eq('id', event.device_id);
      }
    }
  } catch (e) {
    console.log('[Roonaki Push] sendDueNotifications error:', e.message);
  } finally {
    sending = false;
  }
}

export function startSchedulers() {
  // Every minute: send due push notifications.
  cron.schedule('* * * * *', sendDueNotifications);

  // Every 6 hours: generate/replenish future events for long-term delivery.
  cron.schedule('12 */6 * * *', ensureFutureEventsForAllDevices);

  // Run once on boot too.
  setTimeout(sendDueNotifications, 5000);
  setTimeout(ensureFutureEventsForAllDevices, 15000);
}
