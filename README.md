# Telegram Bot Notify

Простой Telegram бот для отправки уведомлений через HTTP запросы.

## Запуск с Docker Compose

### 1. Настройка переменных окружения

Скопируйте файл `env.example` в `.env` и заполните необходимые переменные:

```bash
cp env.example .env
```

Отредактируйте `.env` файл:
```env
TELEGRAM_BOT_TOKEN=your_telegram_bot_token_here
CHAT_ID=your_chat_id_here
PORT=5656
NODE_ENV=production
```

### 2. Запуск приложения

```bash
# Сборка и запуск
docker-compose up --build

# Запуск в фоновом режиме
docker-compose up -d --build

# Остановка
docker-compose down
```

### 3. Использование

После запуска бот будет доступен по адресу `http://localhost:5656`

**Отправка сообщения:**
```
GET http://localhost:5656/?text=Ваше сообщение
```

**Отправка в конкретный чат:**
```
GET http://localhost:5656/?text=Ваше сообщение&chat_id=123456789
```

## Переменные окружения

- `TELEGRAM_BOT_TOKEN` - токен вашего Telegram бота
- `CHAT_ID` - ID чата по умолчанию для отправки сообщений
- `PORT` - порт для запуска сервера (по умолчанию 5656)
- `NODE_ENV` - окружение (production/development)

## Логи

Логи приложения сохраняются в папку `./logs` на хосте.
