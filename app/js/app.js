import { profiles, meta, cards, pointer } from "./progress.js";
import { mascot, praise } from "./mascot.js";

/* Языки, для которых собран словарь. Коды совпадают с именами файлов
   app/db/wortschatz-<код>.db и с ключами LANGS в scripts/build_db.py. */
export const LANGS = [
  { code: "de", name: "немецкий", flag: "🇩🇪" },
  { code: "it", name: "итальянский", flag: "🇮🇹" },
  { code: "en", name: "английский", flag: "🇬🇧" },
];

/* ---------- связь с воркером ---------- */

const worker = new Worker("js/db-worker.js");
const pending = new Map();
let seq = 0;

worker.onmessage = ({ data: { id, ok, result, error } }) => {
  const p = pending.get(id);
  pending.delete(id);
  ok ? p?.resolve(result) : p?.reject(new Error(error));
};

const ask = (action, payload) =>
  new Promise((resolve, reject) => {
    const id = ++seq;
    pending.set(id, { resolve, reject });
    worker.postMessage({ id, action, lang, payload });
  });

/* ---------- мелочи ---------- */

const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];
const esc = (s) =>
  String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const plural = (n, one, few, many) => {
  const m10 = n % 10, m100 = n % 100;
  if (m10 === 1 && m100 !== 11) return one;
  if (m10 >= 2 && m10 <= 4 && (m100 < 10 || m100 >= 20)) return few;
  return many;
};
const show = (view) => $$(".view").forEach((v) => (v.hidden = v.id !== view));
/* При элизии артикль сливается со словом: l'alleanza, но la causa. */
const withArticle = (w, wrap = (a) => a) =>
  w.article ? wrap(esc(w.article)) + (w.article.endsWith("'") ? "" : " ") + esc(w.lemma) : esc(w.lemma);

/* ---------- состояние ---------- */

let profile = null;
let lang = "de";
let queue = [];
let pos = 0;
let revealed = false;
/* Какие словари реально лежат на сервере. Языков в списке может быть больше,
   чем собранных баз, — кнопка недоступного языка не должна вести в ошибку. */
let ready = new Set(LANGS.map((l) => l.code));
let session = { done: 0, fresh: 0, missed: 0 };   // итоги текущего захода

/* ---------- онбординг и профили ---------- */

function renderLangChoice() {
  const list = LANGS.filter((l) => ready.has(l.code));
  $("#langChoice").innerHTML = list.map(
    (l, i) => `<label><input type="radio" name="lang" value="${l.code}" ${i ? "" : "checked"}>
               <b>${l.flag} ${l.name}</b><span>10 000 слов по частотности</span></label>`
  ).join("");
}

$("#daily").oninput = (e) => ($("#dailyOut").textContent = e.target.value);

$("#createProfile").onclick = async () => {
  const id = await profiles.create({
    name: $("#newName").value.trim() || "Без имени",
    lang: $('input[name="lang"]:checked').value,
    startRank: +$('input[name="start"]:checked').value,
    dailyNew: +$("#daily").value,
  });
  await startSession(id);
};

$("#toProfiles").onclick = (e) => { e.preventDefault(); renderProfiles(); };
$("#addProfile").onclick = () => show("onboarding");
$("#switchProfile").onclick = () => renderProfiles();

async function renderProfiles() {
  const list = await profiles.list();
  if (!list.length) return show("onboarding");
  $("#profileList").innerHTML = list.map((p) => {
    const l = LANGS.find((x) => x.code === p.lang) || LANGS[0];
    return `<li><button data-id="${p.id}"><b>${esc(p.name)}</b>
            <span>${l.flag} ${l.name} · ${p.dailyNew} новых в день</span></button></li>`;
  }).join("");
  $$("#profileList button").forEach((b) => (b.onclick = () => startSession(+b.dataset.id)));
  show("profiles");
}

