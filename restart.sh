#!/usr/bin/env bash
set -Eeuo pipefail

# NOTIFY_URL — POST JSON {"text":"..."} на сервис уведомлений (этот же проект).
# При падении сервиса уведомить об ошибке нельзя — notify вызывается только после
# полностью успешного деплоя. Ошибки смотрите в логах и .deploy-compose-failure.log.
NOTIFY_URL="${NOTIFY_URL:-}"
PROJECT_NAME="${PROJECT_NAME:-notifier}"
DEPLOY_VARIANT="${DEPLOY_VARIANT:-production}"
DEPLOY_WRAPPER="${DEPLOY_WRAPPER:-restart.sh}"

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LAST_GOOD_ENV="$ROOT_DIR/.last-good-deploy.env"
HISTORY_LOG="$ROOT_DIR/.deploy-history.log"
COMPOSE_FAILURE_LOG="$ROOT_DIR/.deploy-compose-failure.log"

LOG_FILE="$(mktemp -t "${PROJECT_NAME}-restart.XXXXXX.log")"

json_escape() {
  local s="$1"
  s="${s//\\/\\\\}"
  s="${s//\"/\\\"}"
  s="${s//$'\n'/\\n}"
  s="${s//$'\r'/\\r}"
  s="${s//$'\t'/\\t}"
  printf '%s' "$s"
}

notify() {
  [[ -z "${NOTIFY_URL}" ]] && return 0
  local text="$1"
  local payload
  payload="{\"text\":\"$(json_escape "$text")\"}"

  curl -X POST "${NOTIFY_URL}" \
    -H "Content-Type: application/json" \
    -d "$payload" \
    --fail \
    --show-error \
    --silent || echo "curl notify error"
}

deploy_saved_files_notice() {
  local strict="${1:-1}"
  if [[ "$strict" == "1" ]]; then
    echo "Логи ошибки сохранены в файлы:"
  else
    echo "На сервере в каталоге проекта для разбора могут быть полезны файлы:"
  fi
  echo "• ${COMPOSE_FAILURE_LOG} — docker compose ps и логи контейнеров"
  echo "• ${HISTORY_LOG} — журнал событий деплоя"
  echo "• ${LAST_GOOD_ENV} — последний успешный образ (NOTIFIER_IMAGE)"
}

append_deploy_history() {
  local status="$1"
  local ref="${2:-unknown}"
  echo "$(date -u +%Y-%m-%dT%H:%M:%SZ)"$'\t'"$status"$'\t'"$ref" >> "$HISTORY_LOG"
}

write_last_good_registry_env() {
  umask 077
  {
    echo "# Сгенерировано restart.sh после успешного деплоя. Не коммитить."
    echo "export NOTIFIER_IMAGE=$(printf '%q' "${NOTIFIER_IMAGE:-}")"
  } > "$LAST_GOOD_ENV"
  chmod 600 "$LAST_GOOD_ENV" 2>/dev/null || true
}

deploy_from_registry() {
  docker compose pull
  docker compose up -d --remove-orphans
}

dump_compose_failure_logs() {
  local label="${1:-deploy}"
  {
    echo ""
    echo "======== $(date -u +%Y-%m-%dT%H:%M:%SZ) — $label ========"
    docker compose ps -a 2>&1 || true
    echo "---- logs (последние строки) ----"
    docker compose logs --no-color --tail 800 2>&1 || echo "(docker compose logs недоступен: $?)"
  } >> "$COMPOSE_FAILURE_LOG"
}

report_deploy_failure_no_rollback() {
  dump_compose_failure_logs "registry: финальная ошибка"
  echo "restart.sh: деплой не удался (откат недоступен или откат упал). См. $LOG_FILE" >&2
  deploy_saved_files_notice 1 >&2
  exit 1
}

on_error() {
  local exit_code="$?"
  local cmd="${BASH_COMMAND:-unknown}"
  echo "restart.sh: ошибка (команда: $cmd, код: $exit_code). Лог: $LOG_FILE" >&2
  exit "$exit_code"
}

cleanup() {
  rm -f "$LOG_FILE" >/dev/null 2>&1 || true
}

trap on_error ERR
trap cleanup EXIT

exec > >(tee -a "$LOG_FILE") 2>&1

cd "$ROOT_DIR"

if [[ -n "${GHCR_TOKEN:-}" && -n "${GHCR_USERNAME:-}" ]]; then
  echo "$GHCR_TOKEN" | docker login ghcr.io -u "$GHCR_USERNAME" --password-stdin
fi

if [[ "${SKIP_GIT:-}" != "1" ]]; then
  branch="$(git rev-parse --abbrev-ref HEAD)"
  git fetch origin
  git reset --hard "origin/${branch}"
fi

# Режим registry (CI задаёт NOTIFIER_IMAGE): шаг 1 — build в GitHub Actions; шаг 2 здесь — pull + up.
if [[ -n "${NOTIFIER_IMAGE:-}" ]]; then
  ATTEMPT_REF="${NOTIFIER_IMAGE##*:}"
  if deploy_from_registry; then
    write_last_good_registry_env
    append_deploy_history "ok" "$ATTEMPT_REF"
  else
    dump_compose_failure_logs "registry: первый деплой не удался"
    if [[ -f "$LAST_GOOD_ENV" && "${ROLLBACK_IN_PROGRESS:-}" != "1" ]]; then
      # shellcheck disable=SC1090
      if source "$LAST_GOOD_ENV" 2>/dev/null; then
        export ROLLBACK_IN_PROGRESS=1
        ROLLBACK_REF="${NOTIFIER_IMAGE##*:}"
        echo "restart.sh: откат к образу ${ROLLBACK_REF} (сервис уведомлений может быть недоступен — без NOTIFY)." >&2
        if deploy_from_registry; then
          append_deploy_history "rollback_ok" "$ROLLBACK_REF"
          exit 0
        fi
      fi
    fi
    report_deploy_failure_no_rollback
  fi
else
  # Локально: сборка на сервере, без pull из registry.
  if docker compose build && docker compose up -d --remove-orphans; then
    GIT_REF="$(git rev-parse --short HEAD 2>/dev/null || echo local-build)"
    append_deploy_history "ok" "$GIT_REF"
  else
    dump_compose_failure_logs "локальная сборка"
    echo "restart.sh: локальная сборка не удалась. См. $LOG_FILE" >&2
    deploy_saved_files_notice 1 >&2
    exit 1
  fi
fi

notify "✅ ${DEPLOY_VARIANT} стенд: проект ${PROJECT_NAME} обновлён без ошибок (источник: ${DEPLOY_WRAPPER})."
