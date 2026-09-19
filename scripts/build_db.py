#!/usr/bin/env python3
"""Собирает app/db/wortschatz-<язык>.db — 10k самых частотных лемм языка
с английскими и русскими значениями.

    python3 scripts/build_db.py            # все языки
    python3 scripts/build_db.py de it      # только указанные

Источники на язык (качает scripts/fetch_sources.sh в data/<язык>/):
  main.jsonl  English Wiktionary, секция языка  (CC BY-SA 4.0)
  ru.jsonl    Русский Викисловарь, секция языка (CC BY-SA 4.0)
  freq.txt    Частотность OpenSubtitles         (MIT)

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
TARGET = 10000

POS_KEEP = {
    "noun": "noun", "verb": "verb", "adj": "adj", "adv": "adv",
    "prep": "prep", "conj": "conj", "pron": "pron", "num": "num",
    "intj": "intj", "det": "det", "article": "det", "particle": "particle",
}
GENDER_TAGS = {"masculine": "m", "feminine": "f", "neuter": "n"}

# Глоссы, которые описывают форму или отсылают к другому слову, а не переводят его.
# В итальянском таких почти 9% — нанизанные клитики (esserne) и служебная пометка
# Wiktionary «Used other than figuratively or idiomatically» у субстантивированных
# инфинитивов (mangiare).
SKIP_GLOSS_EN = re.compile(
    r"^(inflection|misspelling|alternative (form|spelling)|obsolete|archaic|"
    r"superseded|dated form|abbreviation of|initialism|acronym|romanization|"
    r"plural of|genitive of|dative of|accusative of|singular of|"
    r"past participle of|present participle of|simple past|third-person|"
    r"first-person|second-person|imperative of|subjunctive of|gerund of|"
    r"compound of|contraction of|combination of|clipping of|elision of|"
    r"apocopic form|syncopic form|eye dialect|used other than|"
    r"comparative|superlative|female equivalent|masculine of|feminine of|"
    r"diminutive of|augmentative of|surname|"
    r"a (male|female) given name)\b", re.I)
SKIP_GLOSS_RU = re.compile(r"^(форма |то же, что|уменьш|сокр\. от|устар)", re.I)
SKIP_TAGS = {"obsolete", "archaic", "misspelling", "rare", "form-of", "alt-of"}

# Формы, которые нельзя учитывать при подсчёте частоты леммы:
#  auxiliary  — вспомогательный глагол из сложных времён (habe geäugt → "haben"):
#               без фильтра частота haben размазывается по всем глаголам языка;
#  alternative/obsolete — устаревшие написания дают ложные пересечения;
#  table-tags/inflection-template — служебные строки из таблиц склонения.
FORM_JUNK = {"table-tags", "inflection-template", "class", "auxiliary",
             "alternative", "obsolete", "archaic", "rare"}
FORM_TEMPLATE_RE = re.compile(r"^(de-|it-|en-|no-table)")

# Значения-«грамматики»: верные, но для карточки бесполезные.
# Wiktionary ставит их первыми у служебных слов (sein → "forms the present perfect"),
# поэтому главное значение выбирается по оценке, а не по порядку.
GRAMMAR_EN = re.compile(
    r"^(forms?\b|used (to|with|as|in|after|before|other)\b|as a |translated with|"
    r"indicates?\b|expresses?\b|refers? to\b|denotes?\b|marks?\b|"
    r"(nominative|accusative|genitive|dative|singular|plural|comparative|superlative)\b|"
    r"a |an |the )", re.I)
GRAMMAR_RU = re.compile(
    r"^(употребляется|используется|служит|указывает|выражает|обозначает|"
    r"(определённый|неопределённый) артикль|(личное|притяжательное|указательное) местоимение)", re.I)


# ---------------------------------------------------------------- языки

def article_de(word, gender):
    return {"m": "der", "f": "die", "n": "das"}.get(gender)


def article_it(word, gender):
    """В итальянском артикль зависит не только от рода, но и от первых букв:
    lo перед s+согласная, z, gn, ps, pn, x, y; l' перед гласной."""
    w = word.lower()
    if gender == "f":
        return "l'" if w[:1] in "aeiou" else "la"
    if gender != "m":
        return None
    if w[:1] in "aeiou":
        return "l'"
    if re.match(r"(z|gn|ps|pn|x|y|s[bcdfgklmnpqrtvwz])", w):
        return "lo"
    return "il"