async function startSession(id) {
  profile = await profiles.get(id);
  lang = profile.lang || "de";
  await meta.set("activeProfile", id);
  $("#whoName").textContent = profile.name;
  renderLangSwitch();
  show("main");
  switchTab("study");
  await buildQueue();
}

/* ---------- переключение языка ---------- */

async function detectLangs() {
  const checks = await Promise.all(LANGS.map(async (l) => {
    try {
      const r = await fetch(`db/wortschatz-${l.code}.db`, { method: "HEAD" });
      return r.ok ? l.code : null;
    } catch {
      return null;
    }
  }));
  const found = checks.filter(Boolean);
  // Пустой ответ значит, что мы офлайн и HEAD не прошёл, — тогда не отключаем
  // ничего, пусть решает кэш service worker.
  if (found.length) ready = new Set(found);
}

function renderLangSwitch() {
  $("#langSwitch").innerHTML = LANGS.map((l) => {
    const off = !ready.has(l.code);
    return `<button role="tab" data-lang="${l.code}" aria-selected="${l.code === lang}"
             class="${l.code === lang ? "active" : ""}" ${off ? "disabled" : ""}
             title="${off ? "словарь ещё не собран" : ""}">${l.flag} ${l.name}</button>`;
  }).join("");
  $$("#langSwitch button:not([disabled])").forEach((b) => (b.onclick = () => setLang(b.dataset.lang)));
}

async function setLang(code) {
  if (code === lang) return;
  lang = code;
  profile.lang = code;                 // язык запоминается у профиля
  await profiles.update(profile);
  renderLangSwitch();
  $("#card").innerHTML = `<p class="empty">загружаю словарь…</p>`;
  await buildQueue();
  if (!$("#tab-stats").hidden) renderStats();
}

/* ---------- очередь на сегодня ---------- */

async function buildQueue() {
  try {
    const due = await cards.due(profile.id, lang, 120);
    const reviews = due.length
      ? (await ask("byIds", { ids: due.map((c) => c.wordId) })).map((w) => ({ word: w, isNew: false }))
      : [];

    const doneNew = await cards.newToday(profile.id, lang);
    const allowance = Math.max(0, profile.dailyNew - doneNew);
    const from = await pointer.get(profile.id, lang);
    const fresh = allowance
      ? (await ask("newWords", { afterRank: from, limit: allowance })).map((w) => ({ word: w, isNew: true }))
      : [];

    // Новые вперемешку с повторениями: подряд идущие незнакомые слова
    // утомляют и хуже запоминаются.
    queue = [];
    while (reviews.length || fresh.length) {
      for (let i = 0; i < 3 && reviews.length; i++) queue.push(reviews.shift());
      if (fresh.length) queue.push(fresh.shift());
    }
    pos = 0;
    session = { done: 0, fresh: 0, missed: 0 };
    renderCard();
    updateQueueInfo();
  } catch (e) {
    $("#card").innerHTML = `<p class="empty">не удалось открыть словарь: ${esc(e.message)}</p>`;
  }
}

function updateQueueInfo() {
  const left = queue.length - pos;
  $("#queueInfo").textContent = left
    ? `${left} ${plural(left, "карточка", "карточки", "карточек")} в очереди`
    : "на сегодня всё";
}

/* ---------- карточка ---------- */

