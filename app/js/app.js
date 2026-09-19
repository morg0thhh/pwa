/* Тонкий слой поверх воркера: шлёт запрос, ждёт ответ с тем же id. */
const worker = new Worker("js/db-worker.js");
const pending = new Map();
let seq = 0;

worker.onmessage = ({ data: { id, ok, result, error } }) => {
  const { resolve, reject } = pending.get(id) || {};
  pending.delete(id);
  ok ? resolve?.(result) : reject?.(new Error(error));
};

const ask = (action, payload) =>
  new Promise((resolve, reject) => {
    const id = ++seq;
    pending.set(id, { resolve, reject });
    worker.postMessage({ id, action, payload });
  });

const $ = (sel) => document.querySelector(sel);
const card = $("#card");
let current = null;
let level = "";

function render(w) {
  current = w;
  if (!w) {
    card.innerHTML = `<p class="empty">на этом уровне слов нет</p>`;
    return;
  }
  const senses = (json) => {
    try {
      return JSON.parse(json || "[]").slice(1);
    } catch {
      return [];
    }
  };
  const extraEn = senses(w.senses_en);
  const extraRu = senses(w.senses_ru);

  card.innerHTML = `
    <div class="meta">
      <span class="badge">${w.level}</span>
      <span class="badge muted">${w.pos}</span>
      <span class="rank">#${w.freq_rank}</span>
    </div>
    <h2 class="lemma">${w.article ? `<span class="art">${w.article}</span> ` : ""}${w.lemma}</h2>
    ${w.plural ? `<p class="grammar">мн. ч. — ${w.plural}</p>` : ""}
    ${w.ipa ? `<p class="ipa">${w.ipa}</p>` : ""}

    <div class="back" hidden>
      <p class="tr ru">${w.translation_ru || "<i>нет русского перевода</i>"}</p>
      <p class="tr en">${w.translation_en}</p>
      ${extraRu.length ? `<p class="more">ещё: ${extraRu.join("; ")}</p>` : ""}
      ${extraEn.length ? `<p class="more">also: ${extraEn.join("; ")}</p>` : ""}
      ${w.example_de ? `<blockquote>${w.example_de}<span>${w.example_en || ""}</span></blockquote>` : ""}
    </div>`;
}

const reveal = () => card.querySelector(".back")?.removeAttribute("hidden");

async function next() {
  card.classList.add("loading");
  render(await ask("random", { level }));
  card.classList.remove("loading");
}

$("#reveal").onclick = reveal;
$("#next").onclick = next;

/* Пробел показывает перевод, стрелка вправо — следующее слово.
   В поле поиска клавиши не перехватываем. */
document.addEventListener("keydown", (e) => {
  if (e.target.tagName === "INPUT") return;
  if (e.code === "Space") {
    e.preventDefault();
    current && (card.querySelector(".back")?.hidden ? reveal() : next());
  }
  if (e.code === "ArrowRight") next();
});

$("#level").onchange = (e) => {
  level = e.target.value;
  next();
};

let searchTimer;
$("#q").oninput = (e) => {
  clearTimeout(searchTimer);
  const q = e.target.value;
  // Ждём паузу в наборе, иначе запрос уходит на каждую букву.
  searchTimer = setTimeout(async () => {
    const box = $("#results");
    if (!q.trim()) return box.replaceChildren();
    const rows = await ask("search", { q });
    box.innerHTML = rows.length
      ? rows
          .map(
            (w) => `<li><b>${w.article ? w.article + " " : ""}${w.lemma}</b>
                    <span>${w.translation_ru || w.translation_en}</span></li>`
          )
          .join("")
      : `<li class="empty">ничего не найдено</li>`;
  }, 200);
};

(async () => {
  try {
    const stats = await ask("stats");
    const total = stats.reduce((s, r) => s + r.n, 0);
    $("#stats").textContent =
      `${total.toLocaleString("ru")} слов · ` + stats.map((r) => `${r.level} ${r.n}`).join(" · ");
    await next();
  } catch (e) {
    card.innerHTML = `<p class="empty">не удалось открыть словарь: ${e.message}</p>`;
  }
})();

if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("sw.js").catch(() => {});
}
