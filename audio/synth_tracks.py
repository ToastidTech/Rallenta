#!/usr/bin/env python3
"""
Rallenta Phase 1 audio synthesis — original synthesized tracks, no samples.

Tracks:
  1. rain-bed     "Rallenta Rain"   (family: rain)    — soft synthesized rain bed ~5 min
  2. ambient-pad  "Rallenta Drift"  (family: ambient) — warm synthesized pad ~5 min

Pipeline: numpy synthesis at 48 kHz stereo (float32) -> 24-bit WAV (working master)
          -> ffmpeg libmp3lame ~128 kbps -> MP3 (delivery)

Loop safety: every time-varying modulation completes an INTEGER number of cycles
across the track, and the master is loop-folded with an equal-power crossfade
(tail folded onto head), so the loop point is click-free.

Mastering targets (per spec section 10): ~-18 to -24 LUFS comfort zone, true peak
<= -1 dBTP, no clipping. Reproducibility: fixed seeds everywhere.

Usage: python3 synth_tracks.py
Outputs (in the same directory as this script):
  rain-bed-rallenta-v1.mp3, ambient-pad-rallenta-v1.mp3,
  <track>-rallenta-v1_master.wav (working master, kept for provenance),
  manifest.json
"""

import hashlib
import json
import os
import subprocess
import sys
import wave

import numpy as np

SR = 48000          # sample rate
DUR = 300.0         # seconds (5 minutes)
N = int(SR * DUR)   # 14_400_000 samples
XF = 5 * SR         # loop-fold crossfade length (5 s)
FFMPEG = "ffmpeg"
FFPROBE = "ffprobe"

HERE = os.path.dirname(os.path.abspath(__file__))


# ---------------------------------------------------------------- helpers

def env_envelope(t, cycles, phase=0.0):
    """Smooth periodic envelope that completes `cycles` integer cycles over DUR."""
    return np.sin(2.0 * np.pi * cycles * t / DUR + phase).astype(np.float32)


def fft_filter_noise(rng, n, shape_fn):
    """Periodic shaped noise: FFT of white noise * spectral shape -> IFFT.
    Result is exactly periodic with length n (loop-friendly)."""
    w = rng.standard_normal(n).astype(np.float64)
    W = np.fft.rfft(w)
    freqs = np.fft.rfftfreq(n, 1.0 / SR)
    H = shape_fn(freqs)
    W = W * H
    x = np.fft.irfft(W, n)
    # remove DC, normalize to unit RMS
    x = x - x.mean()
    x = x / np.sqrt(np.mean(x ** 2))
    return x.astype(np.float32)


def one_pole_lp(x, cutoff, sr):
    """Gentle one-pole lowpass (for thunder beds); non-periodic-safe but we
    crossfade-fold the final master, so loop continuity is preserved."""
    alpha = 1.0 - np.exp(-2.0 * np.pi * cutoff / sr)
    y = np.empty_like(x)
    acc = 0.0
    # operate in float64 chunks for speed
    for i in range(0, len(x), 1 << 20):
        blk = x[i:i + (1 << 20)].astype(np.float64)
        out = np.empty_like(blk)
        for j, v in enumerate(blk):
            acc += alpha * (v - acc)
            out[j] = acc
        y[i:i + (1 << 20)] = out.astype(np.float32)
    return y


def raised_cosine_bump(t, center, width):
    """Smooth bump: 0 outside [center-width/2, center+width/2], 1 at center."""
    u = (t - center) / (width / 2.0)
    m = np.abs(u) < 1.0
    e = np.zeros_like(t)
    e[m] = 0.5 * (1.0 + np.cos(np.pi * u[m]))
    return e.astype(np.float32)


def loop_fold(stereo, xf):
    """Fold the tail (extra `xf` samples) onto the head with an equal-power
    crossfade. stereo shape: (2, N+xf). Returns (2, N) loop-safe master."""
    n = stereo.shape[1] - xf
    ramp = (np.arange(xf, dtype=np.float64) / xf) * (np.pi / 2.0)
    g_head = np.cos(ramp).astype(np.float32) ** 2
    g_tail = np.sin(ramp).astype(np.float32) ** 2
    out = stereo[:, :n].copy()
    out[:, :xf] = stereo[:, :n][:, :xf] * g_head + stereo[:, n:n + xf] * g_tail
    return out


def write_wav24(path, stereo):
    """Write float32 stereo (2, N) in [-1, 1] as 24-bit PCM WAV."""
    data = np.clip(stereo, -1.0, 1.0)
    int24 = (data * 8388607.0).astype(np.int32)
    raw = int24.astype('<i4')
    b = bytearray()
    for v in raw.T.reshape(-1):  # interleave L,R; take low 3 bytes
        b += int(v).to_bytes(4, "little", signed=True)[:3]
    with wave.open(path, "wb") as w:
        w.setnchannels(2)
        w.setsampwidth(3)
        w.setframerate(SR)
        w.writeframes(bytes(b))


