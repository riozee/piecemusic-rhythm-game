<script lang="ts">
  import { onMount } from 'svelte';
  import QRCode from 'qrcode';

  const BASE_NOTE_TRAVEL_TIME = 2000;
  const BASE_HIT_WINDOW_START = 900;
  const BASE_HIT_WINDOW_END = 1500;
  const HIT_TOLERANCE_DEG = 45;
  const NETWORK_THROTTLE_MS = 16;

  type Note = {
    id: string;
    side: 'LEFT' | 'RIGHT';
    angle: number;
    createdAt: number;
    type: 'SINGLE' | 'DOUBLE';
    missed?: boolean;
    travelTime: number;
    hitStart: number;
    hitEnd: number;
  };

  type HitFeedback = {
    id: string;
    angle: number;
  };

  let urlRoom = $state<string | null>(null);
  let isDevMode = $state(false);
  let isAutoMode = $state(false);

  let role = $state<'loading' | 'desktop' | 'phone'>('loading');
  let status = $state('初期化中 ⏳');
  let qrUrl = $state('');
  let qrDataUrl = $state('');

  let isConnected = $state(false);
  let isPlaying = $state(false);

  let playerState = $state({ left: false, right: false });
  let notes = $state<Note[]>([]);
  let hits = $state<HitFeedback[]>([]);
  let score = $state(0);
  let combo = $state(0);

  let steeringContainerRef = $state<HTMLDivElement | null>(null);

  // Engine state variables
  let speedMultiplier = 1.0;
  let sendAction: any = null;
  let hostPeerId: string | null = null;
  let activePlayerId: string | null = null;
  let prevAngle = { LEFT: 180, RIGHT: 0 };

  // Autopilot Smoothing Refs
  let targetTilt = 0;
  let currentTilt = 0;

  let phoneState = { left: false, right: false, tilt: 0 };
  let lastSendTime = 0;
  let lastSentTilt = 0;
  let sensorsStarted = false;

  onMount(() => {
    const searchParams = new URLSearchParams(window.location.search);
    urlRoom = searchParams.get('room');
    isDevMode = searchParams.get('dev') === 'true';
    isAutoMode = searchParams.get('auto') === 'true';

    if (isDevMode || isAutoMode) {
      role = 'desktop';
      status = isAutoMode ? 'AUTOPILOT ENGAGED 🚀' : 'デベロッパーモード 🔥';
      isConnected = true;
      isPlaying = true;
    }
  });

  // --- Speed Escalation Engine ---
  $effect(() => {
    if (!isPlaying || role !== 'desktop') return;

    const speedScaler = setInterval(() => {
      speedMultiplier *= 1.005;
    }, 1000);

    return () => clearInterval(speedScaler);
  });

  // --- Auto-Pilot AI Engine (Smooth) ---
  $effect(() => {
    if (!isAutoMode || role !== 'desktop' || !isPlaying) return;

    let animationFrameId: number;

    const renderLoop = () => {
      currentTilt += (targetTilt - currentTilt) * 0.15;
      if (steeringContainerRef) {
        steeringContainerRef.style.transform = `rotate(${currentTilt}deg)`;
      }
      animationFrameId = requestAnimationFrame(renderLoop);
    };
    renderLoop();

    const autopilotEngine = setInterval(() => {
      const now = Date.now();

      const pendingHits = notes.filter(n => {
        if (n.missed) return false;
        const age = now - n.createdAt;
        const optimalHitTime = n.hitStart + ((n.hitEnd - n.hitStart) * 0.25) + (Math.random() * 20 - 10);
        return age >= optimalHitTime && age <= optimalHitTime + 60;
      });

      const upcomingNotes = notes.filter(n => !n.missed).sort((a, b) => a.createdAt - b.createdAt);
      if (upcomingNotes.length > 0) {
        const baseNote = upcomingNotes[0];
        const angleDrift = Math.random() * 4 - 2;
        targetTilt = (baseNote.side === 'RIGHT' ? baseNote.angle : baseNote.angle - 180) + angleDrift;
      } else {
        targetTilt = 0;
      }

      if (pendingHits.length > 0) {
        const activeTaps = pendingHits.map(n => n.side);

        playerState = {
          left: activeTaps.includes('LEFT'),
          right: activeTaps.includes('RIGHT')
        };

        setTimeout(() => {
          playerState = { left: false, right: false };
        }, 60);

        handleTaps(activeTaps, currentTilt);
      }
    }, 30);

    return () => {
      clearInterval(autopilotEngine);
      cancelAnimationFrame(animationFrameId);
    };
  });

  // --- Desktop Game Loop ---
  $effect(() => {
    if (role !== 'desktop' || !isConnected || !isPlaying) return;

    let spawnerTimeout: ReturnType<typeof setTimeout>;

    const spawnNote = () => {
      const roll = Math.random();
      const now = Date.now();
      const speed = speedMultiplier;
      const newNotes: Note[] = [];

      const currentTravelTime = BASE_NOTE_TRAVEL_TIME / speed;
      const currentHitStart = BASE_HIT_WINDOW_START / speed;
      const currentHitEnd = BASE_HIT_WINDOW_END / speed;

      const getNextAngle = (side: 'LEFT' | 'RIGHT') => {
        const variance = (Math.random() * 40) - 20;
        let base = prevAngle[side] + variance;
        if (side === 'RIGHT') base = Math.max(-45, Math.min(45, base));
        if (side === 'LEFT') base = Math.max(135, Math.min(225, base));
        prevAngle[side] = base;
        return base;
      };

      if (roll < 0.25) {
        const rightAngle = getNextAngle('RIGHT');
        newNotes.push({ id: `R-${now}`, side: 'RIGHT', angle: rightAngle, createdAt: now, type: 'DOUBLE', travelTime: currentTravelTime, hitStart: currentHitStart, hitEnd: currentHitEnd });
        newNotes.push({ id: `L-${now}`, side: 'LEFT', angle: rightAngle + 180, createdAt: now, type: 'DOUBLE', travelTime: currentTravelTime, hitStart: currentHitStart, hitEnd: currentHitEnd });
      } else if (roll < 0.75) {
        const side = Math.random() > 0.5 ? 'LEFT' : 'RIGHT';
        newNotes.push({ id: `${side[0]}-${now}`, side, angle: getNextAngle(side), createdAt: now, type: 'SINGLE', travelTime: currentTravelTime, hitStart: currentHitStart, hitEnd: currentHitEnd });
      }

      if (newNotes.length > 0) notes = [...notes, ...newNotes];

      const nextSpawnInterval = 1000 / speedMultiplier;
      spawnerTimeout = setTimeout(spawnNote, nextSpawnInterval);
    };

    spawnerTimeout = setTimeout(spawnNote, 1000);

    const cleanup = setInterval(() => {
      const now = Date.now();
      let dropped = false;
      const next = notes.map(n => {
        if (!n.missed && now - n.createdAt > n.hitEnd) {
          dropped = true;
          return { ...n, missed: true };
        }
        return n;
      }).filter(n => now - n.createdAt < n.travelTime + 200);

      if (dropped) setTimeout(() => { combo = 0; }, 0);
      notes = next;
    }, 100);

    return () => {
      clearTimeout(spawnerTimeout);
      clearInterval(cleanup);
    };
  });

  // --- Network Initialization ---
  $effect(() => {
    if (isDevMode || isAutoMode || role === 'loading') return;

    let currentRoom: any = null;

    const initializeTrystero = async () => {
      const { joinRoom } = await import('@trystero-p2p/mqtt');
      const isHost = !urlRoom;
      const roomId = urlRoom || 'game_' + Math.random().toString(36).substring(2, 9);

      const config = {
        appId: 'my-campus-racer-v4',
        rtcConfig: { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] }
      };

      currentRoom = joinRoom(config, roomId);
      const controllerAction = currentRoom.makeAction('controller');

      if (isHost) {
        role = 'desktop';
        const generatedQrUrl = `${window.location.origin}${window.location.pathname}?room=${roomId}`;
        qrUrl = generatedQrUrl;
        try {
          qrDataUrl = await QRCode.toDataURL(generatedQrUrl, { width: 300, margin: 2, color: { dark: '#000000', light: '#ffffff' } });
        } catch (err) {
          console.error('Failed to generate QR code', err);
        }
        status = 'コントローラーの接続を待機中 🎧';

        currentRoom.onPeerJoin = (peerId: string) => {
          if (!activePlayerId) {
            activePlayerId = peerId;
            status = 'コントローラーが接続されました。開始を待っています 💿';
            isConnected = true;
          }
        };

        currentRoom.onPeerLeave = (peerId: string) => {
          if (activePlayerId === peerId) {
            activePlayerId = null;
            isConnected = false;
            isPlaying = false;
            status = '信号が途絶えました。再スキャンして接続してください 📡';
            playerState = { left: false, right: false };
            notes = [];
            speedMultiplier = 1.0;
          }
        };

        controllerAction.onMessage = (payload: any, { peerId }: any) => {
          if (!activePlayerId) {
            activePlayerId = peerId;
            isConnected = true;
          }
          if (peerId !== activePlayerId) return;

          if (payload.action === 'START') {
            status = 'ゲームスタート 🔥';
            isPlaying = true;
            return;
          }

          if (steeringContainerRef) {
            steeringContainerRef.style.transform = `rotate(${payload.tilt}deg)`;
          }

          if (playerState.left !== payload.left || playerState.right !== payload.right) {
            playerState = { left: payload.left, right: payload.right };
          }

          if (payload.taps && payload.taps.length > 0) handleTaps(payload.taps, payload.tilt);
        };

      } else {
        role = 'phone';
        status = '画面にペアリング中 🔗';
        sendAction = controllerAction;

        currentRoom.onPeerJoin = (peerId: string) => {
          hostPeerId = peerId;
          status = '準備完了 🔥';
        };
      }
    };

    initializeTrystero();
    return () => { if (currentRoom) currentRoom.leave(); };
  });

  function handleTaps(taps: string[], currentTilt: number) {
    const now = Date.now();
    let notesToKeep = [...notes];
    let hitRegistered = false;
    const newHits: HitFeedback[] = [];

    taps.forEach(tapSide => {
      const targetNoteIndex = notesToKeep.findIndex(n => {
        const age = now - n.createdAt;
        return n.side === tapSide && !n.missed && age >= n.hitStart && age <= n.hitEnd;
      });

      if (targetNoteIndex !== -1) {
        const note = notesToKeep[targetNoteIndex];
        const expectedAngle = note.side === 'LEFT' ? currentTilt + 180 : currentTilt;
        const angleDiff = Math.abs(((note.angle - expectedAngle + 540) % 360) - 180);

        if (angleDiff <= HIT_TOLERANCE_DEG) {
          notesToKeep.splice(targetNoteIndex, 1);
          hitRegistered = true;

          const speedBonus = Math.floor((speedMultiplier - 1) * 500);
          score += 100 + speedBonus;

          const uniqueSuffix = Math.random().toString(36).substring(2, 6);
          const hitId = `${now}-${tapSide}-${uniqueSuffix}`;

          newHits.push({ id: hitId, angle: note.angle });
          setTimeout(() => {
            hits = hits.filter(x => x.id !== hitId);
          }, 300);
        }
      }
    });

    if (hitRegistered) combo += 1;
    else if (taps.length > 0) combo = 0;

    if (newHits.length > 0) hits = [...hits, ...newHits];
    notes = notesToKeep;
  }

  async function requestSensors() {
    if (sensorsStarted) return;

    try {
      if (document.documentElement.requestFullscreen) await document.documentElement.requestFullscreen();
      const screenOrientation = window.screen?.orientation as any;
      if (screenOrientation && typeof screenOrientation.lock === 'function') {
        await screenOrientation.lock('landscape');
      }
    } catch (e) { console.warn('ネイティブ画面方向ロックがスキップされました', e); }

    if (typeof (DeviceOrientationEvent as any)?.requestPermission === 'function') {
      try {
        const permission = await (DeviceOrientationEvent as any).requestPermission();
        if (permission !== 'granted') return alert('プレイするにはモーションセンサーへのアクセス許可が必要です 🛑');
      } catch (e) { console.error(e); }
    }

    sensorsStarted = true;
    if (sendAction && hostPeerId) {
      sendAction.send({ action: 'START' }, { target: hostPeerId });
    }

    window.addEventListener('deviceorientation', (e) => {
      if (!sendAction || !hostPeerId) return;

      const now = Date.now();
      const isNativePortrait = window.innerHeight > window.innerWidth;
      let currentTilt = isNativePortrait ? -(e.beta || 0) : (((window.screen?.orientation as any)?.angle || window.orientation || 0) === 90 ? (e.beta || 0) : -(e.beta || 0));

      const rawTilt = Math.max(-90, Math.min(90, currentTilt));
      const clampedTilt = Math.round(rawTilt * 10) / 10;

      phoneState.tilt = clampedTilt;

      if (now - lastSendTime >= NETWORK_THROTTLE_MS) {
        if (clampedTilt !== lastSentTilt) {
          lastSendTime = now;
          lastSentTilt = clampedTilt;

          sendAction.send({
            left: phoneState.left,
            right: phoneState.right,
            tilt: clampedTilt,
            taps: []
          }, { target: hostPeerId });
        }
      }
    });

    status = 'センサー有効 🟢';
  }

  function handlePointer(side: 'LEFT' | 'RIGHT', action: 'DOWN' | 'UP') {
    if (!sendAction || !hostPeerId) return;

    if (side === 'LEFT') phoneState.left = action === 'DOWN';
    if (side === 'RIGHT') phoneState.right = action === 'DOWN';

    const taps = action === 'DOWN' ? [side] : [];

    sendAction.send({
      left: phoneState.left,
      right: phoneState.right,
      tilt: phoneState.tilt,
      taps: taps
    }, { target: hostPeerId });
  }
