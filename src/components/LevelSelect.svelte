<script lang="ts">
  import type { SongData, SongLevel } from '../types/song';

  interface Props {
    song: SongData;
    levels: SongLevel[];
    selectedLevel?: SongLevel | null;
    isLoadingMedia?: boolean;
    isMediaReady?: boolean;
    onSelectLevel: (level: SongLevel) => void;
    onBack: () => void;
    focusedIndex?: number;
  }

  const {
    song,
    levels,
    selectedLevel = null,
    isLoadingMedia = false,
    isMediaReady = true,
    onSelectLevel,
    onBack,
    focusedIndex = -1,
  }: Props = $props();

  function getDifficultyColor(diff: number): { bg: string; text: string; border: string } {
    if (diff < 4.0) {
      return { bg: 'bg-[#d8ecd7]', text: 'text-[#047857]', border: 'border-[#047857]' };
    }
    if (diff < 7.0) {
      return { bg: 'bg-[#fff3cd]', text: 'text-[#b45309]', border: 'border-[#b45309]' };
    }
    if (diff < 9.0) {
      return { bg: 'bg-[#fce1db]', text: 'text-[#be123c]', border: 'border-[#be123c]' };
    }
    return { bg: 'bg-[#ede9fe]', text: 'text-[#6d28d9]', border: 'border-[#6d28d9]' };
  }
</script>

<div class="w-full h-full paper-bg flex items-center justify-center p-4 select-none relative overflow-y-auto">
  <!-- Subtle decorative paper cuts -->
  <div class="absolute -top-6 -right-6 w-32 h-14 bg-[#dbe9f4]/60 border border-[#292524]/20 rotate-[12deg] pointer-events-none"></div>
  <div class="absolute -bottom-8 -left-8 w-40 h-16 bg-[#fff3cd]/60 border border-[#292524]/20 rotate-[-8deg] pointer-events-none"></div>

  <!-- Level Selection Card -->
  <div class="paper-card jagged-border bg-[#fffdfa] w-full max-w-xl p-6 sm:p-8 relative flex flex-col my-auto z-10">
    <!-- Header with Back button and Title -->
    <div class="flex items-center justify-between pb-4 border-b border-[#292524]/15 mb-6">
      <button
        onclick={onBack}
        class="paper-btn px-3 py-1.5 bg-white text-[#292524] text-xs font-mono font-bold tracking-wider flex items-center gap-1.5 cursor-pointer shadow-[2px_2px_0px_#292524]"
      >
        <span>←</span>
        <span>曲一覧</span>
      </button>

      <div class="text-right font-mono">
        <span class="inline-block px-2 py-0.5 bg-[#faf7f0] border border-[#292524] text-[10px] font-bold uppercase tracking-widest text-[#292524]/70 mb-1">
          {song.name}
        </span>
        <h2 class="text-xl font-black tracking-wider text-[#292524]">レベルを選択</h2>
        <span class="text-[10px] text-[#292524]/60 uppercase tracking-widest">
          {levels.length} 難易度
        </span>
      </div>
    </div>

    <!-- Levels List -->
    <div class="flex flex-col gap-3.5 max-h-[50vh] overflow-y-auto pr-1">
      {#each levels as level, idx (level.id ? level.id + '_' + idx : idx)}
        {@const isCurrent = selectedLevel?.id === level.id}
        {@const isFocused = idx === focusedIndex}
        {@const diffStyle = getDifficultyColor(level.difficulty)}
        {@const noteCount = level.trackData?.notes?.length || 0}
        <div
          class="paper-card p-4 sm:p-5 relative transition-all border-[1.5px] shadow-[3px_3px_0px_#292524] hover:translate-x-0.5 hover:-translate-y-0.5 {isFocused ? 'bg-[#eff6ff] border-[#3b82f6] ring-2 ring-[#3b82f6]' : isCurrent ? 'bg-[#eafaf0] border-[#10b981] ring-2 ring-[#10b981]' : 'bg-white border-[#292524]'}"
        >
          <div class="flex items-center justify-between mb-3">
            <!-- Level Name -->
            <div class="flex items-center gap-2">
              <span class="w-2.5 h-2.5 bg-[#292524] inline-block"></span>
              <h3 class="text-lg sm:text-xl font-black font-mono tracking-wide text-[#292524]">
                {level.name}
              </h3>
            </div>

            <!-- Difficulty Badge (Single decimal digit: 0.0 - 10.0) -->
            <div class="flex items-center gap-1.5 px-2.5 py-1 {diffStyle.bg} {diffStyle.border} border-[1.5px] shadow-[1.5px_1.5px_0px_#292524]">
              <span class="text-[10px] font-mono font-bold tracking-wider text-[#292524]/70 uppercase">難易度</span>
              <span class="text-sm font-mono font-black {diffStyle.text}">
                {level.difficulty.toFixed(1)}
              </span>
            </div>
          </div>

          <!-- Level Chart Stats -->
          <div class="mb-4 text-xs font-mono text-[#292524]/70 flex flex-wrap gap-x-4 gap-y-1">
            <span>📝 {noteCount} ノート</span>
            <span>•</span>
            <span>〰️ {level.trackData?.nodes?.length || 0} ノード</span>
            <span>•</span>
            <span>⚡ {level.trackData?.speedBPs?.length || 0} 速度BP</span>
          </div>

          <!-- Play Action Button -->
          <button
            onclick={() => onSelectLevel(level)}
            disabled={isLoadingMedia && !isMediaReady}
            class="paper-btn w-full py-2.5 px-4 bg-[#d8ecd7] hover:bg-[#c5dac1] text-[#292524] font-mono font-black tracking-widest text-xs sm:text-sm flex items-center justify-center gap-2 cursor-pointer shadow-[2px_2px_0px_#292524] disabled:opacity-50 disabled:pointer-events-none"
          >
            <span>▶ レベルをプレイ</span>
          </button>
        </div>
      {/each}
    </div>

    <!-- Instructions / Footer -->
    <div class="mt-6 pt-4 border-t border-[#292524]/15 flex items-center justify-between text-[11px] text-[#292524]/60 font-mono">
      <span>難易度を選んで開始</span>
      <span>プレイ準備完了</span>
    </div>
  </div>
</div>
