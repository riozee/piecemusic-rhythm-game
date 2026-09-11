<script lang="ts">
  import { onMount, onDestroy, untrack } from 'svelte';
  import type { TrackData, TrackNode, BendPoint, Breakpoint, OffsetBreakpoint, TrackNote, TrackDecoration } from '../types/track';
  import {
    dist,
    generatePathData,
    generateSpeedTicksPath,
    generateBeatTicksPath,
    getValueAtProgress,
    getOffsetAtProgress,
    calculateTotalDuration,
    buildTimeProgressTable,
    getTimeToProgress,
    getProgressToTime,
    formatTime,
    getClosestPointOnPath,
    samplePathPolyline,
    sampleTrackPoints,
    getPointOnTrack,
    type PathSample,
  } from '../core/track-math';
  import { computePlaneGrid } from '../core/grid';
  import type { SongData, SongLevel } from '../types/song';
  import { packSongArchive, unpackSongArchive, downloadBlob } from '../core/song-archive';
  import { saveSongToStorage } from '../core/song-storage';
  import { createDefaultTrack } from '../core/levels';
  import { detectBpm } from '../core/bpm';

  interface Props {
    initialSong?: SongData | null;
    initialTrackData?: TrackData;
    audioBlobUrl?: string | null;
    videoBlobUrl?: string | null;
    videoDuration?: number;
    onSaveSong?: (song: SongData) => void;
    onSaveTrack?: (track: TrackData) => void;
    onPlayGame?: (track: TrackData, customMedia?: { audioUrl?: string | null; videoUrl?: string | null }) => void;
    onPlaySongLevel?: (song: SongData, level: SongLevel) => void;
    onBack: () => void;
  }

  const {
    initialSong = null,
    initialTrackData,
    audioBlobUrl: propsAudioBlobUrl = null,
    videoBlobUrl: propsVideoBlobUrl = null,
    videoDuration = 0,
    onSaveSong,
    onSaveTrack,
    onPlayGame,
    onPlaySongLevel,
    onBack,
  }: Props = $props();

  // Song metadata state
  // svelte-ignore state_referenced_locally
  let songId = $state(initialSong?.id || 'song_' + Date.now());
  // svelte-ignore state_referenced_locally
  let songName = $state(initialSong?.name || '新しい曲');
  // svelte-ignore state_referenced_locally
  let songArtist = $state(initialSong?.artist || '');
  // svelte-ignore state_referenced_locally
  let songLevels = $state<SongLevel[]>(
    initialSong?.levels && initialSong.levels.length > 0
      ? JSON.parse(JSON.stringify(initialSong.levels))
      : [
          {
            id: 'standard',
            name: '標準',
            difficulty: 5.0,
            chartFile: 'levels/standard.json',
            trackData: initialTrackData || createDefaultTrack(),
          },
        ]
  );
  let activeLevelIndex = $state(0);

  // svelte-ignore state_referenced_locally
  const initialActiveTrack = initialSong?.levels?.[0]?.trackData || initialTrackData || createDefaultTrack();

  // Active track state initialized directly from initialActiveTrack
  // svelte-ignore state_referenced_locally
  let planeW = $state(initialActiveTrack?.planeW || 2000);
  // svelte-ignore state_referenced_locally
  let planeH = $state(initialActiveTrack?.planeH || 5000);
  // svelte-ignore state_referenced_locally
  let nodes = $state.raw<TrackNode[]>(
    JSON.parse(JSON.stringify(initialActiveTrack?.nodes || [{ x: 0, y: 2500 }, { x: 2000, y: 2500 }]))
  );
  // svelte-ignore state_referenced_locally
  let bends = $state.raw<Record<number, BendPoint>>(
    JSON.parse(JSON.stringify(initialActiveTrack?.bends || {}))
  );
  // svelte-ignore state_referenced_locally
  let speedBPs = $state.raw<Breakpoint[]>(
    JSON.parse(JSON.stringify(initialActiveTrack?.speedBPs || []))
  );
  // svelte-ignore state_referenced_locally
  let zoomBPs = $state.raw<Breakpoint[]>(
    JSON.parse(JSON.stringify(initialActiveTrack?.zoomBPs || []))
  );
  // svelte-ignore state_referenced_locally
  let offsetBPs = $state.raw<OffsetBreakpoint[]>(
    JSON.parse(JSON.stringify(initialActiveTrack?.offsetBPs || []))
  );
  // svelte-ignore state_referenced_locally
  let notes = $state.raw<TrackNote[]>(
    JSON.parse(JSON.stringify(initialActiveTrack?.notes || []))
  );
  // svelte-ignore state_referenced_locally
  let decorations = $state.raw<TrackDecoration[]>(
    JSON.parse(JSON.stringify(initialActiveTrack?.decorations || []))
  );

  // Viewport transformation
  let panX = $state(0);
  let panY = $state(0);
  let zoom = $state(0.75);
  let viewportW = $state(1280);
  let viewportH = $state(720);

  let visibleEditorNotes = $derived.by(() => {
    // World-space bounding box visible in the editor viewport
    const margin = 100; // generous margin to prevent pop-in during pan
    const worldLeft = -panX / zoom - margin;
    const worldTop = -panY / zoom - margin;
    const worldRight = (-panX + viewportW) / zoom + margin;
    const worldBottom = (-panY + viewportH) / zoom + margin;
    
    const result: { note: typeof notes[0]; idx: number }[] = [];
    for (let i = 0; i < notes.length; i++) {
        const n = notes[i];
        if (n.x + n.w >= worldLeft && n.x <= worldRight && n.y + n.h >= worldTop && n.y <= worldBottom) {
            result.push({ note: n, idx: i });
        }
    }
    return result;
  });

  // Same viewport culling for ghost decorations (kept out of the DOM when off-screen).
  let visibleDecorations = $derived.by(() => {
    const margin = 100;
    const worldLeft = -panX / zoom - margin;
    const worldTop = -panY / zoom - margin;
    const worldRight = (-panX + viewportW) / zoom + margin;
    const worldBottom = (-panY + viewportH) / zoom + margin;

    const result: { dec: typeof decorations[0]; idx: number }[] = [];
    for (let i = 0; i < decorations.length; i++) {
      const d = decorations[i];
      if (d.x + d.w >= worldLeft && d.x <= worldRight && d.y + d.h >= worldTop && d.y <= worldBottom) {
        result.push({ dec: d, idx: i });
      }
    }
    return result;
  });

  // Editor tools
  type Tool = 'DRAW' | 'BEND' | 'NOTES' | 'SPEED' | 'ZOOM' | 'OFFSET' | 'PREVIEW';
  let activeTool = $state<Tool>('DRAW');
  let noteColor = $state<'blue' | 'green' | 'deco'>('blue');

  // Interactive interaction states
  let isPanning = $state(false);
  let isResizing = $state<string | null>(null);
  let dragTarget:
    | { type: 'node' | 'bend'; index: number }
    | { type: 'bp'; bpType: 'speed' | 'zoom' | 'offset'; index: number }
    | null = null;
  let drawingNote = $state<{ sx: number; sy: number; cx: number; cy: number } | null>(null);
  let scrubbingPreview = false;
  let previewProgress = $state(0);
  let isPipPlaying = $state(false);

  // Selected breakpoint for real-time editing
  let selectedBP = $state<{
    type: 'speed' | 'zoom' | 'offset';
    index: number;
  } | null>(null);

  // Hover Camera POV box state
  let hoverPov = $state<{
    x: number;
    y: number;
    width: number;
    height: number;
    zoom: number;
    progress: number;
    nx: number;
    ny: number;
    visible: boolean;
  }>({
    x: 0,
    y: 0,
    width: 160,
    height: 90,
    zoom: 1,
    progress: 0,
    nx: 0,
    ny: 0,
    visible: false,
  });

  let lastMx = 0;
  let lastMy = 0;
  let pendingMouseEvent: MouseEvent | null = null;
  let mouseMoveRafId: number | null = null;
  let dragStateBackup: string | null = null;
  let hasMoved = false;
  let showHelp = $state(false);
  let spaceHeld = $state(false);

  // History stack
  let undoStack = $state<string[]>([]);
  let redoStack = $state<string[]>([]);

  // DOM element refs
  let viewportEl = $state<HTMLDivElement | null>(null);
  let viewportRO: ResizeObserver | null = null;
  let pathBgEl = $state<SVGPathElement | null>(null);
  let pipVideoEl = $state<HTMLVideoElement | null>(null);
  let pipAudioEl = $state<HTMLAudioElement | null>(null);
  let fileInputEl = $state<HTMLInputElement | null>(null);
  let videoInputEl = $state<HTMLInputElement | null>(null);
  let audioInputEl = $state<HTMLInputElement | null>(null);
  let archiveInputEl = $state<HTMLInputElement | null>(null);
  let customVideoUrl = $state<string | null>(null);
  let customAudioUrl = $state<string | null>(null);
  // svelte-ignore state_referenced_locally
  let currentAudioBlob = $state<Blob | null>(initialSong?.audioBlob || null);
  // svelte-ignore state_referenced_locally
  let currentVideoBlob = $state<Blob | null>(initialSong?.videoBlob || null);
  // svelte-ignore state_referenced_locally
  let audioFileName = $state<string>(initialSong?.audioFile || (initialSong?.audioBlobUrl || propsAudioBlobUrl ? 'audio.opus' : ''));
  // svelte-ignore state_referenced_locally
  let videoFileName = $state<string>(initialSong?.videoFile || (initialSong?.videoBlobUrl || propsVideoBlobUrl ? 'video.mp4' : ''));

  let resolvedAudioUrl = $derived(customAudioUrl || propsAudioBlobUrl || initialSong?.audioBlobUrl || '');
  let resolvedVideoUrl = $derived(customVideoUrl || propsVideoBlobUrl || initialSong?.videoBlobUrl || '');

  let isPackaging = $state(false);
  let toastMessage = $state<string | null>(null);
  let toastTimeout: any = null;

  function showToast(msg: string) {
    toastMessage = msg;
    if (toastTimeout) clearTimeout(toastTimeout);
    toastTimeout = setTimeout(() => {
      toastMessage = null;
    }, 3500);
  }

  // Dialog states
  let showMetadataDialog = $state(false);
  let tempSongName = $state('');
  let tempSongArtist = $state('');
  let tempSongId = $state('');

  let showAddLevelDialog = $state(false);
  let newLevelName = $state('ハード');
  let newLevelDifficulty = $state(5.0);
  let newLevelCopyCurrent = $state(false);

  let showEditLevelDialog = $state(false);
  let editLevelName = $state('');
  let editLevelDifficulty = $state(5.0);

  function openMetadataDialog() {
    tempSongName = songName;
    tempSongArtist = songArtist;
    tempSongId = songId;
    showMetadataDialog = true;
  }

  function saveMetadata() {
    songName = tempSongName.trim() || '無題の曲';
    songArtist = tempSongArtist.trim();
    songId = tempSongId.trim() || songName.toLowerCase().replace(/[^a-z0-9_-]/g, '_');
    showMetadataDialog = false;
    showToast('✓ 曲の情報を更新しました');
  }

  function commitActiveChart() {
    if (songLevels[activeLevelIndex]) {
      songLevels[activeLevelIndex].trackData = {
        nodes: JSON.parse(JSON.stringify(nodes)),
        bends: JSON.parse(JSON.stringify(bends)),
        speedBPs: JSON.parse(JSON.stringify(speedBPs)),
        zoomBPs: JSON.parse(JSON.stringify(zoomBPs)),
        offsetBPs: JSON.parse(JSON.stringify(offsetBPs)),
        notes: JSON.parse(JSON.stringify(notes)),
        decorations: JSON.parse(JSON.stringify(decorations)),
        planeW,
        planeH,
      };
    }
  }

  function selectLevel(idx: number) {
    if (idx < 0 || idx >= songLevels.length) return;
    commitActiveChart();
    activeLevelIndex = idx;
    const target = songLevels[idx].trackData || createDefaultTrack();
    planeW = target.planeW || 2000;
    planeH = target.planeH || 5000;
    nodes = JSON.parse(JSON.stringify(target.nodes || [{ x: 0, y: 2500 }, { x: 2000, y: 2500 }]));
    bends = JSON.parse(JSON.stringify(target.bends || {}));
    speedBPs = JSON.parse(JSON.stringify(target.speedBPs || []));
    zoomBPs = JSON.parse(JSON.stringify(target.zoomBPs || []));
    offsetBPs = JSON.parse(JSON.stringify(target.offsetBPs || []));
    notes = JSON.parse(JSON.stringify(target.notes || []));
    decorations = JSON.parse(JSON.stringify(target.decorations || []));
    undoStack = [];
    redoStack = [];
    syncPathMetrics();
  }

  function openAddLevelDialog() {
    newLevelName = `レベル ${songLevels.length + 1}`;
    newLevelDifficulty = 5.0;
    newLevelCopyCurrent = false;
    showAddLevelDialog = true;
  }

  function addLevel() {
    commitActiveChart();
    const cleanName = newLevelName.trim() || `レベル ${songLevels.length + 1}`;
    const cleanDiff = Math.max(0, Math.min(10, Math.round(newLevelDifficulty * 10) / 10));
    const newTrack: TrackData = newLevelCopyCurrent
      ? {
          nodes: JSON.parse(JSON.stringify(nodes)),
          bends: JSON.parse(JSON.stringify(bends)),
          speedBPs: JSON.parse(JSON.stringify(speedBPs)),
          zoomBPs: JSON.parse(JSON.stringify(zoomBPs)),
          offsetBPs: JSON.parse(JSON.stringify(offsetBPs)),
          notes: JSON.parse(JSON.stringify(notes)),
          decorations: JSON.parse(JSON.stringify(decorations)),
          planeW,
          planeH,
        }
      : createDefaultTrack();

    const newLvl: SongLevel = {
      id: `lvl_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`,
      name: cleanName,
      difficulty: cleanDiff,
      chartFile: `levels/${cleanName.toLowerCase().replace(/[^a-z0-9_-]/g, '_')}.json`,
      trackData: newTrack,
    };

    songLevels = [...songLevels, newLvl];
    showAddLevelDialog = false;
    selectLevel(songLevels.length - 1);
    showToast(`✓ レベルを追加: ${cleanName} [難易度: ${cleanDiff.toFixed(1)}]`);
  }

  function openEditLevelDialog() {
    const current = songLevels[activeLevelIndex];
    if (!current) return;
    editLevelName = current.name;
    editLevelDifficulty = current.difficulty;
    showEditLevelDialog = true;
  }

  function saveEditLevel() {
    if (songLevels[activeLevelIndex]) {
      songLevels[activeLevelIndex].name = editLevelName.trim() || songLevels[activeLevelIndex].name;
      songLevels[activeLevelIndex].difficulty = Math.max(0, Math.min(10, Math.round(editLevelDifficulty * 10) / 10));
      songLevels = [...songLevels];
      showEditLevelDialog = false;
      showToast(`✓ レベルを更新: ${songLevels[activeLevelIndex].name}`);
    }
  }

  function deleteCurrentLevel() {
    if (songLevels.length <= 1) {
      showToast('⚠ 最後のレベルは削除できません。');
      return;
    }
    const deletedName = songLevels[activeLevelIndex].name;
    songLevels.splice(activeLevelIndex, 1);
    songLevels = [...songLevels];
    activeLevelIndex = Math.max(0, activeLevelIndex - 1);
    selectLevel(activeLevelIndex);
    showEditLevelDialog = false;
    showToast(`✓ レベルを削除: ${deletedName}`);
  }

  // Smooth media seeking & scrubbing states
  let isScrubbing = $state(false);
  let wasPlayingBeforeScrub = false;
  let pendingSeekSec: number | null = null;
  let seekRafId: number | null = null;

  // Computed metrics
  let pathD = $derived(generatePathData(nodes, bends));
  let gridData = $derived(computePlaneGrid(planeW, planeH));
  let totalLength = $state(0);
  let pathSamples = $state.raw<PathSample[]>([]);
  let speedTicksD = $state('');
  let beatTicksD = $state('');
  let bpm = $state<number | null>(null);
  let isDetectingBpm = $state(false);
  let calculatedDuration = $state(0);
  let timeProgressTable = $state.raw<{ progress: number; time: number }[]>([]);

  // PiP preview transforms and playback states
  let pipTransform = $state('none');
  let pipCameraPt = $state({ x: 0, y: 0 });
  let isPipVideoFinished = $state(false);

  // Derived elapsed preview time in seconds
  let previewElapsedSec = $derived(
    getProgressToTime(timeProgressTable, previewProgress, calculatedDuration)
  );

  // Video duration resolution and matching metrics
  let internalVideoDuration = $state(0);
  let effectiveVideoDuration = $derived(
    internalVideoDuration > 0
      ? internalVideoDuration
      : pipVideoEl?.duration && !isNaN(pipVideoEl.duration) && pipVideoEl.duration > 0
        ? pipVideoEl.duration
        : videoDuration && videoDuration > 0
          ? videoDuration
          : 0
  );

  let durationDiff = $derived(calculatedDuration - effectiveVideoDuration);
  let isDurationMatched = $derived(
    effectiveVideoDuration > 0 && Math.abs(durationDiff) <= 0.5
  );

  // Screen-space anchor (relative to the editor viewport) of the selected
  // breakpoint, used to float the inspector as a tooltip above the line.
  let selectedBpScreen = $derived.by<{ x: number; y: number; above: boolean } | null>(() => {
    if (!selectedBP) return null;
    const bp =
      selectedBP.type === 'speed' ? speedBPs[selectedBP.index]
      : selectedBP.type === 'zoom' ? zoomBPs[selectedBP.index]
      : offsetBPs[selectedBP.index];
    if (!bp) return null;
    const pt = pathBgEl && totalLength > 0
      ? pathBgEl.getPointAtLength(bp.progress * totalLength)
      : (pathSamples.length > 0 ? getPointOnTrack(pathSamples, bp.progress) : null);
    if (!pt) return null;
    const sx = panX + pt.x * zoom;
    const sy = panY + pt.y * zoom;
    const clampedX = Math.max(220, Math.min(Math.max(220, viewportW - 220), sx));
    return { x: clampedX, y: sy, above: sy >= 240 };
  });

  function syncPathMetrics() {
    const mathSampled = sampleTrackPoints(nodes, bends, 300);
    const svgLen = pathBgEl && pathBgEl.getTotalLength() > 0 ? pathBgEl.getTotalLength() : 0;
    totalLength = svgLen > 0 ? svgLen : mathSampled.totalLength;
    pathSamples = mathSampled.samples;

    const timeRes = buildTimeProgressTable(totalLength, speedBPs);
    timeProgressTable = timeRes.table;
    calculatedDuration = timeRes.chartDuration;
    speedTicksD = generateSpeedTicksPath(
      pathBgEl,
      speedBPs,
      totalLength,
      timeProgressTable,
      calculatedDuration,
      pathSamples
    );
    beatTicksD = bpm
      ? generateBeatTicksPath(pathBgEl, bpm, totalLength, timeProgressTable, calculatedDuration, pathSamples)
      : '';
  }

  // Initial computation immediately so length and samples are never 0
  syncPathMetrics();

  $effect(() => {
    // Recompute path metrics whenever geometry or speed breakpoints change
    const _d = pathD;
    const _bps = speedBPs;
    untrack(() => {
      if (!dragTarget) {
        syncPathMetrics();
      }
    });
  });

  // Pause PiP media if active tool changes away from PREVIEW
  $effect(() => {
    if (activeTool !== 'PREVIEW') {
      untrack(() => {
        isPipPlaying = false;
        stopPipMedia();
      });
    }
  });

  // Detect BPM whenever the audio source changes, and mark beats on the line.
  $effect(() => {
    const url = resolvedAudioUrl;
    if (url) {
      bpm = null;
      beatTicksD = '';
      isDetectingBpm = true;
      detectBpm(url)
        .then((detected) => {
          bpm = detected;
          isDetectingBpm = false;
          syncPathMetrics();
        })
        .catch(() => {
          isDetectingBpm = false;
        });
    } else {
      bpm = null;
      beatTicksD = '';
      isDetectingBpm = false;
    }
  });

  function analyzeBpm() {
    if (!resolvedAudioUrl) {
      showToast('⚠ 音声が読み込まれていません');
      return;
    }
    isDetectingBpm = true;
    detectBpm(resolvedAudioUrl)
      .then((detected) => {
        bpm = detected;
        isDetectingBpm = false;
        syncPathMetrics();
        showToast(detected ? `🎵 BPM: ${detected.toFixed(1)}` : '⚠ BPMを検出できませんでした');
      })
      .catch(() => {
        isDetectingBpm = false;
        showToast('⚠ BPMの解析に失敗しました');
      });
  }

  onDestroy(() => {
    if (viewportRO) viewportRO.disconnect();
    isPipPlaying = false;
    stopPipMedia();
    if (customVideoUrl) URL.revokeObjectURL(customVideoUrl);
    if (customAudioUrl) URL.revokeObjectURL(customAudioUrl);
  });

  function getPlaneCoords(e: MouseEvent): { x: number; y: number } {
    if (!viewportEl) return { x: 0, y: 0 };
    const rect = viewportEl.getBoundingClientRect();
    const vx = e.clientX - rect.left;
    const vy = e.clientY - rect.top;
    return {
      x: (vx - panX) / zoom,
      y: (vy - panY) / zoom,
    };
  }

  function captureState(): string {
    return JSON.stringify({
      nodes,
      bends,
      speedBPs,
      zoomBPs,
      offsetBPs,
      notes,
      decorations,
      planeW,
      planeH,
    });
  }

  function applyState(snap: string) {
    try {
      const p = JSON.parse(snap);
      nodes = p.nodes;
      bends = p.bends;
      speedBPs = p.speedBPs;
      zoomBPs = p.zoomBPs;
      offsetBPs = p.offsetBPs || [];
      notes = p.notes;
      decorations = p.decorations || [];
      planeW = p.planeW;
      planeH = p.planeH;
    } catch (err) {
      console.error('Failed to apply state:', err);
    }
  }

  function saveHistory(backupStr?: string | null) {
    undoStack.push(backupStr || captureState());
    redoStack = [];
    if (undoStack.length > 40) undoStack.shift();
  }

  function doUndo() {
    if (undoStack.length > 0) {
      redoStack.push(captureState());
      const prev = undoStack.pop();
      if (prev) applyState(prev);
    }
  }

  function doRedo() {
    if (redoStack.length > 0) {
      undoStack.push(captureState());
      const next = redoStack.pop();
      if (next) applyState(next);
    }
  }

  function handleWheel(e: WheelEvent) {
    e.preventDefault();
    const zoomFactor = 1.05;
    const oldZoom = zoom;
    if (e.deltaY < 0) zoom *= zoomFactor;
    else zoom /= zoomFactor;
    zoom = Math.max(0.01, Math.min(zoom, 4));

    if (!viewportEl) return;
    const rect = viewportEl.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;

    panX = mx - (mx - panX) * (zoom / oldZoom);
    panY = my - (my - panY) * (zoom / oldZoom);
  }

  function handleMouseDown(e: MouseEvent) {
    if ((e.target as HTMLElement)?.closest('.notebook-panel')) return;

    lastMx = e.clientX;
    lastMy = e.clientY;
    pendingMouseEvent = null;
    const coords = getPlaneCoords(e);
    dragStateBackup = null;
    hasMoved = false;

    // Middle-click or Space+drag = pan (more intuitive than right-click only)
    if (e.button === 1 || (e.button === 0 && spaceHeld)) {
      e.preventDefault();
      isPanning = true;
      hasMoved = false;
      return;
    }

    // Check resize handles
    const handleEl = (e.target as HTMLElement)?.closest('.resize-handle') as HTMLElement;
    if (handleEl) {
      isResizing = handleEl.dataset.corner || null;
      return;
    }

    const activeSamples = pathSamples.length > 0 ? pathSamples : pathBgEl;

    // Right Click: Delete or Pan
    if (e.button === 2) {
      let deleted = false;
      if (activeTool === 'NOTES') {
        for (let i = notes.length - 1; i >= 0; i--) {
          const n = notes[i];
          if (coords.x >= n.x && coords.x <= n.x + n.w && coords.y >= n.y && coords.y <= n.y + n.h) {
            dragStateBackup = captureState();
            notes.splice(i, 1);
            notes = [...notes];
            deleted = true;
            break;
          }
        }
        if (!deleted) {
          for (let i = decorations.length - 1; i >= 0; i--) {
            const d = decorations[i];
            if (coords.x >= d.x && coords.x <= d.x + d.w && coords.y >= d.y && coords.y <= d.y + d.h) {
              dragStateBackup = captureState();
              decorations.splice(i, 1);
              decorations = [...decorations];
              deleted = true;
              break;
            }
          }
        }
      }

      if (!deleted && (activeTool === 'SPEED' || activeTool === 'ZOOM' || activeTool === 'OFFSET')) {
        const hit = getClosestPointOnPath(pathBgEl, nodes, bends, coords.x, coords.y);
        const threshold = Math.max(40, 32 / zoom);
        if (hit && hit.dist < threshold) {
          const bpDistThreshold = Math.max(30, 24 / zoom);
          if (activeTool === 'SPEED') {
            const before = speedBPs.length;
            const newBPs = speedBPs.filter((bp) => {
              const pt = pathBgEl && totalLength > 0 ? pathBgEl.getPointAtLength(bp.progress * totalLength) : getPointOnTrack(pathSamples, bp.progress);
              const clickDist = dist(coords.x, coords.y, pt.x, pt.y);
              const progDiff = Math.abs(bp.progress - hit.progress);
              return clickDist > bpDistThreshold && progDiff > 0.025;
            });
            if (newBPs.length !== before) {
              dragStateBackup = captureState();
              speedBPs = newBPs;
              deleted = true;
              selectedBP = null;
              syncPathMetrics();
            }
          } else if (activeTool === 'ZOOM') {
            const before = zoomBPs.length;
            const newBPs = zoomBPs.filter((bp) => {
              const pt = pathBgEl && totalLength > 0 ? pathBgEl.getPointAtLength(bp.progress * totalLength) : getPointOnTrack(pathSamples, bp.progress);
              const clickDist = dist(coords.x, coords.y, pt.x, pt.y);
              const progDiff = Math.abs(bp.progress - hit.progress);
              return clickDist > bpDistThreshold && progDiff > 0.025;
            });
            if (newBPs.length !== before) {
              dragStateBackup = captureState();
              zoomBPs = newBPs;
              deleted = true;
              selectedBP = null;
              hoverPov = { ...hoverPov, visible: false };
            }
          } else {
            const before = offsetBPs.length;
            const newBPs = offsetBPs.filter((bp) => {
              const pt = pathBgEl && totalLength > 0 ? pathBgEl.getPointAtLength(bp.progress * totalLength) : getPointOnTrack(pathSamples, bp.progress);
              const clickDist = dist(coords.x, coords.y, pt.x, pt.y);
              const progDiff = Math.abs(bp.progress - hit.progress);
              return clickDist > bpDistThreshold && progDiff > 0.025;
            });
            if (newBPs.length !== before) {
              dragStateBackup = captureState();
              offsetBPs = newBPs;
              deleted = true;
              selectedBP = null;
              hoverPov = { ...hoverPov, visible: false };
            }
          }
        }
      }

      if (deleted) {
        saveHistory(dragStateBackup);
      } else {
        isPanning = true;
      }
      return;
    }

    // Left Click
    if (e.button === 0) {
      if (activeTool === 'PREVIEW') {
        const hit = getClosestPointOnPath(pathBgEl, nodes, bends, coords.x, coords.y);
        const threshold = Math.max(60, 40 / zoom);
        if (hit && hit.dist < threshold) {
          handleScrubberStart();
          scrubbingPreview = true;
          previewProgress = hit.progress;
          updatePiP();
        } else {
          isPanning = true;
          hasMoved = false;
        }
        return;
      }

      if (activeTool === 'NOTES') {
        drawingNote = { sx: coords.x, sy: coords.y, cx: coords.x, cy: coords.y };
        return;
      }

      if (activeTool === 'SPEED' || activeTool === 'ZOOM' || activeTool === 'OFFSET') {
        const hit = getClosestPointOnPath(pathBgEl, nodes, bends, coords.x, coords.y);
        const threshold = Math.max(50, 40 / zoom);
        if (hit && hit.dist < threshold) {
          saveHistory(dragStateBackup);
          if (activeTool === 'SPEED') {
            const currentVal = getValueAtProgress(speedBPs, hit.progress, 1.0);
            const roundedVal = Math.max(0.2, Math.min(3.0, Math.round(currentVal * 10) / 10));
            const newBp: Breakpoint = {
              progress: Math.round(hit.progress * 1000) / 1000,
              val: roundedVal,
            };
            speedBPs = [...speedBPs, newBp];
            selectedBP = { type: 'speed', index: speedBPs.length - 1 };
            dragTarget = { type: 'bp', bpType: 'speed', index: speedBPs.length - 1 };
            syncPathMetrics();
          } else if (activeTool === 'ZOOM') {
            const currentVal = getValueAtProgress(zoomBPs, hit.progress, 1.0);
            const roundedVal = Math.max(0.4, Math.min(2.5, Math.round(currentVal * 10) / 10));
            const newBp: Breakpoint = {
              progress: Math.round(hit.progress * 1000) / 1000,
              val: roundedVal,
            };
            zoomBPs = [...zoomBPs, newBp];
            selectedBP = { type: 'zoom', index: zoomBPs.length - 1 };
            dragTarget = { type: 'bp', bpType: 'zoom', index: zoomBPs.length - 1 };
            makeHoverPov(hit.progress, hit.x, hit.y, true);
          } else {
            const newBp: OffsetBreakpoint = {
              progress: Math.round(hit.progress * 1000) / 1000,
              nx: 0,
              ny: 0,
            };
            offsetBPs = [...offsetBPs, newBp];
            selectedBP = { type: 'offset', index: offsetBPs.length - 1 };
            dragTarget = { type: 'bp', bpType: 'offset', index: offsetBPs.length - 1 };
            makeHoverPov(hit.progress, hit.x, hit.y, true);
          }
        } else {
          selectedBP = null;
          isPanning = true;
          hasMoved = false;
        }
        return;
      }

      // Check hit on existing nodes or bends
      let hitTarget: { type: 'node' | 'bend'; index: number } | null = null;
      if (activeTool === 'BEND') {
        for (let i = 0; i < nodes.length - 1; i++) {
          const n1 = nodes[i];
          const n2 = nodes[i + 1];
          const cx = bends[i] ? bends[i].cx : (n1.x + n2.x) / 2;
          const cy = bends[i] ? bends[i].cy : (n1.y + n2.y) / 2;
          if (dist(coords.x, coords.y, cx, cy) < 18) {
            hitTarget = { type: 'bend', index: i };
            break;
          }
        }
      }

      if (!hitTarget && (activeTool === 'DRAW' || activeTool === 'BEND')) {
        for (let i = 0; i < nodes.length; i++) {
          if (dist(coords.x, coords.y, nodes[i].x, nodes[i].y) < 18) {
            hitTarget = { type: 'node', index: i };
            break;
          }
        }
      }

      if (hitTarget) {
        dragTarget = hitTarget;
      } else {
        const pathHit = getClosestPointOnPath(activeSamples, nodes, bends, coords.x, coords.y);
        if (pathHit && pathHit.dist < 22) {
          saveHistory(dragStateBackup);
          if (activeTool === 'DRAW') {
            const s = pathHit.segmentIndex;
            nodes.splice(s + 1, 0, { x: pathHit.x, y: pathHit.y });
            nodes = [...nodes];
            const newBends: Record<number, BendPoint> = {};
            Object.keys(bends).forEach((k) => {
              const idx = parseInt(k, 10);
              if (idx < s) newBends[idx] = bends[idx];
              else if (idx > s) newBends[idx + 1] = bends[idx];
            });
            bends = newBends;
            dragTarget = { type: 'node', index: s + 1 };
          } else if (activeTool === 'BEND') {
            bends[pathHit.segmentIndex] = { cx: coords.x, cy: coords.y };
            bends = { ...bends };
            dragTarget = { type: 'bend', index: pathHit.segmentIndex };
          }
        }
      }
    }
  }

  function updateBpVal(newVal: number) {
    if (!selectedBP || selectedBP.type === 'offset') return;
    saveHistory(captureState());
    if (selectedBP.type === 'speed') {
      if (speedBPs[selectedBP.index]) {
        speedBPs[selectedBP.index].val = Math.round(newVal * 100) / 100;
        speedBPs = [...speedBPs];
        syncPathMetrics();
      }
    } else if (selectedBP.type === 'zoom') {
      if (zoomBPs[selectedBP.index]) {
        zoomBPs[selectedBP.index].val = Math.round(newVal * 100) / 100;
        zoomBPs = [...zoomBPs];
        const bp = zoomBPs[selectedBP.index];
        const pt = pathBgEl && totalLength > 0
          ? pathBgEl.getPointAtLength(bp.progress * totalLength)
          : (pathSamples.length > 0 ? getPointOnTrack(pathSamples, bp.progress) : { x: 0, y: 0 });
        makeHoverPov(bp.progress, pt.x, pt.y, true);
      }
    }
  }

  function updateBpProgress(newProg: number) {
    if (!selectedBP || selectedBP.type === 'offset') return;
    saveHistory(captureState());
    const clamped = Math.max(0.005, Math.min(0.995, Math.round(newProg * 1000) / 1000));
    if (selectedBP.type === 'speed') {
      if (speedBPs[selectedBP.index]) {
        speedBPs[selectedBP.index].progress = clamped;
        speedBPs = [...speedBPs];
        syncPathMetrics();
      }
    } else if (selectedBP.type === 'zoom') {
      if (zoomBPs[selectedBP.index]) {
        zoomBPs[selectedBP.index].progress = clamped;
        zoomBPs = [...zoomBPs];
        const bp = zoomBPs[selectedBP.index];
        const pt = pathBgEl && totalLength > 0
          ? pathBgEl.getPointAtLength(bp.progress * totalLength)
          : (pathSamples.length > 0 ? getPointOnTrack(pathSamples, bp.progress) : { x: 0, y: 0 });
        makeHoverPov(bp.progress, pt.x, pt.y, true);
      }
    }
  }

  function deleteSelectedBp() {
    if (!selectedBP) return;
    saveHistory(captureState());
    if (selectedBP.type === 'speed') {
      speedBPs = speedBPs.filter((_, i) => i !== selectedBP!.index);
      syncPathMetrics();
    } else if (selectedBP.type === 'zoom') {
      zoomBPs = zoomBPs.filter((_, i) => i !== selectedBP!.index);
      hoverPov = { ...hoverPov, visible: false };
    } else {
      offsetBPs = offsetBPs.filter((_, i) => i !== selectedBP!.index);
      hoverPov = { ...hoverPov, visible: false };
    }
    selectedBP = null;
  }

  function selectTool(tool: Tool) {
    activeTool = tool;
    if (tool !== 'SPEED' && tool !== 'ZOOM' && tool !== 'OFFSET') {
      selectedBP = null;
    }
    if (tool !== 'ZOOM' && tool !== 'OFFSET' && tool !== 'PREVIEW') {
      hoverPov.visible = false;
    }
  }

  function clamp(v: number, min: number, max: number): number {
    return Math.max(min, Math.min(max, v));
  }

  // Build the hover/POV camera frame for a given path point, applying the
  // camera-offset breakpoint value at that progress (shared by ZOOM/OFFSET tools).
  function makeHoverPov(progress: number, px: number, py: number, visible: boolean) {
    const z = getValueAtProgress(zoomBPs, progress, 1.0);
    const off = getOffsetAtProgress(offsetBPs, progress, 0, 0);
    hoverPov = {
      x: px,
      y: py,
      width: 1280 / z,
      height: 720 / z,
      zoom: z,
      progress,
      visible,
      nx: clamp(off.nx, -1, 1),
      ny: clamp(off.ny, -1, 1),
    };
  }

  function refreshOffsetHoverPov() {
    if (!selectedBP || selectedBP.type !== 'offset') return;
    const bp = offsetBPs[selectedBP.index];
    if (!bp) return;
    const pt = pathBgEl && totalLength > 0
      ? pathBgEl.getPointAtLength(bp.progress * totalLength)
      : (pathSamples.length > 0 ? getPointOnTrack(pathSamples, bp.progress) : { x: 0, y: 0 });
    makeHoverPov(bp.progress, pt.x, pt.y, true);
  }

  function updateOffsetBpVal(nx: number, ny: number) {
    if (!selectedBP || selectedBP.type !== 'offset') return;
    const idx = selectedBP.index;
    if (!offsetBPs[idx]) return;
    saveHistory(captureState());
    offsetBPs = offsetBPs.map((b, i) =>
      i === idx
        ? { ...b, nx: Math.round(clamp(nx, -1, 1) * 100) / 100, ny: Math.round(clamp(ny, -1, 1) * 100) / 100 }
        : b
    );
    refreshOffsetHoverPov();
  }

  function updateOffsetBpProgress(newProg: number) {
    if (!selectedBP || selectedBP.type !== 'offset') return;
    const idx = selectedBP.index;
    if (!offsetBPs[idx]) return;
    saveHistory(captureState());
    const clamped = Math.max(0.005, Math.min(0.995, Math.round(newProg * 1000) / 1000));
    offsetBPs = offsetBPs.map((b, i) => (i === idx ? { ...b, progress: clamped } : b));
    refreshOffsetHoverPov();
  }

  let draggingOffset = false;

  function startOffsetDrag(e: PointerEvent) {
    if (!selectedBP || selectedBP.type !== 'offset') return;
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    saveHistory(captureState());
    draggingOffset = true;
    updateOffsetFromEvent(e);
  }

  function updateOffsetFromEvent(e: PointerEvent) {
    if (!selectedBP || selectedBP.type !== 'offset') return;
    const idx = selectedBP.index;
    if (!offsetBPs[idx]) return;
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) return;
    const nx = Math.round(clamp(((e.clientX - r.left) / r.width) * 2 - 1, -1, 1) * 100) / 100;
    const ny = Math.round(clamp(((e.clientY - r.top) / r.height) * 2 - 1, -1, 1) * 100) / 100;
    offsetBPs = offsetBPs.map((b, i) => (i === idx ? { ...b, nx, ny } : b));
    refreshOffsetHoverPov();
  }

  function endOffsetDrag() {
    draggingOffset = false;
  }

  function resetOffsetBp() {
    updateOffsetBpVal(0, 0);
  }

  function toggleHelp() {
    showHelp = !showHelp;
  }

  function fitView() {
    if (!viewportEl) return;
    const vw = viewportW || viewportEl.clientWidth;
    const vh = viewportH || viewportEl.clientHeight;
    const pad = 48;
    const targetZoom = Math.min((vw - pad * 2) / planeW, (vh - pad * 2) / planeH);
    zoom = Math.max(0.02, Math.min(2, targetZoom));
    panX = (vw - planeW * zoom) / 2;
    panY = (vh - planeH * zoom) / 2;
  }

  function isEditableTarget(target: EventTarget | null): boolean {
    if (!(target instanceof HTMLElement)) return false;
    return (
      target instanceof HTMLInputElement ||
      target instanceof HTMLTextAreaElement ||
      target instanceof HTMLSelectElement ||
      target.isContentEditable
    );
  }

  function handleGlobalKeydown(e: KeyboardEvent) {
    if (isEditableTarget(e.target)) return;
    if (showMetadataDialog || showAddLevelDialog || showEditLevelDialog) return;

    const isMac = navigator.platform.toUpperCase().indexOf('MAC') >= 0;
    const cmdOrCtrl = isMac ? e.metaKey : e.ctrlKey;

    if (cmdOrCtrl && !e.shiftKey && e.key.toLowerCase() === 'z') {
      e.preventDefault();
      doUndo();
      return;
    }
    if (cmdOrCtrl && (e.key.toLowerCase() === 'y' || (e.shiftKey && e.key.toLowerCase() === 'z'))) {
      e.preventDefault();
      doRedo();
      return;
    }

    if (cmdOrCtrl || e.altKey) return;

    // Space: play/pause in preview mode, otherwise enter pan mode
    if (e.code === 'Space') {
      e.preventDefault();
      if (activeTool === 'PREVIEW') {
        togglePipPlay();
      } else {
        spaceHeld = true;
      }
      return;
    }

    if (e.key === 'Escape') {
      if (showHelp) {
        showHelp = false;
      } else if (selectedBP) {
        selectedBP = null;
      }
      return;
    }

    if (e.key === '?') {
      toggleHelp();
      return;
    }

    const toolByKey: Record<string, Tool> = {
      '1': 'DRAW',
      '2': 'BEND',
      '3': 'NOTES',
      '4': 'SPEED',
      '5': 'ZOOM',
      '6': 'OFFSET',
      '7': 'PREVIEW',
    };
    if (e.key in toolByKey) {
      const tool = toolByKey[e.key];
      if (tool === 'PREVIEW') {
        selectTool('PREVIEW');
        updatePiP();
      } else {
        selectTool(tool);
      }
      return;
    }

    // Note color shortcuts in NOTES mode (matches on-canvas labels 青 (Z) / 緑 (X) / 白 (C))
    if (activeTool === 'NOTES') {
      const k = e.key.toLowerCase();
      if (k === 'z') {
        noteColor = 'blue';
        return;
      }
      if (k === 'x') {
        noteColor = 'green';
        return;
      }
      if (k === 'c') {
        noteColor = 'deco';
        return;
      }
    }

    // Fit whole chart to view
    if (e.key === '0' || e.key.toLowerCase() === 'f') {
      e.preventDefault();
      fitView();
    }
  }

  // Coalesce rapid-fire mousemove events into one per animation frame.
  function onMouseMove(e: MouseEvent) {
    pendingMouseEvent = e;
    if (mouseMoveRafId === null) {
      mouseMoveRafId = requestAnimationFrame(() => {
        mouseMoveRafId = null;
        const evt = pendingMouseEvent;
        pendingMouseEvent = null;
        if (evt) handleMouseMove(evt);
      });
    }
  }

  function handleMouseMove(e: MouseEvent) {
    const coords = getPlaneCoords(e);
    const dx = e.clientX - lastMx;
    const dy = e.clientY - lastMy;

    if (dragTarget || isResizing || isPanning || drawingNote) {
      if (Math.abs(dx) > 0 || Math.abs(dy) > 0) {
        if (!hasMoved && !dragStateBackup && (dragTarget || isResizing)) {
          dragStateBackup = captureState();
        }
        hasMoved = true;
      }
    }

    const activeSamples = pathSamples.length > 0 ? pathSamples : pathBgEl;

    if (isPanning) {
      panX += dx;
      panY += dy;
    } else if (isResizing) {
      const dxPlane = dx / zoom;
      const dyPlane = dy / zoom;

      let shiftX = 0;
      let shiftY = 0;
      let newW = planeW;
      let newH = planeH;

      if (isResizing.includes('l')) {
        shiftX = Math.min(dxPlane, planeW - 500);
        newW = planeW - shiftX;
      } else if (isResizing.includes('r')) {
        newW = Math.max(500, planeW + dxPlane);
      }
      if (isResizing.includes('t')) {
        shiftY = Math.min(dyPlane, planeH - 500);
        newH = planeH - shiftY;
      } else if (isResizing.includes('b')) {
        newH = Math.max(500, planeH + dyPlane);
      }

      if (shiftX !== 0 || shiftY !== 0) {
        panX += shiftX * zoom;
        panY += shiftY * zoom;
        nodes = nodes.map((n) => ({ x: n.x - shiftX, y: n.y - shiftY }));
        bends = Object.fromEntries(
          Object.entries(bends).map(([k, b]) => [k, { cx: b.cx - shiftX, cy: b.cy - shiftY }])
        );
        notes = notes.map((n) => ({ ...n, x: n.x - shiftX, y: n.y - shiftY }));
      }

      planeW = newW;
      planeH = newH;
      // Pin the first/last nodes to the plane's left/right edges.
      nodes = nodes.map((n, i) =>
        i === 0 ? { ...n, x: 0 } : i === nodes.length - 1 ? { ...n, x: planeW } : n
      );
    } else if (drawingNote) {
      drawingNote = { ...drawingNote, cx: coords.x, cy: coords.y };
    } else if (scrubbingPreview) {
      const hit = getClosestPointOnPath(pathBgEl, nodes, bends, coords.x, coords.y);
      if (hit) {
        previewProgress = hit.progress;
        updatePiP();
      }
    } else if (dragTarget?.type === 'bp') {
      const hit = getClosestPointOnPath(pathBgEl, nodes, bends, coords.x, coords.y);
      if (hit) {
        const newProg = Math.max(0.005, Math.min(0.995, Math.round(hit.progress * 1000) / 1000));
        if (dragTarget.bpType === 'speed') {
          speedBPs[dragTarget.index].progress = newProg;
          speedBPs = [...speedBPs];
        } else if (dragTarget.bpType === 'zoom') {
          zoomBPs[dragTarget.index].progress = newProg;
          zoomBPs = [...zoomBPs];
          makeHoverPov(newProg, hit.x, hit.y, true);
        } else {
          const idx = dragTarget.index;
          offsetBPs = offsetBPs.map((b, i) => (i === idx ? { ...b, progress: newProg } : b));
          makeHoverPov(newProg, hit.x, hit.y, true);
        }
      }
    } else if (dragTarget) {
      if (dragTarget.type === 'node') {
        const idx = dragTarget.index;
        const n = nodes[idx];
        const newX = idx !== 0 && idx !== nodes.length - 1 ? coords.x : n.x;
        nodes = nodes.map((node, i) => (i === idx ? { x: newX, y: coords.y } : node));
      } else if (dragTarget.type === 'bend') {
        const idx = dragTarget.index;
        bends = { ...bends, [idx]: { cx: coords.x, cy: coords.y } };
      }
    }

    // Camera POV box hover tracking in ZOOM/OFFSET modes.
    // While a breakpoint is selected, keep the POV pinned to it so moving the
    // cursor doesn't make the preview jump to other parts of the line.
    if ((activeTool === 'ZOOM' || activeTool === 'OFFSET') && !isPanning && (!dragTarget || dragTarget.type === 'bp')) {
      if (selectedBP && (selectedBP.type === 'zoom' || selectedBP.type === 'offset')) {
        const progress = selectedBP.type === 'zoom'
          ? (zoomBPs[selectedBP.index] ? zoomBPs[selectedBP.index].progress : 0)
          : (offsetBPs[selectedBP.index] ? offsetBPs[selectedBP.index].progress : 0);
        const pt = pathBgEl && totalLength > 0
          ? pathBgEl.getPointAtLength(progress * totalLength)
          : (pathSamples.length > 0 ? getPointOnTrack(pathSamples, progress) : { x: 0, y: 0 });
        makeHoverPov(progress, pt.x, pt.y, true);
      } else {
        const hit = getClosestPointOnPath(pathBgEl, nodes, bends, coords.x, coords.y);
        const hoverThreshold = Math.max(80, 60 / zoom);
        if (hit && hit.dist < hoverThreshold) {
          makeHoverPov(hit.progress, hit.x, hit.y, true);
        } else if (hoverPov.visible) {
          hoverPov = { ...hoverPov, visible: false };
        }
      }
    } else if (hoverPov.visible && dragTarget?.type !== 'bp') {
      hoverPov = { ...hoverPov, visible: false };
    }

    lastMx = e.clientX;
    lastMy = e.clientY;
  }

  function handleMouseUp() {
    if (drawingNote) {
      const nx = Math.min(drawingNote.sx, drawingNote.cx);
      const ny = Math.min(drawingNote.sy, drawingNote.cy);
      const nw = Math.abs(drawingNote.cx - drawingNote.sx);
      const nh = Math.abs(drawingNote.cy - drawingNote.sy);
      if (nw > 10 && nh > 10) {
        saveHistory(dragStateBackup);
        if (noteColor === 'deco') {
          decorations = [...decorations, { id: crypto.randomUUID(), x: nx, y: ny, w: nw, h: nh }];
        } else {
          notes = [...notes, { id: crypto.randomUUID(), x: nx, y: ny, w: nw, h: nh, color: noteColor }];
        }
      }
      drawingNote = null;
    } else if (dragTarget) {
      if (hasMoved) {
        saveHistory(dragStateBackup);
      }
      if (dragTarget.type === 'node' || dragTarget.type === 'bend') {
        syncPathMetrics();
      } else if (dragTarget.type === 'bp' && dragTarget.bpType === 'speed') {
        syncPathMetrics();
      }
    } else if (isResizing && hasMoved) {
      saveHistory(dragStateBackup);
      syncPathMetrics();
    }

    isPanning = false;
    isResizing = null;
    dragTarget = null;
    if (scrubbingPreview) {
      scrubbingPreview = false;
      handleScrubberEnd();
    }
  }

  function scheduleMediaSeek(targetSec: number) {
    pendingSeekSec = targetSec;
    if (seekRafId !== null) return;
    seekRafId = requestAnimationFrame(() => {
      seekRafId = null;
      applyMediaSeek();
    });
  }

  function applyMediaSeek() {
    if (pendingSeekSec === null) return;
    const targetTime = pendingSeekSec;
    pendingSeekSec = null;

    // Smooth Video Seek: use fastSeek if supported for instantaneous keyframe scrubbing
    if (pipVideoEl && pipVideoEl.duration && pipVideoEl.duration > 0) {
      if (targetTime < pipVideoEl.duration) {
        isPipVideoFinished = false;
        if (!pipVideoEl.seeking) {
          try {
            if (typeof pipVideoEl.fastSeek === 'function') {
              pipVideoEl.fastSeek(targetTime);
            } else {
              pipVideoEl.currentTime = targetTime;
            }
          } catch {
            pipVideoEl.currentTime = targetTime;
          }
        } else {
          // Re-queue if video decoder is busy with previous seek
          pendingSeekSec = targetTime;
        }
      } else {
        isPipVideoFinished = true;
        if (!pipVideoEl.paused) pipVideoEl.pause();
      }
    } else {
      isPipVideoFinished = false;
    }

    // Audio Seek: align audio clock
    if (pipAudioEl && pipAudioEl.duration && pipAudioEl.duration > 0) {
      if (targetTime < pipAudioEl.duration) {
        if (!isPipPlaying || Math.abs(pipAudioEl.currentTime - targetTime) > 0.25) {
          try {
            if (typeof pipAudioEl.fastSeek === 'function') {
              pipAudioEl.fastSeek(targetTime);
            } else {
              pipAudioEl.currentTime = targetTime;
            }
          } catch {
            pipAudioEl.currentTime = targetTime;
          }
        }
      } else {
        if (!pipAudioEl.paused) pipAudioEl.pause();
      }
    }
  }

  function onVideoSeeked() {
    if (pendingSeekSec !== null) {
      applyMediaSeek();
    }
  }

  function handleScrubberStart() {
    isScrubbing = true;
    wasPlayingBeforeScrub = isPipPlaying;
    if (isPipPlaying) {
      isPipPlaying = false;
      stopPipMedia();
    }
  }

  function handleScrubberInput() {
    updatePiP();
  }

  function handleScrubberEnd() {
    isScrubbing = false;
    const currentPreviewSec = getProgressToTime(
      timeProgressTable,
      previewProgress,
      calculatedDuration
    );

    // Apply exact seek on release
    if (pipVideoEl && pipVideoEl.duration && currentPreviewSec < pipVideoEl.duration) {
      pipVideoEl.currentTime = currentPreviewSec;
    }
    if (pipAudioEl && pipAudioEl.duration && currentPreviewSec < pipAudioEl.duration) {
      pipAudioEl.currentTime = currentPreviewSec;
    }

    if (wasPlayingBeforeScrub && previewProgress < 1.0) {
      togglePipPlay();
    }
    wasPlayingBeforeScrub = false;
  }

  function stopPipMedia() {
    if (pipAudioEl && !pipAudioEl.paused) {
      pipAudioEl.pause();
    }
    if (pipVideoEl && !pipVideoEl.paused) {
      pipVideoEl.pause();
    }
  }

  function updatePiP() {
    if (!pathBgEl || totalLength <= 0) return;
    const pt = pathBgEl.getPointAtLength(previewProgress * totalLength);
    pipCameraPt = pt;
    const z = getValueAtProgress(zoomBPs, previewProgress, 1.0);
    const off = getOffsetAtProgress(offsetBPs, previewProgress, 0, 0);
    const offNx = clamp(off.nx, -1, 1);
    const offNy = clamp(off.ny, -1, 1);

    // 320x180 base PiP size
    const w = 320;
    const h = 180;
    const viewportScale = w / 1280;
    const finalZoom = z * viewportScale;

    const cameraX = pt.x - offNx * (640 / z);
    const cameraY = pt.y - offNy * (360 / z);
    const tx = w / 2 - cameraX * finalZoom;
    const ty = h / 2 - cameraY * finalZoom;
    pipTransform = `translate(${tx}px, ${ty}px) scale(${finalZoom})`;

    const currentPreviewSec = getProgressToTime(
      timeProgressTable,
      previewProgress,
      calculatedDuration
    );

    if (pipVideoEl && pipVideoEl.duration && pipVideoEl.duration > 0) {
      isPipVideoFinished = currentPreviewSec >= pipVideoEl.duration;
    } else {
      isPipVideoFinished = false;
    }

    // Schedule smooth seeking without freezing SVG transform or slider UI
    if (isScrubbing || !isPipPlaying) {
      scheduleMediaSeek(currentPreviewSec);
    }
  }

  let lastPipLoopTime = 0;
  function pipLoop(time: number) {
    if (!isPipPlaying || activeTool !== 'PREVIEW') {
      isPipPlaying = false;
      stopPipMedia();
      return;
    }

    let dt = time - lastPipLoopTime;
    lastPipLoopTime = time;
    if (dt > 100) dt = 16;

    // Speed breakpoints only affect the playhead's rate through the line
    // (handled by the time↔progress table). Audio/video always play at their
    // natural rate, matching gameplay.
    let speedMult = getValueAtProgress(speedBPs, previewProgress, 1.0);
    if (speedMult <= 0.05) speedMult = 0.05;

    const hasAudioSource = !!resolvedAudioUrl;
    const isAudioPlaying = !!(
      hasAudioSource &&
      pipAudioEl &&
      pipAudioEl.duration &&
      !pipAudioEl.paused &&
      !pipAudioEl.ended &&
      pipAudioEl.currentTime < pipAudioEl.duration
    );

    if (isAudioPlaying && pipAudioEl) {
      // 1. Audio is the MASTER CLOCK - NEVER seek audio while playing!
      if (Math.abs(pipAudioEl.playbackRate - 1.0) > 0.02) {
        pipAudioEl.playbackRate = 1.0;
      }
      const masterTime = pipAudioEl.currentTime;
      previewProgress = getTimeToProgress(timeProgressTable, masterTime, calculatedDuration);

      if (masterTime >= pipAudioEl.duration || previewProgress >= 1.0) {
        previewProgress = 1.0;
        isPipPlaying = false;
        stopPipMedia();
        updatePiP();
        return;
      }

      // Synchronize video to master audio smoothly via playbackRate (no seeking while playing)
      if (pipVideoEl && pipVideoEl.duration && pipVideoEl.duration > 0) {
        if (masterTime < pipVideoEl.duration) {
          isPipVideoFinished = false;
          if (pipVideoEl.paused) pipVideoEl.play().catch(() => {});

          const videoDrift = pipVideoEl.currentTime - masterTime;
          if (Math.abs(videoDrift) > 0.8) {
            // Hard sync on large drift only
            pipVideoEl.currentTime = masterTime;
            pipVideoEl.playbackRate = 1.0;
          } else if (Math.abs(videoDrift) > 0.04) {
            // Soft sync via playbackRate modulation
            const nudge = videoDrift > 0 ? 0.94 : 1.06;
            pipVideoEl.playbackRate = Math.max(0.25, Math.min(2.5, nudge));
          } else {
            pipVideoEl.playbackRate = 1.0;
          }
        } else {
          isPipVideoFinished = true;
          if (!pipVideoEl.paused) pipVideoEl.pause();
        }
      }
    } else if (
      pipVideoEl &&
      !pipVideoEl.paused &&
      !pipVideoEl.ended &&
      pipVideoEl.duration &&
      pipVideoEl.currentTime < pipVideoEl.duration
    ) {
      // 2. Video is the clock if no audio
      if (Math.abs(pipVideoEl.playbackRate - 1.0) > 0.02) {
        pipVideoEl.playbackRate = 1.0;
      }
      previewProgress = getTimeToProgress(timeProgressTable, pipVideoEl.currentTime, calculatedDuration);
      if (previewProgress >= 1.0) {
        previewProgress = 1.0;
        isPipPlaying = false;
        stopPipMedia();
        updatePiP();
        return;
      }
    } else {
      // 3. Fallback Euler integration for overtime or when media is unavailable
      if (totalLength > 0) {
        const ds = 400 * speedMult * (dt / 1000);
        previewProgress += ds / totalLength;
      }
      if (previewProgress >= 1.0) {
        previewProgress = 1.0;
        isPipPlaying = false;
        stopPipMedia();
        updatePiP();
        return;
      }
    }

    updatePiP();
    requestAnimationFrame(pipLoop);
  }

  function togglePipPlay() {
    isPipPlaying = !isPipPlaying;
    if (isPipPlaying) {
      if (previewProgress >= 1.0) {
        previewProgress = 0;
      }
      lastPipLoopTime = performance.now();
      const currentPreviewSec = getProgressToTime(
        timeProgressTable,
        previewProgress,
        calculatedDuration
      );

      // Start Audio
      const hasAudioSource = !!resolvedAudioUrl;
      if (pipAudioEl && hasAudioSource) {
        pipAudioEl.volume = 0.85;
        pipAudioEl.playbackRate = 1.0;
        if (pipAudioEl.duration && currentPreviewSec < pipAudioEl.duration) {
          pipAudioEl.currentTime = currentPreviewSec;
        }
        pipAudioEl.play().catch(() => {});
        if (pipVideoEl) pipVideoEl.muted = true;
      } else if (pipVideoEl) {
        pipVideoEl.muted = false;
        pipVideoEl.volume = 0.85;
      }

      // Start Video
      if (
        pipVideoEl &&
        pipVideoEl.duration &&
        currentPreviewSec < pipVideoEl.duration
      ) {
        pipVideoEl.currentTime = currentPreviewSec;
        pipVideoEl.playbackRate = 1.0;
        pipVideoEl.play().catch(() => {});
      }

      updatePiP();
      requestAnimationFrame(pipLoop);
    } else {
      stopPipMedia();
    }
  }

  async function handleSaveSong() {
    commitActiveChart();
    if (!resolvedAudioUrl && !currentAudioBlob) {
      showToast('⚠ 音声ファイルが必要です。「音声を読み込み」を押してください。');
      return;
    }
    if (!resolvedVideoUrl && !currentVideoBlob) {
      showToast('⚠ 動画ファイルが必要です。「動画を読み込み」を押してください。');
      return;
    }
    if (songLevels.length === 0) {
      showToast('⚠ 曲には最低1つのレベルが必要です。');
      return;
    }

    try {
      isPackaging = true;
      const songData: SongData = {
        id: songId,
        name: songName,
        artist: songArtist,
        audioFile: audioFileName || 'audio.opus',
        videoFile: videoFileName || 'video.mp4',
        audioBlobUrl: resolvedAudioUrl,
        videoBlobUrl: resolvedVideoUrl,
        audioBlob: currentAudioBlob,
        videoBlob: currentVideoBlob,
        levels: songLevels,
        source: 'browser',
        updatedAt: Date.now(),
      };

      const archiveBlob = await packSongArchive(songData);
      await saveSongToStorage(songData, archiveBlob);
      songData.archiveBlob = archiveBlob;
      onSaveSong?.(songData);
      showToast('✓ 曲をブラウザに保存しました！');
    } catch (err: any) {
      console.error('Failed to save song:', err);
      showToast(`⚠ 保存に失敗: ${err.message || err}`);
    } finally {
      isPackaging = false;
    }
  }

  async function handleBackupSong() {
    commitActiveChart();
    if (!resolvedAudioUrl && !currentAudioBlob) {
      showToast('⚠ バックアップには音声ファイルが必要です。');
      return;
    }
    if (!resolvedVideoUrl && !currentVideoBlob) {
      showToast('⚠ バックアップには動画ファイルが必要です。');
      return;
    }

    try {
      isPackaging = true;
      const songData: SongData = {
        id: songId,
        name: songName,
        artist: songArtist,
        audioFile: audioFileName || 'audio.opus',
        videoFile: videoFileName || 'video.mp4',
        audioBlobUrl: resolvedAudioUrl,
        videoBlobUrl: resolvedVideoUrl,
        audioBlob: currentAudioBlob,
        videoBlob: currentVideoBlob,
        levels: songLevels,
        source: 'browser',
        updatedAt: Date.now(),
      };

      const archiveBlob = await packSongArchive(songData);
      const filename = `${songName.trim().replace(/[/\\?%*:|"<>]/g, '_') || 'song'}.zip`;
      downloadBlob(archiveBlob, filename);
      showToast(`✓ アーカイブを端末に保存: ${filename}`);
    } catch (err: any) {
      console.error('Failed to backup song:', err);
      showToast(`⚠ バックアップに失敗: ${err.message || err}`);
    } finally {
      isPackaging = false;
    }
  }

  async function handleArchiveLoad(e: Event) {
    const file = (e.target as HTMLInputElement).files?.[0];
    if (!file) return;
    try {
      isPackaging = true;
      const loaded = await unpackSongArchive(file);
      songId = loaded.id;
      songName = loaded.name;
      songArtist = loaded.artist || '';
      audioFileName = loaded.audioFile || '';
      videoFileName = loaded.videoFile || '';
      if (customAudioUrl) URL.revokeObjectURL(customAudioUrl);
      if (customVideoUrl) URL.revokeObjectURL(customVideoUrl);
      customAudioUrl = loaded.audioBlobUrl;
      customVideoUrl = loaded.videoBlobUrl;
      currentAudioBlob = loaded.audioBlob;
      currentVideoBlob = loaded.videoBlob;
      songLevels = loaded.levels;
      activeLevelIndex = 0;
      selectLevel(0);
      showToast(`✓ 曲アーカイブを読み込み: ${loaded.name}（${loaded.levels.length}レベル）`);
    } catch (err: any) {
      console.error('Failed to unpack song archive:', err);
      showToast(`⚠ アーカイブの読み込みに失敗: ${err.message || err}`);
    } finally {
      isPackaging = false;
      (e.target as HTMLInputElement).value = '';
    }
  }

  function handleSave() {
    handleSaveSong();
  }

  function handleFileLoad(e: Event) {
    const file = (e.target as HTMLInputElement).files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (evt) => {
      try {
        saveHistory();
        applyState(evt.target?.result as string);
        showToast('✓ トラックJSONを現在のレベルに読み込みました');
      } catch (err) {
        console.error('Failed to parse track JSON:', err);
        showToast('⚠ トラックJSONの解析に失敗しました');
      }
    };
    reader.readAsText(file);
    (e.target as HTMLInputElement).value = '';
  }

  function handleVideoUpload(e: Event) {
    const file = (e.target as HTMLInputElement).files?.[0];
    if (!file) return;
    const isVideo =
      file.type.startsWith('video/') || /\.(mp4|webm|mov|m4v|avi|mkv)$/i.test(file.name);
    if (!isVideo) {
      (e.target as HTMLInputElement).value = '';
      showToast('⚠ 動画ファイルを選択してください');
      return;
    }
    if (customVideoUrl) URL.revokeObjectURL(customVideoUrl);
    customVideoUrl = URL.createObjectURL(file);
    currentVideoBlob = file;
    videoFileName = file.name;
    (e.target as HTMLInputElement).value = '';
    showToast(`✓ 動画を読み込み: ${file.name}`);
  }

  function handleAudioUpload(e: Event) {
    const file = (e.target as HTMLInputElement).files?.[0];
    if (!file) return;
    const isAudio =
      file.type.startsWith('audio/') || /\.(opus|ogg|oga|mp3|wav|m4a|aac|flac)$/i.test(file.name);
    if (!isAudio) {
      (e.target as HTMLInputElement).value = '';
      showToast('⚠ 音声ファイルを選択してください（動画は音声として読み込めません）');
      return;
    }
    if (customAudioUrl) URL.revokeObjectURL(customAudioUrl);
    customAudioUrl = URL.createObjectURL(file);
    currentAudioBlob = file;
    audioFileName = file.name;
    (e.target as HTMLInputElement).value = '';
    if (pipAudioEl) {
      pipAudioEl.src = customAudioUrl;
      pipAudioEl.load();
    }
    showToast(`✓ 音声を読み込み: ${file.name}`);
  }

  function launchPlayGame() {
    commitActiveChart();
    const songData: SongData = {
      id: songId,
      name: songName,
      artist: songArtist,
      audioFile: audioFileName || 'audio.opus',
      videoFile: videoFileName || 'video.mp4',
      audioBlobUrl: resolvedAudioUrl,
      videoBlobUrl: resolvedVideoUrl,
      audioBlob: currentAudioBlob,
      videoBlob: currentVideoBlob,
      levels: songLevels,
    };

    if (onPlaySongLevel && songLevels[activeLevelIndex]) {
      onPlaySongLevel(songData, songLevels[activeLevelIndex]);
    } else {
      onPlayGame?.(
        {
          nodes,
          bends,
          speedBPs,
          zoomBPs,
          offsetBPs,
          notes,
          decorations,
          planeW,
          planeH,
        },
        {
          audioUrl: resolvedAudioUrl || null,
          videoUrl: resolvedVideoUrl || null,
        }
      );
    }
  }

  onMount(() => {
    if (viewportEl) {
      viewportRO = new ResizeObserver((entries) => {
        for (const entry of entries) {
          viewportW = entry.contentRect.width;
          viewportH = entry.contentRect.height;
        }
      });
      viewportRO.observe(viewportEl);

      panX = (viewportEl.clientWidth - planeW * zoom) / 2;
      panY = (viewportEl.clientHeight - planeH * zoom) / 2;
    }
    syncPathMetrics();
  });
