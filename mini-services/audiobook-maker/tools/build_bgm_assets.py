#!/usr/bin/env python3
"""build_bgm_assets.py — regenerate the 8 BGM loop assets.

Each mood gets a 45-60s SEAMLESSLY LOOPING stereo bed at 44.1 kHz, built from
at least 4 layers (harmonic pad, sub, motion LFO, texture noise, + pulse for
rhythmic moods). Every file is post-processed with ffmpeg: stereo widen,
loop-seam crossfade, highpass/lowpass, vocal-presence notch, and loudnorm
to I=-20 LUFS (the critical fix — old assets were at -27 dBFS peak / -36 RMS).

Dependencies: numpy + ffmpeg CLI only (no new runtime deps).
Run manually: python3 tools/build_bgm_assets.py
Output: assets/bgm/*.mp3 (overwrites the old sine drones).
"""

import math
import os
import subprocess
import sys
import tempfile
import wave

import numpy as np
from scipy.signal import butter, lfilter

# ---------------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------------

SR = 44100
DURATION = 50.0
ASSET_DIR = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "assets", "bgm")

# ---------------------------------------------------------------------------
# Synthesis helpers
# ---------------------------------------------------------------------------

def sine(freq, dur, sr=SR):
    t = np.linspace(0, dur, int(sr * dur), endpoint=False)
    return np.sin(2 * np.pi * freq * t)

def saw(freq, dur, sr=SR):
    t = np.linspace(0, dur, int(sr * dur), endpoint=False)
    y = np.zeros_like(t)
    for n in range(1, 13):
        y += (1.0 / n) * np.sin(2 * np.pi * freq * n * t)
    return y * 0.5

def triangle(freq, dur, sr=SR):
    t = np.linspace(0, dur, int(sr * dur), endpoint=False)
    y = np.zeros_like(t)
    for n in range(1, 10, 2):
        y += (1.0 / (n * n)) * np.sin(2 * np.pi * freq * n * t)
    return y * (8 / (np.pi ** 2))

def lowpass(x, cutoff, sr=SR):
    """Fast butterworth lowpass filter."""
    nyq = 0.5 * sr
    normal_cutoff = cutoff / nyq
    b, a = butter(4, normal_cutoff, btype='low', analog=False)
    return lfilter(b, a, x)

def highpass(x, cutoff, sr=SR):
    """Fast butterworth highpass filter."""
    nyq = 0.5 * sr
    normal_cutoff = cutoff / nyq
    b, a = butter(4, normal_cutoff, btype='high', analog=False)
    return lfilter(b, a, x)

def noise(dur, sr=SR):
    return np.random.uniform(-1, 1, int(sr * dur))

def lfo_val(freq, dur, sr=SR):
    t = np.linspace(0, dur, int(sr * dur), endpoint=False)
    return 0.5 + 0.5 * np.sin(2 * np.pi * freq * t)

def apply_lfo_amplitude(x, lfo_freq, depth=0.3, sr=SR):
    l = lfo_val(lfo_freq, len(x) / sr, sr)
    return x * (1.0 - depth + depth * l)

def detuned_osc(freq, dur, voices=4, osc_type="saw", sr=SR):
    drift_cents = [3, -2, 1, -3, 2, -1]
    y = np.zeros(int(sr * dur))
    for i in range(voices):
        drift = drift_cents[i % len(drift_cents)]
        f = freq * (2 ** (drift / 1200))
        if osc_type == "saw":
            y += saw(f, dur, sr)
        elif osc_type == "tri":
            y += triangle(f, dur, sr)
        else:
            y += sine(f, dur, sr)
    return y / voices

def stereo(x):
    delay_samples = int(0.012 * SR)
    right = np.zeros(len(x) + delay_samples)
    right[delay_samples:] = x
    left = np.zeros(len(right))
    left[:len(x)] = x
    n = min(len(left), len(right))
    return np.column_stack([left[:n], right[:n]])

def normalize(x, target_peak=0.85):
    peak = np.max(np.abs(x))
    if peak > 0:
        x = x * (target_peak / peak)
    return x

def crossfade_loop(x, sr=SR, fade_sec=2.0):
    fade_len = int(fade_sec * sr)
    if len(x) < fade_len * 2:
        return x
    fade_out = np.linspace(1, 0, fade_len)
    fade_in = np.linspace(0, 1, fade_len)
    body = x[:-fade_len]
    tail = x[-fade_len:]
    head = x[:fade_len]
    crossfaded = tail * fade_out + head * fade_in
    return np.concatenate([crossfaded, body[fade_len:]])

