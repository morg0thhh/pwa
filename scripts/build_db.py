#!/usr/bin/env python3
"""Собирает app/wortschatz.db: 10k немецких лемм по частотности, EN + RU значения.

Источники (качает scripts/fetch_sources.sh в data/):
  kaikki-de.jsonl  English Wiktionary, немецкая секция  (CC BY-SA 4.0)
  kaikki-ru.jsonl  Русский Викисловарь, немецкая секция (CC BY-SA 4.0)
  de_50k.txt       Частотность OpenSubtitles            (MIT)

Ранг считается по леммам, а не по словоформам: частоты всех форм
(ist/war/bin/gewesen) суммируются на лемму (sein), омографы делят частоту.
"""
import json
import os
import re
import sqlite3
import sys
from collections import defaultdict

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA = os.path.join(ROOT, "data")
KAIKKI_EN = os.path.join(DATA, "kaikki-de.jsonl")
KAIKKI_RU = os.path.join(DATA, "kaikki-ru.jsonl")
FREQ = os.path.join(DATA, "de_50k.txt")
OUT = sys.argv[1] if len(sys.argv) > 1 else os.path.join(ROOT, "app", "wortschatz.db")
TARGET = 10000

POS_KEEP = {
    "noun": "noun", "verb": "verb", "adj": "adj", "adv": "adv",
    "prep": "prep", "conj": "conj", "pron": "pron", "num": "num",
    "intj": "intj", "det": "det", "article": "det", "particle": "particle",
}
GENDER = {"masculine": "der", "feminine": "die", "neuter": "das"}
SKIP_GLOSS_EN = re.compile(
    r"^(inflection|misspelling|alternative (form|spelling)|obsolete|archaic|"
    r"superseded|dated form|abbreviation of|initialism|acronym|romanization|"
    r"plural of|genitive of|dative of|accusative of|singular of|"
    r"past participle of|comparative|superlative|female equivalent|surname|"
    r"a (male|female) given name)\b", re.I)
SKIP_GLOSS_RU = re.compile(r"^(форма |то же, что|уменьш|сокр\. от|устар)", re.I)
SKIP_TAGS = {"obsolete", "archaic", "misspelling", "rare", "form-of", "alt-of"}
WORD_RE = re.compile(r"^[A-Za-zÄÖÜäöüßẞ][A-Za-zÄÖÜäöüß\-]*$")
# Формы, которые нельзя учитывать при подсчёте частоты леммы:
#  auxiliary  — вспомогательный глагол из сложных времён (habe geäugt → "haben"):
#               без фильтра частота haben размазывается по всем глаголам языка;
#  alternative/obsolete — устаревшие написания (äugen → "augen") дают ложные пересечения;
#  table-tags/inflection-template — служебные строки из таблиц склонения.
FORM_JUNK = {"table-tags", "inflection-template", "class", "auxiliary",
             "alternative", "obsolete", "archaic", "rare"}
FORM_TEMPLATE_RE = re.compile(r"^(de-|no-table)")

# Значения-«грамматики»: верные, но для карточки бесполезные.
# Wiktionary ставит их первыми у служебных слов (sein → "forms the present perfect"),
# поэтому главное значение выбираем не по порядку, а по оценке.
GRAMMAR_EN = re.compile(
    r"^(forms?\b|used (to|with|as|in|after|before)\b|as a |translated with|"
    r"indicates?\b|expresses?\b|refers? to\b|denotes?\b|marks?\b|"
    r"(nominative|accusative|genitive|dative|singular|plural|comparative|superlative)\b|"
    r"a |an |the )", re.I)
GRAMMAR_RU = re.compile(
    r"^(употребляется|используется|служит|указывает|выражает|обозначает|"
    r"(определённый|неопределённый) артикль|(личное|притяжательное|указательное) местоимение)", re.I)


def clean(g):
    return re.sub(r"\s+", " ", g).strip().rstrip(".")


def clean_ru(g):
    """Русский Викисловарь приклеивает к значению пример через тире
    («иметь (что-либо), владеть — У него много друзей») и ведущую грамматическую
    пометку («(личное местоимение) оно»). Для карточки нужно ни того, ни другого."""
    g = clean(g)
    g = re.split(r"\s[—–]\s", g, maxsplit=1)[0]          # отрезаем пример
    g = re.sub(r"^\([^)]{0,40}\)\s*", "", g)             # ведущая пометка в скобках
    return g.strip(" ,;")


