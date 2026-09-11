import type { SongData, SongListItem } from "../types/song";
import { unpackSongArchive } from "./song-archive";
import { getStoredSongList, getStoredSongArchive } from "./song-storage";

const DEFAULT_SONG_NAME = "逆転";

interface ServerSongMeta {
  id: string;
  name: string;
  artist?: string;
  archiveUrl: string;
  levelCount: number;
  levels?: Array<{ id: string; name: string; difficulty: number }>;
}

/**
 * Normalizes the levels.json (or /api/songs) payload into song metadata.
 * Supports the legacy string[] format as well as the richer object[] format.
 */
function normalizeServerSongs(data: unknown): ServerSongMeta[] {
  if (!Array.isArray(data)) return [];
  const out: ServerSongMeta[] = [];
  for (const item of data) {
    if (typeof item === "string") {
      const cleanName = item.trim();
      if (!cleanName) continue;
      out.push({
        id: cleanName,
        name: cleanName,
        archiveUrl: `/levels/${encodeURIComponent(cleanName)}.zip`,
        levelCount: 1,
      });
    } else if (item && typeof item === "object") {
      const o = item as Record<string, unknown>;
      const id =
        typeof o.id === "string"
          ? o.id
          : typeof o.name === "string"
            ? o.name
            : "";
      const name = typeof o.name === "string" ? o.name : id;
      if (!id) continue;
      const levels = Array.isArray(o.levels)
        ? (o.levels as Array<Record<string, unknown>>)
            .map((lvl) => ({
              id: typeof lvl.id === "string" ? lvl.id : "",
              name: typeof lvl.name === "string" ? lvl.name : "Level",
              difficulty:
                typeof lvl.difficulty === "number" ? lvl.difficulty : 5.0,
            }))
            .filter((lvl) => lvl.id)
        : undefined;
      out.push({
        id,
        name,
        artist: typeof o.artist === "string" ? o.artist : undefined,
        archiveUrl:
          typeof o.archiveUrl === "string"
            ? o.archiveUrl
            : `/levels/${encodeURIComponent(id)}.zip`,
        levelCount:
          typeof o.levelCount === "number"
            ? o.levelCount
            : levels
              ? levels.length
              : 1,
        levels,
      });
    }
  }
  return out;
}

/**
 * Discovers all songs available both from the server and from browser IndexedDB.
 * Only lightweight index metadata is loaded here — no archives are downloaded.
 */
export async function getAvailableSongs(): Promise<SongListItem[]> {
  const songMap = new Map<string, SongListItem>();

  // 1. Fetch server song metadata from dev server API endpoint
  let serverSongs: ServerSongMeta[] = [];
  try {
    const res = await fetch("/api/songs", { cache: "no-store" });
    if (res.ok) {
      serverSongs = normalizeServerSongs(await res.json());
    }
  } catch {}

  // 2. Fallback to static levels.json
  if (serverSongs.length === 0) {
    try {
      const res = await fetch("/levels/levels.json", { cache: "no-store" });
      if (res.ok) {
        serverSongs = normalizeServerSongs(await res.json());
      }
    } catch {}
  }

  // 3. Fallback to default song if no server songs detected
  if (serverSongs.length === 0) {
    serverSongs = [
      {
        id: DEFAULT_SONG_NAME,
        name: DEFAULT_SONG_NAME,
        archiveUrl: `/levels/${encodeURIComponent(DEFAULT_SONG_NAME)}.zip`,
        levelCount: 1,
      },
    ];
  }

  for (const meta of serverSongs) {
    songMap.set(`server_${meta.id}`, {
      id: meta.id,
      name: meta.name,
      artist: meta.artist,
      source: "server",
      levelCount: meta.levelCount,
      levels: meta.levels,
      archiveUrl: meta.archiveUrl,
    });
  }

  // 4. Retrieve browser-saved songs from IndexedDB
  try {
    const storedSongs = await getStoredSongList();
    for (const item of storedSongs) {
      songMap.set(`browser_${item.id}`, item);
    }
  } catch (err) {
    console.warn(
      "[SongLoader] Failed to read stored songs from IndexedDB:",
      err,
    );
  }

  return Array.from(songMap.values());
}

/**
 * Loads a full SongData object either from the server .zip or from browser IndexedDB
 */
export async function loadSong(
  itemOrId: SongListItem | string,
  onProgress?: (percent: number) => void,
): Promise<SongData> {
  let songItem: SongListItem;

  if (typeof itemOrId === "string") {
    const all = await getAvailableSongs();
    const found = all.find((s) => s.id === itemOrId || s.name === itemOrId);
    if (!found) {
      songItem = {
        id: itemOrId,
        name: itemOrId,
        source: "server",
        levelCount: 1,
        archiveUrl: `/levels/${encodeURIComponent(itemOrId)}.zip`,
      };
    } else {
      songItem = found;
    }
  } else {
    songItem = itemOrId;
  }

  if (songItem.source === "browser") {
    onProgress?.(20);
    const archiveBlob = await getStoredSongArchive(songItem.id);
    if (!archiveBlob) {
      throw new Error(
        `Browser storage record not found for song: ${songItem.name}`,
      );
    }
    onProgress?.(60);
    const songData = await unpackSongArchive(archiveBlob, songItem.name);
    songData.source = "browser";
    songData.archiveBlob = archiveBlob;
    onProgress?.(100);
    return songData;
  }

  // Otherwise load from server archive .zip
  const url =
    songItem.archiveUrl || `/levels/${encodeURIComponent(songItem.name)}.zip`;
  onProgress?.(15);
  const response = await fetch(url, { cache: "no-store" });
  if (!response.ok) {
    throw new Error(
      `Failed to load song archive from ${url} (HTTP ${response.status})`,
    );
  }

  const contentLength = response.headers.get("content-length");
  const totalBytes = contentLength ? parseInt(contentLength, 10) : 0;

  let blob: Blob;
  if (response.body && totalBytes > 0) {
    const reader = response.body.getReader();
    const chunks: BlobPart[] = [];
    let received = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) {
        chunks.push(value);
        received += value.length;
        if (onProgress) {
          const pct = Math.min(
            90,
            Math.round((received / totalBytes) * 80) + 15,
          );
          onProgress(pct);
        }
      }
    }
    blob = new Blob(chunks, { type: "application/zip" });
  } else {
    blob = await response.blob();
  }

  onProgress?.(92);
  const songData = await unpackSongArchive(blob, songItem.name);
  songData.source = "server";
  songData.archiveBlob = blob;
  onProgress?.(100);
  return songData;
}
