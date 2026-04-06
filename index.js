const express = require('express');
const TelegramBot = require('node-telegram-bot-api');
const cors = require('cors'); // Добавляем импорт cors
require('dotenv').config();

const VK_API_VERSION = '5.199';

/** Telegram Bot API и VK messages.send: одно текстовое сообщение не длиннее этого (UTF-16 code units в JS). */
const MAX_MESSAGE_CHARS = 4096;

function chunkString(text, maxLen) {
  const chunks = [];
  for (let i = 0; i < text.length; i += maxLen) {
    chunks.push(text.slice(i, i + maxLen));
  }
  return chunks;
}

function getVkEnv() {
  return {
    accessToken: process.env.VK_ACCESS_TOKEN?.trim(),
    defaultPeerId: process.env.VK_PEER_ID?.trim(),
  };
}

/**
 * Отправка сообщения от имени сообщества VK (messages.send).
 * Нужен ключ доступа сообщества (не пользовательский токен) с правом «Сообщения сообщества».
 * Получатель должен написать сообществу первым или разрешить ЛС от сообщества.
 * @see https://dev.vk.com/ru/method/messages.send
 */
async function sendVkMessageOnce(text, peerId, accessToken) {
  const body = new URLSearchParams({
    peer_id: String(peerId),
    message: text,
    random_id: String(Math.floor(Math.random() * 2147483647)),
    access_token: accessToken,
    v: VK_API_VERSION,
  });

  const res = await fetch('https://api.vk.com/method/messages.send', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });

  const data = await res.json();
  if (data.error) {
    const err = data.error;
    throw new Error(`VK API: [${err.error_code}] ${err.error_msg}`);
  }
  return data.response;
}

async function sendVkMessage(text, peerIdOverride) {
  const { accessToken, defaultPeerId } = getVkEnv();
  const peerRaw =
    peerIdOverride != null && String(peerIdOverride).trim() !== ''
      ? String(peerIdOverride).trim()
      : defaultPeerId;

  if (!accessToken || !peerRaw) {
    return { skipped: true };
  }

  const peerId = Number(peerRaw);
  if (!Number.isFinite(peerId) || !Number.isInteger(peerId)) {
    throw new Error(
      `VK: VK_PEER_ID должен быть целым числом (peer_id пользователя или беседы), получено: ${JSON.stringify(peerRaw)}`,
    );
  }

  let lastMessageId;
  for (const chunk of chunkString(text, MAX_MESSAGE_CHARS)) {
    lastMessageId = await sendVkMessageOnce(chunk, peerId, accessToken);
  }
  return { skipped: false, messageId: lastMessageId };
}

// Инициализация бота с токеном
const token = process.env.TELEGRAM_BOT_TOKEN;
const chatId = process.env.CHAT_ID;
const bot = new TelegramBot(token, { polling: true });

// Создание Express приложения
const app = express();
const port = process.env.PORT || 5656;

// Подключаем CORS middleware
app.use(cors({
  origin: '*', // Разрешаем запросы с любых доменов (для разработки)
  // Для продакшена лучше указать конкретный домен:
}));

// Длинные логи/тексты в JSON; разбиение на части по MAX_MESSAGE_CHARS — в deliverNotification.
app.use(express.json({ limit: '1mb' }));

app.get('/health', (req, res) => {
  res.status(200).type('text/plain').send('ok');
});

async function deliverNotification(text, targetChatId, vkPeerOverride) {
  if (!targetChatId) {
    throw new Error(
      'CHAT_ID не указан ни в .env, ни в запросе. Используйте параметр chat_id или добавьте CHAT_ID в .env',
    );
  }

  const chunks = chunkString(text, MAX_MESSAGE_CHARS);

  const [telegramResult, vkResult] = await Promise.allSettled([
    (async () => {
      for (const chunk of chunks) {
        await bot.sendMessage(targetChatId, chunk);
      }
    })(),
    sendVkMessage(text, vkPeerOverride || undefined),
  ]);

  const channels = buildChannels(telegramResult, vkResult);
  const telegramOk = channels.find((c) => c.service === 'telegram')?.ok;
  const vkCh = channels.find((c) => c.service === 'vk');
  const success =
    telegramOk && (vkCh.skipped || (vkCh.ok && !vkCh.skipped));

  let message;
  if (!telegramOk) {
    message = 'Ошибка отправки в Telegram (см. channels)';
  } else if (vkCh.skipped) {
    message = 'Сообщение отправлено в Telegram (VK не настроен в .env — пропуск)';
  } else if (!vkCh.ok) {
    message = 'Отправлено в Telegram, ошибка VK (см. channels)';
  } else {
    message = 'Сообщение отправлено в Telegram и VK';
  }

  return { success, message, channels };
}