def rank_senses(senses, pos, ru=False):
    """Сортирует значения так, чтобы самое пригодное для карточки было первым."""
    grammar = GRAMMAR_RU if ru else GRAMMAR_EN

    def penalty(i, g):
        p = i * 0.5                      # при прочих равных — порядок Wiktionary
        if grammar.match(g):
            p += 100                     # грамматическое описание, не перевод
        if g.endswith(":"):
            p += 100                     # оборванный заголовок ("As a copulative verb:")
        if len(g) > (70 if ru else 60):
            p += 8                       # длинное толкование вместо перевода
        if not ru and pos == "verb" and g.startswith("to "):
            p -= 6                       # у глагола нормальный перевод начинается с to
        p += g.count("(") * (0.6 if ru else 1.5)   # скобки: уточнение или толкование
        return p

    return [g for _, g in sorted(((penalty(i, g), g) for i, g in enumerate(senses)),
                                 key=lambda t: t[0])]


def load_en():
    """(лемма, часть речи) -> запись. Формы нужны для частотного ранга."""
    entries = {}
    with open(KAIKKI_EN, encoding="utf-8") as fh:
        for line in fh:
            try:
                d = json.loads(line)
            except json.JSONDecodeError:
                continue
            if d.get("lang_code") != "de":
                continue
            pos = POS_KEEP.get(d.get("pos"))
            word = d.get("word", "")
            if not pos or not WORD_RE.match(word):
                continue

            senses, gender, examples = [], None, []
            for s in d.get("senses", []):
                tags = set(s.get("tags", []))
                if tags & SKIP_TAGS:
                    continue
                for g in s.get("glosses", []):
                    g = clean(g)
                    if g and not SKIP_GLOSS_EN.match(g) and g not in senses:
                        senses.append(g)
                if pos == "noun" and gender is None:
                    gender = next((GENDER[t] for t in tags if t in GENDER), None)
                for ex in s.get("examples", []):
                    de = ex.get("text")
                    en = ex.get("english") or ex.get("translation")
                    if de and en and len(de) < 160:
                        examples.append((de.strip(), en.strip()))
            if not senses:
                continue

            plural, forms = None, {word.lower()}
            for f in d.get("forms", []):
                ft, fw = set(f.get("tags", [])), f.get("form", "")
                if not fw or ft & FORM_JUNK or not WORD_RE.match(fw):
                    continue
                if FORM_TEMPLATE_RE.match(fw):
                    continue
                forms.add(fw.lower())
                if pos == "noun" and plural is None and "plural" in ft and "genitive" not in ft:
                    plural = fw

            ipa = next((s["ipa"] for s in d.get("sounds", []) if s.get("ipa")), None)

            key = (word, pos)
            if key in entries:  # омонимичные статьи — сливаем
                e = entries[key]
                e["senses"] += [s for s in senses if s not in e["senses"]]
                e["forms"] |= forms
                e["examples"] += examples
                e["gender"] = e["gender"] or gender
                e["plural"] = e["plural"] or plural
                e["ipa"] = e["ipa"] or ipa
            else:
                entries[key] = dict(word=word, pos=pos, senses=senses, gender=gender,
                                    plural=plural, ipa=ipa, forms=forms, examples=examples)
    return entries


def load_ru():
    """(лемма, часть речи) -> [значения]; плюс запасной индекс только по лемме."""
    exact, loose = defaultdict(list), defaultdict(list)
    if not os.path.exists(KAIKKI_RU):
        return exact, loose
    with open(KAIKKI_RU, encoding="utf-8") as fh:
        for line in fh:
            try:
                d = json.loads(line)
            except json.JSONDecodeError:
                continue
            if d.get("lang_code") != "de":
                continue
            word = d.get("word", "")
            if not WORD_RE.match(word):
                continue
            pos = POS_KEEP.get(d.get("pos"))
            out = []
            for s in d.get("senses", []):
                for g in s.get("glosses", []):
                    g = clean_ru(g)
                    if g and not SKIP_GLOSS_RU.match(g) and g not in out:
                        out.append(g)
            if not out:
                continue
            if pos:
                exact[(word, pos)] += out
            loose[word] += out
    return exact, loose


