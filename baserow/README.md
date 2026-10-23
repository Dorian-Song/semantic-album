# Baserow (self-hosted, local)

A local Baserow instance holds a text-only copy of Album's albums, photo descriptions and tags. SQLite stays the source of truth; Album keeps working when Baserow is down.

- Start: `docker compose up -d --build` in this folder. First start takes a minute or two.
- The image is stock Baserow plus a **DeepSeek** AI provider added by `patch_deepseek.py` (OpenAI Responses adapter, default base URL `https://api.deepseek.com`, suggested model `deepseek-flash`). The build fails loudly if a Baserow upgrade moves the patched code.
- Open <http://localhost:8085>. The first sign-up becomes the instance admin.
- Kuma (AI assistant): **Admin tools → AI providers**, add a **DeepSeek** provider with your API key, then enable it for Kuma under **AI features**.
- Logs: `docker logs -f album-baserow`
- `docker compose stop` keeps the data; `docker compose down -v` deletes it.

## Tables

Create a database with three tables (we asked Kuma to do it): **Albums** (Name, Photo count, Created date), **Photos** (SHA-256 ID, File name, Caption, Captured at, Camera) and **Tags** (Name, Photo count = `count(field('Photos'))`). Link Photos ↔ Albums and Photos ↔ Tags (many-to-many). Put the table ids and a database token in `Album/.env`; Album fills the tables itself.
