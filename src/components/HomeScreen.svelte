<script lang="ts">
  interface Props {
    onPlay: () => void;
    onManageSongs: () => void;
    onEdit?: () => void;
    roomId?: string;
    controllerUrl?: string;
    qrDataUrl?: string;
    connectedPeersCount?: number;
    lastReceivedKey?: string | null;
  }

  const {
    onPlay,
    onManageSongs,
    onEdit,
    roomId = '',
    controllerUrl = '',
    qrDataUrl = '',
    connectedPeersCount = 0,
    lastReceivedKey = null,
  }: Props = $props();

  const handleManage = () => {
    if (onManageSongs) onManageSongs();
    else if (onEdit) onEdit();
  };

  let copied = $state(false);

  async function copyLink() {
    if (!controllerUrl) return;
    try {
      await navigator.clipboard.writeText(controllerUrl);
      copied = true;
      setTimeout(() => {
        copied = false;
      }, 2000);
    } catch {
      // Fallback
    }
  }
</script>

<div class="w-full h-full paper-bg flex items-center justify-center p-4 select-none relative overflow-y-auto">
  <!-- Subtle decorative paper cuts / washi tape accents in background -->
  <div class="absolute -top-6 -left-6 w-32 h-14 bg-[#fce1db]/60 border border-[#292524]/20 rotate-[-12deg] pointer-events-none"></div>
  <div class="absolute -bottom-8 -right-8 w-40 h-16 bg-[#d8ecd7]/60 border border-[#292524]/20 rotate-[8deg] pointer-events-none"></div>
  <div class="absolute top-12 right-12 w-20 h-8 bg-[#fff3cd]/50 border border-[#292524]/20 rotate-[22deg] pointer-events-none hidden sm:block"></div>

  <!-- Cards Container -->
  <div class="flex flex-col lg:flex-row gap-6 items-stretch justify-center max-w-4xl w-full my-auto z-10">
    <!-- Left Card: Main Menu -->
    <div class="paper-card jagged-border bg-[#fffdfa] flex-1 max-w-md mx-auto lg:mx-0 p-6 sm:p-8 flex flex-col items-center justify-between">
      <div class="w-full flex flex-col items-center">
        <!-- Top Paper Stamp Header -->
        <div class="inline-flex items-center gap-2 px-3 py-1 bg-[#fff3cd] border-[1.5px] border-[#292524] text-[11px] font-mono tracking-widest uppercase mb-6 shadow-[2px_2px_0px_#292524]">
          <span class="w-2 h-2 bg-[#292524]"></span>
          <span>実験的サウンドエンジン</span>
          <span class="w-2 h-2 bg-[#292524]"></span>
        </div>

        <!-- Title Motif -->
        <div class="text-center mb-6 relative">
          <h1 class="text-3xl sm:text-4xl font-extrabold font-mono tracking-wider text-[#292524] relative inline-block">
            PIECE MUSIC
            <span class="block text-xs font-normal tracking-[0.25em] text-[#292524]/70 mt-1 uppercase">
              リズムゲームシステム
            </span>
          </h1>
          <div class="w-16 h-[1.5px] bg-[#292524] mx-auto mt-3"></div>
        </div>

        <!-- Decorative rotating square graphic -->
        <div class="relative w-14 h-14 mb-6 flex items-center justify-center">
          <div class="absolute w-10 h-10 border-[1.5px] border-[#292524] bg-[#dbe9f4] rotate-12 shadow-[2px_2px_0px_#292524]"></div>
          <div class="absolute w-10 h-10 border-[1.5px] border-[#292524] bg-[#fce1db] -rotate-12 shadow-[2px_2px_0px_#292524]"></div>
          <div class="relative w-7 h-7 border-[1.5px] border-[#292524] bg-[#d8ecd7] flex items-center justify-center text-xs font-mono font-bold">
            ♪
          </div>
        </div>

        <!-- Main Buttons: PLAY & MANAGE SONGS -->
        <div class="w-full flex flex-col gap-3">
          <!-- Play Button -->
          <button
            onclick={onPlay}
            class="paper-btn w-full py-3.5 px-5 bg-[#d8ecd7] hover:bg-[#c5dac1] text-[#292524] flex items-center justify-between group cursor-pointer"
          >
            <div class="flex items-center gap-3">
              <span class="w-3 h-3 bg-[#292524] inline-block"></span>
              <span class="text-lg font-bold font-mono tracking-widest">プレイ</span>
            </div>
            <span class="text-xs font-mono tracking-wider text-[#292524]/70 group-hover:translate-x-1 transition-transform">
              曲を選択 →
            </span>
          </button>

          <!-- Manage Songs Button -->
          <button
            onclick={handleManage}
            class="paper-btn w-full py-3.5 px-5 bg-[#dbe9f4] hover:bg-[#c7d8e6] text-[#292524] flex items-center justify-between group cursor-pointer"
          >
            <div class="flex items-center gap-3">
              <span class="w-3 h-3 border-[1.5px] border-[#292524] bg-white inline-block"></span>
              <span class="text-lg font-bold font-mono tracking-widest">曲を管理</span>
            </div>
            <span class="text-xs font-mono tracking-wider text-[#292524]/70 group-hover:translate-x-1 transition-transform">
              曲・譜面エディタ →
            </span>
          </button>
        </div>
      </div>

      <!-- Left Card Footer -->
      <div class="mt-6 pt-4 border-t border-[#292524]/15 w-full flex items-center justify-between text-[10px] text-[#292524]/60 font-mono">
        <span>マスター音声 / スレーブ映像</span>
        <span>SYS 2026</span>
      </div>
    </div>

    <!-- Right Card: WebRTC Phone Controller Pairing & QR Code -->
    <div class="paper-card jagged-border bg-[#fffdfa] flex-1 max-w-md mx-auto lg:mx-0 p-6 sm:p-8 flex flex-col items-center justify-between">
      <div class="w-full flex flex-col items-center">
        <!-- Top Status Stamp -->
        <div class="flex items-center justify-between w-full mb-4">
          <span class="px-2 py-0.5 bg-[#fce1db] border border-[#292524] text-[10px] font-mono font-bold uppercase tracking-widest">
            スマホ同期
          </span>

          {#if connectedPeersCount > 0}
            <span class="inline-flex items-center gap-1.5 px-2 py-0.5 bg-[#d8ecd7] border border-[#292524] text-[10px] font-mono text-emerald-900 font-bold">
              <span class="w-2 h-2 bg-emerald-600 inline-block animate-pulse"></span>
              <span>{connectedPeersCount} 台接続中</span>
            </span>
          {:else}
            <span class="inline-flex items-center gap-1.5 px-2 py-0.5 bg-[#fff3cd] border border-[#292524] text-[10px] font-mono text-amber-900 font-bold">
              <span class="w-2 h-2 bg-amber-500 inline-block"></span>
              <span>スキャン待機中</span>
            </span>
          {/if}
        </div>

        <h2 class="text-lg sm:text-xl font-bold font-mono tracking-wider text-[#292524] mb-1 text-center">
          コントローラー接続
        </h2>
        <p class="text-[11px] text-[#292524]/70 font-mono text-center mb-4 max-w-xs leading-tight">
          スマホでスキャンすると、ワイヤレスの横画面リズムコントローラーとして使えます。
        </p>

        <!-- QR Code Display Box -->
        <div class="p-3 bg-white border-[1.5px] border-[#292524] shadow-[3px_3px_0px_#292524] mb-4 flex items-center justify-center">
          {#if qrDataUrl}
            <img
              src={qrDataUrl}
              alt="コントローラー接続用のQRコード"
              class="w-40 h-40 sm:w-44 sm:h-44 object-contain block image-rendering-pixelated"
            />
          {:else}
            <div class="w-40 h-40 sm:w-44 sm:h-44 flex items-center justify-center text-xs font-mono text-[#292524]/60">
              QRコード生成中...
            </div>
          {/if}
        </div>

        <!-- Room Code & Link Info -->
        <div class="w-full flex flex-col gap-2">
          <div class="flex items-center justify-between px-3 py-1.5 bg-[#faf7f0] border border-[#292524] text-xs font-mono">
            <span class="text-[#292524]/70">ルームコード:</span>
            <span class="font-bold tracking-widest text-[#292524]">{roomId || '...'}</span>
          </div>

          <!-- Direct URL / Copy button -->
          <div class="flex items-center gap-2">
            <input
              type="text"
              readonly
              value={controllerUrl}
              class="flex-1 px-2.5 py-1.5 bg-white border border-[#292524] text-[10px] font-mono text-[#292524]/80 select-all truncate"
            />
            <button
              onclick={copyLink}
              class="paper-btn px-2.5 py-1.5 bg-[#fff3cd] hover:bg-[#fae8b4] text-[#292524] text-[10px] font-mono font-bold shrink-0 cursor-pointer"
            >
              {copied ? 'コピー済み！' : 'コピー'}
            </button>
          </div>

          <!-- Live Input Test Indicator -->
          {#if lastReceivedKey}
            <div class="mt-1 px-2 py-1 bg-[#d8ecd7] border border-[#292524] text-[11px] font-mono text-[#292524] flex items-center justify-between">
              <span>コントローラー入力:</span>
              <span class="font-black font-mono">{lastReceivedKey}</span>
            </div>
          {/if}
        </div>
      </div>

      <!-- Right Card Footer -->
      <div class="mt-6 pt-4 border-t border-[#292524]/15 w-full flex items-center justify-between text-[10px] text-[#292524]/60 font-mono">
        <span>WebRTC MQTT ビーコン</span>
        <span>インストール不要</span>
      </div>
    </div>
  </div>
</div>
