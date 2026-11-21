/**
 * Glue for the hand-written folder browser in public/legacy/folder-browser (plain HTML, CSS and JavaScript,
 * kept for comparison with the React version). Its files are loaded the first time it is opened.
 */
declare global {
  interface Window {
    LegacyFolderBrowser?: { open(options: { startPath?: string; onSelect(path: string): void; onCancel?(): void }): void };
  }
}

const BASE = '/legacy/folder-browser/';
let loading: Promise<void> | null = null;

function load(): Promise<void> {
  loading ??= new Promise<void>((resolve, reject) => {
    for (const file of ['Architect.css', 'Responsive.css']) {
      const link = document.createElement('link');
      link.rel = 'stylesheet';
      link.href = BASE + file;
      document.head.append(link);
    }
    const script = document.createElement('script');
    script.src = BASE + 'folder-browser.js';
    script.onload = () => resolve();
    script.onerror = () => {
      loading = null;
      reject(new Error('The classic folder browser could not be loaded'));
    };
    document.head.append(script);
  });
  return loading;
}

/** Opens the hand-written browser; resolves with the chosen folder, or null when cancelled. */
export async function chooseFolderClassic(startPath?: string): Promise<string | null> {
  await load();
  return new Promise((resolve) =>
    window.LegacyFolderBrowser!.open({ ...(startPath ? { startPath } : {}), onSelect: resolve, onCancel: () => resolve(null) }),
  );
}
