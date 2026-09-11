import type { SyncState } from "../types/level";

export interface SyncEngineOptions {
  hardSyncThresholdSec?: number;
  softSyncThresholdSec?: number;
  maxRateAdjustment?: number;
  seekCooldownMs?: number;
}

/**
 * MasterSlaveSyncEngine
 *
 * Master: HTMLAudioElement (.opus) - Authoritative, uncompromised clock.
 * Slave:  HTMLVideoElement (.mp4)  - Continuously steered to track master audio.
 */
export class MasterSlaveSyncEngine {
  private audio: HTMLAudioElement | null = null;
  private video: HTMLVideoElement | null = null;

  private hardSyncThreshold: number;
  private softSyncThreshold: number;
  private maxRateAdjustment: number;
  private seekCooldownMs: number;

  private lastSeekTime = 0;
  private isVideoPlayPending = false;
  private animFrameId: number | null = null;
  private isDestroyed = false;
  private stateListeners = new Set<(state: SyncState) => void>();

  private lastRateChangeTime = 0;
  private lastLoopTime = 0;
  private isPausedByUser = true;

  // High-precision interpolated clock state
  private lastRawAudioTime = -1;
  private lastAudioPerfTime = 0;
  private smoothedAudioTime = 0;

  constructor(options: SyncEngineOptions = {}) {
    // 2.0s prevents disruptive seeking when soft sync rate modulation can smoothly catch up
    this.hardSyncThreshold = options.hardSyncThresholdSec ?? 2.0;
    // 0.06s allows for smooth playback nudges before drift becomes perceptible
    this.softSyncThreshold = options.softSyncThresholdSec ?? 0.06;
    // Max speed change is +/- 0.20 (i.e., 0.80x to 1.20x playback speed)
    this.maxRateAdjustment = options.maxRateAdjustment ?? 0.2;
    // 3-second cooldown ensures the video has ample time to rebuild its buffer
    this.seekCooldownMs = options.seekCooldownMs ?? 3000;
  }

  public attach(
    audio: HTMLAudioElement,
    video?: HTMLVideoElement | null,
  ): void {
    this.cleanup();

    this.audio = audio;
    this.video = video || null;

    if (this.video) {
      // Force strictly muted, inline playback to bypass browser autoplay restrictions
      this.video.muted = true;
      this.video.defaultMuted = true;
      this.video.volume = 0;
      this.video.playsInline = true;
      this.video.preload = "auto";
    }

    this.audio.preload = "auto";

    this.lastRawAudioTime = this.audio.currentTime;
    this.lastAudioPerfTime = performance.now();
    this.smoothedAudioTime = this.audio.currentTime;

    this.startSyncLoop();
  }

  /**
   * Continuous per-frame synchronization loop. Single source of truth.
   */
  private startSyncLoop(): void {
    const loop = (now: number) => {
      if (this.isDestroyed) return;
      this.animFrameId = requestAnimationFrame(loop);
      // Throttle to ~60fps: on high-refresh displays this loop would otherwise run
      // 2-3x faster than needed, causing avoidable Svelte reactivity churn.
      if (now - this.lastLoopTime < 1000 / 60 - 1) return;
      this.lastLoopTime = now;
      this.updateSmoothedAudioTime(now);
      this.stepSync(now);
      this.notifyState();
    };

    this.animFrameId = requestAnimationFrame(loop);
  }

  /**
   * Browsers update HTMLAudioElement.currentTime in coarse chunks every 50-100ms.
   * This smooths timestamps using microsecond performance.now() interpolation
   * with strict monotonicity (never jumps backward) to guarantee 60-120 FPS camera tracking.
   */
  private updateSmoothedAudioTime(now: number): void {
    if (!this.audio) {
      this.smoothedAudioTime = 0;
      return;
    }

    const rawTime = this.audio.currentTime;
    const audioPaused = this.audio.paused || this.audio.ended;

    // Detect seek or restart (audio jumped backward by more than 0.5s)
    if (rawTime < this.lastRawAudioTime - 0.5) {
      this.lastRawAudioTime = rawTime;
      this.lastAudioPerfTime = now;
      this.smoothedAudioTime = rawTime;
      return;
    }

    // Detect new audio clock update (browser updated currentTime)
    if (rawTime !== this.lastRawAudioTime) {
      this.lastRawAudioTime = rawTime;
      this.lastAudioPerfTime = now;
      this.smoothedAudioTime = rawTime;
      return;
    }

    // Between audio clock updates: interpolate forward using performance.now() delta
    if (!audioPaused) {
      const dtSec = (now - this.lastAudioPerfTime) / 1000;
      const interpolated = this.lastRawAudioTime + dtSec;
      // Monotonic: never go backward, and don't overshoot duration
      const maxTime = this.audio.duration || Infinity;
      this.smoothedAudioTime = Math.min(
        Math.max(this.smoothedAudioTime, interpolated),
        maxTime,
      );
    }
  }

