// AudioWorkletProcessor 기반 메트로놈 엔진
// - SampleClock(샘플 단위 카운터) 기반 tick
// - Bresenham(정수+잔차 누적) 스케줄링으로 비정수 박 길이 장기 평균 정확도 확보
// - Quantize 정책은 "엔진 모드(this.quantize)"가 소유 (pending에 quantize를 섞지 않음)
// - Stop은 오디오/스케줄만 멈추고, 지표(틱 카운트)는 start에서 세션 기준으로 초기화

class MetronomeProcessor extends AudioWorkletProcessor {
  constructor() {
    super();

    this.running = false;

    // Active params
    this.bpm = 60;
    this.numerator = 4;
    this.denominator = 4;
    this.volume = 1.0;

    // Quantize mode is an engine policy (NOT part of pending)
    // 'bar' = next bar downbeat, 'beat' = next beat
    this.quantize = 'bar';

    // Pending params (applied at quantized boundary)
    this.pending = null;

    // Beat/bar counters
    this.beatIndex = 0;
    this.barIndex = 0;

    // Absolute sample counter (never reset)
    this.totalSamples = 0;

    // Countdown to next tick in samples
    this.samplesUntilNextTick = 0;

    // Timing (samples/beat)
    this.exactSamplesPerBeat = 0.0;
    this.intSamplesPerBeat = 0;
    this.fracSamplesPerBeat = 0.0;
    this.fracAcc = 0.0;

    // Metrics (engine-internal)
    this.referenceSample = 0;
    this.tickCounter = 0;
    this.lastTickSample = -1;

    // Start reference latch
    this.needStartReference = false;

    // Click synth
    this.env = 0.0;
    this.envDecay = 0.0;
    this.phase = 0.0;
    this.freq = 800;
    this.accentFreq = 1000;

    this._recomputeTiming();
    this._setClickEnvelopeTimeConstant(0.02);

    this.port.onmessage = (event) => {
      const msg = event.data;
      if (!msg || typeof msg.type !== 'string') return;

      if (msg.type === 'start') {
        this.running = true;

        const startDelaySec =
          typeof msg.startDelaySec === 'number' ? msg.startDelaySec : 0.05;

        // Do NOT reset totalSamples (absolute timeline must keep flowing)
        this.samplesUntilNextTick = Math.max(
          0,
          Math.floor(startDelaySec * sampleRate)
        );

        // Reset session metrics (start defines a new measurement session)
        this.fracAcc = 0.0;
        this.tickCounter = 0;
        this.lastTickSample = -1;
        this.needStartReference = true;

        if (msg.align !== false) {
          this.beatIndex = 0;
          this.barIndex = 0;
        }

        this.port.postMessage({ type: 'state', running: true });
        return;
      }

      if (msg.type === 'stop') {
        // Stop = silence + stop scheduling (metrics will reset on next start)
        this.running = false;
        this.env = 0.0;
        this.samplesUntilNextTick = 0;

        this.port.postMessage({ type: 'state', running: false });
        return;
      }

      if (msg.type === 'set') {
        // Pending excludes quantize policy: quantize is owned by engine (this.quantize)
        const next = {
          bpm: this._clampNumber(msg.bpm, 30, 300, this.bpm),
          numerator: this._clampInt(msg.numerator, 1, 32, this.numerator),
          denominator: this._clampDenominator(
            msg.denominator,
            this.denominator
          ),
          volume: this._clampNumber(msg.volume, 0, 3.0, this.volume),
        };

        // Optional: allow changing quantize mode explicitly (engine policy)
        if (msg.quantize === 'bar' || msg.quantize === 'beat') {
          this.quantize = msg.quantize;
        }

        this.pending = next;
        this.port.postMessage({
          type: 'pending',
          pending: next,
          quantize: this.quantize,
        });
        return;
      }
    };
  }

  _clampNumber(v, min, max, fallback) {
    if (typeof v !== 'number' || !Number.isFinite(v)) return fallback;
    return Math.min(max, Math.max(min, v));
  }

  _clampInt(v, min, max, fallback) {
    const n = Number(v);
    if (!Number.isFinite(n)) return fallback;
    return Math.min(max, Math.max(min, Math.round(n)));
  }

  _clampDenominator(v, fallback) {
    const allowed = new Set([1, 2, 4, 8, 16, 32]);
    const n = this._clampInt(v, 1, 32, fallback);
    return allowed.has(n) ? n : fallback;
  }

