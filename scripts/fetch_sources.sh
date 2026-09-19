#!/usr/bin/env bash
# Качает исходные словари в data/<язык>/. Идемпотентно: уже скачанное пропускает.
#   ./scripts/fetch_sources.sh          — все языки
#   ./scripts/fetch_sources.sh de it    — только указанные
set -euo pipefail
cd "$(dirname "$0")/.."

# язык : секция в English Wiktionary : секция в русском Викисловаре
langs_kaikki() { case "$1" in
  de) echo "German";;   it) echo "Italian";;   en) echo "English";;
  *) echo "неизвестный язык: $1" >&2; exit 1;; esac; }
langs_ru() { case "$1" in
  de) echo "Немецкий";; it) echo "Итальянский";; en) echo "Английский";; esac; }

urlenc() { python3 -c "import sys,urllib.parse;print(urllib.parse.quote(sys.argv[1]))" "$1"; }

# Целый ли JSONL: у обрезанного файла последняя строка не разбирается.
# Размер этого не показывает, а [ -s ] тем более — поэтому проверяем явно.
intact() {
  case "$1" in
    *.jsonl) python3 -c "
import json,sys
try:
    with open(sys.argv[1],encoding='utf-8',errors='replace') as f:
        last=None
        for line in f: last=line
    json.loads(last)
except Exception:
    sys.exit(1)
" "$1" ;;
    *) [ -s "$1" ] ;;
  esac
}

get() {  # get <путь> <url>
  if [ -s "$1" ] && intact "$1"; then echo "  есть: $(basename "$1")"; return; fi
  if [ -s "$1" ]; then echo "  битый, перекачиваю: $(basename "$1")"; rm -f "$1"; fi
  echo "  качаю: $(basename "$1")"

  # Качаем явными диапазонами и дописываем в конец.
  # Просто `curl -C - --retry` здесь не годится: смещение для докачки curl
  # вычисляет один раз при старте, и после обрыва перезапись начинается
  # с нуля — трёхгигабайтный дамп так не скачать.
  local part="$1.part" total have tries=0
  total=$(curl -fsIL "$2" | tr -d '\r' | awk 'tolower($1)=="content-length:"{n=$2} END{print n}')
  [ -n "$total" ] || { echo "  сервер не сообщил размер"; return 1; }

  while :; do
    have=$( [ -f "$part" ] && wc -c < "$part" | tr -d ' ' || echo 0 )
    [ "$have" -ge "$total" ] && break
    printf '\r  %s / %s МБ' "$((have/1000000))" "$((total/1000000))"
    if curl -fsL --max-time 900 --speed-limit 2048 --speed-time 30 \
            -r "$have-" "$2" >> "$part"; then
      tries=0
    else
      tries=$((tries+1))
      [ "$tries" -ge 10 ] && { echo; echo "  обрывов подряд: $tries, сдаюсь"; return 1; }
      sleep 3
    fi
  done

  printf '\r  %s МБ — готово\n' "$((total/1000000))"
  mv "$part" "$1"
  intact "$1" || { echo "  файл повреждён"; rm -f "$1"; return 1; }
}

for lang in "${@:-de it en}"; do
  k=$(langs_kaikki "$lang"); r=$(langs_ru "$lang")
  dir="data/$lang"; mkdir -p "$dir"
  echo "[$lang]"
  get "$dir/freq.txt" \
    "https://raw.githubusercontent.com/hermitdave/FrequencyWords/master/content/2018/$lang/${lang}_50k.txt"
  get "$dir/ru.jsonl" \
    "https://kaikki.org/ruwiktionary/$(urlenc "$r")/kaikki.org-dictionary-$(urlenc "$r").jsonl"
  get "$dir/main.jsonl" \
    "https://kaikki.org/dictionary/$k/kaikki.org-dictionary-$k.jsonl"
done

du -sh data/*/
