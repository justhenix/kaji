declare const AudioWorkletProcessor: new () => { port: MessagePort };
declare function registerProcessor(name: string, processor: new () => unknown): void;

class KajiAudioCapture extends AudioWorkletProcessor {
  process(inputs: Float32Array[][], outputs: Float32Array[][]): boolean {
    const samples = inputs[0]?.[0];
    if (samples?.length) {
      const copy = samples.slice();
      this.port.postMessage(copy, [copy.buffer]);
    }
    for (const channel of outputs[0] ?? []) channel.fill(0);
    return true;
  }
}

registerProcessor('kaji-audio-capture', KajiAudioCapture);
