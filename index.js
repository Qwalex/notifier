const express = require('express');
const TelegramBot = require('node-telegram-bot-api');
const cors = require('cors'); // Добавляем импорт cors
require('dotenv').config();

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
  
  // Отправка текста в Telegram
  bot.sendMessage(targetChatId, text)
    .then(() => {
      res.send({ success: true, message: 'Сообщение отправлено!' });
    })
    .catch(error => {
      console.error('Ошибка при отправке сообщения:', error);
      res.status(500).send({ success: false, message: 'Ошибка при отправке сообщения' });
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