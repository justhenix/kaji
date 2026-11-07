export function playSendCue(context: AudioContext): OscillatorNode {
  const at = context.currentTime;
  const tone = context.createOscillator();
  const envelope = context.createGain();
  tone.type = 'sine';
  tone.frequency.setValueAtTime(520, at);
  tone.frequency.exponentialRampToValueAtTime(660, at + 0.065);
  envelope.gain.setValueAtTime(0, at);
  envelope.gain.linearRampToValueAtTime(0.065, at + 0.012);
  envelope.gain.exponentialRampToValueAtTime(0.001, at + 0.14);
  tone.connect(envelope).connect(context.destination);
  tone.start(at);
  tone.stop(at + 0.15);
  return tone;
}
