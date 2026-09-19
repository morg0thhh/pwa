/* Прогресс пользователя. Живёт в IndexedDB отдельно от словарей:
   базы слов доступны только на чтение и заменяются целиком при обновлении
   приложения — прогресс это обязан пережить.

   Всё разделено по языкам: ключ карточки — (профиль, язык, слово).
   Иначе слово №42 немецкого и слово №42 итальянского были бы одной записью. */

const DB_NAME = "wortschatz-progress";
const DB_VERSION = 2;

const DAY = 86400000;
/* Слово считается выученным, когда интервал дорос до трёх недель:
   дальше оно всплывает несколько раз в год и почти не требует работы. */
const LEARNED_DAYS = 21;

let idb = null;

function open() {
  if (idb) return Promise.resolve(idb);
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = ({ target: { result: db } }) => {
      // Схема версии 1 была без языка; пересоздаём, миграция не нужна —
      // приложение ещё нигде не работало с реальными данными.
      for (const s of [...db.objectStoreNames]) db.deleteObjectStore(s);

      db.createObjectStore("profiles", { keyPath: "id", autoIncrement: true });

      const progress = db.createObjectStore("progress", { keyPath: ["profileId", "lang", "wordId"] });
      progress.createIndex("due", ["profileId", "lang", "due"]);
      progress.createIndex("profile", ["profileId", "lang"]);

      const reviews = db.createObjectStore("reviews", { keyPath: "id", autoIncrement: true });
      reviews.createIndex("day", ["profileId", "lang", "day"]);

      db.createObjectStore("meta", { keyPath: "key" });
    };
    req.onsuccess = () => resolve((idb = req.result));
    req.onerror = () => reject(req.error);
  });
}

function tx(stores, mode, fn) {
  return open().then(
    (db) =>
      new Promise((resolve, reject) => {
        const t = db.transaction(stores, mode);
        const result = fn(...stores.map((s) => t.objectStore(s)));
        t.oncomplete = () => resolve(result?.value ?? result);
        t.onerror = () => reject(t.error);
        t.onabort = () => reject(t.error);
      })
  );
}

const wrap = (req) => ({ get value() { return req.result; } });
const today = () => new Date().toISOString().slice(0, 10);
const endOfToday = () => {
  const d = new Date();
  d.setHours(23, 59, 59, 999);
  return d.getTime();
};

export const meta = {
  get: async (key) => (await tx(["meta"], "readonly", (s) => wrap(s.get(key))))?.value ?? null,
  set: (key, value) => tx(["meta"], "readwrite", (s) => wrap(s.put({ key, value }))),
};

/* Указатель — докуда по частотному списку дошли. Свой на каждый язык. */
export const pointer = {
  get: async (profileId, lang) => (await meta.get(`pointer:${profileId}:${lang}`)) ?? 0,
  set: (profileId, lang, rank) => meta.set(`pointer:${profileId}:${lang}`, rank),
};

/* ---------- профили ---------- */

export const profiles = {
  list: () => tx(["profiles"], "readonly", (s) => wrap(s.getAll())),
  get: (id) => tx(["profiles"], "readonly", (s) => wrap(s.get(id))),

  async create({ name, lang, startRank = 0, dailyNew = 15 }) {
    const id = await tx(["profiles"], "readwrite", (s) =>
      wrap(s.add({ name, lang, dailyNew, createdAt: Date.now() }))
    );
    // Стартовый сдвиг позволяет не прогонять заново то, что человек уже знает.
    await pointer.set(id, lang, startRank);
    await meta.set("activeProfile", id);
    return id;
  },

  update: (p) => tx(["profiles"], "readwrite", (s) => wrap(s.put(p))),

  async remove(id) {
    await tx(["profiles", "progress", "reviews"], "readwrite", (p, pr, rv) => {
      p.delete(id);
      for (const [store, index] of [[pr, "profile"], [rv, "day"]]) {
        const cur = store.index(index).openCursor(
          IDBKeyRange.bound([id], [id, "￿", "￿"])
        );
        cur.onsuccess = ({ target: { result } }) => {
          if (result) { result.delete(); result.continue(); }
        };
      }
    });
    if ((await meta.get("activeProfile")) === id) await meta.set("activeProfile", null);
  },
};

/* ---------- SM-2 ---------- */