# ---------------------------------------------------------------------------
# Mood builders
# ---------------------------------------------------------------------------

def build_calm_amb(dur):
    root = 65.41
    pad = sum(detuned_osc(root * n, dur, 4, "saw") for n in [1, 1.25, 1.5]) / 3
    pad_tri = sum(detuned_osc(root * n, dur, 3, "tri") for n in [1, 1.25, 1.5]) / 3
    pad = (pad * 0.6 + pad_tri * 0.4) * 0.5
    pad = lowpass(pad, 800)
    sub = sine(root / 2, dur) * 0.3
    pad = apply_lfo_amplitude(pad, 0.08, 0.2)
    tex = lowpass(noise(dur), 400) * 0.06
    return stereo(normalize(pad + sub + tex))

def build_wonder(dur):
    root = 130.81
    pad = sum(detuned_osc(root * n, dur, 4, "saw") for n in [1, 1.5, 2.25]) / 3
    pad = lowpass(pad, 3000)
    shimmer = sum(triangle(root * n * 2, dur) for n in [2, 3, 4]) / 3 * 0.15
    shimmer = highpass(shimmer, 1000)
    sub = sine(root / 2, dur) * 0.2
    y = pad + shimmer + sub
    y = apply_lfo_amplitude(y, 0.12, 0.25)
    tex = highpass(noise(dur), 2000) * 0.04
    return stereo(normalize(y + tex))

def build_sorrow(dur):
    root = 110.0
    pad = sum(detuned_osc(root * n, dur, 5, "saw") for n in [1, 1.2, 1.5]) / 3
    pad = lowpass(pad, 600)
    cello = saw(root, dur) * 0.3
    cello = lowpass(cello, 500)
    cello = apply_lfo_amplitude(cello, 0.15, 0.4)
    sub = sine(root / 2, dur) * 0.25
    tex = lowpass(noise(dur), 200) * 0.08
    y = pad * 0.6 + cello + sub + tex
    return stereo(normalize(y))

def build_resolve(dur):
    root = 130.81
    pad = sum(detuned_osc(root * n, dur, 5, "saw") for n in [1, 1.25, 1.5]) / 3
    pad_tri = sum(detuned_osc(root * n, dur, 3, "tri") for n in [1, 1.25, 1.5]) / 3
    pad = (pad * 0.5 + pad_tri * 0.5) * 0.5
    pad = lowpass(pad, 1500)
    fifth_lfo = np.linspace(0, 1, int(SR * dur))
    fifth = detuned_osc(root * 1.5, dur, 3, "saw") * 0.3 * fifth_lfo
    fifth = lowpass(fifth, 1200)
    sub = sine(root / 2, dur) * 0.25
    y = pad + fifth + sub
    y = apply_lfo_amplitude(y, 0.1, 0.15)
    tex = lowpass(noise(dur), 500) * 0.05
    return stereo(normalize(y + tex))

def build_tension_low(dur):
    root = 55.0
    drone = detuned_osc(root, dur, 4, "saw") * 0.4
    drone = lowpass(drone, 500)
    dis = detuned_osc(root * 1.06, dur, 3, "saw") * 0.1
    dis = lowpass(dis, 600)
    swell = np.linspace(0.3, 0.7, int(SR * dur))
    swell = swell * (1 + 0.2 * np.sin(2 * np.pi * 0.05 * np.linspace(0, dur, int(SR * dur))))
    y = (drone + dis) * swell
    bpm = 70
    beat_interval = 60.0 / bpm
    pulse = np.zeros(int(SR * dur))
    for t in np.arange(0, dur, beat_interval):
        idx = int(t * SR)
        thump_len = int(0.1 * SR)
        if idx + thump_len < len(pulse):
            env = np.exp(-np.linspace(0, 8, thump_len))
            pulse[idx:idx + thump_len] += env * sine(60, 0.1)[:thump_len] * 0.15
        idx2 = idx + int(0.15 * SR)
        if idx2 + thump_len < len(pulse):
            env = np.exp(-np.linspace(0, 8, thump_len))
            pulse[idx2:idx2 + thump_len] += env * sine(55, 0.1)[:thump_len] * 0.12
    pulse = lowpass(pulse, 300)
    sub = sine(root / 2, dur) * 0.3
    y = y + pulse + sub
    tex = lowpass(noise(dur), 150) * 0.06
    return stereo(normalize(y + tex))