def score(entries):
    """Частота леммы = сумма частот её словоформ, поделённая между омографами."""
    form_index = defaultdict(list)
    for key, e in entries.items():
        for f in e["forms"]:
            form_index[f].append(key)

    totals = defaultdict(float)
    with open(FREQ, encoding="utf-8") as fh:
        for line in fh:
            parts = line.split()
            if len(parts) != 2 or not parts[1].isdigit():
                continue
            owners = form_index.get(parts[0].lower())
            if not owners:
                continue
            share = int(parts[1]) / len(owners)
            for key in owners:
                totals[key] += share
    return totals


def level_for(rank):
    for limit, lvl in ((600, "A1"), (1500, "A2"), (3000, "B1"), (5500, "B2")):
        if rank <= limit:
            return lvl
    return "C1"


def write_db(rows):
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    if os.path.exists(OUT):
        os.remove(OUT)
    db = sqlite3.connect(OUT)
    db.executescript("""
    CREATE TABLE words (
      id             INTEGER PRIMARY KEY,
      lemma          TEXT NOT NULL,
      article        TEXT,
      plural         TEXT,
      pos            TEXT NOT NULL,
      ipa            TEXT,
      translation_en TEXT NOT NULL,
      senses_en      TEXT NOT NULL,
      translation_ru TEXT,
      senses_ru      TEXT,
      example_de     TEXT,
      example_en     TEXT,
      freq_rank      INTEGER NOT NULL,
      level          TEXT NOT NULL
    );
    CREATE INDEX idx_words_rank  ON words(freq_rank);
    CREATE INDEX idx_words_level ON words(level);
    CREATE INDEX idx_words_pos   ON words(pos);
    CREATE UNIQUE INDEX idx_words_lemma_pos ON words(lemma, pos);
    """)
    db.executemany(
        "INSERT INTO words (lemma,article,plural,pos,ipa,translation_en,senses_en,"
        "translation_ru,senses_ru,example_de,example_en,freq_rank,level) "
        "VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)", rows)
    db.executescript("""
    CREATE VIRTUAL TABLE words_fts USING fts5(
      lemma, translation_en, translation_ru, content='words', content_rowid='id');
    INSERT INTO words_fts(rowid, lemma, translation_en, translation_ru)
      SELECT id, lemma, translation_en, translation_ru FROM words;
    """)
    db.commit()
    db.execute("VACUUM")
    db.close()


def main():
    print("читаю English Wiktionary…", flush=True)
    entries = load_en()
    print(f"  лемм с английскими значениями: {len(entries):,}", flush=True)

    print("читаю русский Викисловарь…", flush=True)
    ru_exact, ru_loose = load_ru()
    print(f"  статей с русскими значениями: {len(ru_loose):,}", flush=True)

    print("считаю частоты по словоформам…", flush=True)
    ranked = sorted(score(entries).items(), key=lambda kv: -kv[1])
    print(f"  лемм с ненулевой частотой: {len(ranked):,}", flush=True)

    # Междометие и частица почти всегда дублируют то же слово в основной части речи
    # (und/conj + und/intj). Выкидываем дубль, освобождая место настоящему слову.
    seen_lemmas = {w for (w, p), _ in ranked if p not in ("intj", "particle")}
    ranked = [(k, s) for k, s in ranked
              if not (k[1] in ("intj", "particle") and k[0] in seen_lemmas)]
    print(f"  после снятия дублей по частям речи: {len(ranked):,}", flush=True)

    rows, rank, with_ru = [], 0, 0
    for key, _ in ranked[:TARGET]:
        e = entries[key]
        rank += 1
        senses = rank_senses(e["senses"], e["pos"])
        ru = rank_senses(ru_exact.get(key) or ru_loose.get(e["word"]) or [], e["pos"], ru=True)
        if ru:
            with_ru += 1
        ex_de, ex_en = e["examples"][0] if e["examples"] else (None, None)
        rows.append((
            e["word"], e["gender"], e["plural"], e["pos"], e["ipa"],
            senses[0], json.dumps(senses[:8], ensure_ascii=False),
            ru[0] if ru else None,
            json.dumps(ru[:8], ensure_ascii=False) if ru else None,
            ex_de, ex_en, rank, level_for(rank),
        ))

    write_db(rows)
    pct = 100 * with_ru / len(rows) if rows else 0
    print(f"готово: {len(rows):,} слов, русский перевод у {with_ru:,} ({pct:.0f}%)", flush=True)
    print(f"        {OUT} — {os.path.getsize(OUT) / 1e6:.1f} МБ", flush=True)


if __name__ == "__main__":
    main()
