const express = require('express');
const TelegramBot = require('node-telegram-bot-api');
const cors = require('cors'); // Добавляем импорт cors
require('dotenv').config();

const VK_API_VERSION = '5.199';

/**
 * Отправка сообщения от имени сообщества VK (messages.send).
 * Нужен токен группы с правом «Сообщения сообщества», пользователь должен разрешить сообщения или написать сообществу.
 */
async function sendVkMessage(text, peerIdOverride) {
  const accessToken = process.env.VK_ACCESS_TOKEN;
  const defaultPeerId = process.env.VK_PEER_ID;
  const peerId = peerIdOverride ?? defaultPeerId;

  if (!accessToken || !peerId) {
    return { skipped: true };
  }

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
  return { skipped: false };
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
  // origin: 'https://gitlab.services.mts.ru'
}));

// Обработка GET запроса с параметром text
// ...existing code...
// Обработка GET запроса с параметром text
app.get('/', (req, res) => {
  const text = req.query.text;
  const targetChatId = req.query.chat_id || chatId;

  console.log({ targetChatId })
  
  if (!text) {
    return res.status(400).send({ success: false, message: 'Параметр text не указан' });
  }

  if (!targetChatId) {
    return res.status(400).send({ 
      success: false, 
      message: 'CHAT_ID не указан ни в .env, ни в запросе. Используйте параметр chat_id или добавьте CHAT_ID в .env' 
    });
  }

  const vkPeerOverride = req.query.vk_peer_id;
  const telegramPromise = bot.sendMessage(targetChatId, text).then(() => ({ service: 'telegram', ok: true }));
  const vkPromise = sendVkMessage(text, vkPeerOverride || undefined)
    .then((r) => {
      if (r.skipped) {
        return { service: 'vk', ok: true, skipped: true };
      }
      return { service: 'vk', ok: true };
    });

  Promise.all([telegramPromise, vkPromise])
    .then((outcomes) => {
      const vkOutcome = outcomes.find((o) => o.service === 'vk');
      const message =
        vkOutcome && vkOutcome.skipped
          ? 'Сообщение отправлено в Telegram (VK не настроен в .env — пропуск)'
          : 'Сообщение отправлено в Telegram и VK';
      res.send({ success: true, message, channels: outcomes });
    })
    .catch((error) => {
      console.error('Ошибка при отправке сообщения:', error);
      res.status(500).send({
        success: false,
        message: error.message || 'Ошибка при отправке сообщения',
      });
    });
});

// Запуск сервера
app.listen(port, () => {
  console.log(`Сервер запущен на порту ${port}`);
});

// Обработчик для команды /start
bot.onText(/\/start/, (msg) => {
  const chatId = msg.chat.id;
  bot.sendMessage(chatId, 'Привет! Я бот для отправки уведомлений. Мой ID чата: ' + chatId);
});

console.log('Бот запущен...');