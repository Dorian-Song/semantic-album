# Album API tests

Every `/api` request except `/api/health` needs the `X-API-Key` header, matching `ALBUM_API_KEY` in `Album/.env`. The web app gets it from the Vite dev proxy.

## Postman

1. Import `album.postman_collection.json` and `album-local.postman_environment.json`.
2. In the "Album local" environment, set `apiKey` to the value of `ALBUM_API_KEY`.
3. Start Album (`./start.sh`), then run the collection with the Runner.

## Command line

```bash
npx newman@6.2.1 run album.postman_collection.json -e album-local.postman_environment.json \
  --env-var "apiKey=$(grep ^ALBUM_API_KEY= ../.env | cut -d= -f2)" --timeout-request 120000
```

The tests run against the real library and undo what they change: test albums are deleted and the edited description is restored. Folder 5 calls DeepSeek, n8n and Baserow, so those must be configured.