LANGS = {
    "de": {"name": "немецкий", "flag": "🇩🇪", "word_re": r"^[A-Za-zÄÖÜäöüßẞ][A-Za-zÄÖÜäöüß\-]*$",
           "article": article_de, "plural": True},
    "it": {"name": "итальянский", "flag": "🇮🇹", "word_re": r"^[A-Za-zÀ-ÿ][A-Za-zÀ-ÿ'\-]*$",
           "article": article_it, "plural": True},
    "en": {"name": "английский", "flag": "🇬🇧", "word_re": r"^[A-Za-z][A-Za-z'\-]*$",
           "article": lambda w, g: None, "plural": True},
}


# ---------------------------------------------------------------- значения

def clean(g):
    return re.sub(r"\s+", " ", g).strip().rstrip(".")


def clean_ru(g):
    """Русский Викисловарь приклеивает к значению пример через тире
    («иметь (что-либо), владеть — У него много друзей») и ведущую грамматическую
    пометку («(личное местоимение) оно»). Для карточки не нужно ни того, ни другого."""
    g = clean(g)
    g = re.split(r"\s[—–]\s", g, maxsplit=1)[0]
    g = re.sub(r"^\([^)]{0,40}\)\s*", "", g)
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
        p += g.count("(") * (0.6 if ru else 1.5)
        return p

    return [g for _, g in sorted(((penalty(i, g), g) for i, g in enumerate(senses)),
                                 key=lambda t: t[0])]


# ---------------------------------------------------------------- чтение

def load_main(path, cfg):
    """(лемма, часть речи) -> запись. Формы нужны для частотного ранга."""
    word_re = re.compile(cfg["word_re"])
    entries = {}
    with open(path, encoding="utf-8") as fh:
        for line in fh:
            try:
                d = json.loads(line)
            except json.JSONDecodeError:
                continue
            pos = POS_KEEP.get(d.get("pos"))
            word = d.get("word", "")
            if not pos or not word_re.match(word):
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
                    gender = next((GENDER_TAGS[t] for t in tags if t in GENDER_TAGS), None)
                for ex in s.get("examples", []):
                    de = ex.get("text")
                    en = ex.get("english") or ex.get("translation")
                    if de and en and de != en and len(de) < 160:
                        examples.append((de.strip(), en.strip()))
            if not senses:
                continue

            # Род у существительных бывает и на верхнем уровне статьи.
            if pos == "noun" and gender is None:
                gender = next((GENDER_TAGS[t] for t in d.get("tags", []) if t in GENDER_TAGS), None)

            plural, forms = None, {word.lower()}
            for f in d.get("forms", []):
                ft, fw = set(f.get("tags", [])), f.get("form", "")
                if not fw or ft & FORM_JUNK or not word_re.match(fw) or FORM_TEMPLATE_RE.match(fw):
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


def load_ru(path, cfg):
    """(лемма, часть речи) -> [значения]; плюс запасной индекс только по лемме."""
    exact, loose = defaultdict(list), defaultdict(list)
    if not os.path.exists(path):
        return exact, loose
    word_re = re.compile(cfg["word_re"])
    with open(path, encoding="utf-8") as fh:
        for line in fh:
            try:
                d = json.loads(line)
            except json.JSONDecodeError:
                continue
            word = d.get("word", "")
            if not word_re.match(word):
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


CAPITALIZED_SHARE = 0.05


def score(entries, freq_path):
    """Частота леммы = сумма частот её словоформ, поделённая между омографами.

    Частотный список целиком в нижнем регистре, а в немецком регистр значим.
    Поэтому при делении формы между леммой с заглавной буквы и леммой со
    строчной заглавная получает лишь малую долю: «ich» в корпусе — это
    практически всегда местоимение, а не субстантивированное «das Ich».
    """
    form_index = defaultdict(list)
    for key, e in entries.items():
        for f in e["forms"]:
            form_index[f].append(key)

    weights = {}
    for form, owners in form_index.items():
        has_lower = any(w[:1].islower() for w, _ in owners)
        weights[form] = [
            CAPITALIZED_SHARE if (has_lower and w[:1].isupper()) else 1.0 for w, _ in owners
        ]

    totals = defaultdict(float)
    with open(freq_path, encoding="utf-8") as fh:
        for line in fh:
            parts = line.split()
            if len(parts) != 2 or not parts[1].isdigit():
                continue
            form = parts[0].lower()
            owners = form_index.get(form)
            if not owners:
                continue
            ws = weights[form]
            total_w = sum(ws)
            count = int(parts[1])
            for key, w in zip(owners, ws):
                totals[key] += count * w / total_w
    return totals


