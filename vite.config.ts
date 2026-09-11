import { defineConfig, type Plugin } from "vite";
import { svelte } from "@sveltejs/vite-plugin-svelte";
import tailwindcss from "@tailwindcss/vite";
import { strFromU8, unzipSync } from "fflate";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Public R2 bucket (custom domain) that serves the song archives.
const R2_PUBLIC_BASE = "https://data.piecemusic.party";

interface ServerSongLevelMeta {
  id: string;
  name: string;
  difficulty: number;
}

interface ServerSongMeta {
  id: string;
  name: string;
  artist: string;
  archiveUrl: string;
  levelCount: number;
  levels: ServerSongLevelMeta[];
}

let metadataCache: { key: string; songs: ServerSongMeta[] } | null = null;

/**
 * Scans public/levels/*.zip and reads each archive's song.json to build a
 * lightweight index (no media is loaded). The client uses this to list songs
 * without downloading the full archives.
 */
function getSongMetadata(publicDir: string): ServerSongMeta[] {
  const levelsDir = path.resolve(publicDir, "levels");
  if (!fs.existsSync(levelsDir)) return [];

  const zips = fs
    .readdirSync(levelsDir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".zip"))
    .map((entry) => {
      const stat = fs.statSync(path.resolve(levelsDir, entry.name));
      return { name: entry.name, size: stat.size };
    })
    .sort((a, b) => a.name.localeCompare(b.name));

  const cacheKey = zips.map((z) => `${z.name}:${z.size}`).join("|");
  if (metadataCache && metadataCache.key === cacheKey) {
    return metadataCache.songs;
  }

  const songs: ServerSongMeta[] = [];
  for (const zipEntry of zips) {
    const baseName = zipEntry.name.replace(/\.zip$/, "");
    const archiveUrl = `${R2_PUBLIC_BASE}/${encodeURIComponent(baseName)}.zip`;
    let meta: ServerSongMeta | null = null;

    try {
      const data = fs.readFileSync(path.resolve(levelsDir, zipEntry.name));
      const files = unzipSync(data);
      const songJsonKey = Object.keys(files).find(
        (key) =>
          key === "song.json" || key.toLowerCase().endsWith("/song.json"),
      );
      if (songJsonKey && files[songJsonKey]) {
        const parsed = JSON.parse(strFromU8(files[songJsonKey])) as Record<
          string,
          unknown
        >;
        const levels = Array.isArray(parsed.levels)
          ? (parsed.levels as Array<Record<string, unknown>>).map(
              (lvl, idx) => ({
                id: typeof lvl.id === "string" ? lvl.id : `lvl_${idx}`,
                name:
                  typeof lvl.name === "string" ? lvl.name : `Level ${idx + 1}`,
                difficulty:
                  typeof lvl.difficulty === "number" ? lvl.difficulty : 5.0,
              }),
            )
          : [];
        meta = {
          id: typeof parsed.id === "string" ? parsed.id : baseName,
          name: typeof parsed.name === "string" ? parsed.name : baseName,
          artist: typeof parsed.artist === "string" ? parsed.artist : "",
          archiveUrl,
          levelCount: levels.length || 1,
          levels,
        };
      }
    } catch (err) {
      console.warn(
        `[levels] Failed to read metadata from ${zipEntry.name}:`,
        err,
      );
    }

    songs.push(
      meta || {
        id: baseName,
        name: baseName,
        artist: "",
        archiveUrl,
        levelCount: 1,
        levels: [],
      },
    );
  }

  metadataCache = { key: cacheKey, songs };
  return songs;
}

function getLanIp(): string | null {
  const interfaces = os.networkInterfaces();
  for (const name of Object.keys(interfaces)) {
    for (const net of interfaces[name] || []) {
      if (net.family === "IPv4" && !net.internal) {
        return net.address;
      }
    }
  }
  return null;
}

function levelsPlugin(): Plugin {
  const sendSongs = (_req: any, res: any) => {
    const songs = getSongMetadata(path.resolve(__dirname, "public"));
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify(songs));
  };

  const sendHostInfo = (_req: any, res: any) => {
    const lanIp = getLanIp();
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ lanIp }));
  };

  let outDir = "dist";

  return {
    name: "levels-discovery",
    configResolved(config) {
      outDir = path.resolve(config.root, config.build.outDir);
    },
    configureServer(server) {
      server.middlewares.use("/api/levels", sendSongs);
      server.middlewares.use("/api/songs", sendSongs);
      server.middlewares.use("/api/host-info", sendHostInfo);
    },
    configurePreviewServer(server) {
      server.middlewares.use("/api/levels", sendSongs);
      server.middlewares.use("/api/songs", sendSongs);
      server.middlewares.use("/api/host-info", sendHostInfo);
    },
    buildStart() {
      const publicDir = path.resolve(__dirname, "public");
      const songs = getSongMetadata(publicDir);
      const jsonPath = path.resolve(publicDir, "levels/levels.json");
      fs.writeFileSync(jsonPath, JSON.stringify(songs, null, 2));
    },
    closeBundle() {
      // Song archives are served from Cloudflare R2, not static assets
      // (Workers Static Assets has a 25 MiB per-file limit). Remove the .zip
      // files from the build output so they aren't uploaded on deploy.
      const distLevels = path.resolve(outDir, "levels");
      if (!fs.existsSync(distLevels)) return;
      for (const entry of fs.readdirSync(distLevels)) {
        if (entry.endsWith(".zip")) {
          fs.rmSync(path.resolve(distLevels, entry), { force: true });
          console.log(`[levels] excluded from static assets: levels/${entry}`);
        }
      }
    },
  };
}

// https://vite.dev/config/
export default defineConfig({
  server: {
    host: true,
  },
  plugins: [tailwindcss(), svelte(), levelsPlugin()],
});
