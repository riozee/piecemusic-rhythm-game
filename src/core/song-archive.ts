import { zip, unzip, strToU8, strFromU8, type AsyncZippable } from 'fflate';
import type { SongData, SongLevel, SongMetadata } from '../types/song';
import type { TrackData } from '../types/track';
import { createDefaultTrack } from './levels';

/**
 * Infer MIME type from file extension
 */
function getMimeType(filename: string): string {
  const lower = filename.toLowerCase();
  if (lower.endsWith('.opus')) return 'audio/ogg; codecs="opus"';
  if (lower.endsWith('.ogg')) return 'audio/ogg';
  if (lower.endsWith('.mp3')) return 'audio/mpeg';
  if (lower.endsWith('.wav')) return 'audio/wav';
  if (lower.endsWith('.m4a') || lower.endsWith('.aac')) return 'audio/mp4';
  if (lower.endsWith('.mp4')) return 'video/mp4';
  if (lower.endsWith('.webm')) return 'video/webm';
  if (lower.endsWith('.json')) return 'application/json';
  return 'application/octet-stream';
}

/**
 * Converts a Blob or Blob URL into a Uint8Array
 */
async function blobToUint8Array(blobOrUrl: Blob | string): Promise<Uint8Array> {
  let blob: Blob;
  if (typeof blobOrUrl === 'string') {
    const res = await fetch(blobOrUrl);
    if (!res.ok) throw new Error(`Failed to fetch media from ${blobOrUrl}`);
    blob = await res.blob();
  } else {
    blob = blobOrUrl;
  }
  const buffer = await blob.arrayBuffer();
  return new Uint8Array(buffer);
}

/**
 * Creates a blank default song structure
 */
export function createDefaultSong(name = 'New Song', id?: string): SongData {
  const cleanName = name.trim() || 'New Song';
  const cleanId = id || cleanName.toLowerCase().replace(/[^a-z0-9_-]/g, '_');
  return {
    id: cleanId,
    name: cleanName,
    audioBlobUrl: null,
    videoBlobUrl: null,
    audioBlob: null,
    videoBlob: null,
    levels: [
      {
        id: 'standard',
        name: 'Standard',
        difficulty: 5.0,
        chartFile: 'levels/standard.json',
        trackData: createDefaultTrack(),
      },
    ],
    source: 'custom',
    updatedAt: Date.now(),
  };
}

/**
 * Triggers a browser download of a Blob file
 */
export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 15000);
}

/**
 * Packs a SongData object into a compressed ZIP file (Blob)
 * Requires audio, video, and at least one level chart.
 */