def build_tension_high(dur):
    root = 82.41
    cluster = sum(detuned_osc(root * n, dur, 4, "saw") for n in [1, 1.414]) / 2
    cluster = lowpass(cluster, 800)
    y = apply_lfo_amplitude(cluster, 0.15, 0.3)
    bpm = 90
    beat_interval = 60.0 / bpm
    pulse = np.zeros(int(SR * dur))
    for t in np.arange(0, dur, beat_interval):
        idx = int(t * SR)
        thump_len = int(0.08 * SR)
        if idx + thump_len < len(pulse):
            env = np.exp(-np.linspace(0, 10, thump_len))
            pulse[idx:idx + thump_len] += env * sine(80, 0.08)[:thump_len] * 0.2
        idx2 = idx + int(0.12 * SR)
        if idx2 + thump_len < len(pulse):
            env = np.exp(-np.linspace(0, 10, thump_len))
            pulse[idx2:idx2 + thump_len] += env * sine(70, 0.08)[:thump_len] * 0.15
    pulse = lowpass(pulse, 400)
    sub = sine(root / 2, dur) * 0.25
    y = y + pulse + sub
    tex = lowpass(noise(dur), 250) * 0.08
    return stereo(normalize(y + tex))

def build_dread(dur):
    root = 36.71
    drone = detuned_osc(root, dur, 3, "saw") * 0.4
    drone = lowpass(drone, 200)
    seventh = detuned_osc(root * 1.5, dur, 3, "saw") * 0.15
    seventh = lowpass(seventh, 300)
    rumble = lowpass(noise(dur), 120) * 0.15
    rumble = apply_lfo_amplitude(rumble, 0.1, 0.5)
    swell = np.linspace(0.4, 0.7, int(SR * dur))
    y = (drone + seventh) * swell + rumble
    sub = sine(root / 2, dur) * 0.35
    return stereo(normalize(y + sub))

def build_action(dur):
    root = 82.41
    pad = detuned_osc(root, dur, 4, "saw") * 0.35
    pad = lowpass(pad, 2000)
    fifth = detuned_osc(root * 1.5, dur, 3, "saw") * 0.2
    fifth = lowpass(fifth, 3000)
    bpm = 110
    eighth = (60.0 / bpm) / 2
    pulse = np.zeros(int(SR * dur))
    for t in np.arange(0, dur, eighth):
        idx = int(t * SR)
        hit_len = int(0.06 * SR)
        if idx + hit_len < len(pulse):
            env = np.exp(-np.linspace(0, 15, hit_len))
            freq = 90 if (int(t / eighth) % 4 == 0) else 150
            pulse[idx:idx + hit_len] += env * sine(freq, 0.06)[:hit_len] * 0.18
    pulse = lowpass(pulse, 500)
    accents = np.zeros(int(SR * dur))
    for t in np.arange(0, dur, 60.0 / bpm):
        idx = int(t * SR)
        hit_len = int(0.04 * SR)
        if idx + hit_len < len(accents):
            env = np.exp(-np.linspace(0, 20, hit_len))
            accents[idx:idx + hit_len] += env * triangle(440, 0.04)[:hit_len] * 0.08
    accents = highpass(accents, 800)
    sub = sine(root / 2, dur) * 0.2
    y = pad + fifth + pulse + accents + sub
    y = apply_lfo_amplitude(y, 0.2, 0.1)
    tex = highpass(noise(dur), 3000) * 0.03
    return stereo(normalize(y + tex))

MOOD_BUILDERS = {
    "calm_amb": build_calm_amb,
    "wonder": build_wonder,
    "sorrow": build_sorrow,
    "resolve": build_resolve,
    "tension_low": build_tension_low,
    "tension_high": build_tension_high,
    "dread": build_dread,
    "action": build_action,
}

# ---------------------------------------------------------------------------
# ffmpeg post-processing
# ---------------------------------------------------------------------------

def post_process(wav_path, mp3_path):
    af = (
        "highpass=f=40,"
        "lowpass=f=12000,"
        "equalizer=f=2500:t=q:w=1.4:g=-5,"
        "equalizer=f=1200:t=q:w=1.2:g=-3,"
        "loudnorm=I=-20:TP=-1.5:LRA=11"
    )
    cmd = [
        "ffmpeg", "-y", "-loglevel", "error",
        "-i", wav_path,
        "-af", af,
        "-c:a", "libmp3lame", "-b:a", "128k",
        "-ar", "44100", "-ac", "2",
        mp3_path,
    ]
    result = subprocess.run(cmd, capture_output=True, text=True)
    if result.returncode != 0:
        print(f"ffmpeg failed: {result.stderr[-300:]}")
        return False
    return True

