<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import { WebRtcClient, type ControllerCommand, type ControllerState } from '../core/webrtc';
  import { ViewportManager, type ViewportLayout } from '../core/viewport';
  import PaperSvgFilters from './PaperSvgFilters.svelte';

  interface Props {
    initialRoomId?: string;
  }

  const { initialRoomId = '' }: Props = $props();

  // svelte-ignore state_referenced_locally
  let roomId = $state(initialRoomId || '');
  // svelte-ignore state_referenced_locally
  let inputRoomId = $state(initialRoomId || '');
  let isConnected = $state(false);
  let isConnecting = $state(false);
  let statusMessage = $state('初期化中...');
  let client: WebRtcClient | null = null;
  let viewportManager: ViewportManager | null = null;
  // The desktop host is the only peer that sends `state`; we remember its id so
  // we can ignore join/leave events from other phones in the same room.
  let hostPeerId: string | null = null;

  let remoteState = $state<ControllerState>({
    screen: 'home',
    songSelectMode: 'play',
    isPaused: false,
    isGameFinished: false,
  });

  let activeKeys = $state<Record<string, boolean>>({
    D: false,
    K: false,
  });

  let layout = $state<ViewportLayout>({
    isPortrait: false,
    containerWidth: 0,
    containerHeight: 0,
    transform: 'none',
    transformOrigin: '0 0',
    physicalWidth: 0,
    physicalHeight: 0,
  });

  const lanes = [
    { key: 'D', label: '左', bg: '#dbeafe', activeBg: '#bfdbfe' },
    { key: 'K', label: '右', bg: '#d8ecd7', activeBg: '#a8d5a6' },
  ];

  function connectToRoom(targetRoomId: string) {
    if (!targetRoomId) return;
    const cleanId = targetRoomId.trim().toUpperCase();
    roomId = cleanId;

    if (client) {
      client.stop();
    }

    hostPeerId = null;
    isConnecting = true;
    isConnected = false;
    statusMessage = '公開ビーコン経由で接続中...';

    client = new WebRtcClient(cleanId, {
      onPeerJoin: (peerId: string) => {
        // Phones mesh with each other in the same room, so once the host is
        // known, ignore join events from any other peer.
        if (hostPeerId !== null && peerId !== hostPeerId) return;
        isConnected = true;
        isConnecting = false;
        statusMessage = `デスクトップに接続済み (${peerId.slice(0, 5)})`;
      },
      onPeerLeave: (peerId: string) => {
        // Only the desktop host matters; another phone leaving the mesh should
        // not mark this controller as disconnected.
        if (hostPeerId !== null && peerId !== hostPeerId) return;
        hostPeerId = null;
        isConnected = false;
        statusMessage = 'デスクトップ切断';
      },
      onStateMessage: (state, peerId) => {
        // The desktop host is the only peer that sends state; remember it so
        // other phones can be distinguished from the host.
        hostPeerId = peerId;
        isConnected = true;
        isConnecting = false;
        remoteState = state;
      },
    });

    client.start();
  }

  function handleKeyDown(key: string) {
    if (activeKeys[key]) return;
    activeKeys[key] = true;

    if ('vibrate' in navigator) {
      try {
        navigator.vibrate(10);
      } catch {}
    }

    client?.sendKey(key, 'down');
  }

  function handleKeyUp(key: string) {
    if (!activeKeys[key]) return;
    activeKeys[key] = false;
    client?.sendKey(key, 'up');
  }

  function handleTouchStart(e: TouchEvent, key: string) {
    e.preventDefault();
    handleKeyDown(key);
  }

  function handleTouchEnd(e: TouchEvent, key: string) {
    e.preventDefault();
    handleKeyUp(key);
  }

  function handleTouchCancel(e: TouchEvent, key: string) {
    e.preventDefault();
    handleKeyUp(key);
  }

  function toggleFullscreen() {
    viewportManager?.requestFullscreen().catch(() => {});
  }

  function sendCommand(command: ControllerCommand, id = '') {
    client?.sendCommand(command, id);
  }

  let screenLabel = $derived(
    remoteState.screen === 'home'
      ? 'ホーム'
      : remoteState.screen === 'song-select'
        ? remoteState.songSelectMode === 'manage'
          ? '曲を管理'
          : '曲を選択'
        : remoteState.screen === 'level-select'
          ? 'レベル選択'
          : remoteState.screen === 'edit'
            ? '譜面エディタ'
            : remoteState.isGameFinished
              ? 'ステージクリア'
              : remoteState.isPaused
                ? '一時停止中'
                : 'プレイ中'
  );

  let backLabel = $derived(
    remoteState.screen === 'song-select'
      ? 'ホーム'
      : remoteState.screen === 'level-select'
        ? '曲一覧'
        : remoteState.screen === 'edit'
          ? '曲一覧'
          : '戻る'
  );

  onMount(() => {
    viewportManager = new ViewportManager();
    viewportManager.subscribe((newLayout: ViewportLayout) => {
      layout = newLayout;
    });

    if (roomId) {
      connectToRoom(roomId);
    }
  });

  onDestroy(() => {
    client?.stop();
  });
