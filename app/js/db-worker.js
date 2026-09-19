/* Воркер с SQLite. Живёт в отдельном потоке: загрузка базы занимает
   сотни миллисекунд, и в главном потоке она бы заморозила интерфейс.
   Снаружи общение асинхронное (сообщения), внутри — обычный синхронный SQL. */

importScripts("../vendor/sql-wasm.js");

let db = null;

async function open() {
  const SQL = await initSqlJs({ locateFile: (f) => `../vendor/${f}` });
  const res = await fetch("../wortschatz.db");
  if (!res.ok) throw new Error(`словарь не загрузился: HTTP ${res.status}`);
  db = new SQL.Database(new Uint8Array(await res.arrayBuffer()));
}

/* sql.js отдаёт результат в виде {columns, values}; для UI удобнее объекты. */
function query(sql, params = []) {
  const stmt = db.prepare(sql);
  stmt.bind(params);
  const rows = [];
  while (stmt.step()) rows.push(stmt.getAsObject());
  stmt.free();
  return rows;
}

const handlers = {
  stats: () =>
    query(`SELECT level, COUNT(*) AS n FROM words
           GROUP BY level ORDER BY MIN(freq_rank)`),

  random: ({ level }) =>
    query(
      `SELECT * FROM words ${level ? "WHERE level = ?" : ""}
       ORDER BY RANDOM() LIMIT 1`,
      level ? [level] : []
    )[0] || null,

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

self.onmessage = async ({ data: { id, action, payload } }) => {
  try {
    if (!db) await open();
    self.postMessage({ id, ok: true, result: handlers[action](payload || {}) });
  } catch (e) {
    self.postMessage({ id, ok: false, error: e.message });
  }
};
