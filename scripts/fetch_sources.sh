#!/usr/bin/env bash
# Качает исходные словари в data/. Идемпотентно: уже скачанное пропускает.
set -euo pipefail
cd "$(dirname "$0")/.."
mkdir -p data

get() {  # get <файл> <url>
  if [ -s "data/$1" ]; then echo "есть: $1"; return; fi
  echo "качаю: $1"
  curl -fL --retry 3 --progress-bar -o "data/$1" "$2"
}

get de_50k.txt \
  "https://raw.githubusercontent.com/hermitdave/FrequencyWords/master/content/2018/de/de_50k.txt"
get kaikki-ru.jsonl \
  "https://kaikki.org/ruwiktionary/%D0%9D%D0%B5%D0%BC%D0%B5%D1%86%D0%BA%D0%B8%D0%B9/kaikki.org-dictionary-%D0%9D%D0%B5%D0%BC%D0%B5%D1%86%D0%BA%D0%B8%D0%B9.jsonl"
get kaikki-de.jsonl \
  "https://kaikki.org/dictionary/German/kaikki.org-dictionary-German.jsonl"

ls -lh data/