</script>

<svelte:window
  onmousemove={onMouseMove}
  onmouseup={handleMouseUp}
  onkeydown={handleGlobalKeydown}
  onkeyup={(e: KeyboardEvent) => {
    if (e.code === 'Space') spaceHeld = false;
  }}
  onblur={() => (spaceHeld = false)}
/>

<!-- Main Pannable/Zoomable Editor Viewport -->
<!-- svelte-ignore a11y_no_noninteractive_tabindex -->
<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
<div
  bind:this={viewportEl}
  onwheel={handleWheel}
  onmousedown={handleMouseDown}
  onmousemove={onMouseMove}
  onmouseup={handleMouseUp}
  onmouseleave={() => {
    if (hoverPov.visible && !selectedBP) hoverPov = { ...hoverPov, visible: false };
  }}
  oncontextmenu={(e) => e.preventDefault()}
  class="relative w-full h-full overflow-hidden paper-bg-dark select-none {spaceHeld || isPanning ? 'cursor-grabbing' : activeTool === 'PREVIEW' ? 'cursor-default' : 'cursor-crosshair'}"
  role="region"
  tabindex="-1"
  aria-label="トラックエディタ"
>
  <!-- Hidden background video element to resolve duration even when PiP is closed -->
  {#if resolvedVideoUrl}
    <!-- svelte-ignore a11y_media_has_caption -->
    <video
      src={resolvedVideoUrl}
      preload="metadata"
      muted
      class="hidden"
      onloadedmetadata={(e) => {
        const dur = e.currentTarget.duration;
        if (dur && !isNaN(dur) && dur > 0) {
          internalVideoDuration = dur;
        }
      }}
    ></video>
  {/if}

  <!-- PiP Audio Element for Preview Mode Sound -->
  {#if resolvedAudioUrl}
    <audio
      bind:this={pipAudioEl}
      src={resolvedAudioUrl}
      preload="auto"
    ></audio>
  {/if}

  <!-- Top Navigation Header -->
  <div class="fixed top-4 left-4 right-4 z-40 flex flex-wrap items-center justify-between gap-3 pointer-events-none">
    <!-- Left Group: Navigation, Song Title, and Level Dropdown -->
    <div class="flex items-center gap-2 pointer-events-auto flex-wrap">
      <button
        onclick={onBack}
        class="paper-btn px-3 py-1.5 bg-white text-[#292524] text-xs font-mono font-bold tracking-wider flex items-center gap-1.5 shadow-[2px_2px_0px_#292524] cursor-pointer"
      >
        <span>←</span>
        <span>曲一覧</span>
      </button>

      <!-- Song Metadata Trigger -->
      <button
        onclick={openMetadataDialog}
        class="paper-btn px-3 py-1.5 bg-[#fffdfa] hover:bg-[#faf7f0] border-[1.5px] border-[#292524] text-xs font-mono font-black text-[#292524] flex items-center gap-1.5 shadow-[2px_2px_0px_#292524] cursor-pointer"
        title="曲情報を編集（名前・アーティスト・ID）"
      >
        <span>🎵</span>
        <span class="max-w-[130px] truncate">{songName}</span>
        <span class="text-[10px] text-[#292524]/60 font-normal">✏️</span>
      </button>

      <!-- Level Selection Dropdown & Quick Actions -->
      <div class="flex items-center gap-1 bg-[#fffdfa] border-[1.5px] border-[#292524] px-2 py-1 shadow-[2px_2px_0px_#292524]">
        <span class="text-[10px] font-mono font-bold text-[#292524]/60 uppercase">レベル:</span>
        <select
          value={activeLevelIndex}
          onchange={(e) => {
            const val = (e.target as HTMLSelectElement).value;
            if (val === '__add__') {
              (e.target as HTMLSelectElement).value = activeLevelIndex.toString();
              openAddLevelDialog();
            } else {
              selectLevel(parseInt(val, 10));
            }
          }}
          class="bg-white border border-[#292524] px-2 py-0.5 text-xs font-mono font-bold text-[#292524] cursor-pointer max-w-[160px] truncate"
        >
          {#each songLevels as lvl, idx}
            <option value={idx}>
              {lvl.name} [Diff: {lvl.difficulty.toFixed(1)}]
            </option>
          {/each}
          <option value="__add__">+ レベルを追加...</option>
        </select>

        <button
          onclick={openAddLevelDialog}
          class="paper-btn px-2 py-0.5 bg-[#d8ecd7] hover:bg-[#c5dac1] text-[#047857] text-xs font-mono font-black border border-[#292524] cursor-pointer"
          title="レベルを追加"
        >
          + レベル
        </button>

        <button
          onclick={openEditLevelDialog}
          class="paper-btn px-1.5 py-0.5 bg-white hover:bg-[#faf7f0] text-[#292524] text-xs font-mono border border-[#292524] cursor-pointer"
          title="レベルの名前と難易度を編集"
        >
          ⚙️
        </button>
      </div>
    </div>

    <!-- Center: Duration Comparison Bar -->
    <div class="pointer-events-auto hidden md:flex items-center gap-3 px-3.5 py-1.5 bg-[#fffdfa] border-[1.5px] border-[#292524] shadow-[3px_3px_0px_#292524] font-mono text-xs">
      <div class="flex items-center gap-1.5 font-bold text-[#292524]">
        <span class="text-[#292524]/60 font-medium">譜面:</span>
        <span>{formatTime(calculatedDuration)}</span>
      </div>

      <!-- Comparative Progress Bar Track -->
      <div
        class="relative w-28 lg:w-36 h-3 bg-[#faf7f0] border-[1.5px] border-[#292524] overflow-hidden"
        title="譜面と動画の長さの比較"
      >
        {#if effectiveVideoDuration > 0}
          {@const maxDur = Math.max(calculatedDuration, effectiveVideoDuration)}
          {@const videoPercent = (effectiveVideoDuration / maxDur) * 100}
          {@const chartPercent = (calculatedDuration / maxDur) * 100}

          {#if calculatedDuration > effectiveVideoDuration + 0.5}
            <div
              class="absolute top-0 bottom-0 w-1 bg-[#292524] z-10 -translate-x-1/2"
              style="left: {videoPercent}%;"
              title="動画の長さ: {formatTime(effectiveVideoDuration)}"
            ></div>
          {/if}

          <div
            class="h-full transition-all duration-300 {isDurationMatched ? 'bg-[#10b981]' : calculatedDuration < effectiveVideoDuration ? 'bg-[#292524]' : 'bg-[#f43f5e]'}"
            style="width: {chartPercent}%;"
          ></div>
        {:else}
          <div class="h-full bg-[#cbd5e1] w-full flex items-center justify-center text-[9px] text-[#292524]/50">
            動画なし
          </div>
        {/if}
      </div>

      <div class="flex items-center gap-1.5 font-bold text-[#292524]">
        <span class="text-[#292524]/60 font-medium">動画:</span>
        <span>{effectiveVideoDuration > 0 ? formatTime(effectiveVideoDuration) : '--:--'}</span>
      </div>

      {#if effectiveVideoDuration <= 0}
        <span class="px-1.5 py-0.2 bg-[#f1f5f9] text-[#64748b] text-[10px] font-bold border border-[#94a3b8]">
          動画なし
        </span>
      {:else if isDurationMatched}
        <span class="px-1.5 py-0.2 bg-[#d8ecd7] text-[#047857] text-[10px] font-black border border-[#047857] shadow-[1px_1px_0px_#047857]">
          ✓ 一致
        </span>
      {:else if calculatedDuration < effectiveVideoDuration}
        <span class="px-1.5 py-0.2 bg-[#fef3c7] text-[#b45309] text-[10px] font-bold border border-[#b45309]">
          -{formatTime(effectiveVideoDuration - calculatedDuration)}
        </span>
      {:else}
        <span class="px-1.5 py-0.2 bg-[#fce1db] text-[#be123c] text-[10px] font-bold border border-[#be123c]">
          +{formatTime(calculatedDuration - effectiveVideoDuration)}
        </span>
      {/if}
    </div>

    <!-- Right Group: High-Visibility Media Buttons & Play Game -->
    <div class="pointer-events-auto flex items-center gap-2 flex-wrap">
      <!-- High Visibility Audio Load Button -->
      <button
        onclick={() => audioInputEl?.click()}
        class="paper-btn px-3 py-1.5 {resolvedAudioUrl ? 'bg-[#d8ecd7] text-[#047857]' : 'bg-[#fff3cd] text-[#b45309] ring-2 ring-[#b45309]'} border-[1.5px] border-[#292524] font-mono font-black text-xs flex items-center gap-1.5 shadow-[2px_2px_0px_#292524] cursor-pointer"
        title="音声・BGMを読み込み"
      >
        <span>🎵</span>
        <span class="max-w-[120px] truncate">{resolvedAudioUrl ? `音声: ${audioFileName || 'OK'}` : '音声を読み込み'}</span>
      </button>

      <!-- High Visibility Video Load Button -->
      <button
        onclick={() => videoInputEl?.click()}
        class="paper-btn px-3 py-1.5 {resolvedVideoUrl ? 'bg-[#dbe9f4] text-[#0369a1]' : 'bg-[#fff3cd] text-[#b45309] ring-2 ring-[#b45309]'} border-[1.5px] border-[#292524] font-mono font-black text-xs flex items-center gap-1.5 shadow-[2px_2px_0px_#292524] cursor-pointer"
        title="背景動画を読み込み"
      >
        <span>🎥</span>
        <span class="max-w-[120px] truncate">{resolvedVideoUrl ? `動画: ${videoFileName || 'OK'}` : '動画を読み込み'}</span>
      </button>

      <!-- Test Play Game Button -->
      <button
        onclick={launchPlayGame}
        class="paper-btn px-3.5 py-1.5 bg-[#292524] hover:bg-[#3f3a39] text-white font-mono font-bold text-xs tracking-wider flex items-center gap-1.5 shadow-[3px_3px_0px_#292524] cursor-pointer"
      >
        <span>▶</span>
        <span>ゲームでテスト</span>
      </button>
    </div>
  </div>

  <!-- Transformed Editor Canvas Plane -->
  <div
    class="absolute top-0 left-0 bg-[#1c1917] border-[1.5px] border-[#44403c] shadow-[6px_6px_0px_#000000]"
    style="
      width: {planeW}px;
      height: {planeH}px;
      transform-origin: 0 0;
      transform: translate({panX}px, {panY}px) scale({zoom});
    "
  >
    <svg class="w-full h-full absolute top-0 left-0 overflow-visible">
      <!-- Uniform Grid Layer -->
      <g id="grid-layer" opacity="0.25" pointer-events="none">
        <path
          d={gridData.pathD}
          stroke="#cbd5e1"
          stroke-width="0.5"
          fill="none"
          shape-rendering="crispEdges"
        />
      </g>

      <!-- Notes Layer -->
      <g id="notes-layer">
        <!-- Ghost Decorations (white, non-interactive) -->
        {#each visibleDecorations as { dec, idx } (dec.id ?? `_dec_${idx}`)}
          <rect
            x={dec.x}
            y={dec.y}
            width={dec.w}
            height={dec.h}
            fill="rgba(255, 255, 255, 0.25)"
            stroke="#ffffff"
            stroke-width="1.2"
            stroke-linejoin="miter"
            shape-rendering="crispEdges"
            rx="0"
            ry="0"
          />
        {/each}

        {#each visibleEditorNotes as { note, idx } (note.id ?? `_${idx}`)}
          {@const isBlue = note.color !== 'green'}
          <rect
            data-index={idx}
            x={note.x}
            y={note.y}
            width={note.w}
            height={note.h}
            fill={isBlue ? 'rgba(59, 130, 246, 0.22)' : 'rgba(16, 185, 129, 0.22)'}
            stroke={isBlue ? '#3b82f6' : '#10b981'}
            stroke-width="1.2"
            stroke-linejoin="miter"
            shape-rendering="crispEdges"
            rx="0"
            ry="0"
          />
          {#if zoom >= 0.25}
            <text
              x={note.x + note.w / 2}
              y={note.y + note.h / 2 + 4}
              font-family="monospace"
              font-size="11"
              font-weight="bold"
              fill={isBlue ? '#60a5fa' : '#34d399'}
              text-anchor="middle"
            >
              {isBlue ? '青 (Z)' : '緑 (X)'}
            </text>
          {/if}
        {/each}

        <!-- Drawing Note Preview -->
        {#if drawingNote}
          {@const nx = Math.min(drawingNote.sx, drawingNote.cx)}
          {@const ny = Math.min(drawingNote.sy, drawingNote.cy)}
          {@const nw = Math.abs(drawingNote.cx - drawingNote.sx)}
          {@const nh = Math.abs(drawingNote.cy - drawingNote.sy)}
          <rect
            x={nx}
            y={ny}
            width={nw}
            height={nh}
            fill={noteColor === 'deco' ? 'rgba(255, 255, 255, 0.25)' : noteColor === 'blue' ? 'rgba(59, 130, 246, 0.22)' : 'rgba(16, 185, 129, 0.22)'}
            stroke={noteColor === 'deco' ? '#ffffff' : noteColor === 'blue' ? '#3b82f6' : '#10b981'}
            stroke-width="1.2"
            stroke-linejoin="miter"
            shape-rendering="crispEdges"
            stroke-dasharray="4 4"
            rx="0"
            ry="0"
          />
        {/if}
      </g>

      <!-- Background Path -->
      <path
        bind:this={pathBgEl}
        d={pathD}
        fill="none"
        stroke={activeTool === 'PREVIEW' || activeTool === 'SPEED' ? '#57534e' : '#d6d3d1'}
        stroke-width={activeTool === 'PREVIEW' || activeTool === 'SPEED' ? '6' : '3.5'}
        stroke-linecap="round"
        stroke-linejoin="round"
      />

      <!-- Foreground Path (Active in Preview) -->
      {#if activeTool === 'PREVIEW' && totalLength > 0}
        <path
          d={pathD}
          pathLength="1000"
          fill="none"
          stroke="#fafaf9"
          stroke-width="3.5"
          stroke-linecap="round"
          stroke-linejoin="round"
          style="
            stroke-dasharray: 1000;
            stroke-dashoffset: {Math.max(0, Math.min(1000, 1000 * (1 - previewProgress)))};
          "
        />

        <!-- Interactive Click/Scrub Hit Area for Preview Mode -->
        <!-- svelte-ignore a11y_no_static_element_interactions -->
        <path
          d={pathD}
          fill="none"
          stroke="transparent"
          stroke-width={Math.max(30, 20 / zoom)}
          stroke-linecap="round"
          stroke-linejoin="round"
          class="cursor-pointer pointer-events-auto"
          onmousedown={(e) => {
            if (e.button !== 0) return;
            e.stopPropagation();
            const coords = getPlaneCoords(e);
            const hit = getClosestPointOnPath(pathBgEl, nodes, bends, coords.x, coords.y);
            if (hit) {
              handleScrubberStart();
              scrubbingPreview = true;
              previewProgress = hit.progress;
              updatePiP();
            }
          }}
        />
      {/if}

      <!-- Speed Ticks -->
      <path
        d={speedTicksD}
        fill="none"
        stroke="#94a3b8"
        stroke-width="1.8"
        stroke-linecap="round"
      />

      <!-- Beat Ticks (BPM) -->
      <path
        d={beatTicksD}
        fill="none"
        stroke="#22d3ee"
        stroke-width="1.6"
        stroke-linecap="round"
      />

      <!-- Interactive Breakpoint Markers -->
      <g id="markers-layer">
        {#each speedBPs as bp, index}
          {@const pt = pathBgEl && totalLength > 0
            ? pathBgEl.getPointAtLength(bp.progress * totalLength)
            : (pathSamples.length > 0 ? getPointOnTrack(pathSamples, bp.progress) : null)}
          {#if pt}
            {@const isSelected = selectedBP?.type === 'speed' && selectedBP?.index === index}
            <!-- Interactive hit target -->
            <!-- svelte-ignore a11y_no_static_element_interactions -->
            <g
              class="cursor-pointer pointer-events-auto"
              onwheel={(e) => {
                e.preventDefault();
                e.stopPropagation();
                const delta = e.deltaY < 0 ? 0.1 : -0.1;
                selectedBP = { type: 'speed', index };
                updateBpVal(Math.max(0.2, Math.min(3.0, Math.round((bp.val + delta) * 10) / 10)));
              }}
              ondblclick={(e) => {
                e.stopPropagation();
                const entered = prompt('速度倍率を入力（例: 1.5）:', bp.val.toString());
                if (entered) {
                  const n = parseFloat(entered);
                  if (!isNaN(n) && n > 0) {
                    selectedBP = { type: 'speed', index };
                    updateBpVal(Math.round(n * 100) / 100);
                  }
                }
              }}
              onmousedown={(e) => {
                e.stopPropagation();
                if (e.button === 2) {
                  saveHistory(captureState());
                  speedBPs = speedBPs.filter((_, i) => i !== index);
                  if (selectedBP?.type === 'speed' && selectedBP.index === index) {
                    selectedBP = null;
                  }
                  syncPathMetrics();
                  return;
                }
                if (e.button === 0) {
                  saveHistory(captureState());
                  activeTool = 'SPEED';
                  selectedBP = { type: 'speed', index };
                  dragTarget = { type: 'bp', bpType: 'speed', index };
                }
              }}
            >
              <!-- Large hit circle for effortless clicking/dragging -->
              <circle cx={pt.x} cy={pt.y} r="22" fill="transparent" />
              {#if isSelected}
                <circle cx={pt.x} cy={pt.y} r="15" fill="none" stroke="#f59e0b" stroke-width="2" stroke-dasharray="3 3" />
              {/if}
              <polygon
                points="{pt.x},{pt.y - 8} {pt.x - 7},{pt.y + 7} {pt.x + 7},{pt.y + 7}"
                fill={isSelected ? '#fbbf24' : '#f59e0b'}
                stroke="#292524"
                stroke-width={isSelected ? '2' : '1.5'}
              />
              <text
                x={pt.x}
                y={pt.y - 11}
                font-size="10"
                fill="#fbbf24"
                text-anchor="middle"
                font-weight="bold"
                font-family="monospace"
              >
                {bp.val.toFixed(1)}x
              </text>
            </g>
          {/if}
        {/each}

        {#each zoomBPs as bp, index}
          {@const pt = pathBgEl && totalLength > 0
            ? pathBgEl.getPointAtLength(bp.progress * totalLength)
            : (pathSamples.length > 0 ? getPointOnTrack(pathSamples, bp.progress) : null)}
          {#if pt}
            {@const isSelected = selectedBP?.type === 'zoom' && selectedBP?.index === index}
            <!-- Interactive hit target -->
            <!-- svelte-ignore a11y_no_static_element_interactions -->
            <g
              class="cursor-pointer pointer-events-auto"
              onwheel={(e) => {
                e.preventDefault();
                e.stopPropagation();
                const delta = e.deltaY < 0 ? 0.05 : -0.05;
                selectedBP = { type: 'zoom', index };
                updateBpVal(Math.max(0.4, Math.min(2.5, Math.round((bp.val + delta) * 100) / 100)));
              }}
              ondblclick={(e) => {
                e.stopPropagation();
                const entered = prompt('ズーム倍率を入力（例: 1.2）:', bp.val.toString());
                if (entered) {
                  const n = parseFloat(entered);
                  if (!isNaN(n) && n > 0) {
                    selectedBP = { type: 'zoom', index };
                    updateBpVal(Math.round(n * 100) / 100);
                  }
                }
              }}
              onmousedown={(e) => {
                e.stopPropagation();
                if (e.button === 2) {
                  saveHistory(captureState());
                  zoomBPs = zoomBPs.filter((_, i) => i !== index);
                  if (selectedBP?.type === 'zoom' && selectedBP.index === index) {
                    selectedBP = null;
                    hoverPov = { ...hoverPov, visible: false };
                  }
                  return;
                }
                if (e.button === 0) {
                  saveHistory(captureState());
                  activeTool = 'ZOOM';
                  selectedBP = { type: 'zoom', index };
                  dragTarget = { type: 'bp', bpType: 'zoom', index };
                  makeHoverPov(bp.progress, pt.x, pt.y, true);
                }
              }}
            >
              <!-- Large hit circle for effortless clicking/dragging -->
              <circle cx={pt.x} cy={pt.y} r="22" fill="transparent" />
              {#if isSelected}
                <circle cx={pt.x} cy={pt.y} r="15" fill="none" stroke="#3b82f6" stroke-width="2" stroke-dasharray="3 3" />
              {/if}
              <rect
                x={pt.x - 6}
                y={pt.y - 6}
                width="12"
                height="12"
                fill={isSelected ? '#60a5fa' : '#3b82f6'}
                stroke="#292524"
                stroke-width={isSelected ? '2' : '1.5'}
                rx="0"
              />
              <text
                x={pt.x}
                y={pt.y - 10}
                font-size="10"
                fill="#60a5fa"
                text-anchor="middle"
                font-weight="bold"
                font-family="monospace"
              >
                {bp.val.toFixed(1)}z
              </text>
            </g>
          {/if}
        {/each}

        {#each offsetBPs as bp, index}
          {@const pt = pathBgEl && totalLength > 0
            ? pathBgEl.getPointAtLength(bp.progress * totalLength)
            : (pathSamples.length > 0 ? getPointOnTrack(pathSamples, bp.progress) : null)}
          {#if pt}
            {@const isSelected = selectedBP?.type === 'offset' && selectedBP?.index === index}
            <!-- svelte-ignore a11y_no_static_element_interactions -->
            <g
              class="cursor-pointer pointer-events-auto"
              onmousedown={(e) => {
                e.stopPropagation();
                if (e.button === 2) {
                  saveHistory(captureState());
                  offsetBPs = offsetBPs.filter((_, i) => i !== index);
                  if (selectedBP?.type === 'offset' && selectedBP.index === index) {
                    selectedBP = null;
                    hoverPov = { ...hoverPov, visible: false };
                  }
                  return;
                }
                if (e.button === 0) {
                  saveHistory(captureState());
                  activeTool = 'OFFSET';
                  selectedBP = { type: 'offset', index };
                  dragTarget = { type: 'bp', bpType: 'offset', index };
                  makeHoverPov(bp.progress, pt.x, pt.y, true);
                }
              }}
            >
              <circle cx={pt.x} cy={pt.y} r="22" fill="transparent" />
              {#if isSelected}
                <circle cx={pt.x} cy={pt.y} r="15" fill="none" stroke="#8b5cf6" stroke-width="2" stroke-dasharray="3 3" />
              {/if}
              <circle
                cx={pt.x}
                cy={pt.y}
                r="7"
                fill={isSelected ? '#a78bfa' : '#8b5cf6'}
                stroke="#292524"
                stroke-width={isSelected ? '2' : '1.5'}
              />
              <line x1={pt.x - 4} y1={pt.y} x2={pt.x + 4} y2={pt.y} stroke="#ffffff" stroke-width="1.5" />
              <line x1={pt.x} y1={pt.y - 4} x2={pt.x} y2={pt.y + 4} stroke="#ffffff" stroke-width="1.5" />
              <text
                x={pt.x}
                y={pt.y - 12}
                font-size="9"
                fill="#a78bfa"
                text-anchor="middle"
                font-weight="bold"
                font-family="monospace"
              >
                {bp.nx.toFixed(2)},{bp.ny.toFixed(2)}
              </text>
            </g>
          {/if}
        {/each}
      </g>

      <!-- Nodes & Bend Handles Layer -->
      <g id="nodes-layer">
        {#each nodes.slice(0, -1) as n1, i (i)}
          {@const n2 = nodes[i + 1]}
          {@const cx = bends[i] ? bends[i].cx : (n1.x + n2.x) / 2}
          {@const cy = bends[i] ? bends[i].cy : (n1.y + n2.y) / 2}
          <line
            x1={n1.x}
            y1={n1.y}
            x2={cx}
            y2={cy}
            stroke="#94a3b8"
            stroke-width="1.5"
            stroke-dasharray="3 3"
          />
          <line
            x1={n2.x}
            y1={n2.y}
            x2={cx}
            y2={cy}
            stroke="#94a3b8"
            stroke-width="1.5"
            stroke-dasharray="3 3"
          />
          <circle
            cx={cx}
            cy={cy}
            r="6"
            fill="#ffffff"
            stroke="#d6d3d1"
            stroke-width="2"
            class="cursor-grab"
          />
        {/each}

        {#each nodes as n, i (i)}
          {@const isEnd = i === 0 || i === nodes.length - 1}
          <rect
            x={n.x - 5}
            y={n.y - 5}
            width="10"
            height="10"
            fill={isEnd ? '#fafaf9' : '#ffffff'}
            stroke="#d6d3d1"
            stroke-width="2"
            class={isEnd ? 'cursor-ns-resize' : 'cursor-move'}
          />
        {/each}
      </g>

      <!-- Active Preview POV Camera Frame Indicator -->
      {#if activeTool === 'PREVIEW' && pathBgEl && totalLength > 0}
        {@const pt = pathBgEl.getPointAtLength(previewProgress * totalLength)}
        {@const curZoom = getValueAtProgress(zoomBPs, previewProgress, 1.0)}
        {@const off = getOffsetAtProgress(offsetBPs, previewProgress, 0, 0)}
        {@const w = 1280 / curZoom}
        {@const h = 720 / curZoom}
        {@const cx = pt.x - Math.max(-1, Math.min(1, off.nx)) * (w / 2)}
        {@const cy = pt.y - Math.max(-1, Math.min(1, off.ny)) * (h / 2)}
        <g id="preview-pov-box" pointer-events="none">
          <rect
            x={cx - w / 2}
            y={cy - h / 2}
            width={w}
            height={h}
            fill="rgba(79, 70, 229, 0.06)"
            stroke="#4f46e5"
            stroke-width="1.5"
            stroke-linejoin="miter"
            shape-rendering="crispEdges"
            stroke-dasharray="6 4"
            rx="0"
            ry="0"
          />
          <circle
            cx={pt.x}
            cy={pt.y}
            r="4.5"
            fill="#4f46e5"
          />
        </g>
      {/if}

      <!-- Dynamic Hover Camera POV Box (ZOOM/OFFSET modes) -->
      {#if hoverPov.visible && (activeTool === 'ZOOM' || activeTool === 'OFFSET')}
        {@const hcx = hoverPov.x - hoverPov.nx * (hoverPov.width / 2)}
        {@const hcy = hoverPov.y - hoverPov.ny * (hoverPov.height / 2)}
        <g id="hover-pov-box" pointer-events="none">
          <rect
            x={hcx - hoverPov.width / 2}
            y={hcy - hoverPov.height / 2}
            width={hoverPov.width}
            height={hoverPov.height}
            fill="rgba(148, 163, 184, 0.12)"
            stroke="#94a3b8"
            stroke-width="2"
            stroke-dasharray="6 4"
            rx="4"
          />
          <circle
            cx={hoverPov.x}
            cy={hoverPov.y}
            r="4.5"
            fill="#ef4444"
          />
          <!-- Zoom indicator badge pinned to corner of POV box -->
          <rect
            x={hcx - hoverPov.width / 2}
            y={hcy - hoverPov.height / 2 - 20}
            width="54"
            height="20"
            fill="#1e293b"
            rx="3"
          />
          <text
            x={hcx - hoverPov.width / 2 + 27}
            y={hcy - hoverPov.height / 2 - 6}
            font-family="monospace"
            font-size="11"
            font-weight="bold"
            fill="#ffffff"
            text-anchor="middle"
          >
            {hoverPov.zoom.toFixed(2)}z
          </text>
        </g>
      {/if}
    </svg>
  </div>

  <!-- 4 Corner Resizing Handles -->
  <div
    class="resize-handle absolute z-30 bg-white border-[1.5px] border-[#292524] shadow-[2px_2px_0px_#292524] w-4 h-4 cursor-nwse-resize -translate-x-1/2 -translate-y-1/2"
    data-corner="tl"
    style="left: {panX}px; top: {panY}px;"
  ></div>
  <div
    class="resize-handle absolute z-30 bg-white border-[1.5px] border-[#292524] shadow-[2px_2px_0px_#292524] w-4 h-4 cursor-nesw-resize -translate-x-1/2 -translate-y-1/2"
    data-corner="tr"
    style="left: {panX + planeW * zoom}px; top: {panY}px;"
  ></div>
  <div
    class="resize-handle absolute z-30 bg-white border-[1.5px] border-[#292524] shadow-[2px_2px_0px_#292524] w-4 h-4 cursor-nesw-resize -translate-x-1/2 -translate-y-1/2"
    data-corner="bl"
    style="left: {panX}px; top: {panY + planeH * zoom}px;"
  ></div>
  <div
    class="resize-handle absolute z-30 bg-white border-[1.5px] border-[#292524] shadow-[2px_2px_0px_#292524] w-4 h-4 cursor-nwse-resize -translate-x-1/2 -translate-y-1/2"
    data-corner="br"
    style="left: {panX + planeW * zoom}px; top: {panY + planeH * zoom}px;"
  ></div>

  <!-- Picture-in-Picture (PiP) Window -->
  {#if activeTool === 'PREVIEW'}
    <div class="notebook-panel fixed bottom-24 left-6 w-80 p-3 bg-[#fffdfa] border-[1.5px] border-[#292524] shadow-[4px_4px_0px_#292524] z-50 pointer-events-auto">
      <div class="flex items-center justify-between pb-1.5 mb-2 border-b border-[#292524]/20 text-xs font-mono font-bold">
        <span class="flex items-center gap-1.5">
          <span>カメラPOVプレビュー</span>
          {#if resolvedAudioUrl}
            <span class="text-[11px] text-[#047857]" title="音声再生中">🎵</span>
          {/if}
        </span>
        <span class="text-[10px] text-[#292524]/70 tracking-tight">
          {formatTime(previewElapsedSec)} / {formatTime(calculatedDuration)}
        </span>
      </div>

      <!-- Preview 16:9 Screen Box with Solid Black Background -->
      <div class="relative w-full aspect-video overflow-hidden border-[1.5px] border-[#292524] bg-black">
        <!-- Video Background Layer (Fades to Black if Chart > Video) -->
        {#if resolvedVideoUrl}
          <video
            bind:this={pipVideoEl}
            src={resolvedVideoUrl}
            muted
            playsinline
            disablepictureinpicture
            disableremoteplayback
            onloadedmetadata={updatePiP}
            onseeked={onVideoSeeked}
            class="absolute inset-0 w-full h-full object-cover pointer-events-none transition-opacity duration-300 z-0"
            style="
              opacity: {isPipVideoFinished ? 0 : 0.5};
            "
          ></video>
        {/if}

        <!-- Transformed Track Layer -->
        <div
          class="absolute top-0 left-0 z-10 pointer-events-none"
          style="
            width: {planeW}px;
            height: {planeH}px;
            transform-origin: 0 0;
            transform: {pipTransform};
          "
        >
          <svg style="width: {planeW}px; height: {planeH}px;" class="overflow-visible pointer-events-none">
            <!-- Uniform Grid in PiP -->
            <g id="pip-grid" opacity="0.25">
              <path
                d={gridData.pathD}
                stroke="#cbd5e1"
                stroke-width="0.5"
                fill="none"
                shape-rendering="crispEdges"
              />
            </g>

            <!-- Notes in PiP -->
            {#if activeTool === 'PREVIEW'}
              {#each decorations as dec, i (dec.id ?? `_pip_dec_${i}`)}
                <rect
                  x={dec.x}
                  y={dec.y}
                  width={dec.w}
                  height={dec.h}
                  fill="rgba(255, 255, 255, 0.3)"
                  stroke="#ffffff"
                  stroke-width="1.5"
                  stroke-linejoin="miter"
                  shape-rendering="crispEdges"
                  rx="0"
                  ry="0"
                />
              {/each}

              {#each notes as note, i (note.id ?? `_pip_${i}`)}
                {@const isBlue = note.color !== 'green'}
                <rect
                  x={note.x}
                  y={note.y}
                  width={note.w}
                  height={note.h}
                  fill={isBlue ? 'rgba(59, 130, 246, 0.35)' : 'rgba(16, 185, 129, 0.35)'}
                  stroke={isBlue ? '#3b82f6' : '#10b981'}
                  stroke-width="1.5"
                  stroke-linejoin="miter"
                  shape-rendering="crispEdges"
                  rx="0"
                  ry="0"
                />
                <text
                  x={note.x + note.w / 2}
                  y={note.y + note.h / 2 + 4}
                  font-family="monospace"
                  font-size="10"
                  font-weight="bold"
                  fill={isBlue ? '#3b82f6' : '#10b981'}
                  text-anchor="middle"
                  opacity="0.9"
                >
                  {isBlue ? 'Z' : 'X'}
                </text>
              {/each}
            {/if}

            <!-- Background Path in PiP -->
            <path
              d={pathD}
              fill="none"
              stroke="#e2e8f0"
              stroke-width="5"
              stroke-linecap="round"
              stroke-linejoin="round"
            />

            <!-- Foreground Progress Path in PiP -->
            <path
              d={pathD}
              pathLength="1000"
              fill="none"
              stroke="#fafaf9"
              stroke-width="3"
              stroke-linecap="round"
              stroke-linejoin="round"
              style="
                stroke-dasharray: 1000;
                stroke-dashoffset: {Math.max(0, Math.min(1000, 1000 * (1 - previewProgress)))};
              "
            />

            <!-- Speed Ticks in PiP -->
            <path
              d={speedTicksD}
              fill="none"
              stroke="#94a3b8"
              stroke-width="1.8"
              stroke-linecap="round"
            />

            <!-- Beat Ticks in PiP -->
            <path
              d={beatTicksD}
              fill="none"
              stroke="#22d3ee"
              stroke-width="1.6"
              stroke-linecap="round"
            />

            <!-- Current Preview Playhead Dot in PiP -->
            {#if pathBgEl && totalLength > 0}
              {@const currentPt = pathBgEl.getPointAtLength(previewProgress * totalLength)}
              <g>
                <circle
                  cx={currentPt.x}
                  cy={currentPt.y}
                  r="6"
                  fill="#ffffff"
                  stroke="#292524"
                  stroke-width="1.5"
                />
                <circle
                  cx={currentPt.x}
                  cy={currentPt.y}
                  r="2.5"
                  fill="#ef4444"
                />
              </g>
            {/if}
          </svg>
        </div>
      </div>

      <!-- PiP Controls Bar -->
      <div class="flex items-center gap-2 mt-2">
        <button
          onclick={togglePipPlay}
          class="paper-btn px-2.5 py-1 bg-[#292524] text-white text-xs font-mono font-bold cursor-pointer shadow-[2px_2px_0px_#292524]"
          title={isPipPlaying ? 'プレビューを一時停止' : 'プレビューを再生'}
          aria-label={isPipPlaying ? 'プレビューを一時停止' : 'プレビューを再生'}
        >
          {isPipPlaying ? '⏸' : '▶'}
        </button>

        <input
          type="range"
          min="0"
          max="1"
          step="any"
          bind:value={previewProgress}
          onpointerdown={handleScrubberStart}
          oninput={handleScrubberInput}
          onchange={handleScrubberEnd}
          onpointerup={handleScrubberEnd}
          class="flex-1 cursor-pointer accent-[#292524] h-1.5 bg-[#e2e8f0]"
        />

        <span class="text-[10px] font-mono text-[#292524] min-w-9 text-right font-bold">
          {Math.round(previewProgress * 100)}%
        </span>
      </div>
    </div>
  {/if}

  <!-- Breakpoint Editing Tooltip (floats above the selected breakpoint) -->
  {#if selectedBpScreen}
    <div
      class="absolute z-50 pointer-events-none"
      style="left: {selectedBpScreen.x}px; top: {selectedBpScreen.y}px;"
    >
      <!-- Speed / Zoom inspector -->
      {#if selectedBP && ((selectedBP.type === 'speed' && speedBPs[selectedBP.index]) || (selectedBP.type === 'zoom' && zoomBPs[selectedBP.index]))}
        {@const isSpeed = selectedBP.type === 'speed'}
        {@const bp = isSpeed ? speedBPs[selectedBP.index] : zoomBPs[selectedBP.index]}
        <div class="notebook-panel pointer-events-auto -translate-x-1/2 {selectedBpScreen.above ? '-translate-y-full -mt-3' : 'mt-3'} p-2.5 flex flex-wrap items-center gap-2.5 bg-[#fffdfa] border-[1.5px] border-[#292524] shadow-[4px_4px_0px_#292524]">
          <!-- Badge -->
          <div class="flex items-center gap-1.5 px-2 py-0.5 {isSpeed ? 'bg-[#fef3c7] text-[#b45309]' : 'bg-[#dbeafe] text-[#1d4ed8]'} border border-current text-xs font-mono font-bold">
            <span>{isSpeed ? '⏱️ 速度BP' : '🔍 ズームBP'}</span>
            <span class="opacity-70">#{selectedBP.index + 1}</span>
          </div>

          <!-- Progress Position with Fine-Tuning Steppers -->
          <div class="flex items-center gap-1 font-mono text-xs text-[#292524]">
            <span class="text-stone-400 font-bold">位置:</span>
            <button
              onclick={() => updateBpProgress(bp.progress - 0.01)}
              class="paper-btn px-1 py-0.2 bg-white text-[#292524] text-[10px]"
              title="1%戻す"
            >
              ◀
            </button>
            <span class="font-bold min-w-10 text-center">{(bp.progress * 100).toFixed(1)}%</span>
            <button
              onclick={() => updateBpProgress(bp.progress + 0.01)}
              class="paper-btn px-1 py-0.2 bg-white text-[#292524] text-[10px]"
              title="1%進める"
            >
              ▶
            </button>
          </div>

          <div class="w-px h-5 bg-[#292524]/20"></div>

          <!-- Stepper and Slider Controls -->
          <div class="flex items-center gap-1.5">
            <span class="text-stone-500 font-mono text-xs font-bold">{isSpeed ? '速度:' : 'ズーム:'}</span>

            <button
              onclick={() => updateBpVal(Math.max(isSpeed ? 0.2 : 0.4, Math.round((bp.val - 0.5) * 100) / 100))}
              class="paper-btn px-1.5 py-0.5 bg-white text-[#292524] font-mono font-bold text-xs"
              title="0.5減らす"
            >
              -0.5
            </button>
            <button
              onclick={() => updateBpVal(Math.max(isSpeed ? 0.2 : 0.4, Math.round((bp.val - 0.1) * 100) / 100))}
              class="paper-btn px-2 py-0.5 bg-white text-[#292524] font-mono font-bold text-xs"
              title="0.1減らす"
            >
              -0.1
            </button>

            <input
              type="range"
              min={isSpeed ? 0.2 : 0.4}
              max={isSpeed ? 4.0 : 3.0}
              step={isSpeed ? 0.05 : 0.05}
              value={bp.val}
              oninput={(e) => updateBpVal(parseFloat((e.target as HTMLInputElement).value))}
              class="w-24 cursor-pointer accent-[#292524] h-1.5 bg-[#e2e8f0]"
            />

            <button
              onclick={() => updateBpVal(Math.min(isSpeed ? 5.0 : 4.0, Math.round((bp.val + 0.1) * 100) / 100))}
              class="paper-btn px-2 py-0.5 bg-white text-[#292524] font-mono font-bold text-xs"
              title="0.1増やす"
            >
              +0.1
            </button>
            <button
              onclick={() => updateBpVal(Math.min(isSpeed ? 5.0 : 4.0, Math.round((bp.val + 0.5) * 100) / 100))}
              class="paper-btn px-1.5 py-0.5 bg-white text-[#292524] font-mono font-bold text-xs"
              title="0.5増やす"
            >
              +0.5
            </button>

            <!-- Direct Numeric Input Box for Precision Editing -->
            <div class="flex items-center gap-0.5 bg-[#292524] px-1.5 py-0.5 border border-[#292524]">
              <input
                type="number"
                min={isSpeed ? 0.1 : 0.2}
                max={isSpeed ? 10.0 : 5.0}
                step="0.05"
                value={bp.val}
                onchange={(e) => {
                  const v = parseFloat((e.target as HTMLInputElement).value);
                  if (!isNaN(v) && v > 0) updateBpVal(v);
                }}
                class="w-12 bg-transparent text-white font-mono font-bold text-xs text-right outline-none"
              />
              <span class="text-stone-300 font-mono text-xs font-bold">{isSpeed ? 'x' : 'z'}</span>
            </div>
          </div>

          <div class="w-px h-5 bg-[#292524]/20"></div>

          <!-- Presets -->
          <div class="flex items-center gap-1">
            {#if isSpeed}
              {#each [0.5, 0.8, 1.0, 1.5, 2.0] as preset}
                <button
                  onclick={() => updateBpVal(preset)}
                  class="paper-btn px-1.5 py-0.5 text-xs font-mono {Math.abs(bp.val - preset) < 0.05 ? 'bg-[#f59e0b] text-white font-bold' : 'bg-white text-[#292524]'}"
                >
                  {preset}x
                </button>
              {/each}
            {:else}
              {#each [0.6, 0.8, 1.0, 1.3, 1.6] as preset}
                <button
                  onclick={() => updateBpVal(preset)}
                  class="paper-btn px-1.5 py-0.5 text-xs font-mono {Math.abs(bp.val - preset) < 0.05 ? 'bg-[#3b82f6] text-white font-bold' : 'bg-white text-[#292524]'}"
                >
                  {preset}z
                </button>
              {/each}
            {/if}
          </div>

          <!-- Action Buttons -->
          <div class="flex items-center gap-1.5 ml-auto">
            <button
              onclick={deleteSelectedBp}
              class="paper-btn px-2.5 py-1 bg-[#fce1db] hover:bg-[#f8b4a5] text-[#be123c] font-mono font-bold text-xs flex items-center gap-1"
              title="ブレークポイントを削除"
            >
              <span>🗑️</span>
              <span>削除</span>
            </button>

            <button
              onclick={() => (selectedBP = null)}
              class="paper-btn px-2.5 py-1 bg-white hover:bg-stone-100 text-[#292524] font-mono font-bold text-xs"
              title="インスペクタを閉じる"
            >
              ✕
            </button>
          </div>
        </div>
      {/if}

      <!-- Camera-Offset inspector -->
      {#if selectedBP?.type === 'offset' && offsetBPs[selectedBP.index]}
        {@const bp = offsetBPs[selectedBP.index]}
        <div class="notebook-panel pointer-events-auto -translate-x-1/2 {selectedBpScreen.above ? '-translate-y-full -mt-3' : 'mt-3'} p-2.5 flex flex-wrap items-center gap-3 bg-[#fffdfa] border-[1.5px] border-[#292524] shadow-[4px_4px_0px_#292524]">
          <div class="flex items-center gap-1.5 px-2 py-0.5 bg-[#ede9fe] text-[#6d28d9] border border-current text-xs font-mono font-bold">
            <span>📐 オフセットBP</span>
            <span class="opacity-70">#{selectedBP.index + 1}</span>
          </div>

          <!-- Progress Position Steppers -->
          <div class="flex items-center gap-1 font-mono text-xs text-[#292524]">
            <span class="text-stone-400 font-bold">位置:</span>
            <button
              onclick={() => updateOffsetBpProgress(bp.progress - 0.01)}
              class="paper-btn px-1 py-0.2 bg-white text-[#292524] text-[10px]"
              title="1%戻す"
            >
              ◀
            </button>
            <span class="font-bold min-w-10 text-center">{(bp.progress * 100).toFixed(1)}%</span>
            <button
              onclick={() => updateOffsetBpProgress(bp.progress + 0.01)}
              class="paper-btn px-1 py-0.2 bg-white text-[#292524] text-[10px]"
              title="1%進める"
            >
              ▶
            </button>
          </div>

          <div class="w-px h-10 bg-[#292524]/20"></div>

          <!-- Mini POV box with draggable playhead dot -->
          <div class="flex flex-col items-center gap-1">
            <!-- svelte-ignore a11y_no_static_element_interactions -->
            <div
              class="relative w-40 aspect-video border-[1.5px] border-[#292524] bg-white overflow-hidden cursor-crosshair touch-none"
              onpointerdown={startOffsetDrag}
              onpointermove={(e) => {
                if (draggingOffset) updateOffsetFromEvent(e);
              }}
              onpointerup={endOffsetDrag}
              onpointercancel={endOffsetDrag}
            >
              <div class="absolute left-1/2 top-0 bottom-0 w-px bg-[#292524]/15"></div>
              <div class="absolute top-1/2 left-0 right-0 h-px bg-[#292524]/15"></div>
              <div
                class="absolute w-3 h-3 -translate-x-1/2 -translate-y-1/2 rounded-full bg-[#ef4444] border-[1.5px] border-[#292524]"
                style="left: {50 + bp.nx * 50}%; top: {50 + bp.ny * 50}%;"
              ></div>
            </div>
            <span class="text-[10px] font-mono text-[#292524]">ドラッグで移動</span>
          </div>

          <!-- Readout -->
          <div class="flex items-center gap-1 font-mono text-xs text-[#292524]">
            <span class="text-stone-400 font-bold">X:</span>
            <span class="font-bold min-w-9 text-right">{bp.nx.toFixed(2)}</span>
            <span class="text-stone-400 font-bold ml-2">Y:</span>
            <span class="font-bold min-w-9 text-right">{bp.ny.toFixed(2)}</span>
          </div>

          <button
            onclick={resetOffsetBp}
            class="paper-btn px-2.5 py-1 bg-white text-[#292524] font-mono font-bold text-xs"
            title="中央に戻す"
          >
            ⌖ 中央
          </button>

          <div class="flex items-center gap-1.5 ml-auto">
            <button
              onclick={deleteSelectedBp}
              class="paper-btn px-2.5 py-1 bg-[#fce1db] hover:bg-[#f8b4a5] text-[#be123c] font-mono font-bold text-xs flex items-center gap-1"
              title="ブレークポイントを削除"
            >
              <span>🗑️</span>
              <span>削除</span>
            </button>

            <button
              onclick={() => (selectedBP = null)}
              class="paper-btn px-2.5 py-1 bg-white hover:bg-stone-100 text-[#292524] font-mono font-bold text-xs"
              title="インスペクタを閉じる"
            >
              ✕
            </button>
          </div>
        </div>
      {/if}
    </div>
  {/if}

  <!-- Bottom Floating Command Bar -->
  <div class="fixed bottom-6 left-1/2 -translate-x-1/2 flex flex-col items-center gap-2 z-40 w-[95%] max-w-5xl pointer-events-none">
    <!-- Notes Sub-Toolbar (When NOTES tool is active) -->
    {#if activeTool === 'NOTES'}
      <div class="notebook-panel p-2 flex items-center gap-2 bg-[#fffdfa] border-[1.5px] border-[#292524] shadow-[3px_3px_0px_#292524] pointer-events-auto">
        <span class="px-2 text-xs font-mono font-bold text-[#292524]">色:</span>
        <button
          onclick={() => (noteColor = 'blue')}
          class="paper-btn px-3 py-1 bg-[#dbeafe] text-[#1d4ed8] font-mono font-bold text-xs {noteColor === 'blue' ? 'ring-2 ring-[#1d4ed8]' : ''}"
        >
          青 (Z)
        </button>
        <button
          onclick={() => (noteColor = 'green')}
          class="paper-btn px-3 py-1 bg-[#d8ecd7] text-[#047857] font-mono font-bold text-xs {noteColor === 'green' ? 'ring-2 ring-[#047857]' : ''}"
        >
          緑 (X)
        </button>
        <button
          onclick={() => (noteColor = 'deco')}
          class="paper-btn px-3 py-1 bg-[#f1f5f9] text-[#475569] font-mono font-bold text-xs {noteColor === 'deco' ? 'ring-2 ring-[#94a3b8]' : ''}"
          title="装飾（白）— スコアや判定に影響しないゴースト矩形"
        >
          白 (C)
        </button>
      </div>
    {/if}

    <!-- Main Toolbar -->
    <div class="notebook-panel p-2 flex flex-wrap justify-center gap-1.5 bg-[#fffdfa] border-[1.5px] border-[#292524] shadow-[4px_4px_0px_#292524] pointer-events-auto w-full items-center">
      <!-- Undo / Redo -->
      <button
        onclick={doUndo}
        disabled={undoStack.length === 0}
        class="paper-btn px-2.5 py-1.5 bg-white text-[#292524] font-mono font-bold text-xs disabled:opacity-40"
        title="元に戻す (Ctrl+Z)"
      >
        ↩
      </button>
      <button
        onclick={doRedo}
        disabled={redoStack.length === 0}
        class="paper-btn px-2.5 py-1.5 bg-white text-[#292524] font-mono font-bold text-xs disabled:opacity-40"
        title="やり直す (Ctrl+Y)"
      >
        ↪
      </button>

      <div class="w-px h-6 bg-[#292524]/20 mx-1"></div>

      <!-- Fit to View & Help -->
      <button
        onclick={fitView}
        class="paper-btn px-2.5 py-1.5 bg-white text-[#292524] font-mono font-bold text-xs"
        title="全体を表示 (0 / F)"
      >
        ⛶ 全体表示
      </button>
      <button
        onclick={() => (showHelp = !showHelp)}
        class="paper-btn px-2.5 py-1.5 bg-white text-[#292524] font-mono font-bold text-xs"
        title="操作ガイド (?)"
      >
        ? ヘルプ
      </button>

      <div class="w-px h-6 bg-[#292524]/20 mx-1"></div>

      <!-- BPM Analyzer -->
      <button
        onclick={analyzeBpm}
        class="paper-btn px-3 py-1.5 bg-[#cffafe] hover:bg-[#a5f3fc] text-[#0e7490] font-mono font-bold text-xs"
        title="BPMを解析して拍をラインに表示"
      >
        🎵 {isDetectingBpm ? '解析中...' : bpm ? `${bpm.toFixed(1)} BPM` : 'BPM解析'}
      </button>

      <div class="w-px h-6 bg-[#292524]/20 mx-1"></div>

      <!-- Tool Buttons -->
      <button
        onclick={() => selectTool('DRAW')}
        class="paper-btn px-3 py-1.5 font-mono font-bold text-xs {activeTool === 'DRAW' ? 'bg-[#d8ecd7] ring-2 ring-[#292524]' : 'bg-white'}"
        title="描画ツール (1) — 線をクリックして頂点を追加"
      >
        ✏️ 描画 <span class="text-[9px] font-black text-[#292524]/50">1</span>
      </button>
      <button
        onclick={() => selectTool('BEND')}
        class="paper-btn px-3 py-1.5 font-mono font-bold text-xs {activeTool === 'BEND' ? 'bg-[#dbe9f4] ring-2 ring-[#292524]' : 'bg-white'}"
        title="カーブツール (2) — 直線をドラッグして曲げる"
      >
        〰️ カーブ <span class="text-[9px] font-black text-[#292524]/50">2</span>
      </button>
      <button
        onclick={() => selectTool('NOTES')}
        class="paper-btn px-3 py-1.5 font-mono font-bold text-xs {activeTool === 'NOTES' ? 'bg-[#fce1db] ring-2 ring-[#292524]' : 'bg-white'}"
        title="ノートツール (3) — ドラッグで描画、Z/Xで色切替"
      >
        🔲 ノート <span class="text-[9px] font-black text-[#292524]/50">3</span>
      </button>
      <button
        onclick={() => selectTool('SPEED')}
        class="paper-btn px-3 py-1.5 font-mono font-bold text-xs {activeTool === 'SPEED' ? 'bg-[#fff3cd] ring-2 ring-[#292524]' : 'bg-white'}"
        title="速度ブレークポイント (4) — 線をクリックで追加"
      >
        ⏱️ 速度BP <span class="text-[9px] font-black text-[#292524]/50">4</span>
      </button>
      <button
        onclick={() => selectTool('ZOOM')}
        class="paper-btn px-3 py-1.5 font-mono font-bold text-xs {activeTool === 'ZOOM' ? 'bg-[#dbe9f4] ring-2 ring-[#292524]' : 'bg-white'}"
        title="ズームブレークポイント (5) — 線をクリックで追加"
      >
        🔍 ズームBP <span class="text-[9px] font-black text-[#292524]/50">5</span>
      </button>
      <button
        onclick={() => selectTool('OFFSET')}
        class="paper-btn px-3 py-1.5 font-mono font-bold text-xs {activeTool === 'OFFSET' ? 'bg-[#ede9fe] ring-2 ring-[#292524]' : 'bg-white'}"
        title="カメラオフセットBP (6) — 線をクリックで追加。ポップアップでプレイヘッド位置を設定"
      >
        📐 オフセット <span class="text-[9px] font-black text-[#292524]/50">6</span>
      </button>
      <button
        onclick={() => {
          selectTool('PREVIEW');
          updatePiP();
        }}
        class="paper-btn px-3 py-1.5 font-mono font-bold text-xs {activeTool === 'PREVIEW' ? 'bg-[#c7d2fe] ring-2 ring-[#292524]' : 'bg-white'}"
        title="プレビューツール (7) — カメラ追従を確認"
      >
        📺 プレビュー <span class="text-[9px] font-black text-[#292524]/50">7</span>
      </button>

      <div class="w-px h-6 bg-[#292524]/20 mx-1"></div>

      <!-- File & Storage Actions -->
      <button
        onclick={handleSaveSong}
        disabled={isPackaging}
        class="paper-btn px-3 py-1.5 bg-[#d8ecd7] hover:bg-[#c5dac1] text-[#047857] font-mono font-bold text-xs flex items-center gap-1.5 shadow-[1px_1px_0px_#292524] cursor-pointer"
        title="圧縮アーカイブとしてブラウザに保存"
      >
        <span>💾</span>
        <span>曲を保存</span>
      </button>

      <button
        onclick={handleBackupSong}
        disabled={isPackaging}
        class="paper-btn px-3 py-1.5 bg-[#fff3cd] hover:bg-[#fae8b4] text-[#b45309] font-mono font-bold text-xs flex items-center gap-1.5 shadow-[1px_1px_0px_#292524] cursor-pointer"
        title="バックアップアーカイブ (.zip) をダウンロード"
      >
        <span>📦</span>
        <span>バックアップ</span>
      </button>

      <button
        onclick={() => archiveInputEl?.click()}
        disabled={isPackaging}
        class="paper-btn px-3 py-1.5 bg-white hover:bg-[#faf7f0] text-[#292524] font-mono font-bold text-xs flex items-center gap-1.5 shadow-[1px_1px_0px_#292524] cursor-pointer"
        title="曲アーカイブ (.zip) を展開してエディタに読み込み"
      >
        <span>📂</span>
        <span>アーカイブを読み込み</span>
      </button>

      <!-- Hidden file inputs -->
      <input
        bind:this={fileInputEl}
        type="file"
        accept=".json"
        onchange={handleFileLoad}
        class="hidden"
      />
      <input
        bind:this={videoInputEl}
        type="file"
        accept="video/*,.mp4,.webm"
        onchange={handleVideoUpload}
        class="hidden"
      />
      <input
        bind:this={audioInputEl}
        type="file"
        accept="audio/*,.opus,.ogg,.mp3,.wav,.m4a"
        onchange={handleAudioUpload}
        class="hidden"
      />
      <input
        bind:this={archiveInputEl}
        type="file"
        accept=".zip,.pm"
        onchange={handleArchiveLoad}
        class="hidden"
      />

      <div class="w-px h-6 bg-[#292524]/20 mx-1"></div>

      <!-- Play Game Button -->
      <button
        onclick={launchPlayGame}
        class="paper-btn px-4 py-1.5 bg-[#292524] hover:bg-[#3f3a39] text-white font-mono font-bold text-xs cursor-pointer shadow-[2px_2px_0px_#292524]"
      >
        ▶ ゲームをプレイ
      </button>
    </div>

    <!-- Info & Duration Badges -->
    <div class="flex justify-between items-center w-full px-2 pointer-events-auto gap-2 text-xs font-mono text-[#292524]/80">
      <div class="bg-[#fffdfa] px-3 py-1 border border-[#292524]/40 shadow-xs flex-1 truncate">
        {#if activeTool === 'DRAW'}
          ✏️ 描画 [1]: 線をクリックして点を追加、点をドラッグで移動。端は固定。
        {:else if activeTool === 'BEND'}
          〰️ カーブ [2]: 直線をドラッグして曲げ、曲線上の点をドラッグして整形。
        {:else if activeTool === 'NOTES'}
          🔲 ノート [3]: ドラッグで描画、右クリックで消去。Z/X/C で色切替（C=白装飾）。
        {:else if activeTool === 'SPEED'}
          ⏱️ 速度BP [4]: 線をクリックで追加。ホイール/ダブルクリックで値変更、右クリックで削除。
        {:else if activeTool === 'ZOOM'}
          🔍 ズームBP [5]: 線をクリックで追加。ホバーでカメラ枠を確認、右クリックで削除。
        {:else if activeTool === 'OFFSET'}
          📐 オフセットBP [6]: 線をクリックで追加。ポップアップでプレイヘッドのオフセットを設定。
        {:else if activeTool === 'PREVIEW'}
          📺 プレビュー [7]: 線上をドラッグでスクラブ。Space で再生/一時停止。
        {/if}
      </div>

      <div class="bg-[#fffdfa] px-3 py-1 border border-[#292524]/40 font-bold shadow-xs whitespace-nowrap">
        ⏱️ 譜面時間: {calculatedDuration.toFixed(2)}秒
      </div>
    </div>
  </div>
</div>

<!-- Help / Shortcut Overlay -->
{#if showHelp}
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <!-- svelte-ignore a11y_click_events_have_key_events -->
  <div
    class="fixed inset-0 z-50 bg-black/60 flex items-center justify-center p-4"
    onclick={(e) => {
      if (e.target === e.currentTarget) showHelp = false;
    }}
  >
    <div class="paper-card jagged-border bg-[#fffdfa] w-full max-w-2xl max-h-[85vh] overflow-y-auto p-6 border-2 border-[#292524] shadow-[6px_6px_0px_#292524] flex flex-col gap-4 font-mono text-xs text-[#292524]">
      <div class="flex items-center justify-between border-b border-[#292524]/20 pb-3">
        <h3 class="text-base font-mono font-black text-[#292524]">🎮 エディタ操作ガイド</h3>
        <button
          onclick={() => (showHelp = false)}
          class="paper-btn px-2 py-0.5 bg-white text-xs font-mono font-bold cursor-pointer"
        >
          ✕
        </button>
      </div>

      <div class="grid grid-cols-1 md:grid-cols-2 gap-x-6 gap-y-4">
        <div>
          <h4 class="font-black text-[#292524] border-b border-[#292524]/20 pb-1 mb-2">ツール切り替え（キー）</h4>
          <ul class="space-y-1.5">
            <li><kbd class="kbd">1</kbd> ✏️ 描画 — 線をクリックして頂点を追加</li>
            <li><kbd class="kbd">2</kbd> 〰️ カーブ — 直線をドラッグして曲げる</li>
            <li><kbd class="kbd">3</kbd> 🔲 ノート — ドラッグで描画</li>
            <li><kbd class="kbd">4</kbd> ⏱️ 速度BP — 線をクリックで追加</li>
            <li><kbd class="kbd">5</kbd> 🔍 ズームBP — 線をクリックで追加</li>
            <li><kbd class="kbd">6</kbd> � オフセットBP — 線をクリックで追加</li>
            <li><kbd class="kbd">7</kbd> �📺 プレビュー — カメラ追従を確認</li>
          </ul>
        </div>

        <div>
          <h4 class="font-black text-[#292524] border-b border-[#292524]/20 pb-1 mb-2">ビュー操作</h4>
          <ul class="space-y-1.5">
            <li><kbd class="kbd">ホイール</kbd> ズームイン / アウト</li>
            <li><kbd class="kbd">右ドラッグ</kbd> / <kbd class="kbd">中ドラッグ</kbd> / <kbd class="kbd">Space+ドラッグ</kbd> パン</li>
            <li><kbd class="kbd">0</kbd> または <kbd class="kbd">F</kbd> 全体を表示</li>
          </ul>

          <h4 class="font-black text-[#292524] border-b border-[#292524]/20 pb-1 mt-4 mb-2">ショートカット</h4>
          <ul class="space-y-1.5">
            <li><kbd class="kbd">Ctrl/⌘+Z</kbd> 元に戻す</li>
            <li><kbd class="kbd">Ctrl/⌘+Y</kbd> やり直す</li>
            <li><kbd class="kbd">Space</kbd> プレビュー再生/停止</li>
            <li><kbd class="kbd">Z</kbd> / <kbd class="kbd">X</kbd> / <kbd class="kbd">C</kbd> ノート色（青/緑/白装飾）※ノートツール時</li>
            <li><kbd class="kbd">Esc</kbd> 選択解除 / ガイドを閉じる</li>
            <li><kbd class="kbd">?</kbd> このガイドを表示</li>
          </ul>
        </div>
      </div>

      <div class="bg-[#faf7f0] border border-[#292524]/30 p-3 leading-relaxed">
        <span class="font-black">ヒント:</span> ブレークポイントはダブルクリックで数値入力、ホイールで微調整、右クリックで削除できます。オフセットBPはポップアップの赤い点をドラッグしてプレイヘッド位置を設定します。プレビュー中は画面上の線を直接ドラッグして曲の任意の位置へスクラブできます。
      </div>
    </div>
  </div>
{/if}

<!-- Floating Toast Notification -->
{#if toastMessage}
  <div class="paper-card fixed bottom-24 left-1/2 -translate-x-1/2 z-50 bg-[#fffdfa] border-[1.5px] border-[#292524] px-4 py-2 text-xs font-mono font-black text-[#292524] shadow-[4px_4px_0px_#292524] animate-bounce">
    {toastMessage}
  </div>
{/if}

<!-- Song Metadata Dialog -->
{#if showMetadataDialog}
  <div class="fixed inset-0 z-50 bg-black/60 flex items-center justify-center p-4">
    <div class="paper-card jagged-border bg-[#fffdfa] w-full max-w-md p-6 border-[2px] border-[#292524] shadow-[6px_6px_0px_#292524] flex flex-col gap-4">
      <div class="flex items-center justify-between border-b border-[#292524]/20 pb-3">
        <h3 class="text-base font-mono font-black text-[#292524]">曲情報を編集</h3>
        <button
          onclick={() => (showMetadataDialog = false)}
          class="paper-btn px-2 py-0.5 bg-white text-xs font-mono font-bold cursor-pointer"
        >
          ✕
        </button>
      </div>

      <div class="flex flex-col gap-3 font-mono text-xs">
        <div>
          <label for="metaSongNameInput" class="block font-bold text-[#292524] mb-1">曲名 / タイトル:</label>
          <input
            id="metaSongNameInput"
            type="text"
            bind:value={tempSongName}
            placeholder="例: 逆転"
            class="w-full px-3 py-2 bg-white border-[1.5px] border-[#292524] text-[#292524] font-bold"
          />
        </div>

        <div>
          <label for="metaSongArtistInput" class="block font-bold text-[#292524] mb-1">アーティスト / 作者（任意）:</label>
          <input
            id="metaSongArtistInput"
            type="text"
            bind:value={tempSongArtist}
            placeholder="例: 作曲者名"
            class="w-full px-3 py-2 bg-white border-[1.5px] border-[#292524] text-[#292524]"
          />
        </div>

        <div>
          <label for="metaSongIdInput" class="block font-bold text-[#292524] mb-1">曲ID（スラッグ）:</label>
          <input
            id="metaSongIdInput"
            type="text"
            bind:value={tempSongId}
            placeholder="例: gyakuten"
            class="w-full px-3 py-2 bg-white border-[1.5px] border-[#292524] text-[#292524]"
          />
        </div>
      </div>

      <div class="flex justify-end gap-2 pt-2 border-t border-[#292524]/20">
        <button
          onclick={() => (showMetadataDialog = false)}
          class="paper-btn px-4 py-2 bg-white text-[#292524] text-xs font-mono font-bold cursor-pointer"
        >
          キャンセル
        </button>
        <button
          onclick={saveMetadata}
          class="paper-btn px-5 py-2 bg-[#d8ecd7] text-[#047857] text-xs font-mono font-black cursor-pointer shadow-[2px_2px_0px_#292524]"
        >
          情報を保存
        </button>
      </div>
    </div>
  </div>
{/if}

<!-- Add Level Dialog -->
{#if showAddLevelDialog}
  <div class="fixed inset-0 z-50 bg-black/60 flex items-center justify-center p-4">
    <div class="paper-card jagged-border bg-[#fffdfa] w-full max-w-md p-6 border-[2px] border-[#292524] shadow-[6px_6px_0px_#292524] flex flex-col gap-4">
      <div class="flex items-center justify-between border-b border-[#292524]/20 pb-3">
        <h3 class="text-base font-mono font-black text-[#292524]">レベルを追加</h3>
        <button
          onclick={() => (showAddLevelDialog = false)}
          class="paper-btn px-2 py-0.5 bg-white text-xs font-mono font-bold cursor-pointer"
        >
          ✕
        </button>
      </div>

      <div class="flex flex-col gap-3.5 font-mono text-xs">
        <div>
          <label for="newLevelNameInput" class="block font-bold text-[#292524] mb-1">レベル名（自由入力）:</label>
          <input
            id="newLevelNameInput"
            type="text"
            bind:value={newLevelName}
            placeholder="例: イージー、ハード、カオス、マスター"
            class="w-full px-3 py-2 bg-white border-[1.5px] border-[#292524] text-[#292524] font-bold"
          />
          <p class="text-[10px] text-[#292524]/60 mt-0.5">このレベルの譜面につける名前です。</p>
        </div>

        <div>
          <div class="flex items-center justify-between mb-1">
            <label for="newLevelDiffRange" class="font-bold text-[#292524]">難易度（0.0 - 10.0）:</label>
            <span class="px-2 py-0.5 bg-[#fff3cd] border border-[#292524] font-black text-sm text-[#b45309]">
              {newLevelDifficulty.toFixed(1)}
            </span>
          </div>
          <div class="flex items-center gap-3">
            <input
              id="newLevelDiffRange"
              type="range"
              min="0.0"
              max="10.0"
              step="0.1"
              bind:value={newLevelDifficulty}
              class="flex-1 cursor-pointer accent-[#292524]"
            />
            <input
              type="number"
              min="0.0"
              max="10.0"
              step="0.1"
              bind:value={newLevelDifficulty}
              class="w-16 px-2 py-1 bg-white border border-[#292524] text-center font-bold"
            />
          </div>
          <p class="text-[10px] text-[#292524]/60 mt-0.5">0〜10の小数1桁の数値です。</p>
        </div>

        <div class="flex items-center gap-2 pt-1">
          <input
            type="checkbox"
            id="copyChartCheckbox"
            bind:checked={newLevelCopyCurrent}
            class="accent-[#292524] w-4 h-4 cursor-pointer"
          />
          <label for="copyChartCheckbox" class="cursor-pointer text-[#292524] font-bold select-none">
            現在のレベルのトラック（ノードとノート）を複製
          </label>
        </div>
      </div>

      <div class="flex justify-end gap-2 pt-2 border-t border-[#292524]/20">
        <button
          onclick={() => (showAddLevelDialog = false)}
          class="paper-btn px-4 py-2 bg-white text-[#292524] text-xs font-mono font-bold cursor-pointer"
        >
          キャンセル
        </button>
        <button
          onclick={addLevel}
          class="paper-btn px-5 py-2 bg-[#d8ecd7] text-[#047857] text-xs font-mono font-black cursor-pointer shadow-[2px_2px_0px_#292524]"
        >
          追加
        </button>
      </div>
    </div>
  </div>
{/if}

<!-- Edit Current Level Dialog -->
{#if showEditLevelDialog && songLevels[activeLevelIndex]}
  <div class="fixed inset-0 z-50 bg-black/60 flex items-center justify-center p-4">
    <div class="paper-card jagged-border bg-[#fffdfa] w-full max-w-md p-6 border-[2px] border-[#292524] shadow-[6px_6px_0px_#292524] flex flex-col gap-4">
      <div class="flex items-center justify-between border-b border-[#292524]/20 pb-3">
        <h3 class="text-base font-mono font-black text-[#292524]">レベル設定を編集</h3>
        <button
          onclick={() => (showEditLevelDialog = false)}
          class="paper-btn px-2 py-0.5 bg-white text-xs font-mono font-bold cursor-pointer"
        >
          ✕
        </button>
      </div>

      <div class="flex flex-col gap-3.5 font-mono text-xs">
        <div>
          <label for="editLevelNameInput" class="block font-bold text-[#292524] mb-1">レベル名:</label>
          <input
            id="editLevelNameInput"
            type="text"
            bind:value={editLevelName}
            class="w-full px-3 py-2 bg-white border-[1.5px] border-[#292524] text-[#292524] font-bold"
          />
        </div>

        <div>
          <div class="flex items-center justify-between mb-1">
            <label for="editLevelDiffRange" class="font-bold text-[#292524]">難易度（0.0 - 10.0）:</label>
            <span class="px-2 py-0.5 bg-[#fff3cd] border border-[#292524] font-black text-sm text-[#b45309]">
              {editLevelDifficulty.toFixed(1)}
            </span>
          </div>
          <div class="flex items-center gap-3">
            <input
              id="editLevelDiffRange"
              type="range"
              min="0.0"
              max="10.0"
              step="0.1"
              bind:value={editLevelDifficulty}
              class="flex-1 cursor-pointer accent-[#292524]"
            />
            <input
              type="number"
              min="0.0"
              max="10.0"
              step="0.1"
              bind:value={editLevelDifficulty}
              class="w-16 px-2 py-1 bg-white border border-[#292524] text-center font-bold"
            />
          </div>
        </div>
      </div>

      <div class="flex items-center justify-between pt-2 border-t border-[#292524]/20">
        {#if songLevels.length > 1}
          <button
            onclick={deleteCurrentLevel}
            class="paper-btn px-3 py-1.5 bg-[#fce1db] text-[#be123c] text-xs font-mono font-bold cursor-pointer"
            title="このレベルを削除"
          >
            レベルを削除
          </button>
        {:else}
          <span class="text-[10px] font-mono text-[#292524]/50">最後のレベルは削除できません</span>
        {/if}

        <div class="flex items-center gap-2">
          <button
            onclick={() => (showEditLevelDialog = false)}
            class="paper-btn px-3 py-1.5 bg-white text-[#292524] text-xs font-mono font-bold cursor-pointer"
          >
            キャンセル
          </button>
          <button
            onclick={saveEditLevel}
            class="paper-btn px-4 py-1.5 bg-[#d8ecd7] text-[#047857] text-xs font-mono font-black cursor-pointer shadow-[2px_2px_0px_#292524]"
          >
            変更を保存
          </button>
        </div>
      </div>
    </div>
  </div>
{/if}
