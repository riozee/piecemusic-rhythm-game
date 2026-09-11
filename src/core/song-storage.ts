import type { SongData, SongListItem } from '../types/song';

const DB_NAME = 'PieceMusicStorage';
const DB_VERSION = 1;
const STORE_NAME = 'songs';

interface StoredSongEntry {
  id: string;
  name: string;
  artist?: string;
  archiveBlob: Blob;
  levelSummaries: Array<{ id: string; name: string; difficulty: number }>;
  updatedAt: number;
}

function openDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      reject(new Error('IndexedDB is not supported in this browser.'));
      return;
    }
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME, { keyPath: 'id' });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

/**
 * Saves a compressed song archive Blob to IndexedDB
 */
export async function saveSongToStorage(song: SongData, archiveBlob: Blob): Promise<void> {
  const db = await openDB();
  const entry: StoredSongEntry = {
    id: song.id,
    name: song.name,
    artist: song.artist || '',
    archiveBlob,
    levelSummaries: song.levels.map((lvl) => ({
      id: lvl.id,
      name: lvl.name,
      difficulty: lvl.difficulty,
    })),
    updatedAt: Date.now(),
  };

  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    const store = tx.objectStore(STORE_NAME);
    const req = store.put(entry);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
}

/**
 * Retrieves the list of all songs stored in browser IndexedDB
 */
export async function getStoredSongList(): Promise<SongListItem[]> {
  try {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readonly');
      const store = tx.objectStore(STORE_NAME);
      const req = store.getAll();
      req.onsuccess = () => {
        const records = (req.result || []) as StoredSongEntry[];
        const items: SongListItem[] = records.map((r) => ({
          id: r.id,
          name: r.name,
          artist: r.artist,
          source: 'browser',
          levelCount: r.levelSummaries ? r.levelSummaries.length : 1,
          levels: r.levelSummaries || [],
          updatedAt: r.updatedAt,
        }));
        resolve(items);
      };
      req.onerror = () => reject(req.error);
    });
  } catch (err) {
    console.warn('[SongStorage] Failed to read stored songs:', err);
    return [];
  }
}

/**
 * Retrieves the compressed archive Blob for a specific song ID from IndexedDB
 */
export async function getStoredSongArchive(songId: string): Promise<Blob | null> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readonly');
    const store = tx.objectStore(STORE_NAME);
    const req = store.get(songId);
    req.onsuccess = () => {
      const record = req.result as StoredSongEntry | undefined;
      resolve(record ? record.archiveBlob : null);
    };
    req.onerror = () => reject(req.error);
  });
}

/**
 * Deletes a song from IndexedDB
 */
export async function deleteStoredSong(songId: string): Promise<void> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    const store = tx.objectStore(STORE_NAME);
    const req = store.delete(songId);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
}
