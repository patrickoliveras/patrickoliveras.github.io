/* Getting the finished file where it needs to go: a normal download, the
 * player's own card (File System Access, Chrome and Edge on computers), or
 * the share sheet on phones. */

const PLAYER_DIRS = /^(music|música|musica|record|recordings?|grabaciones|video|videos|vídeos|photos?|fotos|pictures|imágenes|imagenes|ebook|e-?books?|libros|fm|voice|voz|playlist|playlists?)$/i;
const VIDEO_DIR = /^(videos?|vídeos?)$/i;
const INTERNAL_MARKER = /^video conversion tool\.rar$/i;

export const platform = (() => {
  if (typeof navigator === 'undefined') return 'computer';
  const ua = navigator.userAgent || '';
  if (/iPhone|iPod/.test(ua)) return 'phone';
  if (/iPad/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1)) return 'tablet';
  if (/Android/.test(ua)) return /Mobile/.test(ua) ? 'phone' : 'tablet';
  return 'computer';
})();

export const os = (() => {
  if (typeof navigator === 'undefined') return 'other';
  const ua = navigator.userAgent || '';
  if (/Windows/.test(ua)) return 'windows';
  if (/Macintosh|Mac OS X/.test(ua) && platform === 'computer') return 'mac';
  if (/CrOS/.test(ua)) return 'chromeos';
  return 'other';
})();

/** Saving straight onto the player needs a computer and Chrome/Edge's folder access. */
export function canSaveToFolder() {
  return platform === 'computer' && typeof window !== 'undefined' && typeof window.showDirectoryPicker === 'function';
}

// ------------------------------------------------------------ downloads

export function download(blob, name) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.rel = 'noopener';
  a.style.display = 'none';
  document.body.appendChild(a);
  a.click();
  a.remove();
  // Long enough for slow disks; the Blob itself stays alive in the app.
  setTimeout(() => URL.revokeObjectURL(url), 120000);
}

export function canShare(blob, name) {
  try {
    if (platform === 'computer' || !navigator.canShare) return false;
    return navigator.canShare({ files: [new File([blob], name, { type: 'application/octet-stream' })] });
  } catch (_) {
    return false;
  }
}

export async function share(blob, name) {
  const file = new File([blob], name, { type: 'application/octet-stream' });
  await navigator.share({ files: [file], title: name });
}

// ------------------------------------------------------------ remembered folder

// The chosen folder is kept for this visit only. Storing folder handles in
// IndexedDB crashes Chromium when they're read back in incognito-style
// profiles (reproduced in testing), and a crash is worse than one extra click.
// The picker's `id` makes Chrome reopen it in the same folder next visit.
let sessionFolder = null;

export async function rememberedFolder() {
  return sessionFolder;
}

export async function rememberFolder(handle) {
  sessionFolder = handle;
}

export async function forgetFolder() {
  sessionFolder = null;
}

// ------------------------------------------------------------ the player's folder

async function permitted(handle, ask) {
  const opts = { mode: 'readwrite' };
  try {
    if ((await handle.queryPermission(opts)) === 'granted') return true;
    if (!ask) return false;
    return (await handle.requestPermission(opts)) === 'granted';
  } catch (_) {
    return false;
  }
}

// Folders the computer itself makes: Windows library folders carry
// desktop.ini, macOS home folders carry .localized. Never the player.
const COMPUTER_MARKER = /^(desktop\.ini|\.localized)$/i;
// What sits at the root of a removable disk: Windows' System Volume
// Information, and the folders macOS writes onto FAT disks.
const DISK_ROOT_MARKER = /^(system volume information|\.spotlight-v100|\.fseventsd|\.trashes)$/i;

/** Look inside a chosen folder to decide where the video belongs. */
export async function inspect(handle) {
  const names = [];
  let videos = null;
  let internal = false;
  let computer = false;
  let diskRoot = false;
  let playerish = 0;
  let n = 0;
  for await (const entry of handle.values()) {
    if (++n > 400) break;
    names.push(entry.name);
    if (entry.kind === 'file' && INTERNAL_MARKER.test(entry.name)) internal = true;
    if (COMPUTER_MARKER.test(entry.name)) computer = true;
    if (DISK_ROOT_MARKER.test(entry.name)) diskRoot = true;
    if (entry.kind === 'directory') {
      if (VIDEO_DIR.test(entry.name) && !videos) videos = entry;
      if (PLAYER_DIRS.test(entry.name)) playerish++;
    }
  }
  return {
    names,
    internal,
    computer,
    diskRoot,
    videos,
    isVideoFolder: VIDEO_DIR.test(handle.name),
    looksLikePlayer: internal || diskRoot || playerish >= 2 || (!!videos && n < 60),
  };
}

/** Ask the person to pick the player's card. Rejects with AbortError on cancel. */
export async function pickFolder() {
  const handle = await window.showDirectoryPicker({ id: 'reproductor-zuszox', mode: 'readwrite' });
  await rememberFolder(handle);
  return handle;
}

/**
 * Where to write inside the chosen folder. Returns {dir, label} or
 * {warning:'internal'} when it looks like the player's internal memory.
 */
export async function resolveTarget(root, { allowInternal = false, allowComputer = false } = {}) {
  const info = await inspect(root);
  if (info.internal && !allowInternal) return { warning: 'internal', root };
  // How sure are we this is the player? 'player' (a disk's root, or the
  // player's own folders), 'maybe' (a clean folder called Videos), or a
  // folder on the computer, which gets a warning first.
  if (info.computer && !allowComputer) return { warning: 'computer', root };
  if (!info.computer && info.looksLikePlayer) {
    const dir = info.videos || (await root.getDirectoryHandle('Videos', { create: true }));
    return { dir, label: `${root.name} › ${dir.name}`, certainty: 'player' };
  }
  if (!info.computer && info.isVideoFolder) return { dir: root, label: root.name, certainty: 'maybe' };
  if (!allowComputer) return { warning: 'computer', root };
  return { dir: root, label: root.name, certainty: 'other' };
}

/** The remembered folder if it's still there and we may write to it. */
export async function usableRemembered(ask) {
  const handle = await rememberedFolder();
  if (!handle) return null;
  if (!(await permitted(handle, ask))) return null;
  try {
    // Throws if the player was unplugged.
    for await (const _ of handle.values()) break;
    return handle;
  } catch (_) {
    return null;
  }
}

export async function writeTo(dir, name, blob) {
  const fh = await dir.getFileHandle(name, { create: true });
  const w = await fh.createWritable();
  try {
    await w.write(blob);
    await w.close();
  } catch (err) {
    try {
      await w.abort();
    } catch (_) {}
    throw err;
  }
}