function renderCard() {
  const item = queue[pos];
  const card = $("#card");
  revealed = false;

  if (!item) {
    $("#gradeBar").hidden = true;
    $("#revealBar").hidden = true;
    renderDone();
    return;
  }

  const w = item.word;
  const extra = (json) => {
    try { return JSON.parse(json || "[]").slice(1, 4); } catch { return []; }
  };

  $("#gradeBar").hidden = true;
  $("#revealBar").hidden = false;

  card.innerHTML = `
    <div class="meta">
      ${item.isNew ? `<span class="badge new">новое</span>` : `<span class="badge">повторение</span>`}
      <span class="badge muted">${esc(w.level)}</span>
      <span class="badge muted">${esc(w.pos)}</span>
      <span class="rank">#${w.freq_rank}</span>
    </div>
    <h2 class="lemma">${withArticle(w, (a) => `<span class="art">${a}</span>`)}</h2>
    ${w.plural ? `<p class="grammar">мн. ч. — ${esc(w.plural)}</p>` : ""}
    ${w.ipa ? `<p class="ipa">${esc(w.ipa)}</p>` : ""}
    <div class="back" hidden>
      <p class="tr ru">${w.translation_ru ? esc(w.translation_ru) : "<i>нет русского перевода</i>"}</p>
      <p class="tr en">${esc(w.translation_en)}</p>
      ${extra(w.senses_ru).length ? `<p class="more">ещё: ${esc(extra(w.senses_ru).join("; "))}</p>` : ""}
      ${w.example_de ? `<blockquote>${esc(w.example_de)}<span>${esc(w.example_en || "")}</span></blockquote>` : ""}
    </div>`;
}

/* День закрыт — единственное место, где появляется печенька. */
async function renderDone() {
  const card = $("#card");
  const { streak } = await cards.history(profile.id, lang, 1);
  const st = await cards.stats(profile.id, lang);

  // Заход мог быть пустым: человек открыл приложение, когда всё уже сделано.
  const worked = session.done > 0;

  card.innerHTML = `
    <div class="done">
      <div class="mascot-slot xl" data-state="celebrate"></div>
      <h2>${worked ? esc(praise(streak)) : "на сегодня всё"}</h2>
      ${worked ? `<p class="done-line">
        ${session.done} ${plural(session.done, "карточка", "карточки", "карточек")}
        ${session.fresh ? `· ${session.fresh} ${plural(session.fresh, "новое", "новых", "новых")}` : ""}
        ${session.missed ? `· ${session.missed} на потом` : ""}
      </p>` : `<p class="done-line">Очередь пуста — приходи завтра.</p>`}
      <div class="done-stats">
        <div><b>${streak}</b><span>${plural(streak, "день", "дня", "дней")} подряд</span></div>
        <div><b>${st.learned}</b><span>выучено</span></div>
        <div><b>${st.seen}</b><span>в работе</span></div>
      </div>
      <p class="done-hint">Новые слова и повторения появятся завтра.
         Хочешь больше сегодня — подними дневную норму.</p>
    </div>`;

  mascot.render(card.querySelector(".mascot-slot"), "celebrate");
}

function reveal() {
  const back = $("#card .back");
  if (!back || revealed) return;
  back.hidden = false;
  revealed = true;
  $("#revealBar").hidden = true;
  $("#gradeBar").hidden = false;
}

async function grade(g) {
  const item = queue[pos];
  if (!item || !revealed) return;

  await cards.review(profile.id, lang, item.word.id, g, item.isNew);
  if (item.isNew) await pointer.set(profile.id, lang, item.word.freq_rank);

  session.done++;
  if (item.isNew) session.fresh++;
  if (g === 0) {
    session.missed++;
    // «Не помню» — слово возвращается в эту же сессию через пару карточек.
    queue.splice(Math.min(pos + 3, queue.length), 0, { ...item, isNew: false });
  }

  pos++;
  renderCard();
  updateQueueInfo();
}

$("#reveal").onclick = reveal;
$$("#gradeBar button").forEach((b) => (b.onclick = () => grade(+b.dataset.grade)));

document.addEventListener("keydown", (e) => {
  if (e.target.tagName === "INPUT" || $("#main").hidden || $("#tab-study").hidden) return;
  if (e.code === "Space") { e.preventDefault(); reveal(); }
  if (["Digit1", "Digit2", "Digit3", "Digit4"].includes(e.code)) grade(+e.code.slice(-1) - 1);
});

/* ---------- вкладки ---------- */

