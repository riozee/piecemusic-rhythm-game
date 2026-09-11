import type { TrackData } from './track';

export interface SongLevel {
  id: string;
  name: string;
  difficulty: number; // 0.0 to 10.0 (one decimal digit)
  chartFile?: string; // relative path within archive, e.g. "levels/easy.json"
  trackData: TrackData;
}

export interface SongMetadataLevel {
  id: string;
  name: string;
  difficulty: number;
  chartFile: string;
}

export interface SongMetadata {
  id: string;
  name: string;
  artist?: string;
  audioFile: string;
  videoFile: string;
  levels: SongMetadataLevel[];
  updatedAt?: number;
}

export interface SongData {
  id: string;
  name: string;
  artist?: string;
  audioFile?: string;
  videoFile?: string;
  audioBlobUrl: string | null;
  videoBlobUrl: string | null;
  audioBlob: Blob | null;
  videoBlob: Blob | null;
  levels: SongLevel[];
  source?: 'server' | 'browser' | 'custom';
  archiveBlob?: Blob | null;
  archiveUrl?: string;
  updatedAt?: number;
}

export interface SongListItem {
  id: string;
  name: string;
  artist?: string;
  source: 'server' | 'browser' | 'custom';
  levelCount: number;
  levels?: Array<{ id: string; name: string; difficulty: number }>;
  archiveUrl?: string;
  updatedAt?: number;
}