def level_for(rank):
    for limit, lvl in ((600, "A1"), (1500, "A2"), (3000, "B1"), (5500, "B2")):
        if rank <= limit:
            return lvl
    return "C1"


# ---------------------------------------------------------------- запись

def write_db(out, rows, lang):
    os.makedirs(os.path.dirname(out), exist_ok=True)
    if os.path.exists(out):
        os.remove(out)
    db = sqlite3.connect(out)
    db.executescript("""
    CREATE TABLE words (
      id             INTEGER PRIMARY KEY,
      lemma          TEXT NOT NULL,
      article        TEXT,
      gender         TEXT,
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
    CREATE TABLE info (key TEXT PRIMARY KEY, value TEXT);
    CREATE INDEX idx_words_rank  ON words(freq_rank);
    CREATE INDEX idx_words_level ON words(level);
    CREATE INDEX idx_words_pos   ON words(pos);
    CREATE UNIQUE INDEX idx_words_lemma_pos ON words(lemma, pos);
    """)
    db.executemany(
        "INSERT INTO words (lemma,article,gender,plural,pos,ipa,translation_en,senses_en,"
        "translation_ru,senses_ru,example_de,example_en,freq_rank,level) "
        "VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)", rows)
    db.executemany("INSERT INTO info (key,value) VALUES (?,?)",
                   [("lang", lang), ("name", LANGS[lang]["name"]), ("count", str(len(rows)))])
    db.executescript("""
    CREATE VIRTUAL TABLE words_fts USING fts5(
      lemma, translation_en, translation_ru, content='words', content_rowid='id');
    INSERT INTO words_fts(rowid, lemma, translation_en, translation_ru)
      SELECT id, lemma, translation_en, translation_ru FROM words;
    """)
    db.commit()
    db.execute("VACUUM")
    db.close()


def build(lang):
    cfg = LANGS[lang]
    data = os.path.join(ROOT, "data", lang)
    out = os.path.join(ROOT, "app", "db", f"wortschatz-{lang}.db")
    for f in ("main.jsonl", "ru.jsonl", "freq.txt"):
        if not os.path.exists(os.path.join(data, f)):
            print(f"[{lang}] нет {f} — сначала ./scripts/fetch_sources.sh {lang}")
            return

    print(f"\n[{lang}] {cfg['name']}")
    entries = load_main(os.path.join(data, "main.jsonl"), cfg)
    print(f"  лемм со значениями: {len(entries):,}", flush=True)

    ru_exact, ru_loose = load_ru(os.path.join(data, "ru.jsonl"), cfg)
    print(f"  статей с русским: {len(ru_loose):,}", flush=True)

    ranked = sorted(score(entries, os.path.join(data, "freq.txt")).items(), key=lambda kv: -kv[1])

    # Междометие и частица почти всегда дублируют то же слово в основной части речи
    # (und/conj + und/intj). Выкидываем дубль, освобождая место настоящему слову.
    seen = {w for (w, p), _ in ranked if p not in ("intj", "particle")}
    ranked = [(k, s) for k, s in ranked
              if not (k[1] in ("intj", "particle") and k[0] in seen)]
    print(f"  с ненулевой частотой: {len(ranked):,}", flush=True)

    rows, rank, with_ru = [], 0, 0
    for key, _ in ranked[:TARGET]:
        e = entries[key]
        rank += 1
        senses = rank_senses(e["senses"], e["pos"])
        ru = rank_senses(ru_exact.get(key) or ru_loose.get(e["word"]) or [], e["pos"], ru=True)
        if ru:
            with_ru += 1
        article = cfg["article"](e["word"], e["gender"]) if e["pos"] == "noun" else None
        ex_de, ex_en = e["examples"][0] if e["examples"] else (None, None)
        rows.append((
            e["word"], article, e["gender"], e["plural"], e["pos"], e["ipa"],
            senses[0], json.dumps(senses[:8], ensure_ascii=False),
            ru[0] if ru else None,
            json.dumps(ru[:8], ensure_ascii=False) if ru else None,
            ex_de, ex_en, rank, level_for(rank),
        ))

    write_db(out, rows, lang)
    pct = 100 * with_ru / len(rows) if rows else 0
    print(f"  готово: {len(rows):,} слов, русский у {with_ru:,} ({pct:.0f}%), "
          f"{os.path.getsize(out) / 1e6:.1f} МБ", flush=True)


if __name__ == "__main__":
    for lang in (sys.argv[1:] or list(LANGS)):
        if lang not in LANGS:
            sys.exit(f"неизвестный язык: {lang}; доступны: {', '.join(LANGS)}")
        build(lang)