/* Оценки: 0 — не вспомнил, 1 — тяжело, 2 — нормально, 3 — легко.
   Классический SM-2 из Anki: интервал растёт множителем «лёгкости»,
   который сам подстраивается под то, как человек отвечает. */
export function schedule(card, grade) {
  let { ease = 2.5, interval = 0, reps = 0, lapses = 0 } = card || {};

  if (grade === 0) {
    reps = 0;
    lapses += 1;
    interval = 0;                       // вернётся сегодня же
    ease = Math.max(1.3, ease - 0.2);
  } else {
    reps += 1;
    if (reps === 1) interval = grade === 3 ? 3 : 1;
    else if (reps === 2) interval = grade === 1 ? 3 : 6;
    else {
      const mult = grade === 1 ? 1.2 : grade === 3 ? ease * 1.3 : ease;
      interval = Math.round(interval * mult);
    }
    ease = Math.max(1.3, ease + (grade === 1 ? -0.15 : grade === 3 ? 0.15 : 0));
  }

  return {
    ease: Math.round(ease * 100) / 100,
    interval,
    reps,
    lapses,
    due: Date.now() + interval * DAY,
    reviewedAt: Date.now(),
  };
}

/* ---------- карточки ---------- */

export const cards = {
  get: (profileId, lang, wordId) =>
    tx(["progress"], "readonly", (s) => wrap(s.get([profileId, lang, wordId]))),

  /* Слова, у которых подошёл срок. Верхняя граница — конец суток,
     чтобы всё запланированное на сегодня попало в сессию. */
  due: (profileId, lang, limit = 120) =>
    tx(["progress"], "readonly", (s) => {
      const out = [];
      const cur = s.index("due").openCursor(
        IDBKeyRange.bound([profileId, lang, 0], [profileId, lang, endOfToday()])
      );
      cur.onsuccess = ({ target: { result } }) => {
        if (result && out.length < limit) { out.push(result.value); result.continue(); }
      };
      return { get value() { return out; } };
    }),

  async review(profileId, lang, wordId, grade, isNew) {
    const card = await cards.get(profileId, lang, wordId);
    const next = schedule(card, grade);
    await tx(["progress", "reviews"], "readwrite", (p, r) => {
      p.put({ profileId, lang, wordId, ...next });
      r.add({ profileId, lang, wordId, grade, day: today(), at: Date.now(), isNew: !!isNew });
    });
    return next;
  },

  async stats(profileId, lang) {
    const all = await tx(["progress"], "readonly", (s) =>
      wrap(s.index("profile").getAll(IDBKeyRange.only([profileId, lang])))
    );
    const now = endOfToday();
    return {
      seen: all.length,
      learned: all.filter((c) => c.interval >= LEARNED_DAYS).length,
      learning: all.filter((c) => c.interval < LEARNED_DAYS).length,
      due: all.filter((c) => c.due <= now).length,
    };
  },

  /* История повторений по дням — для графика и для подсчёта серии. */
  async history(profileId, lang, days = 30) {
    const rows = await tx(["reviews"], "readonly", (s) =>
      wrap(s.index("day").getAll(IDBKeyRange.bound([profileId, lang, ""], [profileId, lang, "￿"])))
    );
    const byDay = new Map();
    for (const r of rows) byDay.set(r.day, (byDay.get(r.day) || 0) + 1);

    const out = [];
    for (let i = days - 1; i >= 0; i--) {
      out.push({
        day: new Date(Date.now() - i * DAY).toISOString().slice(0, 10),
        n: 0,
      });
    }
    for (const d of out) d.n = byDay.get(d.day) || 0;

    // Серия: сколько дней подряд были повторения. Сегодняшний пропуск
    // серию не рвёт — день ещё не кончился.
    let streak = 0;
    for (let i = 0; ; i++) {
      const day = new Date(Date.now() - i * DAY).toISOString().slice(0, 10);
      if (byDay.get(day)) streak++;
      else if (i > 0) break;
    }
    return { days: out, streak, total: rows.length };
  },

  newToday: async (profileId, lang) => {
    const rows = await tx(["reviews"], "readonly", (s) =>
      wrap(s.index("day").getAll(IDBKeyRange.only([profileId, lang, today()])))
    );
    return rows.filter((r) => r.isNew).length;
  },
};
