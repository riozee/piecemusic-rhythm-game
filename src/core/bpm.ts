/**
 * Lightweight tempo (BPM) estimation using onset-strength autocorrelation.
 * Decodes the audio in a Web Audio context, computes a half-wave-rectified
 * energy-flux envelope, and autocorrelates it over a musically-plausible
 * lag range. Returns BPM (rounded to 1 decimal) or null on failure.
 */
export async function detectBpm(audioUrl: string): Promise<number | null> {
  try {
    const res = await fetch(audioUrl);
    if (!res.ok) return null;
    const arrayBuffer = await res.arrayBuffer();

    const Ctor =
      window.AudioContext ||
      (window as unknown as { webkitAudioContext: typeof AudioContext })
        .webkitAudioContext;
    const ctx = new Ctor();
    try {
      const audioBuf = await ctx.decodeAudioData(arrayBuffer);
      const data = audioBuf.getChannelData(0);
      const sr = audioBuf.sampleRate;

      // ~200 fps envelope of frame energy.
      const hop = Math.max(256, Math.floor(sr / 200));
      const numFrames = Math.floor(data.length / hop);
      if (numFrames < 256) return null;

      const flux = new Float32Array(numFrames);
      let prevEnergy = 0;
      for (let i = 0; i < numFrames; i++) {
        const start = i * hop;
        let energy = 0;
        for (let j = 0; j < hop; j++) {
          const s = data[start + j];
          energy += s * s;
        }
        energy = Math.sqrt(energy / hop);
        const d = energy - prevEnergy;
        flux[i] = d > 0 ? d : 0;
        prevEnergy = energy;
      }

      // Autocorrelation over 55..200 BPM, with a mild preference for common
      // tempos (~120 BPM) to avoid picking half/double-time harmonics.
      const minBpm = 55;
      const maxBpm = 200;
      const minLag = Math.floor((60 * sr) / (hop * maxBpm));
      const maxLag = Math.floor((60 * sr) / (hop * minBpm));

      let bestLag = minLag;
      let bestScore = -Infinity;
      for (let lag = minLag; lag <= maxLag; lag++) {
        let score = 0;
        for (let i = 0; i < numFrames - lag; i++) {
          score += flux[i] * flux[i + lag];
        }
        const bpm = (60 * sr) / (hop * lag);
        const weight = 1 + Math.exp(-((bpm - 120) ** 2) / 2000);
        score *= weight;
        if (score > bestScore) {
          bestScore = score;
          bestLag = lag;
        }
      }

      const bpm = (60 * sr) / (hop * bestLag);
      return Math.round(bpm * 10) / 10;
    } finally {
      ctx.close();
    }
  } catch (err) {
    console.warn("[BPM] detection failed:", err);
    return null;
  }
}
