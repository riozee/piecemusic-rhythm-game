<script lang="ts">
  import type { SongListItem } from '../types/song';

  interface Props {
    mode: 'play' | 'manage';
    songs: SongListItem[];
    selectedSongId?: string | null;
    isLoading?: boolean;
    loadingProgress?: number;
    onSelectSong: (song: SongListItem) => void;
    onAddSong: () => void;
    onImportArchive: (file: File) => void;
    onDeleteSong?: (songId: string) => void;
    onBackupSong?: (song: SongListItem) => void;
    onBack: () => void;
    focusedIndex?: number;
  }

  const {
    mode = 'play',
    songs,
    selectedSongId = null,
    isLoading = false,
    loadingProgress = 0,
    onSelectSong,
    onAddSong,
    onImportArchive,
    onDeleteSong,
    onBackupSong,
    onBack,
    focusedIndex = -1,
  }: Props = $props();

  let fileInputEl = $state<HTMLInputElement | null>(null);
  let pendingDelete = $state<SongListItem | null>(null);

  function confirmDelete() {
    if (pendingDelete && onDeleteSong) {
      onDeleteSong(pendingDelete.id);
    }
    pendingDelete = null;
  }

  // Server songs cannot be edited and are hidden from Manage Songs screen
  let displayedSongs = $derived(
    mode === 'manage' ? songs.filter((s) => s.source !== 'server') : songs
  );

  function handleFileInput(e: Event) {
    const file = (e.target as HTMLInputElement).files?.[0];
    if (file) {
      onImportArchive(file);
    }
    (e.target as HTMLInputElement).value = '';
  }
</script>