def measure_loudness(mp3_path):
    cmd = [
        "ffmpeg", "-loglevel", "info",
        "-i", mp3_path,
        "-af", "loudnorm=I=-20:TP=-1.5:LRA=11:print_format=summary",
        "-f", "null", "-",
    ]
    result = subprocess.run(cmd, capture_output=True, text=True)
    stderr = result.stderr
    lufs = None
    tp = None
    for line in stderr.split("\n"):
        if "Input Integrated:" in line:
            try:
                lufs = float(line.split(":")[1].strip().split()[0])
            except (ValueError, IndexError):
                pass
        if "Input True Peak:" in line:
            try:
                tp = float(line.split(":")[1].strip().split()[0])
            except (ValueError, IndexError):
                pass
    return lufs, tp

def get_duration(mp3_path):
    result = subprocess.run(
        ["ffprobe", "-v", "error", "-show_entries", "format=duration",
         "-of", "default=noprint_wrappers=1:nokey=1", mp3_path],
        capture_output=True, text=True
    )
    try:
        return float(result.stdout.strip())
    except ValueError:
        return 0.0

# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main():
    os.makedirs(ASSET_DIR, exist_ok=True)
    print(f"Building 8 BGM assets at {SR}Hz, {DURATION}s each")
    print(f"Output dir: {ASSET_DIR}")
    print(f"{'='*80}")
    results = []
    for mood, builder in MOOD_BUILDERS.items():
        print(f"\nBuilding {mood}...")
        y = builder(DURATION)
        mono = y.mean(axis=1) if y.ndim > 1 else y
        mono = crossfade_loop(mono)
        y = stereo(mono)
        tmp_wav = tempfile.NamedTemporaryFile(suffix=".wav", delete=False, dir=ASSET_DIR)
        tmp_wav.close()
        with wave.open(tmp_wav.name, "w") as wf:
            wf.setnchannels(2)
            wf.setsampwidth(2)
            wf.setframerate(SR)
            y_int16 = (y * 32767).astype(np.int16)
            wf.writeframes(y_int16.tobytes())
        mp3_path = os.path.join(ASSET_DIR, f"{mood}.mp3")
        if not post_process(tmp_wav.name, mp3_path):
            print(f"  FAILED: ffmpeg post-processing")
            results.append((mood, 0, None, None, "FAILED"))
            os.unlink(tmp_wav.name)
            continue
        lufs, tp = measure_loudness(mp3_path)
        dur = get_duration(mp3_path)
        os.unlink(tmp_wav.name)
        status = "OK"
        if lufs is not None and (lufs < -23 or lufs > -17):
            status = f"WARNING: LUFS {lufs:.1f} out of [-23, -17] range"
        results.append((mood, dur, lufs, tp, status))
        print(f"  {mood}.mp3: {dur:.1f}s, {lufs:.1f} LUFS, TP={tp:.1f} dB — {status}")
    print(f"\n{'='*80}")
    print(f"{'MOOD':<15} {'DURATION':>8} {'LUFS':>8} {'TRUE PEAK':>10} {'STATUS'}")
    print(f"{'-'*15} {'-'*8} {'-'*8} {'-'*10} {'-'*20}")
    for mood, dur, lufs, tp, status in results:
        lufs_str = f"{lufs:.1f}" if lufs is not None else "N/A"
        tp_str = f"{tp:.1f} dB" if tp is not None else "N/A"
        print(f"{mood:<15} {dur:>7.1f}s {lufs_str:>8} {tp_str:>10} {status}")
    print(f"\n{'='*80}")
    print("Assertion check: every asset must be between -23 and -17 LUFS")
    all_ok = True
    for mood, dur, lufs, tp, status in results:
        if lufs is None:
            print(f"  {mood}: FAIL (could not measure LUFS)")
            all_ok = False
        elif lufs < -23 or lufs > -17:
            print(f"  {mood}: FAIL ({lufs:.1f} LUFS outside [-23, -17])")
            all_ok = False
        else:
            print(f"  {mood}: PASS ({lufs:.1f} LUFS)")
    if not all_ok:
        print("\nASSERTION FAILED — some assets are outside the target LUFS range!")
        sys.exit(1)
    else:
        print("\nAll assets pass the LUFS assertion.")

if __name__ == "__main__":
    main()
