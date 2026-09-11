import type { Level } from "../types/level";
import type { TrackData } from "../types/track";

const DEFAULT_LEVEL_NAME = "逆転";

export function createDefaultTrack(): TrackData {
  return {
    nodes: [
      { x: 0, y: 500 },
      { x: 2000, y: 500 },
    ],
    bends: {},
    speedBPs: [],
    zoomBPs: [],
    offsetBPs: [],
    notes: [],
    decorations: [],
    planeW: 2000,
    planeH: 1000,
  };
}

/**
 * Creates a Level descriptor for a given level folder name in ./public/levels
 */
export function createLevel(name: string): Level {
  const cleanName = name.trim();
  const encoded = encodeURIComponent(cleanName);
  return {
    id: cleanName,
    name: cleanName,
    audioUrl: `/levels/${encoded}/audio.opus`,
    videoUrl: `/levels/${encoded}/video.mp4`,
    notesUrl: `/levels/${encoded}/notes.json`,
  };
}

/**
 * Fetches the track notes and configuration for a given level.
 * Falls back to a clean default track if not found.
 */
export async function loadTrackData(level: Level): Promise<TrackData> {
  try {
    const res = await fetch(level.notesUrl, { cache: "no-store" });
    if (res.ok) {
      const data = (await res.json()) as TrackData;
      if (Array.isArray(data.nodes) && data.nodes.length >= 2) {
        return {
          nodes: data.nodes,
          bends: data.bends || {},
          speedBPs: data.speedBPs || [],
          zoomBPs: data.zoomBPs || [],
          offsetBPs: data.offsetBPs || [],
          notes: data.notes || [],
          decorations: data.decorations || [],
          planeW: data.planeW || 2000,
          planeH: data.planeH || 1000,
        };
      }
    }
  } catch (err) {
    console.warn(`[Levels] Failed to load notes.json for ${level.name}:`, err);
  }
  return createDefaultTrack();
}

/**
 * Discover all available levels in ./public/levels.
 * Checks the Vite dev middleware endpoint first, then static levels.json, and falls back to default.
 */
export async function getAvailableLevelNames(): Promise<string[]> {
  const extractNames = (data: unknown): string[] => {
    if (!Array.isArray(data)) return [];
    return data
      .map((item) => {
        if (typeof item === "string") return item;
        if (item && typeof item === "object") {
          const name = (item as { name?: unknown }).name;
          return typeof name === "string" ? name : undefined;
        }
        return undefined;
      })
      .filter(
        (name): name is string => typeof name === "string" && name.length > 0,
      );
  };

  // 1. Try dev/preview API endpoint
  try {
    const res = await fetch("/api/levels", { cache: "no-store" });
    if (res.ok) {
      const names = extractNames(await res.json());
      if (names.length > 0) {
        return names;
      }
    }
  } catch {
    // Ignore and proceed to fallback
  }

  // 2. Try static levels.json generated during build
  try {
    const res = await fetch("/levels/levels.json", { cache: "no-store" });
    if (res.ok) {
      const names = extractNames(await res.json());
      if (names.length > 0) {
        return names;
      }
    }
  } catch {
    // Ignore and proceed to fallback
  }

  // 3. Fallback to known default level
  return [DEFAULT_LEVEL_NAME];
}

/**
 * Resolves the active level to play based on URL parameter (?level=) or first available level.
 */
export async function resolveActiveLevel(): Promise<Level> {
  const params = new URLSearchParams(window.location.search);
  const requested = params.get("level");
  if (requested) {
    return createLevel(requested);
  }

  const available = await getAvailableLevelNames();
  const selected = available[0] || DEFAULT_LEVEL_NAME;
  return createLevel(selected);
}
