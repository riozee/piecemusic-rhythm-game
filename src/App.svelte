<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import QRCode from 'qrcode';
  import { MasterSlaveSyncEngine } from './core/sync-engine';
  import { ViewportManager, type ViewportLayout } from './core/viewport';
  import { revokeMediaBlob } from './core/media-loader';
  import { WebRtcHost, generateRoomId, type ControllerKeyEvent, type ControllerCommand, type ControllerState } from './core/webrtc';
  import type { SyncState } from './types/level';
  import type { TrackData } from './types/track';
  import type { SongData, SongLevel, SongListItem } from './types/song';
  import { getAvailableSongs, loadSong } from './core/song-loader';
  import { createDefaultSong, packSongArchive, unpackSongArchive, downloadBlob } from './core/song-archive';
  import { deleteStoredSong } from './core/song-storage';
  import { createDefaultTrack } from './core/levels';
  import HomeScreen from './components/HomeScreen.svelte';
  import SongSelect from './components/SongSelect.svelte';
  import LevelSelect from './components/LevelSelect.svelte';
  import EditScreen from './components/EditScreen.svelte';
  import PauseOverlay from './components/PauseOverlay.svelte';
  import StageClearOverlay from './components/StageClearOverlay.svelte';
  import PaperSvgFilters from './components/PaperSvgFilters.svelte';
  import RhythmPlayCanvas from './components/RhythmPlayCanvas.svelte';
  import PhoneController from './components/PhoneController.svelte';

  // Check if current URL is for the phone controller screen
  const urlParams = new URLSearchParams(window.location.search);
  const isControllerMode =
    urlParams.get('mode') === 'controller' ||
    window.location.pathname.startsWith('/controller');
  const controllerInitialRoom = urlParams.get('room') || '';

  type Screen = 'home' | 'song-select' | 'level-select' | 'edit' | 'playing';

  let currentScreen = $state<Screen>('home');
  let isPaused = $state<boolean>(false);
  let isAwaitingAudioStart = $state<boolean>(false);
  // True when the current gameplay session was launched from the chart editor,
  // so quitting returns to the editor instead of level selection.
  let launchedFromEditor = false;

  // Song & Level selection state
  let songSelectMode = $state<'play' | 'manage'>('play');
  let availableSongs = $state<SongListItem[]>([]);
  let displayedSongs = $derived.by(() =>
    songSelectMode === 'manage'
      ? availableSongs.filter((s) => s.source !== 'server')
      : availableSongs
  );
  let remoteSongCursor = $state(0);
  let remoteLevelCursor = $state(0);
  let activeSong = $state<SongData>(createDefaultSong('逆転'));
  // svelte-ignore state_referenced_locally
  let activeLevel = $state<SongLevel>(
    activeSong.levels[0] || {
      id: 'standard',
      name: '標準',
      difficulty: 5.0,
      trackData: createDefaultTrack(),
    }
  );
  // svelte-ignore state_referenced_locally
  let activeTrackData = $state<TrackData>(activeLevel.trackData || createDefaultTrack());
  let errorMessage = $state<string | null>(null);

  // Loading state
  let isLoadingSong = $state<boolean>(false);
  let songLoadingProgress = $state<number>(0);

  // In-Game score & completion tracking
  let currentGameScore = $state(0);
  let currentGameCombo = $state(0);
  let rhythmCanvas = $state<RhythmPlayCanvas | null>(null);
  let isGameFinished = $state(false);
  let finalGameStats = $state<{
    score: number;
    maxCombo: number;
    totalNotes: number;
    hitNotes: number;
  } | null>(null);

  // Native Chart Duration & Independent Game Elapsed Time
  let chartDuration = $state(0);
  let gameElapsedSec = $state(0);
  let overtimeAnimId: number | null = null;
  let lastOvertimeTick = 0;

  // WebRTC Phone Controller Pairing State
  let roomId = $state<string>('');
  let controllerUrl = $state<string>('');
  let qrDataUrl = $state<string>('');
  let connectedPeersCount = $state<number>(0);
  let lastReceivedKey = $state<string | null>(null);
  // `$state.raw` keeps reassignment reactive without deep-proxying the trystero
  // host instance (which would break its internal action objects).
  let webrtcHost = $state.raw<WebRtcHost | null>(null);

  // Media blob URLs
  let audioBlobUrl = $state<string | null>(null);
  let videoBlobUrl = $state<string | null>(null);

  // Master/slave sync status
  let syncCurrentTime = $state<number>(0);
  let syncDuration = $state<number>(0);
  let syncIsPlaying = $state<boolean>(false);

  let audioElement = $state<HTMLAudioElement | null>(null);
  let videoElement = $state<HTMLVideoElement | null>(null);

  // Video finishing condition: if chart is longer than video, video fades to black
  let isVideoFinished = $derived(
    videoElement && !isNaN(videoElement.duration) && videoElement.duration > 0
      ? gameElapsedSec >= videoElement.duration
      : false
  );

  const syncEngine = new MasterSlaveSyncEngine();
  let viewportManager: ViewportManager | null = null;
  let unsubscribeSync: (() => void) | null = null;

  let layout = $state<ViewportLayout>({
    isPortrait: false,
    containerWidth: 0,
    containerHeight: 0,
    transform: 'none',
    transformOrigin: '0 0',
    physicalWidth: 0,
    physicalHeight: 0,
  });

  function startOvertimeLoop() {
    if (overtimeAnimId !== null) return;
    lastOvertimeTick = performance.now();

    const loop = (now: number) => {
      if (currentScreen !== 'playing' || isPaused || isGameFinished) {
        overtimeAnimId = null;
        return;
      }
      const dt = (now - lastOvertimeTick) / 1000;
      lastOvertimeTick = now;
      if (dt > 0 && dt < 0.2) {
        gameElapsedSec += dt;
      }
      overtimeAnimId = requestAnimationFrame(loop);
    };

    overtimeAnimId = requestAnimationFrame(loop);
  }

  function stopOvertimeLoop() {
    if (overtimeAnimId !== null) {
      cancelAnimationFrame(overtimeAnimId);
      overtimeAnimId = null;
    }
  }

  async function refreshSongList() {
    try {
      availableSongs = await getAvailableSongs();
    } catch (e) {
      console.warn('[App] Failed to refresh songs list:', e);
    }
  }

  onMount(async () => {
    if (isControllerMode) return;

    try {
      viewportManager = new ViewportManager();
      viewportManager.subscribe((newLayout: ViewportLayout) => {
        layout = newLayout;
      });

      unsubscribeSync = syncEngine.onSyncState((state: SyncState) => {
        syncCurrentTime = state.currentTime;
        syncDuration = state.duration;
        syncIsPlaying = state.isPlaying;

        // While master audio is actively playing, drive gameElapsedSec from audio clock
        if (state.isPlaying || (syncDuration > 0 && state.currentTime < syncDuration - 0.1)) {
          gameElapsedSec = state.currentTime;
          stopOvertimeLoop();
        } else if (
          currentScreen === 'playing' &&
          !isPaused &&
          !isGameFinished &&
          chartDuration > syncDuration
        ) {
          // If chart is longer than audio, continue advancing game time in overtime loop
          startOvertimeLoop();
        }
      });

      // 1. Initialize WebRTC Host & Room ID
      let storedRoom = sessionStorage.getItem('piecemusic_room_id');
      if (!storedRoom) {
        storedRoom = generateRoomId();
        sessionStorage.setItem('piecemusic_room_id', storedRoom);
      }
      roomId = storedRoom;

      // 2. Discover LAN host IP if running on localhost dev server
      let host = window.location.host;
      try {
        const res = await fetch('/api/host-info');
        if (res.ok) {
          const info = await res.json();
          if (
            info.lanIp &&
            (window.location.hostname === 'localhost' ||
              window.location.hostname === '127.0.0.1')
          ) {
            host = `${info.lanIp}:${window.location.port}`;
          }
        }
      } catch {}

      controllerUrl = `${window.location.protocol}//${host}/?mode=controller&room=${roomId}`;

      // 3. Generate Sharp Paper styled QR Code
      qrDataUrl = await QRCode.toDataURL(controllerUrl, {
        errorCorrectionLevel: 'M',
        margin: 2,
        color: {
          dark: '#292524',
          light: '#fffdfa',
        },
        width: 240,
      });

      // 4. Start WebRTC Host listening on public MQTT beacon
      webrtcHost = new WebRtcHost(roomId, {
        onPeerJoin: (peerId: string) => {
          console.log('[WebRTC] Controller phone connected:', peerId);
          connectedPeersCount = webrtcHost?.getConnectedPeerCount() || 1;
          broadcastControllerState();
        },
        onPeerLeave: (peerId: string) => {
          console.log('[WebRTC] Controller phone disconnected:', peerId);
          connectedPeersCount = webrtcHost?.getConnectedPeerCount() || 0;
        },
        onKeyMessage: (event: ControllerKeyEvent, peerId: string) => {
          lastReceivedKey = `${event.key} [${event.action.toUpperCase()}]`;

          // Process key event in rhythm game when in playing mode.
          // Latency compensation: map the phone's press timestamp into host audio
          // time so the note is judged at the moment it was pressed — not when the
          // WebRTC packet happened to arrive. Each phone has its own clock offset.
          if (currentScreen === 'playing' && event.action === 'down' && !isGameFinished) {
            const offsetMs = webrtcHost?.getClockOffsetMs(peerId) ?? null;
            if (offsetMs !== null) {
              const hostPerfNow = event.timestamp - offsetMs;
              const pressAudioTime = syncEngine.hostClockToAudioTime(hostPerfNow);
              rhythmCanvas?.handleRhythmInput(event.key, pressAudioTime);
            } else {
              // No clock sample for this phone yet — judge at live playhead time.
              rhythmCanvas?.handleRhythmInput(event.key);
            }
          }
        },
        onCommandMessage: (event) => {
          handleControllerCommand(event.command, event.id);
        },
      });
      webrtcHost.start();

      // 5. Discover songs (index only — no archive is downloaded here).
      //    A song is loaded lazily when the user selects it.
      await refreshSongList();
    } catch (err: any) {
      console.error('Failed to initialize game barebone:', err);
      errorMessage = err?.message || '初期化エラー';
    }
  });

  $effect(() => {
    if (audioElement) {
      syncEngine.attach(audioElement, videoElement);
    }
  });

  function buildControllerState(): ControllerState {
    return {
      screen: currentScreen,
      songSelectMode: songSelectMode,
      isPaused: isPaused,
      isGameFinished: isGameFinished,
    };
  }

  function broadcastControllerState() {
    webrtcHost?.sendState(buildControllerState());
  }

  // Broadcast the desktop's current screen/context to connected phones so the
  // remote controller can render context-sensitive controls.
  $effect(() => {
    if (webrtcHost) {
      broadcastControllerState();
    }
  });

  // Keep the remote cursor in bounds and reset it when leaving a selection screen.
  $effect(() => {
    if (currentScreen !== 'song-select') {
      remoteSongCursor = 0;
    } else if (remoteSongCursor >= displayedSongs.length) {
      remoteSongCursor = 0;
    }

    const levelCount = activeSong?.levels?.length || 0;
    if (currentScreen !== 'level-select') {
      remoteLevelCursor = 0;
    } else if (remoteLevelCursor >= levelCount) {
      remoteLevelCursor = 0;
    }
  });

  // Navigation handlers
  function toPlaySongSelect() {
    songSelectMode = 'play';
    refreshSongList();
    currentScreen = 'song-select';
  }

  function toManageSongSelect() {
    songSelectMode = 'manage';
    refreshSongList();
    currentScreen = 'song-select';
  }

  function toSongSelect() {
    refreshSongList();
    currentScreen = 'song-select';
  }

  function toHome() {
    currentScreen = 'home';
  }

  // Song selection handler
  async function handleSelectSong(songItem: SongListItem) {
    // Skip the redundant download/extract only if this song is actually loaded.
    // (The initial placeholder has no media, so it must not short-circuit a real load.)
    const alreadyLoaded =
      activeSong &&
      activeSong.id === songItem.id &&
      !!(activeSong.audioBlobUrl || activeSong.audioBlob || activeSong.archiveBlob);
    if (alreadyLoaded) {
      if (activeSong.levels.length > 0) {
        activeLevel = activeSong.levels[0];
        activeTrackData = activeLevel.trackData;
      }
      audioBlobUrl = activeSong.audioBlobUrl;
      videoBlobUrl = activeSong.videoBlobUrl;
      if (audioElement) {
        syncEngine.attach(audioElement, videoElement);
      }
      currentScreen = songSelectMode === 'play' ? 'level-select' : 'edit';
      return;
    }

    isLoadingSong = true;
    songLoadingProgress = 10;
    errorMessage = null;
    try {
      activeSong = await loadSong(songItem, (pct) => (songLoadingProgress = pct));
      if (activeSong.levels.length > 0) {
        activeLevel = activeSong.levels[0];
        activeTrackData = activeLevel.trackData;
      }
      audioBlobUrl = activeSong.audioBlobUrl;
      videoBlobUrl = activeSong.videoBlobUrl;
      if (audioElement) {
        syncEngine.attach(audioElement, videoElement);
      }

      if (songSelectMode === 'play') {
        currentScreen = 'level-select';
      } else {
        currentScreen = 'edit';
      }
    } catch (err: any) {
      console.error('Failed to load song:', err);
      errorMessage = err?.message || '曲アーカイブの読み込みに失敗';
    } finally {
      isLoadingSong = false;
    }
  }

  function handleAddSong() {
    activeSong = createDefaultSong('新しい曲');
    if (activeSong.levels.length > 0) {
      activeLevel = activeSong.levels[0];
      activeTrackData = activeLevel.trackData;
    }
    audioBlobUrl = null;
    videoBlobUrl = null;
    currentScreen = 'edit';
  }

  async function handleImportArchive(file: File) {
    isLoadingSong = true;
    songLoadingProgress = 20;
    errorMessage = null;
    try {
      activeSong = await unpackSongArchive(file);
      if (activeSong.levels.length > 0) {
        activeLevel = activeSong.levels[0];
        activeTrackData = activeLevel.trackData;
      }
      audioBlobUrl = activeSong.audioBlobUrl;
      videoBlobUrl = activeSong.videoBlobUrl;
      currentScreen = 'edit';
    } catch (err: any) {
      console.error('Failed to unpack song archive:', err);
      errorMessage = err?.message || '曲アーカイブの展開に失敗';
    } finally {
      isLoadingSong = false;
    }
  }

  async function handleDeleteSong(songId: string) {
    try {
      await deleteStoredSong(songId);
      await refreshSongList();
    } catch (err: any) {
      errorMessage = `Failed to delete song: ${err.message || err}`;
    }
  }

  async function handleBackupSongFromList(songItem: SongListItem) {
    try {
      const songData = await loadSong(songItem);
      const archiveBlob = await packSongArchive(songData);
      downloadBlob(archiveBlob, `${songData.name || 'song'}.zip`);
    } catch (err: any) {
      errorMessage = `Failed to backup song: ${err.message || err}`;
    }
  }

  // Play specific level
  async function handleSelectAndPlaySongLevel(level: SongLevel, startTimeSec = 0) {
    try {
      activeLevel = level;
      activeTrackData = level.trackData;
      audioBlobUrl = activeSong.audioBlobUrl;
      videoBlobUrl = activeSong.videoBlobUrl;

      currentScreen = 'playing';
      isPaused = false;
      isGameFinished = false;
      finalGameStats = null;
      gameElapsedSec = startTimeSec;
      currentGameScore = 0;
      currentGameCombo = 0;
      errorMessage = null;
      isAwaitingAudioStart = false;

      if (audioElement) {
        syncEngine.attach(audioElement, videoElement);
        if (startTimeSec > 0) {
          await seekAudioTo(startTimeSec);
        }
      }

      // Start audio first so it consumes the current user gesture; then enter
      // fullscreen (which can otherwise steal the transient activation).
      await syncEngine.play();

      viewportManager?.requestFullscreen().catch((err: unknown) => {
        console.warn('Fullscreen request bypassed:', err);
      });

      // If autoplay was blocked (e.g. the level was started from the phone
      // remote, which has no desktop user gesture), prompt for a single tap.
      if (!syncEngine.isPlaying) {
        isAwaitingAudioStart = true;
      }
    } catch (err: any) {
      console.error('Failed to start level playback:', err);
      errorMessage = err?.message || '再生の開始に失敗';
    }
  }

  // Seek the master audio to a target time, waiting for its metadata to load
  // first (needed when the audio src changed in the same tick).
  async function seekAudioTo(timeSec: number): Promise<void> {
    const audio = audioElement;
    if (!audio) return;

    // Let Svelte flush any pending src attribute change.
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));

    if (audio.readyState >= 1 && !isNaN(audio.duration)) {
      syncEngine.seek(timeSec);
      return;
    }

    await new Promise<void>((resolve) => {
      let settled = false;
      const done = () => {
        if (!settled) {
          settled = true;
          resolve();
        }
      };
      audio.addEventListener('loadedmetadata', done, { once: true });
      audio.addEventListener('error', done, { once: true });
      setTimeout(done, 4000);
    });

    syncEngine.seek(timeSec);
  }

  async function handlePlaySongLevelFromEditor(song: SongData, level: SongLevel, startTimeSec = 0) {
    activeSong = song;
    audioBlobUrl = song.audioBlobUrl;
    videoBlobUrl = song.videoBlobUrl;
    launchedFromEditor = true;
    await handleSelectAndPlaySongLevel(level, startTimeSec);
  }

  function handleSongSaved(savedSong: SongData) {
    activeSong = savedSong;
    refreshSongList();
  }

  // Chart completion handler
  function handleGameComplete(
    score: number,
    maxCombo: number,
    totalNotes: number,
    hitNotes: number
  ) {
    syncEngine.pause();
    stopOvertimeLoop();
    isGameFinished = true;
    finalGameStats = { score, maxCombo, totalNotes, hitNotes };
  }

  // Pause / Resume / Restart / Exit handlers
  function handlePause() {
    if (currentScreen !== 'playing' || isGameFinished) return;
    isPaused = true;
    stopOvertimeLoop();
    syncEngine.pause();
  }

  async function handleResume() {
    if (currentScreen !== 'playing' || isGameFinished) return;
    isPaused = false;
    try {
      if (syncDuration > 0 && syncCurrentTime < syncDuration) {
        await syncEngine.play();
      } else if (chartDuration > syncDuration) {
        startOvertimeLoop();
      }
    } catch (err: any) {
      console.error('Failed to resume playback:', err);
      errorMessage = err?.message || '再開に失敗';
    }
  }

  async function handleRestart() {
    stopOvertimeLoop();
    syncEngine.seek(0);
    gameElapsedSec = 0;
    isPaused = false;
    isGameFinished = false;
    finalGameStats = null;
    currentGameScore = 0;
    currentGameCombo = 0;
    try {
      await syncEngine.play();
    } catch (err: any) {
      console.error('Failed to restart playback:', err);
      errorMessage = err?.message || '最初から再生に失敗';
    }
  }

  function handleExitToMenu() {
    stopOvertimeLoop();
    syncEngine.pause();
    syncEngine.seek(0);
    gameElapsedSec = 0;
    isPaused = false;
    isGameFinished = false;
    finalGameStats = null;
    currentScreen = launchedFromEditor ? 'edit' : 'level-select';
    launchedFromEditor = false;
  }

  function togglePause() {
    if (isGameFinished) return;
    if (isPaused) {
      handleResume();
    } else {
      handlePause();
    }
  }

  function startAudioFromPrompt() {
    isAwaitingAudioStart = false;
    syncEngine.play().catch((err: unknown) => {
      console.warn('Failed to start audio from prompt:', err);
    });
  }

  // Remote commands sent from the phone controller.
  function handleControllerCommand(command: ControllerCommand, id = '') {
    switch (command) {
      case 'start':
        startFromController();
        break;
      case 'level-select':
        chooseLevelFromController();
        break;
      case 'pause':
        if (currentScreen === 'playing') togglePause();
        break;
      case 'restart':
        if (currentScreen === 'playing') handleRestart();
        break;
      case 'play':
        toPlaySongSelect();
        break;
      case 'edit':
        toManageSongSelect();
        break;
      case 'back':
        handleRemoteBack();
        break;
      case 'quit':
        if (currentScreen === 'playing') handleExitToMenu();
        break;
      case 'up':
        handleRemoteMove(-1);
        break;
      case 'down':
        handleRemoteMove(1);
        break;
      case 'ok':
        handleRemoteConfirm();
        break;
    }

    // Immediately push the latest state back to phones so the remote UI
    // reflects synchronous navigation (back/play/edit/pause/quit, etc.).
    broadcastControllerState();
  }

  function handleRemoteBack() {
    switch (currentScreen) {
      case 'song-select':
        toHome();
        break;
      case 'level-select':
      case 'edit':
        toSongSelect();
        break;
      default:
        break;
    }
  }

  function handleRemoteMove(delta: number) {
    if (currentScreen === 'song-select') {
      const len = displayedSongs.length;
      if (len === 0) return;
      remoteSongCursor = ((remoteSongCursor + delta) % len + len) % len;
    } else if (currentScreen === 'level-select') {
      const len = activeSong?.levels?.length || 0;
      if (len === 0) return;
      remoteLevelCursor = ((remoteLevelCursor + delta) % len + len) % len;
    }
  }

  function handleRemoteConfirm() {
    if (currentScreen === 'song-select') {
      const song = displayedSongs[remoteSongCursor];
      if (song) handleSelectSong(song);
    } else if (currentScreen === 'level-select') {
      const level = activeSong?.levels?.[remoteLevelCursor];
      if (level) handleSelectAndPlaySongLevel(level);
    }
  }

  function startFromController() {
    // Already playing: ignore (use restart to replay).
    if (currentScreen === 'playing') return;
    const hasLoadedSong = !!(
      activeSong &&
      (activeSong.audioBlobUrl || activeSong.audioBlob || activeSong.archiveBlob)
    );
    if (hasLoadedSong && activeLevel && activeLevel.trackData) {
      handleSelectAndPlaySongLevel(activeLevel);
    } else {
      chooseLevelFromController();
    }
  }

  function chooseLevelFromController() {
    handleExitToMenu();
  }

  function handleScoreUpdate(score: number, combo: number) {
    currentGameScore = score;
    currentGameCombo = combo;
  }

  function formatTime(seconds: number): string {
    if (!seconds || isNaN(seconds) || seconds < 0) return '00:00';
    const mins = Math.floor(seconds / 60);
    const secs = Math.floor(seconds % 60);
    return `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
  }

  onDestroy(() => {
    stopOvertimeLoop();
    webrtcHost?.stop();
    unsubscribeSync?.();
    syncEngine?.destroy();
    revokeMediaBlob(audioBlobUrl);
    revokeMediaBlob(videoBlobUrl);
  });
</script>

<svelte:window
  onkeydown={(e: KeyboardEvent) => {
    if (!isControllerMode && currentScreen === 'playing' && e.key === 'Escape') {
      e.preventDefault();
      togglePause();
    }
  }}
/>

{#if isControllerMode}
  <!-- Phone Controller Route (Directly rendered on mobile scan) -->
  <PhoneController initialRoomId={controllerInitialRoom} />
{:else}
  <!-- Desktop Game View -->
  <!-- SVG Paper Filters for Hand-Crafted Jagged Edges -->
  <PaperSvgFilters />

  <!-- Invisible Master Audio Element fed with local Blob URL or stream -->
  <audio
    bind:this={audioElement}
    src={audioBlobUrl || activeSong?.audioBlobUrl || ''}
    preload="auto"
    style="position: fixed; width: 0; height: 0; opacity: 0; pointer-events: none;"
  ></audio>

  <main
    class="fixed inset-0 w-full h-full overflow-hidden bg-black select-none"
    role="presentation"
  >
    <!-- Auto-Oriented Game Viewport Container -->
    <div
      class="absolute top-0 left-0 overflow-hidden bg-black"
      style="
        width: {layout.containerWidth}px;
        height: {layout.containerHeight}px;
        transform: {layout.transform};
        transform-origin: {layout.transformOrigin};
        will-change: transform, width, height;
      "
    >
      <!-- Video Background Layer (Fades to solid black if chart is longer than video) -->
      {#if videoBlobUrl || activeSong?.videoBlobUrl}
        <video
          bind:this={videoElement}
          src={videoBlobUrl || activeSong?.videoBlobUrl}
          preload="auto"
          muted
          playsinline
          disablepictureinpicture
          disableremoteplayback
          class="absolute inset-0 w-full h-full object-cover pointer-events-none transition-opacity duration-700"
          style="
            opacity: {isVideoFinished ? 0 : 0.5};
          "
          onplaying={() => console.log('[Video] Background video playing')}
          onerror={(e) => {
            const target = e.currentTarget as HTMLVideoElement;
            if (target && target.src && target.error) {
              console.warn('[Video] Playback warning code:', target.error.code, target.error.message);
            }
          }}
        ></video>
      {/if}

      <!-- 2D Paper Rhythm Track Layer -->
      {#if currentScreen === 'playing'}
        <RhythmPlayCanvas
          bind:this={rhythmCanvas}
          trackData={activeTrackData}
          currentTimeSec={gameElapsedSec}
          {isPaused}
          containerWidth={layout.containerWidth}
          containerHeight={layout.containerHeight}
          onScoreChange={handleScoreUpdate}
          onGameComplete={handleGameComplete}
          onDurationCalculated={(dur) => (chartDuration = dur)}
        />
      {/if}

      <!-- In-Game Top-Left Pause Button -->
      {#if currentScreen === 'playing' && !isPaused && !isGameFinished}
        <button
          onclick={togglePause}
          class="paper-btn absolute top-4 left-4 z-40 px-3.5 py-2 bg-[#fffdfa]/95 hover:bg-white text-[#292524] text-xs font-mono font-bold tracking-wider flex items-center gap-2 cursor-pointer shadow-[3px_3px_0px_#292524]"
          title="一時停止 (Esc)"
          aria-label="ゲームを一時停止"
        >
          <span class="inline-flex gap-0.5 items-center">
            <span class="w-1.5 h-3 bg-[#292524]"></span>
            <span class="w-1.5 h-3 bg-[#292524]"></span>
          </span>
          <span>一時停止</span>
          <span class="text-[10px] text-[#292524]/60 font-normal">[ESC]</span>
        </button>
      {/if}

      <!-- In-Game Score & Combo HUD Pill (Top Center) -->
      {#if currentScreen === 'playing'}
        <div class="absolute top-4 left-1/2 -translate-x-1/2 z-40 px-4 py-1.5 bg-[#fffdfa]/95 border-[1.5px] border-[#292524] shadow-[3px_3px_0px_#292524] flex items-center gap-4 text-xs font-mono font-black tracking-wider text-[#292524]">
          <div class="flex items-center gap-1.5">
            <span class="text-[#292524]/60 font-normal">{activeSong.name} [{activeLevel.name}]:</span>
            <span>{currentGameScore}</span>
          </div>
          <div class="w-px h-3.5 bg-[#292524]/30"></div>
          <div class="flex items-center gap-1.5">
            <span class="text-[#292524]/60 font-normal">コンボ:</span>
            <span class="text-[#d97706]">{currentGameCombo}</span>
          </div>
          <div class="w-px h-3.5 bg-[#292524]/30"></div>
          <div class="flex items-center gap-1.5 text-[11px] font-normal text-[#292524]/70">
            <span>{formatTime(gameElapsedSec)} / {formatTime(chartDuration || syncDuration)}</span>
          </div>
        </div>
      {/if}

      <!-- In-Game Controller Connected Badge on Top-Right -->
      {#if currentScreen === 'playing' && connectedPeersCount > 0}
        <div class="absolute top-4 right-4 z-40 px-3 py-1.5 bg-[#fffdfa]/90 border-[1.5px] border-[#292524] text-[10px] font-mono font-bold text-[#292524] flex items-center gap-2 shadow-[2px_2px_0px_#292524]">
          <span class="w-2 h-2 bg-emerald-500 inline-block animate-pulse"></span>
          <span>スマホ接続済み</span>
          {#if lastReceivedKey}
            <span class="px-1.5 py-0.2 bg-[#d8ecd7] border border-[#292524]/40">
              {lastReceivedKey}
            </span>
          {/if}
        </div>
      {/if}

      <!-- In-Game Bottom Touch Lanes (For direct touch screen / mobile players) -->
      {#if currentScreen === 'playing' && !isPaused && !isGameFinished}
        <div class="absolute bottom-4 left-4 right-4 z-40 flex items-center justify-between pointer-events-none">
          <button
            type="button"
            ontouchstart={(e) => { e.preventDefault(); rhythmCanvas?.handleRhythmInput('z'); }}
            onmousedown={() => rhythmCanvas?.handleRhythmInput('z')}
            class="paper-btn pointer-events-auto px-6 py-3 bg-[#dbeafe]/90 active:bg-[#bfdbfe] text-[#1d4ed8] font-mono font-bold text-sm tracking-wider shadow-[3px_3px_0px_#292524] flex items-center gap-2 cursor-pointer"
          >
            <span class="w-3 h-3 bg-[#3b82f6]"></span>
            <span>青 [Z / D]</span>
          </button>

          <button
            type="button"
            ontouchstart={(e) => { e.preventDefault(); rhythmCanvas?.handleRhythmInput('x'); }}
            onmousedown={() => rhythmCanvas?.handleRhythmInput('x')}
            class="paper-btn pointer-events-auto px-6 py-3 bg-[#d8ecd7]/90 active:bg-[#a8d5a6] text-[#047857] font-mono font-bold text-sm tracking-wider shadow-[3px_3px_0px_#292524] flex items-center gap-2 cursor-pointer"
          >
            <span>緑 [X / K]</span>
            <span class="w-3 h-3 bg-[#047857]"></span>
          </button>
        </div>
      {/if}

      <!-- Tap-to-start prompt (autoplay blocked until a desktop gesture) -->
      {#if currentScreen === 'playing' && isAwaitingAudioStart && !isPaused && !isGameFinished}
        <div class="absolute inset-0 z-50 bg-[#292524]/70 backdrop-blur-[2px] flex items-center justify-center p-4 select-none">
          <div class="paper-card jagged-border bg-[#fffdfa] w-full max-w-sm p-8 flex flex-col items-center gap-4">
            <span class="text-3xl">🔊</span>
            <h2 class="text-xl font-black font-mono text-[#292524]">タップで開始</h2>
            <p class="text-xs font-mono text-[#292524]/70 text-center">音声を再生するには、この画面を一度タップする必要があります。</p>
            <button
              onclick={startAudioFromPrompt}
              class="paper-btn w-full py-3 bg-[#d8ecd7] hover:bg-[#c5dac1] text-[#292524] font-mono font-bold tracking-widest text-sm cursor-pointer"
            >
              ▶ 開始
            </button>
          </div>
        </div>
      {/if}

      <!-- In-Game Pause Overlay Modal -->
      {#if currentScreen === 'playing' && isPaused && !isGameFinished}
        <PauseOverlay
          levelName="{activeSong.name} - {activeLevel.name}"
          currentTimeSec={gameElapsedSec}
          durationSec={chartDuration || syncDuration}
          onResume={handleResume}
          onRestart={handleRestart}
          onExit={handleExitToMenu}
        />
      {/if}

      <!-- Stage Clear / Results Modal -->
      {#if currentScreen === 'playing' && isGameFinished && finalGameStats}
        <StageClearOverlay
          levelName="{activeSong.name} - {activeLevel.name}"
          score={finalGameStats.score}
          maxCombo={finalGameStats.maxCombo}
          hitNotes={finalGameStats.hitNotes}
          totalNotes={finalGameStats.totalNotes}
          onPlayAgain={handleRestart}
          onLevelSelect={handleExitToMenu}
        />
      {/if}

      <!-- Solid Paper Menus overlaying the game viewport -->
      {#if currentScreen === 'home'}
        <div class="absolute inset-0 z-30">
          <HomeScreen
            onPlay={toPlaySongSelect}
            onManageSongs={toManageSongSelect}
            {roomId}
            {controllerUrl}
            {qrDataUrl}
            {connectedPeersCount}
            {lastReceivedKey}
          />
        </div>
      {:else if currentScreen === 'song-select'}
        <div class="absolute inset-0 z-30">
          <SongSelect
            mode={songSelectMode}
            songs={availableSongs}
            selectedSongId={activeSong?.id}
            isLoading={isLoadingSong}
            loadingProgress={songLoadingProgress}
            onSelectSong={handleSelectSong}
            onAddSong={handleAddSong}
            onImportArchive={handleImportArchive}
            onDeleteSong={handleDeleteSong}
            onBackupSong={handleBackupSongFromList}
            onBack={toHome}
            focusedIndex={remoteSongCursor}
          />
        </div>
      {:else if currentScreen === 'level-select'}
        <div class="absolute inset-0 z-30">
          <LevelSelect
            song={activeSong}
            levels={activeSong?.levels || []}
            selectedLevel={activeLevel}
            onSelectLevel={handleSelectAndPlaySongLevel}
            onBack={toSongSelect}
            focusedIndex={remoteLevelCursor}
          />
        </div>
      {:else if currentScreen === 'edit'}
        <div class="absolute inset-0 z-30">
          <EditScreen
            initialSong={activeSong}
            initialTrackData={activeTrackData}
            audioBlobUrl={audioBlobUrl || activeSong?.audioBlobUrl}
            videoBlobUrl={videoBlobUrl || activeSong?.videoBlobUrl}
            videoDuration={syncDuration}
            onSaveSong={handleSongSaved}
            onPlaySongLevel={handlePlaySongLevelFromEditor}
            onBack={toSongSelect}
          />
        </div>
      {/if}

      <!-- Global Error Banner if any error occurs -->
      {#if errorMessage}
        <div class="paper-card absolute bottom-4 left-1/2 -translate-x-1/2 z-50 bg-[#fce1db] border-[1.5px] border-[#292524] px-4 py-2 text-xs font-mono text-[#292524] flex items-center gap-3 shadow-[3px_3px_0px_#292524]">
          <span>⚠ {errorMessage}</span>
          <button
            onclick={() => (errorMessage = null)}
            class="font-bold underline cursor-pointer"
          >
            閉じる
          </button>
        </div>
      {/if}
    </div>
  </main>
{/if}
