const express = require('express');
const TelegramBot = require('node-telegram-bot-api');
const cors = require('cors'); // Добавляем импорт cors
const multer = require('multer');
const { URL } = require('url');
require('dotenv').config();

const VK_API_VERSION = '5.199';

/** Telegram Bot API и VK messages.send: одно текстовое сообщение не длиннее этого (UTF-16 code units в JS). */
const MAX_MESSAGE_CHARS = 4096;
/** Лимит размера файла (Telegram Bot API — до 50 MB для документов). */
const MAX_FILE_BYTES = Number(process.env.MAX_FILE_BYTES) || 50 * 1024 * 1024;
const TELEGRAM_CAPTION_MAX = 1024;

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_FILE_BYTES },
});

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

async function vkMethod(method, params, accessToken) {
  const body = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value != null && value !== '') {
      body.set(key, String(value));
    }
  }
  body.set('access_token', accessToken);
  body.set('v', VK_API_VERSION);

  const res = await fetch(`https://api.vk.com/method/${method}`, {
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

function resolveVkPeer(peerIdOverride) {
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

  return { skipped: false, peerId, accessToken };
}

/**
 * Отправка сообщения от имени сообщества VK (messages.send).
 * @see https://dev.vk.com/ru/method/messages.send
 */
async function sendVkMessageOnce(text, peerId, accessToken) {
  return vkMethod(
    'messages.send',
    {
      peer_id: String(peerId),
      message: text,
      random_id: String(Math.floor(Math.random() * 2147483647)),
    },
    accessToken,
  );
}

async function sendVkMessage(text, peerIdOverride) {
  const resolved = resolveVkPeer(peerIdOverride);
  if (resolved.skipped) {
    return { skipped: true };
  }

  const { peerId, accessToken } = resolved;
  let lastMessageId;
  for (const chunk of chunkString(text, MAX_MESSAGE_CHARS)) {
    lastMessageId = await sendVkMessageOnce(chunk, peerId, accessToken);
  }
  return { skipped: false, messageId: lastMessageId };
}

async function uploadToVkServer(uploadUrl, fieldName, file) {
  const form = new FormData();
  form.append(
    fieldName,
    new Blob([file.buffer], { type: file.mimetype }),
    file.originalname,
  );
  const res = await fetch(uploadUrl, { method: 'POST', body: form });
  const data = await res.json();
  if (!res.ok || data.error) {
    throw new Error(
      data.error || `VK upload failed: HTTP ${res.status}`,
    );
  }
  return data;
}

async function sendVkFile(file, peerIdOverride, caption) {
  const resolved = resolveVkPeer(peerIdOverride);
  if (resolved.skipped) {
    return { skipped: true };
  }

  const { peerId, accessToken } = resolved;
  let attachment;

  if (file.mimetype?.startsWith('image/')) {
    const server = await vkMethod(
      'photos.getMessagesUploadServer',
      { peer_id: String(peerId) },
      accessToken,
    );
    const uploadData = await uploadToVkServer(server.upload_url, 'photo', file);
    const saved = await vkMethod(
      'photos.saveMessagesPhoto',
      {
        photo: uploadData.photo,
        server: String(uploadData.server),
        hash: uploadData.hash,
      },
      accessToken,
    );
    const photo = Array.isArray(saved) ? saved[0] : saved;
    attachment = `photo${photo.owner_id}_${photo.id}`;
  } else {
    const server = await vkMethod(
      'docs.getMessagesUploadServer',
      { peer_id: String(peerId), type: 'doc' },
      accessToken,
    );
    const uploadData = await uploadToVkServer(server.upload_url, 'file', file);
    const saved = await vkMethod('docs.save', { file: uploadData.file }, accessToken);
    const doc = saved.doc ?? saved;
    attachment = `doc${doc.owner_id}_${doc.id}`;
  }

  const messageId = await vkMethod(
    'messages.send',
    {
      peer_id: String(peerId),
      attachment,
      message: caption || '',
      random_id: String(Math.floor(Math.random() * 2147483647)),
    },
    accessToken,
  );
  return { skipped: false, messageId };
}

async function sendTelegramFile(targetChatId, file, caption) {
  const opts = {
    caption: caption || undefined,
    filename: file.originalname,
  };
  const { buffer, mimetype } = file;

  if (mimetype?.startsWith('image/')) {
    await bot.sendPhoto(targetChatId, buffer, opts);
  } else if (mimetype?.startsWith('video/')) {
    await bot.sendVideo(targetChatId, buffer, opts);
  } else if (mimetype?.startsWith('audio/')) {
    await bot.sendAudio(targetChatId, buffer, opts);
  } else {
    await bot.sendDocument(targetChatId, buffer, opts);
  }
}

function filenameFromUrl(fileUrl, contentDisposition) {
  if (contentDisposition) {
    const match = /filename\*?=(?:UTF-8''|")?([^";\n]+)/i.exec(contentDisposition);
    if (match?.[1]) {
      try {
        return decodeURIComponent(match[1].replace(/"/g, ''));
      } catch {
        return match[1].replace(/"/g, '');
      }
    }
  }
  try {
    const base = new URL(fileUrl).pathname.split('/').pop();
    if (base) return decodeURIComponent(base);
  } catch {
    /* ignore */
  }
  return 'file';
}

async function fetchFileFromUrl(fileUrl) {
  let parsed;
  try {
    parsed = new URL(fileUrl);
  } catch {
    throw new Error('Некорректный file_url');
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw new Error('file_url должен использовать http или https');
  }

  const res = await fetch(fileUrl);
  if (!res.ok) {
    throw new Error(`Не удалось скачать file_url: HTTP ${res.status}`);
  }

  const contentLength = res.headers.get('content-length');
  if (contentLength && Number(contentLength) > MAX_FILE_BYTES) {
    throw new Error(`Файл больше лимита (${MAX_FILE_BYTES} байт)`);
  }

  const buffer = Buffer.from(await res.arrayBuffer());
  if (buffer.length > MAX_FILE_BYTES) {
    throw new Error(`Файл больше лимита (${MAX_FILE_BYTES} байт)`);
  }

  const mimetype =
    res.headers.get('content-type')?.split(';')[0]?.trim() || 'application/octet-stream';

  return {
    buffer,
    originalname: filenameFromUrl(fileUrl, res.headers.get('content-disposition')),
    mimetype,
  };
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

function fileSuccessMessage(vkCh) {
  if (vkCh.skipped) {
    return 'Файл отправлен в Telegram (VK не настроен в .env — пропуск)';
  }
  if (!vkCh.ok) {
    return 'Файл отправлен в Telegram, ошибка VK (см. channels)';
  }
  return 'Файл отправлен в Telegram и VK';
}

async function deliverWithFile(text, targetChatId, vkPeerOverride, file) {
  if (!targetChatId) {
    throw new Error(
      'CHAT_ID не указан ни в .env, ни в запросе. Используйте параметр chat_id или добавьте CHAT_ID в .env',
    );
  }

  const caption =
    text && text.length <= TELEGRAM_CAPTION_MAX
      ? text
      : text
        ? text.slice(0, TELEGRAM_CAPTION_MAX)
        : undefined;
  const telegramRemainder =
    text && text.length > TELEGRAM_CAPTION_MAX ? text.slice(TELEGRAM_CAPTION_MAX) : undefined;
  const vkCaption =
    text && text.length <= MAX_MESSAGE_CHARS
      ? text
      : text
        ? text.slice(0, MAX_MESSAGE_CHARS)
        : undefined;
  const vkRemainder =
    text && text.length > MAX_MESSAGE_CHARS ? text.slice(MAX_MESSAGE_CHARS) : undefined;

  const [telegramResult, vkResult] = await Promise.allSettled([
    (async () => {
      await sendTelegramFile(targetChatId, file, caption);
      if (telegramRemainder) {
        for (const chunk of chunkString(telegramRemainder, MAX_MESSAGE_CHARS)) {
          await bot.sendMessage(targetChatId, chunk);
        }
      }
    })(),
    (async () => {
      const r = await sendVkFile(file, vkPeerOverride || undefined, vkCaption);
      if (!r.skipped && vkRemainder) {
        const resolved = resolveVkPeer(vkPeerOverride);
        if (!resolved.skipped) {
          for (const chunk of chunkString(vkRemainder, MAX_MESSAGE_CHARS)) {
            await sendVkMessageOnce(chunk, resolved.peerId, resolved.accessToken);
          }
        }
      }
      return r;
    })(),
  ]);

  const channels = buildChannels(telegramResult, vkResult);
  const telegramOk = channels.find((c) => c.service === 'telegram')?.ok;
  const vkCh = channels.find((c) => c.service === 'vk');
  const success =
    telegramOk && (vkCh.skipped || (vkCh.ok && !vkCh.skipped));

  let message;
  if (!telegramOk) {
    message = 'Ошибка отправки файла в Telegram (см. channels)';
  } else {
    message = fileSuccessMessage(vkCh);
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

async function respondNotifyFile(res, { text, file, targetChatId, vkPeerOverride }) {
  try {
    const { success, message, channels } = await deliverWithFile(
      text || '',
      targetChatId,
      vkPeerOverride,
      file,
    );

    if (!success) {
      console.error('Ошибка при отправке файла:', { channels });
      return res.status(500).json({ success: false, message, channels });
    }

    return res.json({ success: true, message, channels });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return res.status(400).json({ success: false, message: msg });
  }
}

async function respondNotifyWithOptionalFile(
  res,
  { text, fileUrl, file, targetChatId, vkPeerOverride },
) {
  try {
    const fileToSend = file || (fileUrl ? await fetchFileFromUrl(fileUrl) : null);
    if (fileToSend) {
      return respondNotifyFile(res, {
        text: text || '',
        file: fileToSend,
        targetChatId,
        vkPeerOverride,
      });
    }
    if (!text) {
      return res.status(400).json({
        success: false,
        message: 'Укажите text, file (multipart) или file_url',
      });
    }
    return respondNotify(res, text, targetChatId, vkPeerOverride);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return res.status(400).json({ success: false, message: msg });
  }
}

/** Простые уведомления: GET ?text=... или ?file_url=... */
async function handleNotifyGet(req, res) {
  const text = firstQueryParam(req.query.text);
  const fileUrl = firstQueryParam(req.query.file_url);

  if (!text && !fileUrl) {
    return res.status(400).json({
      success: false,
      message: 'Укажите text и/или file_url',
    });
  }

  const targetChatId = firstQueryParam(req.query.chat_id) ?? chatId;
  const vkPeerOverride = firstQueryParam(req.query.vk_peer_id);

  return respondNotifyWithOptionalFile(res, {
    text,
    fileUrl,
    targetChatId,
    vkPeerOverride,
  });
}

async function handleNotifyMultipart(req, res) {
  if (!req.file) {
    return res.status(400).json({
      success: false,
      message: 'Для multipart нужно поле file',
    });
  }

  const text = req.body?.text ?? req.body?.caption;
  const targetChatId = req.body?.chat_id ?? chatId;
  const vkPeerOverride = req.body?.vk_peer_id;
  const file = {
    buffer: req.file.buffer,
    originalname: req.file.originalname || 'file',
    mimetype: req.file.mimetype || 'application/octet-stream',
  };

  return respondNotifyFile(res, {
    text: text || '',
    file,
    targetChatId,
    vkPeerOverride,
  });
}

function maybeUpload(req, res, next) {
  const ct = req.headers['content-type'] || '';
  if (!ct.includes('multipart/form-data')) {
    return next();
  }
  upload.single('file')(req, res, (err) => {
    if (err) {
      const msg =
        err.code === 'LIMIT_FILE_SIZE'
          ? `Файл больше лимита (${MAX_FILE_BYTES} байт)`
          : err instanceof Error
            ? err.message
            : String(err);
      const status = err.code === 'LIMIT_FILE_SIZE' ? 413 : 400;
      return res.status(status).json({ success: false, message: msg });
    }
    return handleNotifyMultipart(req, res);
  });
}

async function handleNotifyPost(req, res) {
  const fileUrl = req.body?.file_url;
  const text = req.body?.text;
  const targetChatId = req.body?.chat_id ?? chatId;
  const vkPeerOverride = req.body?.vk_peer_id;

  if (typeof fileUrl === 'string' && fileUrl.trim()) {
    return respondNotifyWithOptionalFile(res, {
      text: typeof text === 'string' ? text : '',
      fileUrl: fileUrl.trim(),
      targetChatId,
      vkPeerOverride,
    });
  }

  if (!text || typeof text !== 'string') {
    return res.status(400).json({
      success: false,
      message: 'Ожидается JSON с полем text (строка) или file_url',
    });
  }

  return respondNotify(res, text, targetChatId, vkPeerOverride);
}

/** Railway project webhooks — https://docs.railway.com/observability/webhooks */
function railwaySeverityEmoji(severity) {
  switch (String(severity || '').toUpperCase()) {
    case 'CRITICAL':
    case 'ERROR':
      return '🔴';
    case 'WARNING':
      return '🟡';
    case 'INFO':
      return '🔵';
    default:
      return '🚂';
  }
}

function railwayEventTitle(type) {
  if (!type || typeof type !== 'string') {
    return 'Событие Railway';
  }
  const [category, ...rest] = type.split('.');
  const action = rest.join('.') || '';
  const categoryRu = {
    Deployment: 'Деплой',
    Volume: 'Том',
    Monitor: 'Мониторинг',
    Alert: 'Алерт',
  }[category] || category;
  const actionRu = {
    failed: 'ошибка',
    success: 'успех',
    crashed: 'краш',
    removed: 'удалён',
    started: 'запущен',
    completed: 'завершён',
  }[action.toLowerCase()] || action.replace(/_/g, ' ');
  return action ? `${categoryRu}: ${actionRu}` : categoryRu;
}

function appendRailwayLine(lines, label, value) {
  if (value == null || value === '') return;
  lines.push(`${label}: ${value}`);
}

function formatRailwayWebhookMessage(payload) {
  const { type, details = {}, resource = {}, severity, timestamp } = payload;
  const emoji = railwaySeverityEmoji(severity);
  const lines = [`${emoji} Railway — ${railwayEventTitle(type)}`];

  if (type) {
    appendRailwayLine(lines, 'Тип', type);
  }
  if (severity) {
    appendRailwayLine(lines, 'Важность', severity);
  }

  const project = resource.project?.name;
  const service = resource.service?.name;
  const environment = resource.environment?.name;
  const workspace = resource.workspace?.name;
  appendRailwayLine(lines, 'Workspace', workspace);
  appendRailwayLine(lines, 'Проект', project);
  appendRailwayLine(lines, 'Сервис', service);
  appendRailwayLine(lines, 'Окружение', environment);
  if (resource.environment?.isEphemeral) {
    appendRailwayLine(lines, 'Эфемерное окружение', 'да');
  }

  const deploymentId =
    resource.deployment?.id || details.id;
  appendRailwayLine(lines, 'Deployment ID', deploymentId);

  if (details.status) {
    appendRailwayLine(lines, 'Статус', details.status);
  }
  if (details.source) {
    appendRailwayLine(lines, 'Источник', details.source);
  }
  if (details.branch) {
    appendRailwayLine(lines, 'Ветка', details.branch);
  }
  if (details.commitHash) {
    const short =
      String(details.commitHash).length > 8
        ? String(details.commitHash).slice(0, 7)
        : details.commitHash;
    appendRailwayLine(lines, 'Коммит', short);
  }
  if (details.commitAuthor) {
    appendRailwayLine(lines, 'Автор', details.commitAuthor);
  }
  if (details.commitMessage) {
    const msg = String(details.commitMessage).trim();
    const clipped = msg.length > 500 ? `${msg.slice(0, 497)}...` : msg;
    appendRailwayLine(lines, 'Сообщение коммита', clipped);
  }

  const extraDetailKeys = Object.keys(details).filter(
    (k) =>
      ![
        'id',
        'status',
        'source',
        'branch',
        'commitHash',
        'commitAuthor',
        'commitMessage',
      ].includes(k),
  );
  for (const key of extraDetailKeys) {
    const val = details[key];
    if (val != null && typeof val !== 'object') {
      appendRailwayLine(lines, key, String(val));
    }
  }

  if (timestamp) {
    appendRailwayLine(lines, 'Время', timestamp);
  }

  return lines.join('\n');
}

function verifyRailwayWebhookSecret(req) {
  const secret = process.env.RAILWAY_WEBHOOK_SECRET?.trim();
  if (!secret) {
    return null;
  }
  const provided =
    firstQueryParam(req.query.secret) ||
    req.headers['x-webhook-secret'] ||
    req.headers['x-railway-webhook-secret'];
  if (provided !== secret) {
    return 'Неверный секрет webhook (задайте ?secret=... или заголовок X-Webhook-Secret)';
  }
  return null;
}

async function handleRailwayWebhook(req, res) {
  const authError = verifyRailwayWebhookSecret(req);
  if (authError) {
    return res.status(401).json({ success: false, message: authError });
  }

  const body = req.body;
  if (!body || typeof body !== 'object' || !body.type) {
    return res.status(400).json({
      success: false,
      message: 'Ожидается JSON payload Railway с полем type',
    });
  }

  const text = formatRailwayWebhookMessage(body);
  const targetChatId = firstQueryParam(req.query.chat_id) ?? chatId;
  const vkPeerOverride = firstQueryParam(req.query.vk_peer_id);

  console.log('Railway webhook: %s', body.type);
  return respondNotify(res, text, targetChatId, vkPeerOverride);
}

app.post('/webhooks/railway', handleRailwayWebhook);
app.post('/webhooks/railway/', handleRailwayWebhook);

/** GET — текст/file_url; POST — JSON или multipart (поле file). */
app.get('/', handleNotifyGet);
app.get('/notify', handleNotifyGet);
app.get('/notify/', handleNotifyGet);
app.post('/', maybeUpload, handleNotifyPost);
app.post('/notify', maybeUpload, handleNotifyPost);
app.post('/notify/', maybeUpload, handleNotifyPost);

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