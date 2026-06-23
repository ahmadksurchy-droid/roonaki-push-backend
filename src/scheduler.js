import cron from 'node-cron';
import { supabase } from './supabase.js';
import { buildPushMessage, sendPushMessages, getPushReceipts } from './push.js';
import { generateEventsForDevice } from './prayerGenerator.js';

const SCHEDULE_AHEAD_DAYS = Number(process.env.SCHEDULE_AHEAD_DAYS || 35);
const SEND_LOOKBACK_MINUTES = Number(process.env.SEND_LOOKBACK_MINUTES || 15);
let sending = false;
let filling = false;
let checkingReceipts = false;

const minuteIso = (value) => new Date(value).toISOString().slice(0, 16);
const buildDedupeKey = ({ scheduled_at, prayer_key, event_type }) =>
  `${minuteIso(scheduled_at)}:${prayer_key || 'unknown'}:${event_type || 'adhan'}`;

async function logDelivery(row) {
  try {
    await supabase.from('push_delivery_logs').insert(row);
  } catch (e) {
    console.log('[Roonaki Push] logDelivery failed:', e.message);
  }
}

async function upsertEvents(deviceId, events) {
  if (!events.length) return 0;
  const rows = events.map((e) => {
    const scheduledAt = e.whenIso;
    return {
      device_id: deviceId,
      event_key: e.eventKey,
      dedupe_key: buildDedupeKey({
        scheduled_at: scheduledAt,
        prayer_key: e.prayerKey,
        event_type: e.eventType,
      }),
      prayer_key: e.prayerKey || null,
      event_type: e.eventType || null,
      title: e.title,
      body: e.body,
      scheduled_at: scheduledAt,
      sound_key: e.soundKey || 'silent',
      data: e.data || {},
      status: 'pending',
      updated_at: new Date().toISOString(),
    };
  });

  // event_key is canonical, and dedupe_key gives a second safety layer for old rows.
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

async function markEvents(ids, patch) {
  if (!ids.length) return;
  const { error } = await supabase
    .from('notification_events')
    .update({ ...patch, updated_at: new Date().toISOString() })
    .in('id', ids);
  if (error) throw error;
}

export async function sendDueNotifications() {
  if (sending) return;
  sending = true;
  try {
    const nowIso = new Date(Date.now() + 90 * 1000).toISOString();
    const oldIso = new Date(Date.now() - SEND_LOOKBACK_MINUTES * 60 * 1000).toISOString();

    const { data: events, error } = await supabase
      .from('notification_events')
      .select('*, devices!inner(*)')
      .eq('status', 'pending')
      .lte('scheduled_at', nowIso)
      .gte('scheduled_at', oldIso)
      .order('scheduled_at', { ascending: true })
      .limit(200);

    if (error) throw error;
    if (!events?.length) return;

    // Safety dedupe: if old rows exist with different event_key but same device/prayer/type/minute,
    // send only one notification and mark the rest as skipped.
    const seen = new Set();
    const sendable = [];
    const skipped = [];
    for (const event of events) {
      const sig = `${event.device_id}:${event.dedupe_key || buildDedupeKey(event)}`;
      if (seen.has(sig)) skipped.push(event);
      else {
        seen.add(sig);
        sendable.push(event);
      }
    }

    if (skipped.length) {
      await markEvents(
        skipped.map((e) => e.id),
        {
          status: 'skipped_duplicate',
          last_error: 'Skipped duplicate with same device/prayer/type/minute',
        }
      );
    }

    if (!sendable.length) return;

    // Claim rows before sending. This avoids double-send if the scheduler overlaps/restarts.
    await markEvents(
      sendable.map((e) => e.id),
      { status: 'processing', processing_started_at: new Date().toISOString() }
    );

    const messages = sendable.map((event) => buildPushMessage(event, event.devices));
    const tickets = await sendPushMessages(messages);

    for (let i = 0; i < sendable.length; i++) {
      const event = sendable[i];
      const ticket = tickets[i];
      const ok = ticket?.status === 'ok';
      const ticketId = ticket?.id || null;
      const errorText = ok ? null : JSON.stringify(ticket || { error: 'No ticket returned' });

      await supabase
        .from('notification_events')
        .update({
          status: ok ? 'sent' : 'error',
          sent_at: ok ? new Date().toISOString() : null,
          attempts: (event.attempts || 0) + 1,
          expo_ticket_id: ticketId,
          last_error: errorText,
          updated_at: new Date().toISOString(),
        })
        .eq('id', event.id);

      await logDelivery({
        event_id: event.id,
        device_id: event.device_id,
        install_id: event.devices?.install_id || null,
        expo_push_token: event.devices?.expo_push_token || null,
        prayer_key: event.prayer_key,
        event_type: event.event_type,
        scheduled_at: event.scheduled_at,
        expo_ticket_id: ticketId,
        ticket_status: ticket?.status || 'missing',
        receipt_status: null,
        error: errorText,
        message: messages[i] || {},
      });

      if (!ok && ticket?.details?.error === 'DeviceNotRegistered') {
        await supabase
          .from('devices')
          .update({ enabled: false, updated_at: new Date().toISOString() })
          .eq('id', event.device_id);
      }
    }
  } catch (e) {
    console.log('[Roonaki Push] sendDueNotifications error:', e.message);
  } finally {
    sending = false;
  }
}

export async function checkPushReceipts() {
  if (checkingReceipts) return;
  checkingReceipts = true;
  try {
    const { data: logs, error } = await supabase
      .from('push_delivery_logs')
      .select('*')
      .not('expo_ticket_id', 'is', null)
      .is('receipt_status', null)
      .gte('created_at', new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString())
      .limit(100);

    if (error) throw error;
    if (!logs?.length) return;

    const receipts = await getPushReceipts(logs.map((l) => l.expo_ticket_id));

    for (const log of logs) {
      const receipt = receipts[log.expo_ticket_id];
      if (!receipt) continue;
      const errorText = receipt.status === 'ok' ? null : JSON.stringify(receipt);

      await supabase
        .from('push_delivery_logs')
        .update({ receipt_status: receipt.status, error: errorText })
        .eq('id', log.id);

      if (receipt?.details?.error === 'DeviceNotRegistered') {
        await supabase
          .from('devices')
          .update({ enabled: false, updated_at: new Date().toISOString() })
          .eq('id', log.device_id);
      }
    }
  } catch (e) {
    console.log('[Roonaki Push] checkPushReceipts error:', e.message);
  } finally {
    checkingReceipts = false;
  }
}

export function startSchedulers() {
  // User-requested plan: every minute check due prayer notifications to ensure exact timing.
  cron.schedule('* * * * *', sendDueNotifications);

  // Every 6 hours: generate/replenish future events for long-term delivery.
  cron.schedule('12 */6 * * *', ensureFutureEventsForAllDevices);

  // Every 15 minutes: check Expo receipts and log delivery failures.
  cron.schedule('7,22,37,52 * * * *', checkPushReceipts);

  // Run once on boot too.
  setTimeout(sendDueNotifications, 5000);
  setTimeout(ensureFutureEventsForAllDevices, 15000);
  setTimeout(checkPushReceipts, 60000);
}