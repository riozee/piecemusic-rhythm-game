<script lang="ts">
  import { onMount } from 'svelte';

  interface Props {
    levelName: string;
    score: number;
    maxCombo: number;
    hitNotes: number;
    totalNotes: number;
    onPlayAgain: () => void;
    onLevelSelect: () => void;
  }

  const {
    levelName,
    score,
    maxCombo,
    hitNotes,
    totalNotes,
    onPlayAgain,
    onLevelSelect,
  }: Props = $props();

  const accuracy = $derived(
    totalNotes > 0 ? Math.round((hitNotes / totalNotes) * 100) : 100
  );

  const grade = $derived.by(() => {
    if (accuracy >= 100) return { rank: 'S', label: 'パーフェクト', bg: '#fff3cd', border: '#d97706' };
    if (accuracy >= 80) return { rank: 'A', label: 'グレート', bg: '#d8ecd7', border: '#059669' };
    if (accuracy >= 60) return { rank: 'B', label: 'グッド', bg: '#dbe9f4', border: '#2563eb' };
    return { rank: 'C', label: 'クリア', bg: '#fce1db', border: '#e11d48' };
  });

  // --- Auto-restart after 15 seconds of inactivity ---
  const AUTO_RESTART_MS = 15_000;
  let autoRestartRemaining = $state(AUTO_RESTART_MS);
  let autoRestartRafId: number | null = null;
  let autoRestartDeadline = $state(0);

  function resetAutoRestart() {
    autoRestartDeadline = performance.now() + AUTO_RESTART_MS;
    autoRestartRemaining = AUTO_RESTART_MS;
  }

  function tickAutoRestart() {
    const now = performance.now();
    const left = autoRestartDeadline - now;
    autoRestartRemaining = Math.max(0, left);
    if (left <= 0) {
      onPlayAgain();
      return;
    }
    autoRestartRafId = requestAnimationFrame(tickAutoRestart);
  }

  function cleanupAutoRestart() {
    if (autoRestartRafId != null) { cancelAnimationFrame(autoRestartRafId); autoRestartRafId = null; }
  }

  function handleActivity() {
    resetAutoRestart();
  }

  onMount(() => {
    resetAutoRestart();
    autoRestartRafId = requestAnimationFrame(tickAutoRestart);

    const events = ['mousemove', 'mousedown', 'keydown', 'touchstart', 'pointerdown'] as const;
    for (const evt of events) window.addEventListener(evt, handleActivity, { passive: true });

    return () => {
      cleanupAutoRestart();
      for (const evt of events) window.removeEventListener(evt, handleActivity);
    };
  });

  const autoRestartSec = $derived(Math.ceil(autoRestartRemaining / 1000));
  const autoRestartProgress = $derived(autoRestartRemaining / AUTO_RESTART_MS * 100);
</script>

<div
  class="absolute inset-0 z-50 bg-[#292524]/60 backdrop-blur-[2px] flex items-center justify-center p-4 select-none"
  role="dialog"
  aria-modal="true"