</script>

{#if role === 'desktop'}
  <div class="fixed inset-0 bg-[#020617] overflow-hidden flex items-center justify-center font-sans tracking-tight text-white">
    <div class="absolute inset-0 z-0 bg-[linear-gradient(to_right,#1e293b_1px,transparent_1px),linear-gradient(to_bottom,#1e293b_1px,transparent_1px)] bg-[size:4rem_4rem] opacity-20"></div>

    {#if (!isConnected || qrUrl) && !isConnected}
      <div class="absolute inset-0 z-50 flex flex-col items-center justify-center bg-slate-950/80 backdrop-blur-md">
        <p class="text-[#00f3ff] mb-8 font-mono text-2xl uppercase tracking-widest border-b-2 border-[#00f3ff] pb-2">{status}</p>
        <div class="bg-white p-6 rounded-none border-4 border-[#00f3ff] relative">
          <div class="absolute -top-2 -left-2 w-4 h-4 border-t-4 border-l-4 border-white"></div>
          <div class="absolute -bottom-2 -right-2 w-4 h-4 border-b-4 border-r-4 border-white"></div>
          {#if qrDataUrl}
            <img src={qrDataUrl} alt="Join Game QR Code" class="w-[300px] h-[300px]" />
          {/if}
        </div>
      </div>
    {/if}

    {#if isConnected && !isPlaying}
      <div class="absolute inset-0 z-50 flex flex-col items-center justify-center bg-slate-950/80 backdrop-blur-md">
        <p class="text-[#ff00ea] font-mono text-3xl uppercase tracking-widest border-y-2 border-[#ff00ea] py-4 px-8">{status}</p>
      </div>
    {/if}

    <div class="absolute top-8 left-8 text-white z-40 flex flex-col gap-1">
      <p class="text-6xl font-black italic tracking-tighter text-transparent bg-clip-text bg-gradient-to-br from-white to-slate-500 drop-shadow-md">
        {score.toString().padStart(6, '0')}
      </p>
      <div class="flex items-center gap-3">
        <div class="w-12 h-1 bg-slate-700"></div>
        <p class="text-2xl font-mono font-bold uppercase tracking-widest transition-colors duration-100 {combo > 5 ? 'text-[#00f3ff]' : 'text-slate-500'}">
          x{combo} Combo
        </p>
      </div>
    </div>

    <div class="absolute w-[60vw] h-[60vw] rounded-full border-[2px] border-dashed border-white/20 pointer-events-none z-20 flex items-center justify-center">
      <div class="w-full h-full rounded-full border-[1px] border-white/5 scale-[1.05]"></div>
      <div class="absolute w-full h-full rounded-full border-[1px] border-white/5 scale-[0.95]"></div>
    </div>

    {#each hits as hit (hit.id)}
      <div
        class="absolute top-1/2 left-1/2 w-[8vw] h-[8vw] -mt-[4vw] -ml-[4vw] rounded-full z-50 pointer-events-none"
        style="--angle: {hit.angle}deg; border-color: {hit.angle > 90 && hit.angle < 270 ? '#00f3ff' : '#ff00ea'}; animation: hitPingCrisp 0.4s cubic-bezier(0.16, 1, 0.3, 1) forwards;"
      ></div>
    {/each}

    {#each notes.filter(n => n.type === 'DOUBLE' && n.side === 'RIGHT') as note (note.id)}
      <div
        class="absolute top-1/2 left-1/2 w-[100vw] h-[2px] -mt-[1px] -ml-[50vw] bg-transparent border-t-[2px] border-dashed border-white/40 z-10"
        style="--angle: {note.angle}deg; animation: expandLine {note.travelTime}ms linear forwards;"
      ></div>
    {/each}

    {#each notes as note (note.id)}
      <div
        class="absolute top-1/2 left-1/2 w-8 h-8 -mt-4 -ml-4 z-30 flex items-center justify-center"
        style="color: {note.side === 'LEFT' ? '#00f3ff' : '#ff00ea'}; --angle: {note.angle}deg; animation: flyOut {note.travelTime}ms linear forwards; transform-origin: 50% 50%;"
      >
        <div class="w-full h-full border-[3px] border-current bg-[#020617] rotate-45 transition-all"></div>
      </div>
    {/each}

    <div class="absolute w-16 h-16 bg-[#020617] border-[4px] border-slate-800 rounded-full z-10 flex items-center justify-center shadow-2xl pointer-events-none">
      <div class="w-4 h-4 bg-white/20 rounded-full"></div>
    </div>

    <div
      bind:this={steeringContainerRef}
      class="absolute w-full px-[20vw] flex justify-between items-center z-40 pointer-events-none"
    >
      <div class="absolute inset-x-0 h-[1px] bg-white/10 -z-10 mx-[20vw]"></div>

      <div class="relative flex items-center justify-center w-12 h-24 border-r-4 transition-all duration-75 {playerState.left ? 'border-[#00f3ff] bg-[#00f3ff]/10 scale-110 translate-x-4' : 'border-slate-700 bg-slate-900/50'}">
        <div class="absolute left-0 w-full h-[2px] transition-colors {playerState.left ? 'bg-[#00f3ff]' : 'bg-slate-700'}"></div>
      </div>

      <div class="relative flex items-center justify-center w-12 h-24 border-l-4 transition-all duration-75 {playerState.right ? 'border-[#ff00ea] bg-[#ff00ea]/10 scale-110 -translate-x-4' : 'border-slate-700 bg-slate-900/50'}">
        <div class="absolute right-0 w-full h-[2px] transition-colors {playerState.right ? 'bg-[#ff00ea]' : 'bg-slate-700'}"></div>
      </div>
    </div>
  </div>

{:else if role === 'phone'}
  <div class="fixed inset-0 bg-[#020617] overflow-hidden touch-none select-none font-sans uppercase tracking-widest text-white font-bold">
    <div class="absolute top-1/2 left-1/2 w-[100vh] h-[100vw] sm:w-[100vw] sm:h-[100vh] -translate-x-1/2 -translate-y-1/2 portrait:-rotate-90 landscape:rotate-0 flex p-4 gap-4 box-border">

      {#if !status.includes('有効')}
        <div class="absolute inset-0 flex flex-col items-center justify-center z-50 bg-slate-950/95 portrait:rotate-90 landscape:rotate-0 backdrop-blur-sm">
          <p class="text-[#00f3ff] mb-12 font-mono text-xl text-center border-b-2 border-[#00f3ff] pb-2">{status}</p>
          {#if status.includes('準備完了')}
            <button
              onpointerdown={requestSensors}
              class="px-10 py-5 bg-transparent border-2 border-[#00f3ff] text-[#00f3ff] active:bg-[#00f3ff] active:text-[#020617] font-bold rounded-none text-xl transition-colors"
            >
              START ENGINE
            </button>
          {/if}
        </div>
      {/if}

      <!-- Left button -->
      <!-- svelte-ignore a11y_no_static_element_interactions -->
      <div
        onpointerdown={() => handlePointer('LEFT', 'DOWN')}
        onpointerup={() => handlePointer('LEFT', 'UP')}
        onpointercancel={() => handlePointer('LEFT', 'UP')}
        class="relative flex-1 h-full rounded-2xl border-2 overflow-hidden transition-colors duration-75 border-slate-800 bg-slate-900/50 active:border-[#00f3ff] active:bg-[#00f3ff]/20"
      >
        <div class="absolute inset-0 flex items-center justify-center pointer-events-none opacity-20">
          <span class="text-6xl text-[#00f3ff]">&lt;</span>
        </div>
      </div>

      <!-- Right button -->
      <!-- svelte-ignore a11y_no_static_element_interactions -->
      <div
        onpointerdown={() => handlePointer('RIGHT', 'DOWN')}
        onpointerup={() => handlePointer('RIGHT', 'UP')}
        onpointercancel={() => handlePointer('RIGHT', 'UP')}
        class="relative flex-1 h-full rounded-2xl border-2 overflow-hidden transition-colors duration-75 border-slate-800 bg-slate-900/50 active:border-[#ff00ea] active:bg-[#ff00ea]/20"
      >
        <div class="absolute inset-0 flex items-center justify-center pointer-events-none opacity-20">
          <span class="text-6xl text-[#ff00ea]">&gt;</span>
        </div>
      </div>

    </div>
  </div>

{:else}
  <div class="fixed inset-0 bg-[#020617] flex items-center justify-center text-white font-mono tracking-widest uppercase">
    Initializing...
  </div>
{/if}

<style>
  @keyframes flyOut {
    0% { transform: rotate(var(--angle)) translateX(0) scale(0); opacity: 0; }
    5% { opacity: 1; scale: 0.5; }
    80% { opacity: 1; }
    100% { transform: rotate(var(--angle)) translateX(50vw) scale(1.2); opacity: 0; }
  }
  @keyframes expandLine {
    0% { transform: rotate(var(--angle)) scaleX(0); opacity: 0; }
    5% { opacity: 1; }
    80% { opacity: 1; }
    100% { transform: rotate(var(--angle)) scaleX(1); opacity: 0; }
  }
  @keyframes hitPingCrisp {
    0% { transform: rotate(var(--angle)) translateX(30vw) scale(0.6); opacity: 1; border-width: 8px; border-style: solid; }
    100% { transform: rotate(var(--angle)) translateX(30vw) scale(2); opacity: 0; border-width: 1px; border-style: solid; }
  }
</style>