function buildChannels(telegramResult, vkResult) {
  const channels = [];

  if (telegramResult.status === 'fulfilled') {
    channels.push({ service: 'telegram', ok: true });
  } else {
    const reason = telegramResult.reason;
    channels.push({
      service: 'telegram',
      ok: false,
      error: reason instanceof Error ? reason.message : String(reason),
    });
  }

  if (vkResult.status === 'fulfilled') {
    const r = vkResult.value;
    if (r.skipped) {
      channels.push({ service: 'vk', ok: true, skipped: true });
    } else {
      channels.push({
        service: 'vk',
        ok: true,
        message_id: r.messageId,
      });
    }
  } else {
    const reason = vkResult.reason;
    channels.push({
      service: 'vk',
      ok: false,
      error: reason instanceof Error ? reason.message : String(reason),
    });
  }

  return channels;
}

function firstQueryParam(val) {
  if (val == null) return undefined;
  if (Array.isArray(val)) return val[0] != null ? String(val[0]) : undefined;
  return String(val);
}

async function respondNotify(res, text, targetChatId, vkPeerOverride) {
  try {
    const { success, message, channels } = await deliverNotification(
      text,
      targetChatId,
      vkPeerOverride,
    );

    if (!success) {
      console.error('Ошибка при отправке:', { channels });
      return res.status(500).json({ success: false, message, channels });
    }

    return res.json({ success: true, message, channels });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return res.status(400).json({ success: false, message: msg });
  }
}

/** Простые уведомления: GET ?text=...&chat_id=...&vk_peer_id=... (удобно из браузера; длинный текст — POST). */
async function handleNotifyGet(req, res) {
  const text = firstQueryParam(req.query.text);
  if (!text) {
    return res.status(400).json({
      success: false,
      message: 'Параметр text не указан',
    });
  }

  const targetChatId = firstQueryParam(req.query.chat_id) ?? chatId;
  const vkPeerOverride = firstQueryParam(req.query.vk_peer_id);

  return respondNotify(res, text, targetChatId, vkPeerOverride);
}

async function handleNotifyPost(req, res) {
  const text = req.body?.text;
  if (!text || typeof text !== 'string') {
    return res.status(400).json({
      success: false,
      message: 'Ожидается JSON с полем text (строка)',
    });
  }

  const targetChatId = req.body?.chat_id ?? chatId;
  const vkPeerOverride = req.body?.vk_peer_id;

  return respondNotify(res, text, targetChatId, vkPeerOverride);
}

/** GET — короткие сообщения; POST — JSON (в т.ч. длинные логи). */
app.get('/', handleNotifyGet);
app.get('/notify', handleNotifyGet);
app.get('/notify/', handleNotifyGet);
app.post('/', handleNotifyPost);
app.post('/notify', handleNotifyPost);
app.post('/notify/', handleNotifyPost);

// Запуск сервера
app.listen(port, () => {
  const { accessToken, defaultPeerId } = getVkEnv();
  if (accessToken && defaultPeerId) {
    console.log('VK: отправка сообщений включена (peer_id=%s)', defaultPeerId);
  } else if (accessToken || defaultPeerId) {
    console.warn(
      'VK: задайте оба значения VK_ACCESS_TOKEN и VK_PEER_ID — иначе VK отключён',
    );
  } else {
    console.log('VK: не настроено (только Telegram)');
  }
  console.log(`Сервер запущен на порту ${port}`);
});

// Обработчик для команды /start
bot.onText(/\/start/, (msg) => {
  const chatId = msg.chat.id;
  bot.sendMessage(chatId, 'Привет! Я бот для отправки уведомлений. Мой ID чата: ' + chatId);
});

console.log('Бот запущен...');