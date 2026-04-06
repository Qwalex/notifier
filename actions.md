
Добавлен файл [`.github/workflows/deploy.yml`](C:\Users\qwazi\Projects\notifier\.github\workflows\deploy.yml).

### Что делает workflow
1. **`verify`** (на каждый push/PR в `main` или `master`): `npm ci` и `node --check index.js`.
2. **`deploy`** (только при **push** или **Run workflow** на ветке `main`/`master`): по SSH заходит на сервер, в каталоге с репозиторием выполняет `git fetch` → `checkout` → `pull` и `docker compose up -d --build`.

### Настройка в GitHub
**Secrets → Actions:**
- `DEPLOY_HOST` — хост  
- `DEPLOY_USER` — пользователь SSH  
- `DEPLOY_SSH_KEY` — приватный ключ  

**Variables → Actions (по желанию):**
- `DEPLOY_PATH` — путь к клону с `docker-compose.yml` (если не задать, используется `/root/notifier`)

### Сервер
В `DEPLOY_PATH` должен лежать **git-клон этого репо** (тот же remote), настроенный `.env` с токенами, установлены Docker и плагин Compose; у пользователя SSH должны быть права на `git` и `docker` (часто пользователь в группе `docker`).

Нестандартный SSH-порт: в комментарии в workflow указано, что можно добавить `port:` в шаг `appleboy/ssh-action`.