  _recomputeTiming() {
    const secondsPerBeat = (60.0 / this.bpm) * (4.0 / this.denominator);
    this.exactSamplesPerBeat = Math.max(1e-9, secondsPerBeat * sampleRate);

    this.intSamplesPerBeat = Math.max(1, Math.floor(this.exactSamplesPerBeat));
    this.fracSamplesPerBeat = this.exactSamplesPerBeat - this.intSamplesPerBeat;
  }

  _setClickEnvelopeTimeConstant(tauSec) {
    const tau = Math.max(0.001, tauSec);
    this.envDecay = Math.exp(-1.0 / (tau * sampleRate));
  }

  _shouldApplyPendingAtThisBoundary() {
    if (!this.pending) return false;
    if (this.quantize === 'beat') return true;
    // 'bar' mode: apply only at downbeat
    return this.beatIndex === 0;
  }

  // Returns boolean: applied or not
  _applyPending(currentSample) {
    if (!this.pending) return false;

    this.bpm = this.pending.bpm;
    this.numerator = this.pending.numerator;
    this.denominator = this.pending.denominator;
    this.volume = this.pending.volume;

    this.pending = null;

    this._recomputeTiming();

    // Reset measurement reference at the exact tick sample
    this.referenceSample = currentSample;
    this.tickCounter = 0;
    this.fracAcc = 0.0;

    return true;
  }

  _triggerTick(exactTime, driftMs, intervalMs, appliedPending) {
    this.freq = this.beatIndex === 0 ? this.accentFreq : 800;
    this.env = 1.0;

    this.port.postMessage({
      type: 'tick',
      audioTime: exactTime,
      beatIndex: this.beatIndex,
      barIndex: this.barIndex,
      bpm: this.bpm,
      denominator: this.denominator,
      numerator: this.numerator,
      driftMs,
      intervalMs,
      appliedPending,
    });

    this.beatIndex++;
    if (this.beatIndex >= this.numerator) {
      this.beatIndex = 0;
      this.barIndex++;
    }
  }

  process(inputs, outputs) {
    const output = outputs[0];
    const ch0 = output[0];
    const ch1 = output.length > 1 ? output[1] : null;
    if (!ch0) return true;

    const blockSize = ch0.length;

    if (!this.running) {
      for (let i = 0; i < blockSize; i++) {
        ch0[i] = 0.0;
        if (ch1) ch1[i] = 0.0;
      }
      // Absolute timeline keeps flowing even when stopped
      this.totalSamples += blockSize;
      return true;
    }

    let samplesToTick = this.samplesUntilNextTick;

    for (let i = 0; i < blockSize; i++) {
      const currentSample = this.totalSamples + i;

      if (samplesToTick <= 0) {
        // Establish session reference at the first actual tick after start
        if (this.needStartReference) {
          this.referenceSample = currentSample;
          this.tickCounter = 0;
          this.fracAcc = 0.0;
          this.needStartReference = false;
        }

        // Quantized commit
        let appliedPending = false;
        if (this._shouldApplyPendingAtThisBoundary()) {
          appliedPending = this._applyPending(currentSample);
        }

        // Metrics (engine-internal)
        const exactIdealSample =
          this.referenceSample + this.tickCounter * this.exactSamplesPerBeat;
        const driftMs =
          ((currentSample - exactIdealSample) / sampleRate) * 1000.0;

        const intervalMs =
          this.lastTickSample !== -1
            ? ((currentSample - this.lastTickSample) / sampleRate) * 1000.0
            : (this.exactSamplesPerBeat / sampleRate) * 1000.0;

        this.lastTickSample = currentSample;

        // Emit tick
        this._triggerTick(
          currentTime + i / sampleRate,
          driftMs,
          intervalMs,
          appliedPending
        );

        // Bresenham scheduling (integer + residual accumulation)
        let nextInterval = this.intSamplesPerBeat;
        this.fracAcc += this.fracSamplesPerBeat;
        if (this.fracAcc >= 1.0) {
          nextInterval += 1;
          this.fracAcc -= 1.0;
        }

        samplesToTick += nextInterval;
        this.tickCounter++;
      }

      // Click synth
      let s = 0.0;
      if (this.env > 1e-5) {
        this.phase += 2 * Math.PI * (this.freq / sampleRate);
        if (this.phase > 2 * Math.PI) this.phase -= 2 * Math.PI;

        s = Math.sin(this.phase) * this.env * this.volume;
        this.env *= this.envDecay;
      }

      ch0[i] = s;
      if (ch1) ch1[i] = s;

      samplesToTick -= 1;
    }

    this.samplesUntilNextTick = samplesToTick;
    this.totalSamples += blockSize;
    return true;
  }
}

registerProcessor('metronome-processor', MetronomeProcessor);
