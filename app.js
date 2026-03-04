// metronome-worklet.js
// AudioWorkletProcessor 기반 메트로놈 엔진 (샘플 정확도 보장 및 오차 계측 추가)

class MetronomeProcessor extends AudioWorkletProcessor {
  constructor() {
    super();

    this.running = false;

    // 활성 설정
    this.bpm = 60;
    this.numerator = 4;
    this.denominator = 4;
    this.volume = 1.0;
    this.quantize = 'bar';
    this.pending = null;

    this.beatIndex = 0;
    this.barIndex = 0;

    // --- [추가됨] 계측을 위한 절대 샘플 카운터 ---
    this.samplesUntilNextTick = 0;
    this.totalSamples = 0;
    this.idealSample = 0;
    this.lastTickSample = -1;

    // 클릭 합성용 (최적화된 DSP)
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

        // 시작 시 카운터 초기화
        this.totalSamples = 0;
        const startDelaySec =
          typeof msg.startDelaySec === 'number' ? msg.startDelaySec : 0.05;
        this.samplesUntilNextTick = startDelaySec * sampleRate;
        this.idealSample = this.samplesUntilNextTick;
        this.lastTickSample = -1;

        const align = msg.align === false ? false : true;
        if (align) {
          this.beatIndex = 0;
          this.barIndex = 0;
        }
        this.port.postMessage({ type: 'state', running: true });
      }

      if (msg.type === 'stop') {
        this.running = false;
        this.env = 0.0;
        this.samplesUntilNextTick = 0;
        this.port.postMessage({ type: 'state', running: false });
      }

      if (msg.type === 'set') {
        const next = {
          bpm: this._clampNumber(msg.bpm, 30, 300, this.bpm),
          numerator: this._clampInt(msg.numerator, 1, 32, this.numerator),
          denominator: this._clampDenominator(
            msg.denominator,
            this.denominator
          ),
          volume: this._clampNumber(msg.volume, 0, 3.0, this.volume),
          quantize:
            msg.quantize === 'bar' || msg.quantize === 'beat'
              ? msg.quantize
              : this.quantize,
        };
        this.pending = next;

        this.port.postMessage({
          type: 'pending',
          pending: {
            bpm: next.bpm,
            numerator: next.numerator,
            denominator: next.denominator,
            quantize: next.quantize,
          },
        });
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
    this.samplesPerBeat = Math.max(1, secondsPerBeat * sampleRate);
  }

  _setClickEnvelopeTimeConstant(tauSec) {
    const tau = Math.max(0.001, tauSec);
    this.envDecay = Math.exp(-1.0 / (tau * sampleRate));
  }

  _shouldApplyPendingAtThisBoundary() {
    if (!this.pending) return false;
    if (this.pending.quantize === 'beat') return true;
    return this.beatIndex === 0;
  }

  _applyPending() {
    if (!this.pending) return;

    this.bpm = this.pending.bpm;
    this.numerator = this.pending.numerator;
    this.denominator = this.pending.denominator;
    this.volume = this.pending.volume;
    this.quantize = this.pending.quantize;

    this.pending = null;
    this._recomputeTiming();

    this.port.postMessage({
      type: 'applied',
      applied: {
        bpm: this.bpm,
        numerator: this.numerator,
        denominator: this.denominator,
        quantize: this.quantize,
      },
    });
  }

  _triggerTick(exactTime, driftMs, intervalMs) {
    if (this._shouldApplyPendingAtThisBoundary()) {
      this._applyPending();
    }

    const isAccent = this.beatIndex === 0;
    this.freq = isAccent ? this.accentFreq : 800;
    this.env = 1.0;

    // [수정됨] 틱 발생 시 계측한 Drift와 Interval을 메인 스레드로 전달
    this.port.postMessage({
      type: 'tick',
      audioTime: exactTime,
      beatIndex: this.beatIndex,
      barIndex: this.barIndex,
      bpm: this.bpm,
      denominator: this.denominator,
      numerator: this.numerator,
      driftMs: driftMs,
      intervalMs: intervalMs,
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
      return true;
    }

    let samplesToTick = this.samplesUntilNextTick;

    for (let i = 0; i < blockSize; i++) {
      let currentSample = this.totalSamples + i;

      // 틱 발생 조건: 카운터가 0 이하로 떨어지는 정확한 샘플 프레임
      if (samplesToTick <= 0) {
        // [핵심] 오차(Drift) 계산: 현재 프레임과 수학적으로 완벽한 이상적 위치의 차이
        let driftSamples = currentSample - this.idealSample;
        let driftMs = (driftSamples / sampleRate) * 1000;

        // 간격(Interval) 계산: 이전 틱과의 간격 (Jitter 계산용)
        let intervalMs = 0;
        if (this.lastTickSample !== -1) {
          intervalMs =
            ((currentSample - this.lastTickSample) / sampleRate) * 1000;
        } else {
          intervalMs = (this.samplesPerBeat / sampleRate) * 1000;
        }
        this.lastTickSample = currentSample;

        // 틱 신호 발송
        this._triggerTick(currentTime + i / sampleRate, driftMs, intervalMs);

        // 다음 틱의 이상적인 위치 업데이트 (소수점 정밀도 유지)
        samplesToTick += this.samplesPerBeat;
        this.idealSample += this.samplesPerBeat;
      }

      let s = 0.0;
      if (this.env > 1e-5) {
        const phaseInc = 2 * Math.PI * (this.freq / sampleRate);
        this.phase += phaseInc;
        if (this.phase > 2 * Math.PI) this.phase -= 2 * Math.PI;

        s = Math.sin(this.phase) * this.env * this.volume;
        this.env *= this.envDecay;
      }

      ch0[i] = s;
      if (ch1) ch1[i] = s;

      samplesToTick -= 1;
    }

    // 다음 블록을 위해 상태 저장
    this.samplesUntilNextTick = samplesToTick;
    this.totalSamples += blockSize;

    return true;
  }
}

registerProcessor('metronome-processor', MetronomeProcessor);