export async function packSongArchive(song: SongData): Promise<Blob> {
  if (!song.levels || song.levels.length === 0) {
    throw new Error('Song must contain at least one level chart data.');
  }

  // Resolve audio bytes
  let audioBytes: Uint8Array | null = null;
  if (song.audioBlob) {
    audioBytes = await blobToUint8Array(song.audioBlob);
  } else if (song.audioBlobUrl) {
    audioBytes = await blobToUint8Array(song.audioBlobUrl);
  }

  if (!audioBytes) {
    throw new Error('Song archive requires an audio file.');
  }

  // Resolve video bytes
  let videoBytes: Uint8Array | null = null;
  if (song.videoBlob) {
    videoBytes = await blobToUint8Array(song.videoBlob);
  } else if (song.videoBlobUrl) {
    videoBytes = await blobToUint8Array(song.videoBlobUrl);
  }

  if (!videoBytes) {
    throw new Error('Song archive requires a video file.');
  }

  const audioFileName = song.audioFile || 'audio.opus';
  const videoFileName = song.videoFile || (song.videoBlob?.type.includes('webm') ? 'video.webm' : 'video.mp4');

  const metadataLevels: SongMetadata['levels'] = [];
  const zipEntries: AsyncZippable = {};

  // Store audio and video uncompressed (level 0) inside zip to avoid CPU waste
  // because Opus and MP4 are already compressed media
  zipEntries[audioFileName] = [audioBytes, { level: 0 }];
  zipEntries[videoFileName] = [videoBytes, { level: 0 }];

  // Add each level chart
  song.levels.forEach((lvl, idx) => {
    const slug = lvl.id || `level_${idx}`;
    const chartPath = `levels/${slug}.json`;
    metadataLevels.push({
      id: slug,
      name: lvl.name,
      difficulty: Math.round(lvl.difficulty * 10) / 10,
      chartFile: chartPath,
    });

    const chartJson = JSON.stringify(lvl.trackData || createDefaultTrack(), null, 2);
    zipEntries[chartPath] = [strToU8(chartJson), { level: 6 }];
  });

  const metadata: SongMetadata = {
    id: song.id,
    name: song.name,
    artist: song.artist || '',
    audioFile: audioFileName,
    videoFile: videoFileName,
    levels: metadataLevels,
    updatedAt: Date.now(),
  };

  zipEntries['song.json'] = [strToU8(JSON.stringify(metadata, null, 2)), { level: 6 }];

  return new Promise<Blob>((resolve, reject) => {
    zip(zipEntries, (err, data) => {
      if (err) {
        reject(err);
      } else {
        resolve(new Blob([data.buffer as ArrayBuffer], { type: 'application/zip' }));
      }
    });
  });
}

/**
 * Unpacks a song archive (ZIP) into a full SongData object with Blobs and parsed levels
 */