function switchTab(name) {
  $$(".tabs button").forEach((b) => b.classList.toggle("active", b.dataset.tab === name));
  $$(".tab").forEach((t) => (t.hidden = t.id !== `tab-${name}`));
  if (name === "stats") renderStats();
}
$$(".tabs button").forEach((b) => (b.onclick = () => switchTab(b.dataset.tab)));

/* ---------- поиск ---------- */

let searchTimer;
const runSearch = async () => {
  const q = $("#q").value;
  const box = $("#results");
  if (!q.trim()) return box.replaceChildren();
  const rows = await ask("search", { q });
  const lvl = $("#level").value;
  const shown = lvl ? rows.filter((r) => r.level === lvl) : rows;
  box.innerHTML = shown.length
    ? shown.map((w) => `<li><b>${withArticle(w)}</b>
        <span>${esc(w.translation_ru || w.translation_en)}</span></li>`).join("")
    : `<li class="empty">ничего не найдено</li>`;
};
$("#q").oninput = () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(runSearch, 200);   // ждём паузу в наборе
};
$("#level").onchange = runSearch;

/* ---------- прогресс ---------- */

async function renderStats() {
  const [st, hist, byLevel] = await Promise.all([
    cards.stats(profile.id, lang),
    cards.history(profile.id, lang, 30),
    ask("stats"),
  ]);
  const total = byLevel.reduce((s, r) => s + r.n, 0);

  $("#tiles").innerHTML = [
    ["выучено", st.learned, "интервал больше трёх недель"],
    ["в работе", st.learning, "ещё не закрепились"],
    ["дней подряд", hist.streak, "серия занятий"],
    ["пройдено", `${Math.round((st.seen / total) * 100)}%`, `${st.seen} из ${total.toLocaleString("ru")}`],
  ].map(([label, value, hint]) =>
    `<div class="tile"><b>${value}</b><span>${label}</span><i>${hint}</i></div>`).join("");

  renderChart(hist.days);

  const l = LANGS.find((x) => x.code === lang);
  $("#levelBreak").innerHTML = `<p class="muted-line">Словарь (${l.name}) по уровням: ` +
    byLevel.map((r) => `${r.level} — ${r.n}`).join(" · ") + `</p>`;
}

/* Один ряд значений — легенда не нужна, подпись фигуры называет его сама.
   Столбцы тонкие, со скруглённым верхом и зазором в 2px. */
function renderChart(days) {
  const max = Math.max(1, ...days.map((d) => d.n));
  const fmt = (iso) => { const [, m, d] = iso.split("-"); return `${+d}.${+m}`; };
  $("#chart").innerHTML = `
    <div class="chart-scale"><span>${max}</span><span>0</span></div>
    <div class="bars">
      ${days.map((d) => `
        <div class="bar-slot" tabindex="0"
             aria-label="${fmt(d.day)}: ${d.n} ${plural(d.n, "повторение", "повторения", "повторений")}">
          <div class="bar" style="height:${d.n ? Math.max(3, (d.n / max) * 100) : 0}%"></div>
          <div class="tip">${fmt(d.day)} — ${d.n}</div>
        </div>`).join("")}
    </div>
    <div class="chart-axis"><span>${fmt(days[0].day)}</span><span>сегодня</span></div>`;
}

/* ---------- удаление профиля ---------- */

$("#resetProfile").onclick = async () => {
  if (!confirm(`Удалить профиль «${profile.name}» со всем прогрессом по всем языкам? Отменить будет нельзя.`)) return;
  await profiles.remove(profile.id);
  profile = null;
  await renderProfiles();
};

/* ---------- старт ---------- */

(async () => {
  try {
    mascot.mount();
    await detectLangs();
    renderLangChoice();
    const list = await profiles.list();
    const active = await meta.get("activeProfile");
    if (active && list.some((p) => p.id === active)) await startSession(active);
    else if (list.length) await renderProfiles();
    else show("onboarding");
  } catch (e) {
    document.body.innerHTML = `<p class="empty">не удалось запустить приложение: ${esc(e.message)}</p>`;
  }
})();

if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(() => {});
