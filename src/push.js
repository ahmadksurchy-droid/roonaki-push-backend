import { Expo } from 'expo-server-sdk';

// Must match bangdan/notifications.js. New ID forces Android to create a fresh loud channel.
export const ANDROID_CHANNEL_ID_BASE = 'bangdan_prayer_v7_loud';
const expo = new Expo({ useFcmV1: true });

export function normalizeSoundKey(raw) {
  const s = String(raw || 'silent').trim().toLowerCase();
  if (s === 'none' || s === 'mute') return 'silent';
  return s.replace(/\.(wav|mp3|caf|aiff|m4a)$/i, '') || 'silent';
}

export function androidChannelId(soundKey) {
  const k = normalizeSoundKey(soundKey);
  return k === 'default' ? ANDROID_CHANNEL_ID_BASE : `${ANDROID_CHANNEL_ID_BASE}__${k}`;
}

export function buildPushMessage(event, device) {
  const soundKey = normalizeSoundKey(event.sound_key || event.soundKey || 'silent');
  const isSilent = soundKey === 'silent';
  const message = {
    to: device.expo_push_token,
    title: event.title,
    body: event.body,
    data: {
      ...(event.data || {}),
      bangdanTag: 'bangdan_prayer',
      prayer: event.prayer_key,
      eventType: event.event_type,
      eventKey: event.event_key,
      scheduledAt: event.scheduled_at,
    },
    priority: 'high',
    channelId: androidChannelId(soundKey),
  };

  if (!isSilent) {
    message.sound = `${soundKey}.wav`;
  }

  return message;
}

export async function sendPushMessages(messages) {
  const valid = messages.filter((m) => Expo.isExpoPushToken(m.to));
  const chunks = expo.chunkPushNotifications(valid);
  const tickets = [];

  for (const chunk of chunks) {
    const result = await expo.sendPushNotificationsAsync(chunk);
    tickets.push(...result);
  }

  return tickets;
}

export async function getPushReceipts(ticketIds = []) {
  const ids = ticketIds.filter(Boolean);
  if (!ids.length) return {};

  const receipts = {};
  const chunks = expo.chunkPushNotificationReceiptIds(ids);
  for (const chunk of chunks) {
    const result = await expo.getPushNotificationReceiptsAsync(chunk);
    Object.assign(receipts, result || {});
  }
  return receipts;
}