>
  <!-- Sharp Paper Results Card -->
  <div class="paper-card jagged-border bg-[#fffdfa] w-full max-w-md p-6 sm:p-8 flex flex-col items-center relative shadow-[6px_6px_0px_#292524]">
    <!-- Top Stamp -->
    <div class="inline-flex items-center gap-2 px-3.5 py-1 bg-[#d8ecd7] border-[1.5px] border-[#292524] text-[11px] font-mono font-bold tracking-widest uppercase mb-4 shadow-[2px_2px_0px_#292524]">
      <span class="w-2 h-2 bg-[#292524]"></span>
      <span>ステージクリア</span>
      <span class="w-2 h-2 bg-[#292524]"></span>
    </div>

    <!-- Track Title -->
    <h2 class="text-2xl sm:text-3xl font-black font-mono tracking-wide text-[#292524] mb-1 text-center">
      {levelName}
    </h2>
    <p class="text-[11px] text-[#292524]/60 font-mono tracking-widest uppercase mb-6">
      トラック完了
    </p>

    <!-- Score & Rank Grid -->
    <div class="w-full grid grid-cols-2 gap-3 mb-6">
      <!-- Left: Score & Combo -->
      <div class="flex flex-col gap-2">
        <div class="p-3 bg-[#faf7f0] border-[1.5px] border-[#292524]/40 flex flex-col">
          <span class="text-[10px] font-mono text-[#292524]/60 uppercase tracking-wider">最終スコア</span>
          <span class="text-2xl font-black font-mono text-[#292524] tracking-tight">{score}</span>
        </div>

        <div class="p-3 bg-[#faf7f0] border-[1.5px] border-[#292524]/40 flex flex-col">
          <span class="text-[10px] font-mono text-[#292524]/60 uppercase tracking-wider">最大コンボ</span>
          <span class="text-xl font-black font-mono text-[#d97706] tracking-tight">{maxCombo}</span>
        </div>
      </div>

      <!-- Right: Grade Rank Stamp -->
      <div
        class="p-4 border-[1.5px] border-[#292524] flex flex-col items-center justify-center relative shadow-[2px_2px_0px_#292524]"
        style="background-color: {grade.bg};"
      >
        <span class="text-[10px] font-mono font-bold text-[#292524]/70 uppercase tracking-widest mb-1">
          評価
        </span>
        <span class="text-5xl font-black font-mono text-[#292524] leading-none mb-1">
          {grade.rank}
        </span>
        <span class="text-[10px] font-mono font-bold tracking-wider text-[#292524]">
          {grade.label}
        </span>
      </div>
    </div>

    <!-- Accuracy Details -->
    <div class="w-full mb-6 p-3 bg-[#faf7f0] border-[1.5px] border-[#292524]/30 flex items-center justify-between text-xs font-mono">
      <span class="text-[#292524]/70 font-semibold">ノート精度:</span>
      <span class="font-bold text-[#292524]">{hitNotes} / {totalNotes} ({accuracy}%)</span>
    </div>

    <!-- Action Buttons -->
    <div class="w-full flex flex-col gap-2.5">
      <button
        onclick={onPlayAgain}
        class="paper-btn w-full py-3 px-4 bg-[#d8ecd7] hover:bg-[#c5dac1] text-[#292524] font-mono font-bold tracking-widest text-sm flex items-center justify-between group"
      >
        <div class="flex items-center gap-2">
          <span class="w-2.5 h-2.5 bg-[#292524]"></span>
          <span>もう一度</span>
        </div>
        <span class="text-[11px] text-[#292524]/60 font-mono">リスタート →</span>
      </button>

      <button
        onclick={onLevelSelect}
        class="paper-btn w-full py-3 px-4 bg-[#dbe9f4] hover:bg-[#c7d8e6] text-[#292524] font-mono font-bold tracking-widest text-sm flex items-center justify-between group"
      >
        <div class="flex items-center gap-2">
          <span class="w-2.5 h-2.5 border border-[#292524] bg-white"></span>
          <span>レベル選択</span>
        </div>
        <span class="text-[11px] text-[#292524]/60 font-mono">トラック一覧 →</span>
      </button>
    </div>

    <!-- Auto-Restart Countdown -->
    <div class="mt-4 w-full">
      <div class="flex justify-between text-[10px] font-mono text-[#292524]/60 mb-1">
        <span>自動リスタート</span>
        <span>{autoRestartSec}秒</span>
      </div>
      <div class="w-full h-1.5 bg-neutral-200 border border-[#292524]/20 overflow-hidden">
        <div
          class="h-full bg-[#81c784] transition-[width] duration-100"
          style="width: {autoRestartProgress}%"
        ></div>
      </div>
    </div>
  </div>
</div>
