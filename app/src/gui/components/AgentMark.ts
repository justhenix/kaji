export type AgentState = 'ready' | 'listening' | 'thinking' | 'working' | 'question' | 'failed' | 'paused';

const orbit = [0, 1, 2, 5, 8, 7, 6, 3];
const question = [0, 1, 2, 5, 7];

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
      cell.style.setProperty('--cell-delay', `${delay ?? 0}ms`);
    });
  }

  setAudioLevel(level: number): void {
    this.element.style.setProperty('--audio-level', String(Math.max(0, Math.min(1, level))));
  }
}
