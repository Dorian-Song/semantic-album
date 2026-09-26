# Album UI concept set

These 15 images were generated with Codex's built-in GPT Image tool. They are visual concepts for discussion, not implementation-ready specifications. All intended product copy is in English. The interface is for one person running the application locally; it has no account or profile UI.

## Screens and dialogs

| Image | View |
| --- | --- |
| [01-home.png](01-home.png) | Home: welcome banner, My Albums, Recent Photos, search and import actions |
| [02-album.png](02-album.png) | Album: photo grid, album-scoped import, selection actions, two processing stages |
| [03-photo-detail.png](03-photo-detail.png) | Photo detail: previous/next navigation, thumbnail strip, album memberships, description |
| [04-search-results.png](04-search-results.png) | Search results: multi-album scope and one result per unique photo |
| [05-settings.png](05-settings.png) | Settings: search mode, description provider, local embedding, processing, optional n8n |
| [06-new-album.png](06-new-album.png) | New Album dialog |
| [07-import-folder.png](07-import-folder.png) | Folder import from Home, with an automatically suggested unique album name |
| [08-import-to-album.png](08-import-to-album.png) | Import files or a folder into the currently open album |
| [09-move-photo.png](09-move-photo.png) | Move one album membership to another album |
| [10-edit-description.png](10-edit-description.png) | Edit a generated photo description |
| [11-delete-album.png](11-delete-album.png) | Delete Album confirmation |
| [12-delete-photo.png](12-delete-photo.png) | Delete Photo from Library confirmation |
| [13-add-to-album.png](13-add-to-album.png) | Add a photo to another album without removing existing memberships |
| [14-rename-album.png](14-rename-album.png) | Rename Album dialog |
| [15-empty-album.png](15-empty-album.png) | Empty album with import actions |

`All Photos` can reuse the album-grid layout without an album header. The photo detail view should scroll when details exceed the viewport; previous/next buttons and keyboard arrows should follow the current album or search-result order. Returning to the grid should preserve scroll position, query, and selected albums.

## Behavior to implement

- Importing a folder from Home creates an album named after the folder. If the name already exists, propose the next free suffix, such as `Travel (2)`. The final unique name must be assigned by the backend when the album is created.
- Importing files or a folder from an open album adds photos to that album. The source folder is only an input; the app keeps its own copy. Duplicate bytes in the same album are skipped, while the same photo may belong to other albums.
- Search can target one album, several selected albums, or all albums. Each distinct photo appears once. Every result includes **all** of that photo's album names, including albums outside the search scope.
- `Add to Album` creates another membership. `Move to Album` adds the destination membership and removes the chosen source membership; other memberships remain. A destination that already contains the photo must not create a duplicate.
- `Remove from Album` affects one membership. `Delete from Library` removes all memberships. Deleting an album leaves photos shared with other albums there; photos that were only in the deleted album leave the library. Unreferenced local files are removed later after the backend safety delay. The delay is not a user-facing recovery feature.
- Store the AI-generated description and the user's edited description separately. The edited version wins in display and text search, survives reprocessing, and can be reset to the current AI draft.
- Omit unavailable metadata fields instead of showing invented locations or placeholder values. Show description and embedding progress separately.
- Use English throughout the product. No account avatar, login, or disk quota panel.

## Generation brief and review

The prompts described the product behavior, English-only copy, soft bright palette, accessible contrast, and local single-user use. They used the first refined concept as a visual reference, then requested each page or dialog by its user task. They did not establish a code layout or component library.

Before implementation, correct these image-generation artifacts: some photo-detail backgrounds still show speculative `Places`, `Favorites`, `Trash`, `Years`, `People`, and `Tags` navigation; the search results image shows an empty-result hint while results are visible; sample photo counts, model statuses, filenames and descriptions are illustrative. The navigation should be `Home`, `All Photos`, `Albums`, and `Settings`. The deletion copy should stay concise and must not promise undo.
