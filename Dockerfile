# Раздача готового приложения. Внутри только статика:
# HTML/JS/CSS, sql.js (wasm) и собранный словарь wortschatz.db.
FROM nginx:1.27-alpine

COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY app/       /usr/share/nginx/html/

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s \
  CMD wget -qO- http://127.0.0.1/index.html >/dev/null || exit 1

EXPOSE 80
