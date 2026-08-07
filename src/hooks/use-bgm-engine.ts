"use client";

import { useEffect, useRef } from "react";
import { usePlayerStore } from "@/lib/player-store";
import { useBgmCuesStore } from "@/lib/bgm-cues-store";
import { getBgmAssetUrl } from "@/lib/abm-api";
import { getAudioElement } from "@/lib/audio-element-registry";
import type { BgmCue } from "@/lib/abm-api";

/**
 * useBgmEngine — runtime BGM mixer using Web Audio API.
 *
 * Architecture:
 *   - Each mood <audio> element → MediaElementSourceNode → GainNode → destination
 *   - Narration <audio> → AnalyserNode (tap only, doesn't alter playback)
 *   - Soft ducking: sample narration RMS every ~50ms; when speaking,
 *     BGM gain target = base × 0.45 (duck), with 120ms attack / 700ms release
 *     via gain.setTargetAtTime (smooth, not per-frame writes).
 *   - 1.5s crossfades via gain.linearRampToValueAtTime.
 *
 * Fail-soft: if AudioContext is unavailable or createMediaElementSource
 * throws, falls back to the simple audio.volume path.
 */

const CROSSFADE_SEC = 1.5;
const SEEK_THRESHOLD_SEC = 1.5;
const DUCK_FACTOR = 0.45;
const DUCK_ATTACK_SEC = 0.12;
const DUCK_RELEASE_SEC = 0.70;
const SPEAKING_RMS_THRESHOLD = 0.02;
const SPEAKING_HANGOVER_MS = 200;
const ANALYSER_INTERVAL_MS = 50;

function dbToLinear(db: number): number {
  return Math.pow(10, db / 20);
}

