export interface Level {
  id: string;
  name: string;
  audioUrl: string;
  videoUrl: string;
  notesUrl: string;
}

export interface SyncState {
  currentTime: number;
  duration: number;
  isPlaying: boolean;
  drift: number;
  videoPlaybackRate: number;
}
