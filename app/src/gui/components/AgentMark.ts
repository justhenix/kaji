export type AgentState = 'ready' | 'listening' | 'thinking' | 'working' | 'question' | 'failed' | 'paused';

const orbit = [0, 1, 2, 5, 8, 7, 6, 3];
const question = [0, 1, 2, 5, 7];
const meterThresholds = [0.76, 0.56, 0.86, 0.48, 0.28, 0.59, 0.19, 0.05, 0.26];

export class AgentMark {
  readonly element = document.createElement('span');

  constructor() {
    this.element.className = 'agent-mark';
    this.element.setAttribute('aria-hidden', 'true');
    this.element.innerHTML = `<img class="agent-mark-logo" src="/logo/kaji-mark.svg" alt="" draggable="false" />
      <span class="agent-matrix">${Array.from({ length: 9 }, (_, i) => `<span class="agent-cell" data-cell="${i}"></span>`).join('')}</span>`;
    this.setState('ready');
  }

  setState(state: AgentState): void {
    if (this.element.dataset.state === state) return;
    this.element.dataset.state = state;
    this.element.querySelectorAll<HTMLElement>('.agent-cell').forEach((cell, i) => {
      const row = Math.floor(i / 3), col = i % 3;
      let delay: number | null = 0;
      if (state === 'working') delay = (col + Math.abs(row - 1)) * 90;
      if (state === 'thinking') delay = orbit.includes(i) ? orbit.indexOf(i) * 110 : null;
      if (state === 'question') delay = question.includes(i) ? question.indexOf(i) * 110 : null;
      if (state === 'failed') delay = [0, 2, 4, 6, 8].includes(i) ? 0 : null;
      cell.dataset.active = String(delay !== null);
      cell.dataset.check = String([2, 3, 5, 7].includes(i));
      cell.style.setProperty('--cell-delay', `${delay ?? 0}ms`);
    });
  }

  setAudioLevel(level: number): void {
    const amplitude = (20 * Math.log10(Math.max(0.00001, level)) + 72) / 46;
    const hasSignal = String(amplitude >= meterThresholds[7]!);
    if (this.element.dataset.signal !== hasSignal) this.element.dataset.signal = hasSignal;
    this.element.querySelectorAll<HTMLElement>('.agent-cell').forEach((cell, index) => {
      const lit = String(amplitude >= meterThresholds[index]!);
      if (cell.dataset.lit !== lit) cell.dataset.lit = lit;
    });
  }
}