export async function unpackSongArchive(
  source: Blob | ArrayBuffer | Uint8Array,
  idHint?: string
): Promise<SongData> {
  let uint8Data: Uint8Array;
  if (source instanceof Uint8Array) {
    uint8Data = source;
  } else if (source instanceof ArrayBuffer) {
    uint8Data = new Uint8Array(source);
  } else {
    const buffer = await source.arrayBuffer();
    uint8Data = new Uint8Array(buffer);
  }

  const unzipped: Record<string, Uint8Array> = await new Promise((resolve, reject) => {
    unzip(uint8Data, (err, result) => {
      if (err) reject(err);
      else resolve(result);
    });
  });

  const fileKeys = Object.keys(unzipped);

  // 1. Locate song.json or synthesize metadata
  let metadata: SongMetadata | null = null;
  const songJsonKey = fileKeys.find((k) => k.toLowerCase() === 'song.json' || k.toLowerCase().endsWith('/song.json'));
  if (songJsonKey && unzipped[songJsonKey]) {
    try {
      const text = strFromU8(unzipped[songJsonKey]);
      metadata = JSON.parse(text) as SongMetadata;
    } catch (e) {
      console.warn('[SongArchive] Failed to parse song.json:', e);
    }
  }

  // 2. Identify Audio File
  let audioBytes: Uint8Array | null = null;
  let audioFileName = metadata?.audioFile || '';
  if (audioFileName && unzipped[audioFileName]) {
    audioBytes = unzipped[audioFileName];
  } else {
    // Find audio file by extension
    const foundAudioKey = fileKeys.find((k) => {
      const l = k.toLowerCase();
      return l.endsWith('.opus') || l.endsWith('.ogg') || l.endsWith('.mp3') || l.endsWith('.wav') || l.endsWith('.m4a');
    });
    if (foundAudioKey) {
      audioFileName = foundAudioKey.split('/').pop() || 'audio.opus';
      audioBytes = unzipped[foundAudioKey];
    }
  }

  // 3. Identify Video File
  let videoBytes: Uint8Array | null = null;
  let videoFileName = metadata?.videoFile || '';
  if (videoFileName && unzipped[videoFileName]) {
    videoBytes = unzipped[videoFileName];
  } else {
    // Find video file by extension - check webm first for browser compatibility, then mp4
    const foundVideoKey =
      fileKeys.find((k) => k.toLowerCase().endsWith('.webm')) ||
      fileKeys.find((k) => k.toLowerCase().endsWith('.mp4'));
    if (foundVideoKey) {
      videoFileName = foundVideoKey.split('/').pop() || 'video.webm';
      videoBytes = unzipped[foundVideoKey];
    }
  }

  const audioBlob = audioBytes
    ? new Blob(
        [
          audioBytes.byteOffset === 0 && audioBytes.byteLength === audioBytes.buffer.byteLength
            ? (audioBytes.buffer as ArrayBuffer)
            : (audioBytes.slice().buffer as ArrayBuffer),
        ],
        { type: getMimeType(audioFileName) }
      )
    : null;
  const videoBlob = videoBytes
    ? new Blob(
        [
          videoBytes.byteOffset === 0 && videoBytes.byteLength === videoBytes.buffer.byteLength
            ? (videoBytes.buffer as ArrayBuffer)
            : (videoBytes.slice().buffer as ArrayBuffer),
        ],
        { type: getMimeType(videoFileName) }
      )
    : null;
  const audioBlobUrl = audioBlob ? URL.createObjectURL(audioBlob) : null;
  const videoBlobUrl = videoBlob ? URL.createObjectURL(videoBlob) : null;

  // 4. Parse Levels
  const levels: SongLevel[] = [];
  if (metadata && Array.isArray(metadata.levels) && metadata.levels.length > 0) {
    for (const lvlMeta of metadata.levels) {
      let trackData: TrackData = createDefaultTrack();
      const chartKey = fileKeys.find((k) => k === lvlMeta.chartFile || k.endsWith(lvlMeta.chartFile));
      if (chartKey && unzipped[chartKey]) {
        try {
          const chartJson = strFromU8(unzipped[chartKey]);
          trackData = JSON.parse(chartJson);
        } catch (e) {
          console.warn(`[SongArchive] Failed to parse chart for level ${lvlMeta.name}:`, e);
        }
      }
      levels.push({
        id: lvlMeta.id || `lvl_${levels.length}`,
        name: lvlMeta.name || `Level ${levels.length + 1}`,
        difficulty: typeof lvlMeta.difficulty === 'number' ? lvlMeta.difficulty : 5.0,
        chartFile: lvlMeta.chartFile,
        trackData,
      });
    }
  } else {
    // Fallback: search for any .json files in archive (excluding song.json)
    const jsonKeys = fileKeys.filter(
      (k) => k.toLowerCase().endsWith('.json') && !k.toLowerCase().endsWith('song.json')
    );
    if (jsonKeys.length > 0) {
      jsonKeys.forEach((k, idx) => {
        try {
          const chartJson = strFromU8(unzipped[k]);
          const trackData: TrackData = JSON.parse(chartJson);
          const baseName = k.split('/').pop()?.replace(/\.json$/, '') || `Level ${idx + 1}`;
          levels.push({
            id: `lvl_${idx}`,
            name: baseName,
            difficulty: 5.0,
            chartFile: k,
            trackData,
          });
        } catch {}
      });
    }
  }

  // If still no levels, add default
  if (levels.length === 0) {
    levels.push({
      id: 'standard',
      name: 'Standard',
      difficulty: 5.0,
      chartFile: 'levels/standard.json',
      trackData: createDefaultTrack(),
    });
  }

  const songName = metadata?.name || idHint || 'Imported Song';
  const songId = metadata?.id || (idHint ? idHint.toLowerCase().replace(/[^a-z0-9_-]/g, '_') : 'imported_song');

  return {
    id: songId,
    name: songName,
    artist: metadata?.artist || '',
    audioFile: audioFileName,
    videoFile: videoFileName,
    audioBlobUrl,
    videoBlobUrl,
    audioBlob,
    videoBlob,
    levels,
    source: 'custom',
    updatedAt: metadata?.updatedAt || Date.now(),
  };
}