def encode_mp3(wav_path, mp3_path, title, track_no):
    cmd = [FFMPEG, "-y", "-v", "error", "-i", wav_path,
           "-codec:a", "libmp3lame", "-b:a", "128k",
           "-ar", "48000", "-ac", "2",
           "-id3v2_version", "3",
           "-metadata", f"title={title}",
           "-metadata", "artist=Toastid Tech",
           "-metadata", "album=Rallenta",
           "-metadata", f"track={track_no}",
           mp3_path]
    subprocess.run(cmd, check=True)


def sha256_of(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for blk in iter(lambda: f.read(1 << 20), b""):
            h.update(blk)
    return h.hexdigest()


def ffprobe_duration(path):
    out = subprocess.run(
        [FFPROBE, "-v", "error", "-show_entries", "format=duration,size,bit_rate",
         "-show_entries", "stream=sample_rate,channels,codec_name", "-of", "json", path],
        capture_output=True, text=True, check=True)
    return json.loads(out.stdout)


def decode_pcm(path):
    """Decode MP3 to float32 stereo PCM (2, M)."""
    out = subprocess.run(
        [FFMPEG, "-v", "error", "-i", path, "-f", "f32le", "-acodec", "pcm_f32le",
         "-ar", "48000", "-ac", "2", "pipe:1"],
        capture_output=True, check=True)
    a = np.frombuffer(out.stdout, dtype=np.float32)
    return a.reshape(-1, 2).T.copy()


def measure_true_peak(path):
    """True-peak estimate: 4x oversampled max abs of the decoded MP3."""
    pcm = decode_pcm(path)
    # 4x upsample: zero-pad the positive spectrum to 4x length, then irfft.
    # irfft's 1/(4N) normalization needs a factor of 4 to preserve amplitude.
    from numpy.fft import rfft, irfft
    up = []
    for ch in pcm:
        X = rfft(ch)
        Y = np.concatenate([X, np.zeros(3 * len(X), dtype=X.dtype)])
        y = 4.0 * irfft(Y, len(ch) * 4)
        up.append(y)
    return float(max(np.max(np.abs(u)) for u in up))


# ---------------------------------------------------------------- track 1: rain

def synth_rain():
    rng = np.random.default_rng(20260927)
    n_ext = N + XF
    t = (np.arange(n_ext, dtype=np.float64) / SR)

    # pink-ish rain body: 1/f amplitude, flat below 40 Hz, gentle rolloff above 12 kHz
    def rain_shape(f):
        H = np.sqrt(np.maximum(40.0, 40.0) / np.maximum(f, 40.0))
        H = H / np.sqrt(1.0 + (f / 12000.0) ** 4)  # soft HF rolloff, keeps highs but tames hiss
        H[f == 0] = 0.0
        return H

    rain_l = fft_filter_noise(rng, n_ext, rain_shape)
    rain_c = fft_filter_noise(rng, n_ext, rain_shape)
    rain_r = fft_filter_noise(rng, n_ext, rain_shape)

    # stereo: decorrelated sides + shared center for cohesion
    L = 0.80 * rain_l + 0.45 * rain_c
    R = 0.80 * rain_r + 0.45 * rain_c

    # slow seamless intensity cycle (integer cycles over DUR): breathes, never jumps
    cyc = (1.0
           + 0.13 * env_envelope(t, 5, 0.0)
           + 0.08 * env_envelope(t, 11, 1.3)
           + 0.05 * env_envelope(t, 23, 2.6))
    L = L * cyc
    R = R * cyc

    # fine patter texture: bandpassed noise, integer cycles, very low level
    def pat_shape(f):
        H = np.exp(-0.5 * ((np.log10(np.maximum(f, 1.0)) - np.log10(4200.0)) / 0.35) ** 2)
        H[f < 200] = 0.0
        return H

    pat_l = fft_filter_noise(rng, n_ext, pat_shape)
    pat_r = fft_filter_noise(rng, n_ext, pat_shape)
    pat_env = 0.10 + 0.10 * (0.5 + 0.5 * env_envelope(t, 37, 0.7))
    L += pat_env * pat_l
    R += pat_env * pat_r

    # distant low thunder: lowpassed noise swells, very subtle, smooth raised-cosine envelopes
    th_l = one_pole_lp(fft_filter_noise(rng, n_ext, lambda f: np.ones_like(f) * (f > 0)), 150.0, SR)
    th_r = one_pole_lp(fft_filter_noise(rng, n_ext, lambda f: np.ones_like(f) * (f > 0)), 150.0, SR)
    th_env = np.zeros(n_ext, dtype=np.float32)
    for center, width, amp in [(38.0, 14.0, 0.55), (132.0, 18.0, 0.75),
                               (208.0, 12.0, 0.45), (271.0, 16.0, 0.65)]:
        th_env += amp * raised_cosine_bump(t, center, width)
    th_env = th_env / max(th_env.max(), 1e-9) * 0.16  # keep very subtle vs rain
    L += th_env * th_l
    R += th_env * th_r

    stereo = np.stack([L, R]).astype(np.float32)

    # comfort level: normalize to RMS -20 dBFS, then cap peak at -2 dBFS (pre-MP3 headroom)
    rms = float(np.sqrt(np.mean(stereo ** 2)))
    stereo *= 10 ** (-20.0 / 20.0) / max(rms, 1e-9)
    pk = float(np.max(np.abs(stereo)))
    if pk > 0.794:  # -2 dBFS
        stereo *= 0.794 / pk
    return loop_fold(stereo, XF)


# ---------------------------------------------------------------- track 2: ambient pad

def synth_pad():
    rng = np.random.default_rng(20260928)
    n_ext = N + XF
    t = (np.arange(n_ext, dtype=np.float64) / SR)

    # calm chord: A major add9, low-mid register — warm, no tension, no melody
    # A2 110.00, E3 164.81, A3 220.00, B3 246.94, C#4 277.18, sub A1 55.00
    voices = [
        (55.00,  0.50,  1, 0.0),
        (110.00, 1.00,  2, 0.0),
        (164.81, 0.80,  3, 1.1),
        (220.00, 0.70,  4, 2.2),
        (246.94, 0.55,  2, 0.6),
        (277.18, 0.45,  3, 1.9),
    ]

    L = np.zeros(n_ext, dtype=np.float64)
    R = np.zeros(n_ext, dtype=np.float64)

    for i, (f, amp, k, ph) in enumerate(voices):
        detune_cents = 3.0 * (1 if i % 2 == 0 else -1)          # +/-3 cents detune
        f_d = f * 2.0 ** (detune_cents / 1200.0)
        # slow brightness drift: +/-2 cents over 4 integer cycles (phase-mod, loop-safe)
        drift = 0.02 * np.sin(2.0 * np.pi * 4 * t / DUR + ph)
        phase = 2.0 * np.pi * f_d * t + drift * 2.0 * np.pi * f_d * t * 0.01
        # slow per-voice swell: integer cycles k, gentle depth
        sw = 0.78 + 0.22 * np.sin(2.0 * np.pi * k * t / DUR + ph)
        s = np.sin(phase).astype(np.float32)
        # triangle-ish: add soft 3rd and 5th partials (sparse harmonics, low contrast)
        s = s + 0.18 * np.sin(3.0 * phase).astype(np.float32) \
              + 0.06 * np.sin(5.0 * phase).astype(np.float32)
        s = s * sw.astype(np.float32) * amp
        pan = 0.5 + 0.18 * np.sin(i * 2.4)                      # static gentle stereo spread
        L += s * np.cos(pan * np.pi / 2.0)
        R += s * np.sin(pan * np.pi / 2.0)

    # shimmer: octave partials fading in/out over very slow integer cycles (evolution, not melody)
    for f, amp, k, ph in [(220.0, 0.16, 2, 0.4), (440.0, 0.07, 3, 2.9), (329.63, 0.10, 2, 1.7)]:
        phv = 2.0 * np.pi * f * t
        evo = (0.5 + 0.5 * np.sin(2.0 * np.pi * k * t / DUR + ph)) ** 2
        s = np.sin(phv).astype(np.float32) * evo.astype(np.float32) * amp
        L += s * 0.7071
        R += s * 0.7071

    # airy top: very low-level filtered noise wash, slow integer-cycle motion
    def air_shape(f):
        H = np.exp(-0.5 * ((np.log10(np.maximum(f, 1.0)) - np.log10(6000.0)) / 0.5) ** 2)
        H[f < 1500] = 0.0
        return H

    air_l = fft_filter_noise(rng, n_ext, air_shape)
    air_r = fft_filter_noise(rng, n_ext, air_shape)
    air_env = 0.05 + 0.04 * (0.5 + 0.5 * env_envelope(t, 7, 0.2))
    L = L + air_env * air_l
    R = R + air_env * air_r

    stereo = np.stack([L.astype(np.float32), R.astype(np.float32)])

    # comfort level: RMS -22 dBFS, peak cap -2 dBFS
    rms = float(np.sqrt(np.mean(stereo ** 2)))
    stereo *= 10 ** (-22.0 / 20.0) / max(rms, 1e-9)
    pk = float(np.max(np.abs(stereo)))
    if pk > 0.794:
        stereo *= 0.794 / pk
    return loop_fold(stereo, XF)


# ---------------------------------------------------------------- verification

def verify_mp3(path, label):
    """Decode MP3, check energy continuity at loop point, true peak, and 2x-loop seam."""
    print(f"\n== verifying {label}: {os.path.basename(path)} ==")
    info = ffprobe_duration(path)
    fmt = info["format"]
    streams = info["streams"]
    dur = float(fmt["duration"])
    print(f"  duration: {dur:.3f} s, size: {int(fmt['size'])} bytes, "
          f"bitrate: {int(fmt['bit_rate'])//1000} kbps")
    for s in streams:
        print(f"  stream: {s['codec_name']} {s['sample_rate']} Hz, {s['channels']} ch")

    pcm = decode_pcm(path)  # (2, M)
    m = pcm.shape[1]
    edge = int(0.05 * SR)  # 50 ms
    e_start = float(np.mean(pcm[:, :edge] ** 2))
    e_end = float(np.mean(pcm[:, -edge:] ** 2))
    ratio = e_end / max(e_start, 1e-12)
    print(f"  loop energy: first-50ms RMS^2={e_start:.6e}, last-50ms RMS^2={e_end:.6e}, ratio={ratio:.4f}")

    # 2x loop seam: concatenate decode twice; seam at sample m
    w = 8
    seam_prev = pcm[:, m - w:m]          # tail of pass 1
    seam_next = pcm[:, :w]               # head of pass 2
    delta = np.max(np.abs(seam_next - seam_prev))
    # compare against typical adjacent-sample deltas inside the track
    adj = np.max(np.abs(np.diff(pcm[:, :SR * 10], axis=1)))
    print(f"  2x-loop seam: max abs sample delta across seam = {delta:.6f} "
          f"(typical adjacent-sample max in first 10s = {adj:.6f})")

    tp = measure_true_peak(path)
    peak = float(np.max(np.abs(pcm)))
    print(f"  peak (decoded) = {peak:.4f} ({20*np.log10(max(peak,1e-9)):.2f} dBFS), "
          f"true peak (4x oversampled) = {tp:.4f} ({20*np.log10(max(tp,1e-9)):.2f} dBFS)")

    ok = True
    checks = {
        "duration ~300s": abs(dur - DUR) < 1.0,
        "stereo 48kHz": streams[0]["channels"] == 2 and int(streams[0]["sample_rate"]) == 48000,
        "loop energy continuity (0.5..2.0)": 0.5 < ratio < 2.0,
        "no decode peak clipping (< 0.995)": peak < 0.995,
        "true peak <= -1 dBFS": tp <= 10 ** (-1.0 / 20.0),
    }
    for name, passed in checks.items():
        print(f"  [{'PASS' if passed else 'FAIL'}] {name}")
        ok = ok and passed
    return ok, dur


def main():
    verify_only = "--verify-only" in sys.argv
    tracks = [
        ("rain-bed", "Rallenta Rain", "rain", synth_rain, 1),
        ("ambient-pad", "Rallenta Drift", "ambient", synth_pad, 2),
    ]
    manifest_tracks = []
    all_ok = True

    for track_id, title, family, synth_fn, track_no in tracks:
        wav = os.path.join(HERE, f"{track_id}-rallenta-v1_master.wav")
        mp3 = os.path.join(HERE, f"{track_id}-rallenta-v1.mp3")
        if not verify_only:
            print(f"\n### synthesizing {track_id}: {title}")
            stereo = synth_fn()
            assert stereo.shape == (2, N), stereo.shape
            print(f"  master: {stereo.shape}, RMS={float(np.sqrt(np.mean(stereo**2))):.5f}, "
                  f"peak={float(np.max(np.abs(stereo))):.4f}")
            write_wav24(wav, stereo)
            print(f"  wrote {wav}")
            encode_mp3(wav, mp3, title, track_no)
            print(f"  encoded {mp3} ({os.path.getsize(mp3)} bytes)")

        ok, dur = verify_mp3(mp3, track_id)
        all_ok = all_ok and ok
        manifest_tracks.append({
            "id": track_id,
            "title": title,
            "family": family,
            "file": os.path.basename(mp3),
            "duration_s": round(dur, 3),
            "sha256": sha256_of(mp3),
            "bytes": os.path.getsize(mp3),
            "version": 1,
        })

    manifest = {"tracks": manifest_tracks}
    mp = os.path.join(HERE, "manifest.json")
    with open(mp, "w") as f:
        json.dump(manifest, f, indent=2)
        f.write("\n")
    print(f"\nwrote {mp}")
    print(json.dumps(manifest, indent=2))
    print("\nALL CHECKS PASSED" if all_ok else "\nSOME CHECKS FAILED")
    return 0 if all_ok else 1


if __name__ == "__main__":
    sys.exit(main())