function findActiveCueIndex(cues: BgmCue[], t: number): number {
  let lo = 0, hi = cues.length - 1, result = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (cues[mid].start <= t) {
      if (t < cues[mid].end) result = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return result;
}

interface MoodChannel {
  audio: HTMLAudioElement;
  gainNode: GainNode;
  sourceNode: MediaElementAudioSourceNode;
  playing: boolean;
}

export function useBgmEngine() {
  const currentJob = usePlayerStore((s) => s.currentJob);
  const currentChapterIdx = usePlayerStore((s) => s.currentChapterIdx);
  const isPlaying = usePlayerStore((s) => s.isPlaying);
  const bgmEnabled = usePlayerStore((s) => s.bgmEnabled);
  const bgmVolume = usePlayerStore((s) => s.bgmVolume);

  const fetchCues = useBgmCuesStore((s) => s.fetchCues);

  // Refs
  const cuesRef = useRef<BgmCue[]>([]);
  const ctxRef = useRef<AudioContext | null>(null);
  const channelsRef = useRef<Map<string, MoodChannel>>(new Map());
  const narrationAnalyserRef = useRef<AnalyserNode | null>(null);
  const narrationSourceRef = useRef<MediaElementAudioSourceNode | null>(null);
  const activeMoodRef = useRef<string | null>(null);
  const bgmEnabledRef = useRef(bgmEnabled);
  const bgmVolumeRef = useRef(bgmVolume);
  const lastTimeRef = useRef(0);
  const isSpeakingRef = useRef(false);
  const lastSpeakingTimeRef = useRef(0);
  const webAudioFailedRef = useRef(false);

  useEffect(() => { bgmEnabledRef.current = bgmEnabled; }, [bgmEnabled]);
  useEffect(() => { bgmVolumeRef.current = bgmVolume; }, [bgmVolume]);

  // ── Initialize AudioContext + narration analyser (lazy, on first play) ──
  function initAudioContext(): boolean {
    if (ctxRef.current) return true;
    if (webAudioFailedRef.current) return false;
    try {
      const Ctx = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      const ctx = new Ctx();
      ctxRef.current = ctx;

      // Tap the narration element for RMS analysis (does NOT alter its audio path)
      const narration = getAudioElement();
      if (narration) {
        try {
          const src = ctx.createMediaElementSource(narration);
          const analyser = ctx.createAnalyser();
          analyser.fftSize = 512;
          analyser.smoothingTimeConstant = 0.6;
          src.connect(analyser);
          // Also connect analyser to destination so narration is still heard
          analyser.connect(ctx.destination);
          narrationAnalyserRef.current = analyser;
          narrationSourceRef.current = src;
        } catch (e) {
          // createMediaElementSource can only be called once per element.
          // If it throws, we can't do ducking but BGM still works via volume.
          console.warn("[bgm-engine] narration analyser setup failed:", e);
        }
      }
      return true;
    } catch (e) {
      console.warn("[bgm-engine] AudioContext unavailable, falling back to volume path:", e);
      webAudioFailedRef.current = true;
      return false;
    }
  }

  // ── Get or create a mood channel (audio + gain node) ──
  function getOrCreateChannel(mood: string): MoodChannel | null {
    const existing = channelsRef.current.get(mood);
    if (existing) return existing;

    const ctx = ctxRef.current;
    if (!ctx) return null;

    try {
      const audio = new Audio();
      audio.src = getBgmAssetUrl(mood);
      audio.loop = true;
      audio.preload = "auto";
      audio.volume = 1.0; // Web Audio controls gain, element stays at 1.0

      const sourceNode = ctx.createMediaElementSource(audio);
      const gainNode = ctx.createGain();
      gainNode.gain.value = 0;
      sourceNode.connect(gainNode);
      gainNode.connect(ctx.destination);

      const channel: MoodChannel = { audio, gainNode, sourceNode, playing: false };
      channelsRef.current.set(mood, channel);
      return channel;
    } catch (e) {
      console.warn(`[bgm-engine] channel setup failed for ${mood}:`, e);
      return null;
    }
  }

  // ── Stop all BGM ──
  function stopAll() {
    activeMoodRef.current = null;
    const ctx = ctxRef.current;
    const now = ctx ? ctx.currentTime : 0;
    for (const [, ch] of channelsRef.current) {
      try {
        ch.gainNode.gain.cancelScheduledValues(now);
        ch.gainNode.gain.setValueAtTime(ch.gainNode.gain.value, now);
        ch.gainNode.gain.linearRampToValueAtTime(0, now + 0.1);
        ch.audio.pause();
        ch.audio.currentTime = 0;
      } catch { /* */ }
      ch.playing = false;
    }
  }

  function pauseAll() {
    for (const [, ch] of channelsRef.current) {
      try { ch.audio.pause(); } catch { /* */ }
      ch.playing = false;
    }
  }

  function resumeActive() {
    const mood = activeMoodRef.current;
    if (!mood) return;
    const ch = channelsRef.current.get(mood);
    if (!ch) return;
    if (!ch.playing) {
      try { ch.audio.play().then(() => { ch.playing = true; }).catch(() => {}); } catch { /* */ }
    }
  }

  // ── Fetch cues when chapter changes ──
  useEffect(() => {
    if (!currentJob?.chapterMp3s || currentChapterIdx < 0) {
      cuesRef.current = [];
      stopAll();
      return;
    }
    const chInfo = currentJob.chapterMp3s[currentChapterIdx];
    if (!chInfo) {
      cuesRef.current = [];
      stopAll();
      return;
    }
    stopAll();
    cuesRef.current = [];

    let cancelled = false;
    fetchCues(currentJob.jobId, chInfo.index).then((cues) => {
      if (cancelled) return;
      cuesRef.current = cues || [];
      console.log(`[bgm-engine] chapter ${chInfo.index}: fetched ${cues?.length ?? 0} cues`);
    });
    return () => { cancelled = true; };
  }, [currentJob?.jobId, currentChapterIdx, fetchCues]);

  // ── Pause/resume lockstep + AudioContext resume ──
  useEffect(() => {
    if (!isPlaying) {
      pauseAll();
    } else {
      // Resume AudioContext on user gesture (autoplay policy)
      if (initAudioContext() && ctxRef.current?.state === "suspended") {
        ctxRef.current.resume().catch(() => {});
      }
      // Prime BGM elements for autoplay
      for (const [mood, ch] of channelsRef.current) {
        if (ch.audio.paused) {
          try { ch.audio.play().then(() => {}).catch((e) => {
            console.warn(`[bgm-engine] play() blocked for ${mood}:`, e);
          }); } catch { /* */ }
        }
      }
      resumeActive();
    }
  }, [isPlaying]);

  // ── BGM enabled/disabled ──
  useEffect(() => {
    if (!bgmEnabled) stopAll();
  }, [bgmEnabled]);

  // ── Cleanup on unmount ──
  useEffect(() => {
    return () => {
      for (const [, ch] of channelsRef.current) {
        try { ch.audio.pause(); ch.audio.src = ""; } catch { /* */ }
      }
      channelsRef.current.clear();
      try { ctxRef.current?.close(); } catch { /* */ }
      ctxRef.current = null;
    };
  }, []);

  // ── Narration RMS analyser loop (ducking) ──
  useEffect(() => {
    if (!bgmEnabled || webAudioFailedRef.current) return;
    const interval = setInterval(() => {
      const analyser = narrationAnalyserRef.current;
      if (!analyser) return;
      const buf = new Uint8Array(analyser.frequencyBinCount);
      analyser.getByteTimeDomainData(buf);
      // Compute RMS
      let sum = 0;
      for (let i = 0; i < buf.length; i++) {
        const v = (buf[i] - 128) / 128;
        sum += v * v;
      }
      const rms = Math.sqrt(sum / buf.length);
      const now = performance.now();
      if (rms > SPEAKING_RMS_THRESHOLD) {
        lastSpeakingTimeRef.current = now;
        isSpeakingRef.current = true;
      } else if (now - lastSpeakingTimeRef.current > SPEAKING_HANGOVER_MS) {
        isSpeakingRef.current = false;
      }
    }, ANALYSER_INTERVAL_MS);
    return () => clearInterval(interval);
  }, [bgmEnabled]);

  // ── Main rAF loop: cue lookup + gain control ──
  useEffect(() => {
    if (!bgmEnabled) return;
    let rafId = 0;

    const loop = () => {
      rafId = requestAnimationFrame(loop);
      const audio = getAudioElement();
      if (!audio || !isPlaying) return;
      const cues = cuesRef.current;
      if (!cues || cues.length === 0) return;

      const t = audio.currentTime;
      const ctx = ctxRef.current;

      // Seek detection
      const prevT = lastTimeRef.current;
      const delta = Math.abs(t - prevT);
      if (prevT > 0 && delta > SEEK_THRESHOLD_SEC) {
        const idx = findActiveCueIndex(cues, t);
        const newMood = idx >= 0 ? cues[idx].mood : null;
        if (newMood && newMood !== "silence") {
          const ch = getOrCreateChannel(newMood);
          if (ch) {
            const loopDur = ch.audio.duration && isFinite(ch.audio.duration) ? ch.audio.duration : 30;
            const offset = (t - cues[idx].start) % loopDur;
            try { ch.audio.currentTime = Math.max(0, offset); } catch { /* */ }
          }
        }
        activeMoodRef.current = newMood && newMood !== "silence" ? newMood : null;
      }
      lastTimeRef.current = t;

      // Cue lookup
      const idx = findActiveCueIndex(cues, t);
      const cue = idx >= 0 ? cues[idx] : null;
      const targetMood = cue && cue.mood !== "silence" ? cue.mood : null;

      // Mood change → crossfade
      if (targetMood !== activeMoodRef.current) {
        const now = ctx ? ctx.currentTime : 0;
        const volMultiplier = bgmVolumeRef.current / 100;

        // Fade out outgoing
        if (activeMoodRef.current) {
          const oldCh = channelsRef.current.get(activeMoodRef.current);
          if (oldCh && ctx) {
            oldCh.gainNode.gain.cancelScheduledValues(now);
            oldCh.gainNode.gain.setValueAtTime(oldCh.gainNode.gain.value, now);
            oldCh.gainNode.gain.linearRampToValueAtTime(0, now + CROSSFADE_SEC);
          }
        }

        // Fade in incoming
        if (targetMood && cue) {
          const ch = getOrCreateChannel(targetMood);
          if (ch) {
            const baseGain = dbToLinear(cue.gain_db) * volMultiplier;
            if (ctx) {
              ch.gainNode.gain.cancelScheduledValues(now);
              ch.gainNode.gain.setValueAtTime(ch.gainNode.gain.value, now);
              ch.gainNode.gain.linearRampToValueAtTime(baseGain, now + CROSSFADE_SEC);
            } else {
              // Fallback: use audio.volume
              ch.audio.volume = baseGain;
            }
            if (!ch.playing) {
              try { ch.audio.play().then(() => { ch.playing = true; }).catch(() => {}); } catch { /* */ }
            }
          }
        }
        activeMoodRef.current = targetMood;
      }

      // Ducking: adjust the active mood's gain based on speaking state
      if (ctx && activeMoodRef.current && cue) {
        const ch = channelsRef.current.get(activeMoodRef.current);
        if (ch) {
          const volMult = bgmVolumeRef.current / 100;
          const baseGain = dbToLinear(cue.gain_db) * volMult;
          const targetGain = isSpeakingRef.current ? baseGain * DUCK_FACTOR : baseGain;
          const timeConst = isSpeakingRef.current ? DUCK_ATTACK_SEC : DUCK_RELEASE_SEC;
          ch.gainNode.gain.setTargetAtTime(targetGain, ctx.currentTime, timeConst);
        }
      }

      // Fallback: if Web Audio failed, use audio.volume
      if (webAudioFailedRef.current) {
        const volMult = bgmVolumeRef.current / 100;
        for (const [mood, ch] of channelsRef.current) {
          if (mood === activeMoodRef.current && cue) {
            const baseGain = dbToLinear(cue.gain_db) * volMult;
            const ducked = isSpeakingRef.current ? baseGain * DUCK_FACTOR : baseGain;
            ch.audio.volume = Math.max(0, Math.min(1, ducked));
          } else {
            ch.audio.volume = 0;
          }
        }
      }

      // Pause elements whose gain reached 0
      for (const [mood, ch] of channelsRef.current) {
        if (mood !== activeMoodRef.current && ch.playing) {
          try { ch.audio.pause(); ch.playing = false; } catch { /* */ }
        }
      }
    };

    rafId = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(rafId);
  }, [bgmEnabled, isPlaying]);
}
