// metronome-worklet.js
// AudioWorkletProcessor 기반 메트로놈 엔진
// - Bresenham(정수+잔차 누적) 스케줄링
// - 절대 샘플 카운터(totalSamples) 영구 누적
// - Quantized change: 'bar' = 다음 마디 첫 강박(beatIndex==0)에서만 적용
// - [개선] start 시 referenceSample을 “실제 첫 틱이 발생한 샘플”로 확정(드리프트 정의 일관)

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

    // 절대 샘플 카운터 (리셋 금지)
    this.totalSamples = 0;

    // 다음 틱까지 남은 샘플(정수 카운터)
    this.samplesUntilNextTick = 0;

    // 타이밍(박당 샘플 수) 계산용
    this.exactSamplesPerBeat = 0.0;
    this.intSamplesPerBeat = 0;
    this.fracSamplesPerBeat = 0.0;
    this.fracAcc = 0.0;

    // 계측(내부 기준)용
    this.referenceSample = 0;   // 드리프트 기준점(정수 샘플)
    this.tickCounter = 0;       // 기준점 이후 틱 카운트
    this.lastTickSample = -1;   // interval 계산용

    // start 시 referenceSample을 “첫 틱 발생 샘플”로 확정하기 위한 플래그
    this.needStartReference = false;

    // 클릭 합성(DSP)
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

        // totalSamples는 건드리지 않음
        this.samplesUntilNextTick = Math.max(0, Math.floor(startDelaySec * sampleRate));

        // 계측/잔차 초기화
        this.fracAcc = 0.0;
        this.tickCounter = 0;
        this.lastTickSample = -1;

        // start 기준점(referenceSample)은 “첫 틱이 실제로 발생한 샘플”에서 확정
        this.needStartReference = true;

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
        // samplesUntilNextTick은 그대로 두어도 되지만, 재시작 시 start에서 재설정됨
        this.port.postMessage({ type: 'state', running: false });
      }

      if (msg.type === 'set') {
        const next = {
          bpm: this._clampNumber(msg.bpm, 30, 300, this.bpm),
          numerator: this._clampInt(msg.numerator, 1, 32, this.numerator),
          denominator: this._clampDenominator(msg.denominator, this.denominator),
          volume: this._clampNumber(msg.volume, 0, 3.0, this.volume),
          quantize:
            msg.quantize === 'bar' || msg.quantize === 'beat' ? msg.quantize : this.quantize,
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

  // --------------------
  // Utils
  // --------------------
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

    // Bresenham 분해
    this.intSamplesPerBeat = Math.max(1, Math.floor(this.exactSamplesPerBeat));
    this.fracSamplesPerBeat = this.exactSamplesPerBeat - this.intSamplesPerBeat;
  }

  _setClickEnvelopeTimeConstant(tauSec) {
    const tau = Math.max(0.001, tauSec);
    this.envDecay = Math.exp(-1.0 / (tau * sampleRate));
  }

  _shouldApplyPendingAtThisBoundary() {
    if (!this.pending) return false;
    if (this.pending.quantize === 'beat') return true;
    // bar: 마디 첫 강박에서만
    return this.beatIndex === 0;
  }

  // pending 적용(정확한 틱 샘플 인덱스를 기준점으로)
  _applyPending(currentSample) {
    if (!this.pending) return;

    this.bpm = this.pending.bpm;
    this.numerator = this.pending.numerator;
    this.denominator = this.pending.denominator;
    this.volume = this.pending.volume;
    this.quantize = this.pending.quantize;

    this.pending = null;
    this._recomputeTiming();

    // 새 템포의 기준점은 “바로 지금 틱이 발생한 샘플”
    this.referenceSample = currentSample;
    this.tickCounter = 0;
    this.fracAcc = 0.0;

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
    const isAccent = this.beatIndex === 0;
    this.freq = isAccent ? this.accentFreq : 800;
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
    });

    this.beatIndex++;
    if (this.beatIndex >= this.numerator) {
      this.beatIndex = 0;
      this.barIndex++;
    }
  }

  // --------------------
  // Audio loop
  // --------------------
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
      this.totalSamples += blockSize; // 정지 상태에서도 절대 시간은 흐름
      return true;
    }

    let samplesToTick = this.samplesUntilNextTick;

    for (let i = 0; i < blockSize; i++) {
      const currentSample = this.totalSamples + i;

      if (samplesToTick <= 0) {
        // (1) start 직후 첫 틱에서 referenceSample 확정
        if (this.needStartReference) {
          this.referenceSample = currentSample;
          this.tickCounter = 0;
          this.fracAcc = 0.0;
          this.needStartReference = false;
        }

        // (2) Quantized change: 틱 직전에 pending 적용(계측 기준 일관)
        if (this._shouldApplyPendingAtThisBoundary()) {
          this._applyPending(currentSample);
        }

        // (3) 계측(내부 기준)
        const exactIdealSample = this.referenceSample + (this.tickCounter * this.exactSamplesPerBeat);
        const driftSamples = currentSample - exactIdealSample;
        const driftMs = (driftSamples / sampleRate) * 1000.0;

        let intervalMs = 0.0;
        if (this.lastTickSample !== -1) {
          intervalMs = ((currentSample - this.lastTickSample) / sampleRate) * 1000.0;
        } else {
          intervalMs = (this.exactSamplesPerBeat / sampleRate) * 1000.0;
        }
        this.lastTickSample = currentSample;

        // (4) 틱 메시지 + 클릭 시작
        this._triggerTick(currentTime + i / sampleRate, driftMs, intervalMs);

        // (5) 다음 틱까지 샘플 수(Bresenham)
        let nextInterval = this.intSamplesPerBeat;
        this.fracAcc += this.fracSamplesPerBeat;
        if (this.fracAcc >= 1.0) {
          nextInterval += 1;
          this.fracAcc -= 1.0;
        }

        // 누적 방식으로 다음 틱 예약
        samplesToTick += nextInterval;
        this.tickCounter++;
      }

      // 클릭 합성
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

    this.samplesUntilNextTick = samplesToTick;
    this.totalSamples += blockSize;

    return true;
  }
}

registerProcessor('metronome-processor', MetronomeProcessor);