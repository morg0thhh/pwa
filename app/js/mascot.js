/* Маскот — печенька. Появляется в двух местах: на приветственном экране
   и как награда, когда дневная норма закрыта.

   Работает с одной картинкой: app/mascot/base.png.
   Если нарисуешь отдельные позы, положи их рядом под этими именами —
   они подхватятся автоматически, менять код не нужно:

     idle.png       спокойное ожидание
     celebrate.png  день закрыт

   Файла нет — берётся base.png. Нет и его — блок схлопывается,
   и приложение работает без картинки. */

const EXT = "png";
const BASE = `mascot/base.${EXT}`;

/* Какие позы реально лежат на диске. Проверяется один раз:
   иначе каждый показ давал бы промах и мигание картинки. */
const poses = new Map();

function probe(state) {
  if (!poses.has(state)) {
    poses.set(state, new Promise((resolve) => {
      const img = new Image();
      img.onload = () => resolve(`mascot/${state}.${EXT}`);
      img.onerror = () => resolve(BASE);
      img.src = `mascot/${state}.${EXT}`;
    }));
  }
  return poses.get(state);
}

export const mascot = {
  /* Заполняет уже существующие .mascot-slot в разметке. */
  mount(root = document, state = "idle") {
    for (const slot of root.querySelectorAll(".mascot-slot")) this.render(slot, state);
  },

  async render(slot, state = "idle") {
    if (!slot) return;
    const src = await probe(state);
    let img = slot.querySelector("img");
    if (!img) {
      img = document.createElement("img");
      img.alt = "";
      img.onerror = () => slot.classList.add("no-art");
      slot.append(img);
    }
    if (img.getAttribute("src") !== src) img.src = src;
    slot.dataset.state = state;
  },
};

/* Похвала за закрытый день. Чем длиннее серия, тем сильнее формулировка. */
export function praise(streak) {
  const pools = [
    ["красавчик", "молодчик", "день закрыт", "чисто сработано"],
    ["третий день подряд — идёт", "втягиваешься", "ритм поймал"],
    ["неделя подряд, это уже привычка", "так и набирается словарь", "стабильно"],
    ["месяц без пропусков — сильно", "это уже дисциплина", "мало кто так может"],
  ];
  const pool = streak >= 30 ? pools[3] : streak >= 7 ? pools[2] : streak >= 3 ? pools[1] : pools[0];
  return pool[Math.floor(Math.random() * pool.length)];
}
