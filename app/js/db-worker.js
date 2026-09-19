/* Воркер с SQLite. Живёт в отдельном потоке: загрузка базы занимает
   сотни миллисекунд, и в главном потоке она бы заморозила интерфейс.
   Снаружи общение асинхронное (сообщения), внутри — обычный синхронный SQL. */

importScripts("../vendor/sql-wasm.js");

let SQL = null;
let db = null;
let loaded = null;   // какой язык сейчас открыт

async function use(lang) {
  if (loaded === lang) return;
  SQL ||= await initSqlJs({ locateFile: (f) => `../vendor/${f}` });

  const res = await fetch(`../db/wortschatz-${lang}.db`);
  if (!res.ok) throw new Error(`словарь «${lang}» не загрузился: HTTP ${res.status}`);
  const bytes = new Uint8Array(await res.arrayBuffer());

  // Базы держатся в памяти целиком, поэтому предыдущую закрываем:
  // три языка одновременно — это лишние десятки мегабайт на телефоне.
  db?.close();
  db = new SQL.Database(bytes);
  loaded = lang;
}

/* sql.js отдаёт результат как {columns, values}; для UI удобнее объекты. */
function query(sql, params = []) {
  const stmt = db.prepare(sql);
  stmt.bind(params);
  const rows = [];
  while (stmt.step()) rows.push(stmt.getAsObject());
  stmt.free();
  return rows;
}

const handlers = {
  info: () => Object.fromEntries(query("SELECT key, value FROM info").map((r) => [r.key, r.value])),

  stats: () =>
    query(`SELECT level, COUNT(*) AS n FROM words GROUP BY level ORDER BY MIN(freq_rank)`),

  /* Новые слова выдаются строго по частотности: указатель профиля хранит,
     докуда дошли, поэтому исключать уже пройденное не нужно. */
  newWords: ({ afterRank = 0, limit = 20 }) =>
    query(`SELECT * FROM words WHERE freq_rank > ? ORDER BY freq_rank LIMIT ?`,
          [afterRank, limit]),

  /* Карточки на повторение: id приходят из IndexedDB, значит порядок
     задаётся снаружи и восстанавливается после выборки. */
  byIds: ({ ids }) => {
    if (!ids?.length) return [];
    const rows = query(
      `SELECT * FROM words WHERE id IN (${ids.map(() => "?").join(",")})`, ids);
    const map = new Map(rows.map((r) => [r.id, r]));
    return ids.map((id) => map.get(id)).filter(Boolean);
  },

  /* FTS5 ищет по префиксу: "hau" находит Haus. Кавычки вокруг терма
     обязательны — иначе спецсимволы из ввода ломают синтаксис запроса. */
  search: ({ q, limit = 25 }) => {
    const term = q.trim().replace(/"/g, '""');
    if (!term) return [];
    return query(
      `SELECT w.* FROM words_fts f JOIN words w ON w.id = f.rowid
       WHERE words_fts MATCH ? ORDER BY w.freq_rank LIMIT ?`,
      [`"${term}"*`, limit]
    );
  },
};

self.onmessage = async ({ data: { id, action, lang, payload } }) => {
  try {
    await use(lang);
    self.postMessage({ id, ok: true, result: handlers[action](payload || {}) });
  } catch (e) {
    self.postMessage({ id, ok: false, error: e.message });
  }
};
