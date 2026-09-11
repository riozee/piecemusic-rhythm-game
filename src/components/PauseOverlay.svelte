<script lang="ts">
  interface Props {
    levelName: string;
    currentTimeSec: number;
    durationSec: number;
    onResume: () => void;
    onRestart: () => void;
    onExit: () => void;
  }

  const {
    levelName,
    currentTimeSec,
    durationSec,
    onResume,
    onRestart,
    onExit,
  }: Props = $props();

  function formatTime(seconds: number): string {
    if (!seconds || isNaN(seconds) || seconds < 0) return '00:00';
    const mins = Math.floor(seconds / 60);
    const secs = Math.floor(seconds % 60);
    return `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
  }

  const progressPercent = $derived(
    durationSec > 0 ? Math.min(100, Math.max(0, (currentTimeSec / durationSec) * 100)) : 0
  );
</script>

<div
  class="absolute inset-0 z-50 bg-[#292524]/40 backdrop-blur-[2px] flex items-center justify-center p-4 select-none"
  role="dialog"
  aria-modal="true"
>
  <!-- Sharp Paper Modal Card -->
  <div class="paper-card jagged-border bg-[#fffdfa] w-full max-w-sm p-6 sm:p-8 flex flex-col items-center relative">
    <!-- Header Stamp -->
    <div class="inline-flex items-center gap-2 px-3 py-1 bg-[#fce1db] border-[1.5px] border-[#292524] text-[11px] font-mono tracking-widest uppercase mb-4 shadow-[2px_2px_0px_#292524]">
      <span class="w-2 h-2 bg-[#292524]"></span>
      <span>一時停止中</span>
      <span class="w-2 h-2 bg-[#292524]"></span>
    </div>

    <!-- Title & Level Name -->
    <h2 class="text-2xl font-black font-mono tracking-wider text-[#292524] mb-1">
      {levelName}
    </h2>
    <p class="text-xs text-[#292524]/60 font-mono tracking-widest uppercase mb-6">
      再生を停止中
    </p>

    <!-- Track Progress bar & Timestamp -->
    <div class="w-full mb-6 p-3 bg-[#faf7f0] border-[1.5px] border-[#292524]/30">
      <div class="flex justify-between text-xs font-mono text-[#292524] mb-1.5 font-semibold">
        <span>時間</span>
        <span>{formatTime(currentTimeSec)} / {formatTime(durationSec)}</span>
      </div>
      <div class="w-full h-2 bg-neutral-200 border border-[#292524]/40 overflow-hidden">
        <div
          class="h-full bg-[#81c784] transition-all duration-75"
          style="width: {progressPercent}%"
        ></div>
      </div>
    </div>

    <!-- Action Buttons -->
    <div class="w-full flex flex-col gap-3">
      <!-- Resume -->
      <button
        onclick={onResume}
        class="paper-btn w-full py-3 px-4 bg-[#d8ecd7] hover:bg-[#c5dac1] text-[#292524] font-mono font-bold tracking-widest text-sm flex items-center justify-between group"
      >
        <div class="flex items-center gap-2">
          <span class="w-2.5 h-2.5 bg-[#292524]"></span>
          <span>再開</span>
        </div>
        <span class="text-[10px] text-[#292524]/60 font-mono">ESC</span>
      </button>

      <!-- Restart -->
      <button
        onclick={onRestart}
        class="paper-btn w-full py-3 px-4 bg-[#dbe9f4] hover:bg-[#c7d8e6] text-[#292524] font-mono font-bold tracking-widest text-sm flex items-center justify-between group"
      >
        <div class="flex items-center gap-2">
          <span class="w-2.5 h-2.5 border border-[#292524] bg-white"></span>
          <span>最初から</span>
        </div>
        <span class="text-[10px] text-[#292524]/60 font-mono">00:00 から</span>
      </button>

      <!-- Exit to Menu -->
      <button
        onclick={onExit}
        class="paper-btn w-full py-3 px-4 bg-[#fff3cd] hover:bg-[#fae8b4] text-[#292524] font-mono font-bold tracking-widest text-sm flex items-center justify-between group"
      >
        <div class="flex items-center gap-2">
          <span class="w-2.5 h-2.5 bg-[#292524]/40"></span>
          <span>メニューへ戻る</span>
        </div>
        <span class="text-[10px] text-[#292524]/60 font-mono">レベル選択へ →</span>
      </button>
    </div>

    <!-- Footer Note -->
    <div class="mt-6 pt-3 border-t border-[#292524]/15 w-full text-center text-[10px] text-[#292524]/60 font-mono">
      [ESC] で再開
    </div>
  </div>
</div>
