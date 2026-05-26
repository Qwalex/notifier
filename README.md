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

**Короткое сообщение через GET** (удобно открыть в браузере или вставить ссылку; длинный текст и спецсимволы — лучше через POST):

```
http://localhost:5656/?text=Ваше%20сообщение
```

С указанием чата и VK peer: `?text=...&chat_id=123456789&vk_peer_id=...`

**POST с JSON** (деплой и длинные логи):

```bash
curl -X POST http://localhost:5656/ -H "Content-Type: application/json" -d '{"text":"Ваше сообщение"}'
```

```bash
curl -X POST http://localhost:5656/ -H "Content-Type: application/json" \
  -d '{"text":"Ваше сообщение","chat_id":"123456789"}'
```

**Файл (multipart, поле `file`, опционально `text` как подпись):**

```bash
curl -X POST http://localhost:5656/notify -F "file=@./report.pdf" -F "text=Отчёт за день"
```

**Файл по ссылке (JSON или GET `file_url`):**

```bash
curl -X POST http://localhost:5656/notify -H "Content-Type: application/json" \
  -d '{"file_url":"https://example.com/file.pdf","text":"Подпись"}'
```

## Переменные окружения

- `TELEGRAM_BOT_TOKEN` - токен вашего Telegram бота
- `CHAT_ID` - ID чата по умолчанию для отправки сообщений
- `PORT` - порт для запуска сервера (по умолчанию 5656)
- `NODE_ENV` - окружение (production/development)
- `MAX_FILE_BYTES` - максимальный размер загружаемого файла в байтах (по умолчанию 50 MB)

## Логи

Логи приложения сохраняются в папку `./logs` на хосте.
