# Frontend structure and user flows

Use React, Vite, and TypeScript as the recommended lightweight frontend stack. The frontend calls only the local backend's REST API; it does not call the vision provider, vLLM, or n8n directly. Keep the UI in English, bright and soft, responsive, and operable by keyboard. The [English concept screens](../design/ui-concepts/README.md) are visual starting points; implement behavior according to this document even where a mockup omits a state.

## Proposed file tree

```text
apps/web/
  index.html
  src/
    main.tsx
    app/
      App.tsx
      routes.tsx
      providers.tsx              # query/cache and dialogs if needed
    api/
      client.ts                 # one REST client, error mapping
      albums.ts
      photos.ts
      imports.ts
      search.ts
      exports.ts
      settings.ts
      types.ts                  # shared API DTOs (or shared package)
    pages/
      HomePage.tsx              # banner, album list, recent photos
      AlbumPage.tsx             # one album and in-album import
      SearchResultsPage.tsx     # query, scope, mode, result grid
      PhotoDetailPage.tsx       # viewer, next/previous, edit, albums
      SettingsPage.tsx          # models, n8n, default search, progress
    components/
      layout/
        AppShell.tsx
        Header.tsx
      albums/
        AlbumCard.tsx
        AlbumList.tsx
        AlbumActionsMenu.tsx
      photos/
        PhotoGrid.tsx
        PhotoCard.tsx
        PhotoViewer.tsx
        PhotoFilmstrip.tsx
        AlbumBadges.tsx
      search/
        SearchBar.tsx
        SearchModePicker.tsx
        AlbumScopePicker.tsx
        MetadataFilters.tsx     # date range and camera, from /api/search/facets
      progress/
        ImportProgress.tsx
        ProcessingProgress.tsx
      dialogs/
        ImportPhotosDialog.tsx
        ImportFolderDialog.tsx
        CreateAlbumDialog.tsx
        RenameAlbumDialog.tsx
        MovePhotoDialog.tsx
        DeletePhotoDialog.tsx
        DeleteAlbumDialog.tsx
        EditDescriptionDialog.tsx
        ExportDialog.tsx
      common/
        EmptyState.tsx
        ErrorState.tsx
        ConfirmDialog.tsx
    hooks/
      useJobPolling.ts
      usePhotoNavigation.ts
      useSearchParams.ts
      useSearchStream.ts        # progressive NDJSON search, dedupe by asset ID
    styles/
      tokens.css
      global.css
```

These names describe responsibilities, not a requirement to create empty placeholder files. If the implementation can combine a few tiny components cleanly, do so. Keep server data in a small query/cache layer; local dialog/search-form state can stay in components. No global state framework is required for this prototype.

## Pages and interactions

| Page | Required behavior |
| --- | --- |
| Home `/` | Welcome banner, **My Albums**, **Recent Photos**, create/import actions, and search entry. No account avatar or disk-space meter. |
| Album `/albums/:id` | Album photos and actions to rename/delete/export the album. Import files directly into this album. Multi-select photos to move, remove, delete, or export them. Remove/move/delete photo actions should be reachable without ambiguity. |
| Results `/search?...` | Query plus **Words / Meaning / Both** mode, **Current album / Selected albums / All albums** scope, and optional **Date taken** and **Camera** filters. Show one card per global photo and every album name on it. Preserve all filters when opening a result and returning. |
| Detail `/photos/:id` | Full photo (served from the `display` endpoint so HEIC/AVIF render), description and tags, editable description with reset to AI draft, all album memberships, add/move/remove/delete actions, previous/next and scrollable thumbnail filmstrip. Show capture time, camera, and location only when present. Navigation follows the gallery or result list the user opened. |
| Settings `/settings` | DeepSeek (primary) and OpenAI (fallback) model/base URL/key, local embedding status, detected HEIC/AVIF decoders, n8n webhook URL/secret/status, search default, and bounded worker settings. Never display a saved API key or secret in full. |

Folder import creates a named album from the folder basename by default. Selected-file import is available both from Home (choose/create target album) and inside an album (target already selected). Explain that a typed folder path refers to the machine running the backend; a browser folder picker instead sends its selected files and creates an album from the selected root folder name. The import UI must distinguish import counts from caption and embedding counts; show queued, running, failed, and resumable states. After a browser-selected upload is interrupted, ask the user to reselect files that were not accepted. Do not call a photo “an upload in progress” after its local copy is complete while AI tasks continue.

Metadata filters appear only when the library has at least one photo with that field (from `/api/search/facets`). When a filter is active, state that photos without that metadata are not included, using the count returned by the backend. Hide the Date/Camera controls rather than showing empty pickers.

Progressive search (only when the backend enables `/api/search/stream`): render **Words** results as soon as they arrive, show a quiet "Looking for similar images…" line, then append new **Meaning** results below without moving cards already shown. Deduplicate by asset ID. If meaning search is unavailable, replace that line with an explicit message; never show an empty result without explanation.

Export opens a dialog that states what the ZIP will contain (original photos, descriptions, tags, album names; no embeddings), then shows job progress and a download button when ready. Import progress shows unsupported files by name and reason (for example "HEIC could not be decoded") instead of a bare failure count.

When a field such as location is absent, omit it instead of showing an empty row or invented value. Describe the cloud-image transfer before enabling AI captions, including that OpenAI receives a photo only when DeepSeek fails, and that caption text (not images) goes to the self-hosted n8n server. Provide loading, empty, and error states for each page and dialog. Delete actions must state whether they remove one album reference or the photo from the entire library. Use focus management, labels, sufficient contrast, and keyboard-accessible dialogs/navigation.