<div class="w-full h-full paper-bg flex items-center justify-center p-4 select-none relative overflow-y-auto">
  <!-- Subtle decorative paper cuts -->
  <div class="absolute -top-6 -right-6 w-32 h-14 bg-[#dbe9f4]/60 border border-[#292524]/20 rotate-[12deg] pointer-events-none"></div>
  <div class="absolute -bottom-8 -left-8 w-40 h-16 bg-[#fff3cd]/60 border border-[#292524]/20 rotate-[-8deg] pointer-events-none"></div>

  <!-- Main Container Card -->
  <div class="paper-card jagged-border bg-[#fffdfa] w-full max-w-2xl p-6 sm:p-8 relative flex flex-col my-auto z-10">
    <!-- Header with Back button and Title -->
    <div class="flex items-center justify-between pb-4 border-b border-[#292524]/15 mb-6">
      <button
        onclick={onBack}
        class="paper-btn px-3 py-1.5 bg-white text-[#292524] text-xs font-mono font-bold tracking-wider flex items-center gap-1.5 cursor-pointer shadow-[2px_2px_0px_#292524]"
      >
        <span>←</span>
        <span>ホーム</span>
      </button>

      <div class="text-right font-mono">
        <div class="inline-block px-2.5 py-0.5 border border-[#292524] text-[10px] font-bold uppercase tracking-widest mb-1 {mode === 'play' ? 'bg-[#d8ecd7] text-emerald-900' : 'bg-[#dbe9f4] text-sky-900'}">
          {mode === 'play' ? 'プレイモード' : '管理モード'}
        </div>
        <h2 class="text-xl font-black tracking-wider text-[#292524]">
          {mode === 'play' ? '曲を選択' : '曲を管理'}
        </h2>
        <span class="text-[10px] text-[#292524]/60 uppercase tracking-widest">
          {displayedSongs.length} 曲 利用可能
        </span>
      </div>
    </div>

    <!-- Loading Bar if active -->
    {#if isLoading}
      <div class="w-full mb-4 p-3 bg-[#fff3cd] border border-[#292524] shadow-[2px_2px_0px_#292524] font-mono text-xs">
        <div class="flex justify-between items-center mb-1 font-bold text-[#292524]">
          <span>曲アーカイブを展開・準備中...</span>
          <span>{loadingProgress}%</span>
        </div>
        <div class="w-full h-2 bg-neutral-200 border border-[#292524] overflow-hidden">
          <div
            class="h-full bg-[#10b981] transition-all duration-150"
            style="width: {loadingProgress}%"
          ></div>
        </div>
      </div>
    {/if}

    <!-- Songs List -->
    <div class="flex flex-col gap-3 max-h-[50vh] overflow-y-auto pr-1">
      {#if displayedSongs.length === 0}
        <div class="p-8 text-center bg-white border-[1.5px] border-dashed border-[#292524]/40 font-mono text-xs text-[#292524]/60">
          {#if mode === 'manage'}
            カスタム曲がありません。下の「＋曲を追加」または「曲アーカイブを読み込み」から作成・読み込みしてください！
          {:else}
            プレイできる曲がありません。
          {/if}
        </div>
      {:else}
        {#each displayedSongs as song, i (song.source + '_' + song.id)}
          {@const isSelected = song.id === selectedSongId}
          {@const isFocused = i === focusedIndex}
          <div
            class="paper-card p-4 relative transition-all border-[1.5px] shadow-[3px_3px_0px_#292524] hover:translate-x-0.5 hover:-translate-y-0.5 {isFocused ? 'bg-[#eff6ff] border-[#3b82f6] ring-2 ring-[#3b82f6]' : isSelected ? 'bg-[#eafaf0] border-[#10b981] ring-2 ring-[#10b981]' : 'bg-white border-[#292524]'}"
          >
            <div class="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3">
              <!-- Left: Song details -->
              <div class="flex-1 min-w-0">
                <div class="flex items-center gap-2 mb-1">
                  {#if song.source === 'server'}
                    <span class="inline-block px-2 py-0.2 bg-[#fff3cd] border border-[#292524] text-[9px] font-mono font-bold uppercase tracking-wider text-amber-900">
                      公式
                    </span>
                  {:else}
                    <span class="inline-block px-2 py-0.2 bg-[#dbe9f4] border border-[#292524] text-[9px] font-mono font-black uppercase tracking-wider text-sky-900">
                      ★ カスタム曲
                    </span>
                  {/if}

                  {#if song.levels && song.levels.length > 0}
                    <span class="text-[10px] font-mono text-[#292524]/60">
                      {song.levels.length} レベル
                    </span>
                  {/if}
                </div>

                <h3 class="text-xl font-black font-mono tracking-wide text-[#292524] truncate">
                  {song.name}
                </h3>

                <!-- Level pills preview -->
                {#if song.levels && song.levels.length > 0}
                  <div class="flex flex-wrap gap-1.5 mt-2">
                    {#each song.levels as lvl}
                      <span class="px-1.5 py-0.5 bg-[#faf7f0] border border-[#292524]/30 text-[10px] font-mono text-[#292524]">
                        <span class="font-bold">{lvl.name}</span>
                        <span class="text-[#d97706] font-bold">[{lvl.difficulty.toFixed(1)}]</span>
                      </span>
                    {/each}
                  </div>
                {/if}
              </div>

              <!-- Right: Actions based on mode -->
              <div class="flex items-center gap-2 shrink-0 self-end sm:self-center">
                {#if mode === 'manage'}
                  {#if onBackupSong}
                    <button
                      onclick={() => onBackupSong(song)}
                      disabled={isLoading}
                      class="paper-btn px-2.5 py-1.5 bg-white hover:bg-[#faf7f0] text-[#292524] text-[11px] font-mono font-bold border border-[#292524] shadow-[1px_1px_0px_#292524] cursor-pointer"
                      title="曲のバックアップアーカイブ (.zip) をダウンロード"
                    >
                      📦 バックアップ
                    </button>
                  {/if}

                  {#if song.source === 'browser' && onDeleteSong}
                    <button
                      onclick={() => (pendingDelete = song)}
                      disabled={isLoading}
                      class="paper-btn px-2.5 py-1.5 bg-[#fce1db] hover:bg-[#f8b4a7] text-[#be123c] text-[11px] font-mono font-bold border border-[#292524] shadow-[1px_1px_0px_#292524] cursor-pointer"
                      title="ブラウザ保存から削除"
                    >
                      🗑️
                    </button>
                  {/if}

                  <button
                    onclick={() => onSelectSong(song)}
                    disabled={isLoading}
                    class="paper-btn px-4 py-2 bg-[#dbe9f4] hover:bg-[#c7d8e6] text-[#292524] text-xs font-mono font-black tracking-wider cursor-pointer shadow-[2px_2px_0px_#292524]"
                  >
                    ✏️ 曲を編集 →
                  </button>
                {:else}
                  <!-- Play Mode -->
                  <button
                    onclick={() => onSelectSong(song)}
                    disabled={isLoading}
                    class="paper-btn px-5 py-2.5 bg-[#d8ecd7] hover:bg-[#c5dac1] text-[#292524] text-xs font-mono font-black tracking-wider cursor-pointer shadow-[2px_2px_0px_#292524] flex items-center gap-1.5"
                  >
                    <span>曲を選択</span>
                    <span>→</span>
                  </button>
                {/if}
              </div>
            </div>
          </div>
        {/each}
      {/if}
    </div>

    <!-- Bottom Actions Bar: Add Song & Import Archive (Only in Manage Songs mode) -->
    {#if mode === 'manage'}
      <div class="mt-6 pt-4 border-t border-[#292524]/15 flex flex-col sm:flex-row items-stretch sm:items-center justify-between gap-3">
        <!-- Hidden file input for importing song archives -->
        <input
          bind:this={fileInputEl}
          type="file"
          accept=".zip,.pm"
          onchange={handleFileInput}
          class="hidden"
        />

        <button
          onclick={() => fileInputEl?.click()}
          disabled={isLoading}
          class="paper-btn px-3.5 py-2.5 bg-white hover:bg-[#faf7f0] text-[#292524] text-xs font-mono font-bold tracking-wider flex items-center justify-center gap-2 cursor-pointer shadow-[2px_2px_0px_#292524]"
          title="曲アーカイブ (.zip) を読み込み"
        >
          <span>📂</span>
          <span>曲アーカイブを読み込み (.ZIP)</span>
        </button>

        <!-- Add Song Button -->
        <button
          onclick={onAddSong}
          disabled={isLoading}
          class="paper-btn px-6 py-2.5 bg-[#fff3cd] hover:bg-[#fae8b4] text-[#292524] text-xs font-mono font-black tracking-wider flex items-center justify-center gap-2 cursor-pointer shadow-[3px_3px_0px_#292524]"
        >
          <span>➕</span>
          <span>曲を追加</span>
        </button>
      </div>
    {/if}
  </div>

  <!-- Delete Confirmation Dialog -->
  {#if pendingDelete}
    <div class="fixed inset-0 z-50 bg-black/60 flex items-center justify-center p-4">
      <div class="paper-card jagged-border bg-[#fffdfa] w-full max-w-sm p-6 border-2 border-[#292524] shadow-[6px_6px_0px_#292524] flex flex-col gap-4">
        <div class="text-center font-mono">
          <div class="text-3xl mb-2">🗑️</div>
          <h3 class="text-base font-black text-[#292524]">曲を削除しますか？</h3>
          <p class="text-xs text-[#292524]/70 mt-2 break-words">
            「{pendingDelete.name}」をブラウザ保存から削除します。この操作は元に戻せません。
          </p>
        </div>
        <div class="flex justify-center gap-2 pt-2 border-t border-[#292524]/20">
          <button
            onclick={() => (pendingDelete = null)}
            class="paper-btn px-4 py-2 bg-white text-[#292524] text-xs font-mono font-bold cursor-pointer"
          >
            キャンセル
          </button>
          <button
            onclick={confirmDelete}
            class="paper-btn px-4 py-2 bg-[#fce1db] text-[#be123c] text-xs font-mono font-black cursor-pointer shadow-[2px_2px_0px_#292524]"
          >
            削除する
          </button>
        </div>
      </div>
    </div>
  {/if}
</div>