</script>

<svelte:window
  onkeydown={(e: KeyboardEvent) => {
    const k = e.key.toUpperCase();
    if (['D', 'K'].includes(k)) {
      handleKeyDown(k);
    }
  }}
  onkeyup={(e: KeyboardEvent) => {
    const k = e.key.toUpperCase();
    if (['D', 'K'].includes(k)) {
      handleKeyUp(k);
    }
  }}
/>

<PaperSvgFilters />

<!-- Auto-Oriented Controller Viewport (Always Landscape) -->
<main
  class="fixed inset-0 w-full h-full overflow-hidden bg-[#292524] select-none"
  role="presentation"
>
  <div
    class="absolute top-0 left-0 overflow-hidden paper-bg flex flex-col"
    style="
      width: {layout.containerWidth}px;
      height: {layout.containerHeight}px;
      transform: {layout.transform};
      transform-origin: {layout.transformOrigin};
      will-change: transform, width, height;
    "
  >
    <!-- Subtle decorative paper cuts / washi tape accents -->
    <div class="absolute -top-4 -left-4 w-24 h-10 bg-[#dbe9f4]/60 border border-[#292524]/20 rotate-[-10deg] pointer-events-none"></div>
    <div class="absolute -bottom-6 -right-6 w-28 h-12 bg-[#d8ecd7]/60 border border-[#292524]/20 rotate-[8deg] pointer-events-none"></div>
    <div class="absolute top-16 right-10 w-16 h-6 bg-[#fff3cd]/50 border border-[#292524]/20 rotate-18 pointer-events-none hidden sm:block"></div>

    {#if !roomId}
      <!-- Room Entry Form if no room in query string -->
      <div class="w-full h-full flex items-center justify-center p-6">
        <div class="paper-card jagged-border bg-[#fffdfa] w-full max-w-sm p-6 flex flex-col items-center">
          <div class="inline-flex items-center gap-2 px-3 py-1 bg-[#fff3cd] border-[1.5px] border-[#292524] text-[11px] font-mono tracking-widest uppercase mb-4 shadow-[2px_2px_0px_#292524]">
            <span>WebRTC コントローラー</span>
          </div>
          <h2 class="text-xl font-bold font-mono text-[#292524] mb-2">ルームコードを入力</h2>
          <p class="text-xs text-[#292524]/70 font-mono text-center mb-6">
            デスクトップ画面のQRコードをスキャンするか、ルームコードを手入力してください。
          </p>

          <form
            onsubmit={(e) => {
              e.preventDefault();
              connectToRoom(inputRoomId);
            }}
            class="w-full flex flex-col gap-3"
          >
            <input
              type="text"
              bind:value={inputRoomId}
              placeholder="例: PM-7K9A"
              class="w-full px-4 py-3 border-[1.5px] border-[#292524] font-mono text-center text-lg uppercase tracking-widest bg-white focus:outline-none focus:bg-[#faf7f0]"
            />
            <button
              type="submit"
              class="paper-btn w-full py-3 bg-[#d8ecd7] hover:bg-[#c5dac1] text-[#292524] font-mono font-bold tracking-widest text-sm cursor-pointer"
            >
              デスクトップに接続 →
            </button>
          </form>
        </div>
      </div>
    {:else}
      <!-- Controller Top Status Bar -->
      <header class="w-full jagged-border bg-[#fffdfa] border-b-[1.5px] border-[#292524] px-4 py-2 flex items-center justify-between z-20 shrink-0">
        <!-- Room badge -->
        <div class="flex items-center gap-2">
          <span class="px-2 py-0.5 bg-[#dbe9f4] border border-[#292524] text-[10px] font-mono font-bold tracking-wider">
            {roomId}
          </span>
          <!-- Status pill -->
          {#if isConnected}
            <span class="inline-flex items-center gap-1.5 px-2 py-0.5 bg-[#d8ecd7] border border-[#292524] text-[10px] font-mono text-emerald-900 font-bold">
              <span class="w-2 h-2 bg-emerald-600 inline-block"></span>
              <span>デスクトップ接続済み</span>
            </span>
          {:else}
            <span class="inline-flex items-center gap-1.5 px-2 py-0.5 bg-[#fff3cd] border border-[#292524] text-[10px] font-mono text-amber-900 font-bold">
              <span class="w-2 h-2 bg-amber-600 inline-block animate-pulse"></span>
              <span>{statusMessage}</span>
            </span>
          {/if}
        </div>

        <!-- Right action: Fullscreen toggle -->
        <div class="flex items-center gap-2">
          <button
            onclick={toggleFullscreen}
            class="paper-btn px-2.5 py-1 bg-white text-[#292524] text-[10px] font-mono font-bold tracking-wider flex items-center gap-1"
          >
            <span>⛶</span>
            <span>全画面</span>
          </button>
        </div>
      </header>

      <!-- Desktop context indicator -->
      <div class="w-full px-3 sm:px-4 pt-3 shrink-0">
        <div class="jagged-border px-3 py-1.5 bg-[#faf7f0] border border-[#292524] text-[10px] font-mono font-bold text-[#292524] flex items-center justify-between gap-2">
          <span class="text-[#292524]/60">デスクトップ画面</span>
          <span>{screenLabel}</span>
        </div>
      </div>

      <!-- Contextual remote controls -->
      <div class="flex-1 w-full overflow-y-auto p-3 sm:p-4">
        {#if remoteState.screen === 'home'}
          <div class="w-full h-full flex flex-col justify-center gap-3 max-w-sm mx-auto">
            <button
              type="button"
              onclick={() => sendCommand('play')}
              class="paper-btn w-full py-4 bg-[#d8ecd7] hover:bg-[#c5dac1] text-[#292524] font-mono font-bold tracking-widest text-sm cursor-pointer"
            >
              ▶ プレイ
            </button>
            <button
              type="button"
              onclick={() => sendCommand('edit')}
              class="paper-btn w-full py-4 bg-[#dbe9f4] hover:bg-[#c7d8e6] text-[#292524] font-mono font-bold tracking-widest text-sm cursor-pointer"
            >
              ✏️ 曲を管理
            </button>
          </div>
        {:else if remoteState.screen === 'song-select'}
          <div class="w-full h-full flex flex-col justify-center gap-3 max-w-sm mx-auto">
            <div class="grid grid-cols-2 gap-3">
              <button
                type="button"
                onclick={() => sendCommand('up')}
                class="paper-btn py-4 bg-[#dbe9f4] hover:bg-[#c7d8e6] text-[#292524] font-mono font-bold tracking-widest text-sm cursor-pointer"
              >
                ▲ 上
              </button>
              <button
                type="button"
                onclick={() => sendCommand('down')}
                class="paper-btn py-4 bg-[#dbe9f4] hover:bg-[#c7d8e6] text-[#292524] font-mono font-bold tracking-widest text-sm cursor-pointer"
              >
                ▼ 下
              </button>
            </div>
            <button
              type="button"
              onclick={() => sendCommand('ok')}
              class="paper-btn w-full py-4 bg-[#d8ecd7] hover:bg-[#c5dac1] text-[#292524] font-mono font-bold tracking-widest text-sm cursor-pointer"
            >
              OK
            </button>
          </div>
        {:else if remoteState.screen === 'level-select'}
          <div class="w-full h-full flex flex-col justify-center gap-3 max-w-sm mx-auto">
            <div class="grid grid-cols-2 gap-3">
              <button
                type="button"
                onclick={() => sendCommand('up')}
                class="paper-btn py-4 bg-[#dbe9f4] hover:bg-[#c7d8e6] text-[#292524] font-mono font-bold tracking-widest text-sm cursor-pointer"
              >
                ▲ 上
              </button>
              <button
                type="button"
                onclick={() => sendCommand('down')}
                class="paper-btn py-4 bg-[#dbe9f4] hover:bg-[#c7d8e6] text-[#292524] font-mono font-bold tracking-widest text-sm cursor-pointer"
              >
                ▼ 下
              </button>
            </div>
            <button
              type="button"
              onclick={() => sendCommand('ok')}
              class="paper-btn w-full py-4 bg-[#d8ecd7] hover:bg-[#c5dac1] text-[#292524] font-mono font-bold tracking-widest text-sm cursor-pointer"
            >
              OK
            </button>
          </div>
        {:else if remoteState.screen === 'edit'}
          <div class="w-full h-full flex flex-col items-center justify-center gap-3 text-center">
            <span class="text-4xl">✏️</span>
            <p class="font-mono text-xs text-[#292524]/70 uppercase tracking-widest">デスクトップで譜面編集中</p>
          </div>
        {:else}
          {#if !remoteState.isPaused && !remoteState.isGameFinished}
            <div class="w-full h-full flex flex-col gap-3">
              <div class="flex-1 grid grid-cols-2 gap-3">
                {#each lanes as lane}
                  {@const isActive = activeKeys[lane.key]}
                  <button
                    type="button"
                    ontouchstart={(e) => handleTouchStart(e, lane.key)}
                    ontouchend={(e) => handleTouchEnd(e, lane.key)}
                    ontouchcancel={(e) => handleTouchCancel(e, lane.key)}
                    onmousedown={() => handleKeyDown(lane.key)}
                    onmouseup={() => handleKeyUp(lane.key)}
                    onmouseleave={() => handleKeyUp(lane.key)}
                    class="relative flex flex-col items-center justify-center p-4 sm:p-6 transition-all duration-75 select-none cursor-pointer border-[1.5px] border-[#292524]"
                    style="
                      background-color: {isActive ? lane.activeBg : lane.bg};
                      box-shadow: {isActive ? '1px 1px 0px #292524' : '4px 4px 0px #292524'};
                      transform: {isActive ? 'translate(3px, 3px)' : 'translate(0px, 0px)'};
                    "
                  >
                    <span class="text-2xl sm:text-4xl font-black font-mono text-[#292524] tracking-tight">{lane.label}</span>
                    <span class="text-[10px] sm:text-xs font-mono text-[#292524]/60 uppercase tracking-widest mt-2">ヒット</span>
                  </button>
                {/each}
              </div>
              <button
                type="button"
                onclick={() => sendCommand('pause')}
                class="paper-btn w-full py-3 bg-[#fff3cd] hover:bg-[#fce38a] text-[#292524] font-mono font-bold tracking-widest text-sm cursor-pointer"
              >
                ⏸ 一時停止
              </button>
            </div>
          {:else}
            <div class="w-full h-full flex flex-col justify-center gap-3 max-w-sm mx-auto">
              {#if remoteState.isPaused && !remoteState.isGameFinished}
                <button
                  type="button"
                  onclick={() => sendCommand('pause')}
                  class="paper-btn w-full py-3 bg-[#d8ecd7] hover:bg-[#c5dac1] text-[#292524] font-mono font-bold tracking-widest text-sm cursor-pointer"
                >
                  ▶ 再開
                </button>
              {/if}
              <button
                type="button"
                onclick={() => sendCommand('restart')}
                class="paper-btn w-full py-3 bg-[#dbe9f4] hover:bg-[#c7d8e6] text-[#292524] font-mono font-bold tracking-widest text-sm cursor-pointer"
              >
                ↺ 最初から
              </button>
              <button
                type="button"
                onclick={() => sendCommand('quit')}
                class="paper-btn w-full py-3 bg-[#fce1db] hover:bg-[#f8b4a7] text-[#292524] font-mono font-bold tracking-widest text-sm cursor-pointer"
              >
                ✕ 終了
              </button>
            </div>
          {/if}
        {/if}
      </div>

      <!-- Back button (always shown except during gameplay) -->
      {#if remoteState.screen !== 'playing'}
        <div class="w-full px-3 sm:px-4 pb-3 shrink-0">
          <button
            type="button"
            onclick={() => sendCommand('back')}
            disabled={remoteState.screen === 'home'}
            class="paper-btn w-full py-2.5 bg-white text-[#292524] font-mono font-bold tracking-widest text-xs cursor-pointer shadow-[2px_2px_0px_#292524] {remoteState.screen === 'home' ? 'opacity-40' : ''}"
          >
            ← {backLabel}
          </button>
        </div>
      {/if}

      <!-- Footer Info -->
      <footer class="w-full jagged-border bg-[#fffdfa] border-t border-[#292524]/20 px-4 py-1.5 flex items-center justify-between text-[9px] sm:text-[10px] font-mono text-[#292524]/60 shrink-0">
        <span>WebRTC データチャンネル・サーバー保存なし</span>
        <span>{screenLabel}</span>
      </footer>
    {/if}
  </div>
</main>

<style>
  /* Give every control button the same slightly jagged paper-cut edge used by
     the main screens' jagged-border cards, so the controller matches. */
  button {
    filter: url(#jagged-paper);
  }
</style>
