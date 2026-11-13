/**
 * The image attached in the search bar. A File cannot go into the URL, so the search page's URL carries a token
 * and the file stays here, in memory only: after a reload the image has to be attached again.
 */
let current: { token: string; file: File } | null = null;

export function setImageQuery(file: File): string {
  current = { token: Date.now().toString(36), file };
  return current.token;
}

export function getImageQuery(token: string | null): File | null {
  return token && current?.token === token ? current.file : null;
}

/** A quick check before uploading; the server decides by the file's content. */
export function looksLikeImage(file: File): boolean {
  return file.type === '' || file.type.startsWith('image/');
}