  private stepSync(now: number): void {
    if (!this.audio || !this.video) return;

    // 1. User paused, audio paused, or audio ended -> Slave MUST pause
    if (this.isPausedByUser || this.audio.paused || this.audio.ended) {
      if (!this.video.paused) {
        this.video.pause();
      }
      return;
    }

    // 2. Master audio is playing -> Slave video MUST play
    if (this.video.paused) {
      this.triggerVideoPlay();
    }

    // While seeking or buffering, let decoder catch up before evaluating drift
    if (this.video.seeking || this.video.readyState < 2) {
      return;
    }

    const masterTime = this.audio.currentTime;
    const slaveTime = this.video.currentTime;
    const drift = slaveTime - masterTime; // > 0: video ahead; < 0: video behind
    const absDrift = Math.abs(drift);

    // 3. Catastrophic Drift (Hard Sync) - seek video only if massive drift (> 1.5s)
    if (absDrift > this.hardSyncThreshold) {
      if (
        now - this.lastSeekTime > this.seekCooldownMs &&
        !this.video.seeking
      ) {
        try {
          this.video.currentTime = masterTime;
          this.video.playbackRate = 1.0;
          this.lastSeekTime = now;
        } catch {}
      }
      return;
    }

    // 4. Normal Drift (Soft Sync via smooth speed modulation)
    if (absDrift > this.softSyncThreshold) {
      const adjustment = Math.min(absDrift * 0.25, this.maxRateAdjustment);
      const targetRate = drift > 0 ? 1.0 - adjustment : 1.0 + adjustment;
      if (Math.abs(this.video.playbackRate - targetRate) > 0.015) {
        this.video.playbackRate = targetRate;
        this.lastRateChangeTime = now;
      }
    } else if (this.video.playbackRate !== 1.0) {
      this.video.playbackRate = 1.0;
      this.lastRateChangeTime = now;
    }
  }

  private triggerVideoPlay(): void {
    if (!this.video || !this.video.paused || this.isVideoPlayPending) return;
    this.isVideoPlayPending = true;
    this.video
      .play()
      .catch((err) => {
        console.warn("[SyncEngine] triggerVideoPlay error:", err);
      })
      .finally(() => {
        this.isVideoPlayPending = false;
      });
  }

  private notifyState(): void {
    if (this.stateListeners.size === 0 || !this.audio) return;

    const state: SyncState = {
      currentTime: this.smoothedAudioTime,
      duration: this.audio.duration || 0,
      isPlaying: !this.audio.paused && !this.audio.ended,
      drift: this.video ? this.video.currentTime - this.smoothedAudioTime : 0,
      videoPlaybackRate: this.video ? this.video.playbackRate : 1.0,
    };

    for (const listener of this.stateListeners) {
      listener(state);
    }
  }

  public onSyncState(listener: (state: SyncState) => void): () => void {
    this.stateListeners.add(listener);
    return () => this.stateListeners.delete(listener);
  }

  public async play(): Promise<void> {
    if (!this.audio) {
      throw new Error("Audio element is not attached");
    }

    this.isPausedByUser = false;

    if (this.video) {
      this.video.muted = true;
      this.video.defaultMuted = true;
      this.video.volume = 0;
      this.video.playsInline = true;
    }

    // Reset smoothed clock
    this.lastRawAudioTime = this.audio.currentTime;
    this.lastAudioPerfTime = performance.now();
    this.smoothedAudioTime = this.audio.currentTime;

    // Ensure they start at the exact same timestamp if video is loaded and ready
    if (this.video && this.video.readyState >= 1 && !this.video.seeking) {
      if (Math.abs(this.video.currentTime - this.audio.currentTime) > 0.15) {
        try {
          this.video.currentTime = this.audio.currentTime;
        } catch {}
      }
    }

    const promises: Promise<any>[] = [];
    if (this.audio.paused) {
      promises.push(
        this.audio.play().catch((err) => {
          console.warn("[SyncEngine] audio.play() caught:", err);
        }),
      );
    }
    if (this.video && this.video.paused) {
      promises.push(
        this.video.play().catch((err) => {
          console.warn("[SyncEngine] video.play() caught:", err);
        }),
      );
    }
    await Promise.all(promises);
  }

  public pause(): void {
    this.isPausedByUser = true;
    this.audio?.pause();
    this.video?.pause();
  }

  public seek(timeSec: number): void {
    if (!this.audio) return;
    const target = Math.max(0, Math.min(timeSec, this.duration));
    this.audio.currentTime = target;
    if (this.video && this.video.readyState >= 2 && !this.video.seeking) {
      this.video.currentTime = target;
    }
    this.lastRawAudioTime = target;
    this.lastAudioPerfTime = performance.now();
    this.smoothedAudioTime = target;
    this.lastSeekTime = performance.now();
  }

  public get currentTime(): number {
    return this.smoothedAudioTime;
  }

  /**
   * Converts an arbitrary host monotonic clock value (performance.now()) to the
   * corresponding smoothed audio time, using the same linear interpolation the
   * sync loop applies. Unlike `currentTime`, this is NOT clamped to be monotonic
   * — it may return a value in the past, which is required for latency-compensated
   * input (a key pressed on the phone a few ms ago should be judged at that earlier
   * time, not at packet arrival).
   */
  public hostClockToAudioTime(hostPerfNow: number): number {
    if (!this.audio || this.lastRawAudioTime < 0) return this.smoothedAudioTime;
    return (
      this.lastRawAudioTime + (hostPerfNow - this.lastAudioPerfTime) / 1000
    );
  }

  public get duration(): number {
    return this.audio && !isNaN(this.audio.duration) ? this.audio.duration : 0;
  }

  public get isPlaying(): boolean {
    return !!this.audio && !this.audio.paused && !this.audio.ended;
  }

  public get drift(): number {
    if (!this.audio || !this.video) return 0;
    return this.video.currentTime - this.audio.currentTime;
  }

  private cleanup(): void {
    if (this.animFrameId !== null) {
      cancelAnimationFrame(this.animFrameId);
      this.animFrameId = null;
    }
  }

  public destroy(): void {
    this.isDestroyed = true;
    if (this.animFrameId !== null) {
      cancelAnimationFrame(this.animFrameId);
      this.animFrameId = null;
    }
    this.cleanup();
    this.stateListeners.clear();
    this.audio = null;
    this.video = null;
  }
}
