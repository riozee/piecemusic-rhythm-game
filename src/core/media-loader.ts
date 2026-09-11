import type { Level } from "../types/level";

export interface MediaProgress {
  loadedBytes: number;
  totalBytes: number;
  percent: number;
}

export interface LevelMediaAssets {
  audioBlobUrl: string;
  videoBlobUrl: string;
  fromCache: boolean;
}

/**
 * Downloads a media asset via fetch with streaming progress tracking.
 * No caching: always re-downloads from the network.
 */
export async function fetchBlobWithCache(
  url: string,
  mimeType: string,
  onProgress?: (loaded: number, total: number) => void,
): Promise<{ blobUrl: string; fromCache: boolean; size: number }> {
  // Always fetch fresh from the network (no HTTP cache, no Cache API).
  const response = await fetch(url, { cache: "no-store" });
  if (!response.ok) {
    throw new Error(
      `Failed to load ${url} (HTTP ${response.status} ${response.statusText})`,
    );
  }

  const contentLengthHeader = response.headers.get("content-length");
  const total = contentLengthHeader ? parseInt(contentLengthHeader, 10) : 0;

  let blob: Blob;

  if (response.body) {
    const reader = response.body.getReader();
    const chunks: BlobPart[] = [];
    let received = 0;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) {
        chunks.push(value);
        received += value.length;
        onProgress?.(received, total || received);
      }
    }

    blob = new Blob(chunks, { type: mimeType });
  } else {
    // Fallback if ReadableStream is unsupported
    blob = await response.blob();
    onProgress?.(blob.size, blob.size);
  }

  return {
    blobUrl: URL.createObjectURL(blob),
    fromCache: false,
    size: blob.size,
  };
}

/**
 * Loads both audio (.opus) and video (.mp4) for a level concurrently,
 * tracking combined byte progress and returning local Blob URLs.
 */
export async function loadLevelMedia(
  level: Level,
  onProgress?: (progress: MediaProgress) => void,
): Promise<LevelMediaAssets> {
  let audioLoaded = 0;
  let audioTotal = 0;

  const report = () => {
    if (!onProgress) return;
    const percent =
      audioTotal > 0
        ? Math.min(100, Math.round((audioLoaded / audioTotal) * 100))
        : 0;
    onProgress({ loadedBytes: audioLoaded, totalBytes: audioTotal, percent });
  };

  // Preload audio (~4MB) via Cache API/Blob so master audio playback is instant and zero latency
  const audioResult = await fetchBlobWithCache(
    level.audioUrl,
    'audio/ogg; codecs="opus"',
    (loaded, total) => {
      audioLoaded = loaded;
      audioTotal = total;
      report();
    },
  );

  // Final 100% notification
  onProgress?.({
    loadedBytes: audioResult.size,
    totalBytes: audioResult.size,
    percent: 100,
  });

  return {
    audioBlobUrl: audioResult.blobUrl,
    // Video is streamed directly from the server using native HTTP 206 range requests.
    // This allows the video to buffer and start playing in milliseconds with hardware acceleration.
    videoBlobUrl: level.videoUrl,
    fromCache: audioResult.fromCache,
  };
}

/**
 * Revokes blob URLs to release memory when switching levels or unmounting.
 */
export function revokeMediaBlob(blobUrl: string | null | undefined): void {
  if (blobUrl && blobUrl.startsWith("blob:")) {
    URL.revokeObjectURL(blobUrl);
  }
}
