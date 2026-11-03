import { AgentMark, type AgentState } from './components/AgentMark';
import { openMainWindow, setComposerFrame } from './ipc';
import { store } from './store';

export interface ComposerQuestion {
  id: string;
  title: string;
  options: { id: string; label: string; value: string }[];
  allowCustom?: boolean;
  optional?: boolean;
  kind?: 'clarification' | 'approval';
  step?: number;
  total?: number;
}

export interface ComposerUpdate {
  state?: AgentState;
  message?: string;
  transcript?: string;
  question?: ComposerQuestion | null;
  questionId?: string;
  answer?: string;
  audioLevel?: number;
  dwellEnabled?: boolean;
  dwellTarget?: string;
  dwellProgress?: number;
}

export type ComposerAction =
  | { type: 'request'; text: string }
  | { type: 'listen' | 'dwell'; enabled: boolean }
  | { type: 'answer'; questionId: string; answer: string }
  | { type: 'dismiss' | 'skip'; questionId: string }
  | { type: 'stop' };

type Panel = 'editor' | 'question' | 'notice' | null;
const labels: Record<AgentState, string> = {
  ready: 'Ask Kaji…', listening: 'Listening…', thinking: 'Thinking…',
  working: 'Working…', question: 'Your answer…', failed: 'Something went wrong', paused: 'Paused',
};

export class Composer {
  private readonly mark = new AgentMark();
  private readonly stage = document.createElement('main');
  private readonly panel: HTMLElement;
  private readonly prompt: HTMLButtonElement;
  private readonly voice: HTMLButtonElement;
  private readonly dwell: HTMLButtonElement;
  private readonly input: HTMLTextAreaElement;
  private readonly customAnswer: HTMLInputElement;
  private currentPanel: Panel = null;
  private desiredPanel: Panel = null;
  private state: AgentState = 'ready';
  private question: ComposerQuestion | null = null;
  private answer = '';
  private dwellEnabled = store.settings.enable_head_control;
  private generation = 0;
  private motion: Animation | null = null;
  private frameKey = '';
  private frameUpdates = Promise.resolve();
  private leaving = false;

  constructor(root: HTMLElement) {
    this.stage.className = 'composer-stage';
    this.stage.setAttribute('aria-label', 'Kaji composer');
    this.stage.innerHTML = `
      <section class="composer-panel" hidden>
        <form class="composer-editor" hidden aria-label="Type a request">
          <label class="sr-only" for="composer-input">Your request</label>
          <textarea id="composer-input" placeholder="Type a request…" rows="2" spellcheck="true"></textarea>
          <div class="composer-editor-footer">
            <span class="composer-key-hint">Enter to send</span>
            <button class="composer-primary" type="submit" disabled>Send <i class="ri-arrow-up-line" aria-hidden="true"></i></button>
          </div>
        </form>
        <section class="composer-question" hidden aria-labelledby="composer-question-title">
          <header class="composer-question-header">
            <h2 id="composer-question-title"></h2>
            <button class="composer-icon" type="button" data-dismiss aria-label="Dismiss question" title="Dismiss question"><i class="ri-close-line" aria-hidden="true"></i></button>
          </header>
          <div class="composer-options" role="group" aria-label="Answer options"></div>
          <label class="composer-custom" hidden>
            <span class="sr-only">Your answer</span>
            <input type="text" placeholder="Another answer…" autocomplete="off" />
          </label>
          <p class="composer-answer" role="status" aria-live="polite" hidden></p>
          <footer class="composer-question-footer">
            <span class="composer-step"></span>
            <button class="composer-secondary" type="button" data-skip hidden>Skip</button>
            <button class="composer-secondary" type="button" data-cancel>Cancel</button>
            <button class="composer-primary" type="button" data-continue disabled>Continue</button>
          </footer>
        </section>
        <section class="composer-notice" hidden>
          <div class="composer-notice-header"><span class="composer-notice-title"></span>
            <button class="composer-icon" type="button" data-collapse aria-label="Collapse details" title="Collapse details"><i class="ri-subtract-line" aria-hidden="true"></i></button>
          </div>
          <p class="composer-notice-text"></p>
        </section>
      </section>
      <div class="composer-pill">
        <span class="composer-brand" data-tauri-drag-region></span>
        <button class="composer-prompt" type="button" aria-label="Type a request" aria-expanded="false" aria-controls="composer-panel"><span>Ask Kaji…</span></button>
        <span class="composer-divider" aria-hidden="true"></span>
        <button class="composer-icon composer-voice" type="button" data-dwell-id="voice" aria-label="Start listening" title="Start listening" aria-pressed="false"><i class="ri-mic-line" aria-hidden="true"></i></button>
        <button class="composer-icon composer-dwell" type="button" data-dwell-id="dwell" aria-label="Pause dwell" title="Pause dwell" aria-pressed="true"><i class="ri-cursor-line" aria-hidden="true"></i><span>Dwell</span></button>
        <button class="composer-icon" type="button" data-open-kaji data-dwell-id="main" aria-label="Open Kaji" title="Open Kaji"><i class="ri-settings-3-line" aria-hidden="true"></i></button>
      </div>
      <p class="sr-only composer-announcement" role="status" aria-live="polite"></p>`;
    root.appendChild(this.stage);
    this.panel = this.get('.composer-panel');
    this.panel.id = 'composer-panel';
    this.get('.composer-brand').appendChild(this.mark.element);
    this.prompt = this.get('.composer-prompt');
    this.voice = this.get('.composer-voice');
    this.dwell = this.get('.composer-dwell');
    this.input = this.get('#composer-input');
    this.customAnswer = this.get('.composer-custom input');
    this.restoreDraft();
    this.bind();
    this.appearance();
    this.renderState();
    try {
      const saved = JSON.parse(sessionStorage.getItem('kaji-composer-question') ?? 'null');
      if (saved?.question?.id && saved.question.title && Array.isArray(saved.question.options)) this.update({ question: saved.question, answer: saved.answer ?? '' });
    } catch {}
    void this.resize();
    const observer = new ResizeObserver(() => { void this.resize(); });
    for (const element of this.stage.querySelectorAll('.composer-editor, .composer-question, .composer-notice')) observer.observe(element);
    window.addEventListener('pagehide', () => observer.disconnect(), { once: true });
    store.subscribe((source) => { if (source !== 'status') this.appearance(); });
  }

  private get<T extends HTMLElement>(selector: string): T {
    return this.stage.querySelector<T>(selector)!;
  }

  private emit(action: ComposerAction): void {
    window.dispatchEvent(new CustomEvent<ComposerAction>('kaji:composer-action', { detail: action }));
  }

  private bind(): void {
    this.prompt.onclick = (event) => {
      const next = this.desiredPanel ? null : this.question ? 'question' : ['failed', 'working', 'thinking'].includes(this.state) ? 'notice' : 'editor';
      if (next === 'question') { this.state = 'question'; this.renderState(); }
      void this.openPanel(next, event.detail > 0).then(() => {
        if (next === 'editor') this.input.focus({ preventScroll: true });
      });
    };
    this.voice.onclick = () => {
      if (this.state === 'thinking' || this.state === 'working') {
        this.emit({ type: 'stop' });
        this.update({ state: this.question ? 'question' : 'ready', message: '' });
        void this.openPanel(null, false);
        return;
      }
      const enabled = this.state !== 'listening';
      this.update({ state: enabled ? 'listening' : this.question ? 'question' : 'ready' });
      this.emit({ type: 'listen', enabled });
    };
    this.dwell.onclick = () => {
      this.dwellEnabled = !this.dwellEnabled;
      this.renderState();
      this.emit({ type: 'dwell', enabled: this.dwellEnabled });
      this.get('.composer-announcement').textContent = this.dwellEnabled ? 'Dwell resumed' : 'Dwell paused';
    };
    this.get<HTMLButtonElement>('[data-open-kaji]').onclick = async () => {
      if (this.leaving) return;
      this.leaving = true;
      ++this.generation;
      this.motion?.cancel();
      try { await this.frameUpdates; await openMainWindow(); }
      catch { this.leaving = false; this.update({ state: 'failed', message: 'Couldn’t open Kaji. Try again.' }); }
    };
    this.input.oninput = () => {
      this.get<HTMLButtonElement>('.composer-editor button[type="submit"]').disabled = !this.input.value.trim();
      this.saveDraft();
    };
    this.input.onkeydown = (event) => {
      if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
        event.preventDefault();
        if (this.input.value.trim()) this.get<HTMLFormElement>('.composer-editor').requestSubmit();
      }
    };
    this.get<HTMLFormElement>('.composer-editor').onsubmit = (event) => {
      event.preventDefault();
      const text = this.input.value.trim();
      if (!text || ['thinking', 'working'].includes(this.state)) return;
      this.input.value = '';
      this.saveDraft();
      this.get<HTMLButtonElement>('.composer-editor button[type="submit"]').disabled = true;
      this.update({ state: 'thinking', message: text });
      void this.openPanel(null, false);
      this.emit({ type: 'request', text });
    };
    this.customAnswer.oninput = () => this.setAnswer(this.customAnswer.value);
    this.customAnswer.onkeydown = (event) => {
      if (event.key === 'Enter' && !event.isComposing) { event.preventDefault(); this.submitAnswer(); }
    };
    for (const element of this.stage.querySelectorAll<HTMLButtonElement>('[data-dismiss], [data-cancel]')) {
      element.onclick = (event) => {
        if (this.question) this.emit({ type: 'dismiss', questionId: this.question.id });
        this.state = 'paused';
        this.renderState();
        this.saveDraft();
        void this.openPanel(null, event.detail > 0);
      };
    }
    this.get<HTMLButtonElement>('[data-collapse]').onclick = (event) => { void this.openPanel(null, event.detail > 0); };
    this.get<HTMLButtonElement>('[data-skip]').onclick = () => {
      if (!this.question?.optional) return;
      const questionId = this.question.id;
      this.update({ question: null, state: 'ready' });
      this.emit({ type: 'skip', questionId });
    };
    this.get<HTMLButtonElement>('[data-continue]').onclick = () => this.submitAnswer();
    window.addEventListener('kaji:composer-update', ((event: CustomEvent<ComposerUpdate>) => this.update(event.detail)) as EventListener);
    window.addEventListener('resize', () => this.availableWidth());
    window.addEventListener('keydown', (event) => {
      if (event.key !== 'Escape' || !this.currentPanel) return;
      if (this.question && this.currentPanel === 'question') {
        this.state = 'paused';
        this.emit({ type: 'dismiss', questionId: this.question.id });
        this.renderState();
      }
      void this.openPanel(null, false).then(() => this.prompt.focus({ preventScroll: true }));
    });
  }

  update(update: ComposerUpdate): void {
    if (update.questionId && update.questionId !== this.question?.id) return;
    if (update.question !== undefined) {
      this.question = update.question;
      this.answer = '';
      if (this.question) {
        this.renderQuestion();
        this.state = 'question';
        void this.openPanel('question');
      } else if (this.currentPanel === 'question') void this.openPanel(null, false);
    }
    if (update.state) this.state = update.state;
    if (update.message !== undefined) this.get('.composer-notice-text').textContent = update.message;
    if (update.transcript !== undefined) {
      this.prompt.querySelector('span')!.textContent = update.transcript || labels[this.state];
      this.prompt.dataset.transcript = update.transcript ? 'true' : 'false';
    } else if (update.state || update.question !== undefined) delete this.prompt.dataset.transcript;
    if (update.answer !== undefined && this.question) this.setAnswer(update.answer);
    if (update.dwellEnabled !== undefined) this.dwellEnabled = update.dwellEnabled;
    if (update.audioLevel !== undefined) this.mark.setAudioLevel(update.audioLevel);
    if (update.dwellProgress !== undefined) {
      for (const element of this.stage.querySelectorAll<HTMLElement>('[data-dwell-id]')) {
        const active = element.dataset.dwellId === update.dwellTarget && update.dwellProgress > 0;
        element.dataset.dwelling = String(active);
        element.style.setProperty('--dwell-progress', active ? `${Math.max(0, Math.min(1, update.dwellProgress)) * 360}deg` : '0deg');
      }
    }
    if (update.state || update.question !== undefined || update.dwellEnabled !== undefined) this.renderState();
    if (update.question !== undefined || update.answer !== undefined) this.saveDraft();
    if (update.state === 'failed') void this.openPanel('notice');
  }

  private renderState(): void {
    this.stage.dataset.state = this.state;
    this.mark.setState(this.state);
    if (this.prompt.dataset.transcript !== 'true') this.prompt.querySelector('span')!.textContent = labels[this.state];
    const busy = this.state === 'thinking' || this.state === 'working';
    const listening = this.state === 'listening';
    const label = busy ? 'Stop task' : listening ? 'Stop listening' : 'Start listening';
    this.voice.setAttribute('aria-label', label);
    this.voice.title = label;
    this.voice.setAttribute('aria-pressed', String(listening));
    this.voice.querySelector('i')!.className = busy ? 'ri-stop-line' : listening ? 'ri-mic-fill' : 'ri-mic-line';
    this.dwell.setAttribute('aria-pressed', String(this.dwellEnabled));
    this.dwell.setAttribute('aria-label', this.dwellEnabled ? 'Pause dwell' : 'Resume dwell');
    this.dwell.title = this.dwellEnabled ? 'Pause dwell' : 'Resume dwell';
    this.get('.composer-notice-title').textContent = this.state === 'failed' ? 'Couldn’t continue' : labels[this.state];
    this.prompt.setAttribute('aria-label', this.question ? 'Open question' : busy || this.state === 'failed' ? 'Show task details' : 'Type a request');
    this.get('.composer-announcement').textContent = labels[this.state];
  }

  private renderQuestion(): void {
    const question = this.question!;
    this.get('#composer-question-title').textContent = question.title;
    const options = this.get('.composer-options');
    options.replaceChildren();
    for (const [index, option] of question.options.entries()) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'composer-option';
      button.dataset.optionId = option.id;
      button.setAttribute('aria-pressed', 'false');
      const letter = document.createElement('span');
      letter.className = 'composer-option-letter';
      letter.textContent = String.fromCharCode(65 + index);
      const label = document.createElement('span');
      label.textContent = option.label;
      button.append(letter, label);
      button.onclick = () => { this.customAnswer.value = ''; this.setAnswer(option.value); };
      options.appendChild(button);
    }
    this.customAnswer.value = '';
    this.get('.composer-custom').hidden = !question.allowCustom;
    this.get('[data-skip]').hidden = !question.optional;
    this.get('[data-cancel]').hidden = !!question.optional;
    this.get('[data-continue]').textContent = question.kind === 'approval' ? 'Confirm' : 'Continue';
    this.get('.composer-step').textContent = question.total && question.step ? `${question.step} of ${question.total}` : '';
    this.setAnswer('');
  }

  private setAnswer(value: string): void {
    this.answer = value.trim();
    for (const button of this.stage.querySelectorAll<HTMLButtonElement>('.composer-option')) {
      const option = this.question?.options.find((item) => item.id === button.dataset.optionId);
      button.setAttribute('aria-pressed', String(!!this.answer && option?.value.toLocaleLowerCase() === this.answer.toLocaleLowerCase()));
    }
    const option = this.question?.options.find((item) => item.value.toLocaleLowerCase() === this.answer.toLocaleLowerCase());
    const valid = !!this.answer && (!!this.question?.allowCustom || !!option);
    const caption = this.get('.composer-answer');
    caption.hidden = !this.answer;
    caption.textContent = valid ? `Your answer: ${option?.label ?? this.answer}` : 'Choose one of the available answers.';
    this.get<HTMLButtonElement>('[data-continue]').disabled = !valid;
    this.saveDraft();
    if (this.currentPanel === 'question') void this.resize();
  }

  private submitAnswer(): void {
    if (!this.question || this.get<HTMLButtonElement>('[data-continue]').disabled) return;
    const action: ComposerAction = { type: 'answer', questionId: this.question.id, answer: this.answer };
    this.update({ question: null, state: 'thinking', message: this.answer });
    this.emit(action);
  }

  private async openPanel(next: Panel, animate = true): Promise<void> {
    const generation = ++this.generation;
    this.desiredPanel = next;
    const restoreFocus = this.panel.contains(document.activeElement);
    const wasVisible = !this.panel.hidden;
    const previous = getComputedStyle(this.panel);
    const opacity = previous.opacity;
    const transform = previous.transform;
    this.motion?.cancel();
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (!next && !this.panel.hidden && animate && !reduced) {
      this.motion = this.panel.animate([{ opacity }, { opacity: 0 }], { duration: 120, easing: 'ease-out' });
      await this.motion.finished.catch(() => {});
    }
    if (generation !== this.generation) return;
    this.currentPanel = next;
    this.prompt.setAttribute('aria-expanded', String(!!next));
    this.stage.dataset.panel = next ?? '';
    for (const [name, selector] of [['editor', '.composer-editor'], ['question', '.composer-question'], ['notice', '.composer-notice']] as const) {
      this.get(selector).hidden = next !== name;
    }
    this.panel.hidden = !next;
    this.panel.style.setProperty('--panel-width', next === 'question' ? '448px' : '520px');
    await this.resize();
    if (generation !== this.generation) return;
    if (next && animate && !reduced) {
      const direction = this.stage.dataset.placement === 'top' ? -1 : 1;
      this.motion = this.panel.animate([
        { opacity: wasVisible ? opacity : 0, transform: wasVisible ? transform : `translateY(${direction * 5}px)` },
        { opacity: 1, transform: 'translateY(0)' },
      ], { duration: 250, easing: 'cubic-bezier(0.23, 1, 0.32, 1)' });
    }
    if (!next && restoreFocus) this.prompt.focus({ preventScroll: true });
  }

  private appearance(): void {
    this.stage.dataset.placement = store.settings.composer_position;
    this.stage.style.setProperty('--composer-scale', String(store.settings.composer_size / 100));
    this.stage.style.setProperty('--composer-opacity', String(store.settings.composer_opacity / 100));
    this.availableWidth();
    void this.resize();
  }

  private availableWidth(): void {
    const scale = store.settings.composer_size / 100;
    this.stage.style.setProperty('--available-width', `${Math.max(240, innerWidth / scale - 24)}px`);
  }

  private async resize(): Promise<void> {
    if (this.leaving) return;
    const scale = store.settings.composer_size / 100;
    const width = ((this.currentPanel === 'editor' || this.currentPanel === 'notice' ? 520 : 448) + 24) * scale;
    const bodyHeight = this.currentPanel ? Math.min(this.panel.scrollHeight + 2, 400) + 8 : 0;
    const height = (92 + bodyHeight) * scale;
    const key = `${Math.ceil(width)}:${Math.ceil(height)}:${store.settings.composer_position}`;
    if (this.frameKey === key) return;
    this.frameKey = key;
    this.frameUpdates = this.frameUpdates.catch(() => {}).then(() => setComposerFrame(width, height));
    try { await this.frameUpdates; }
    catch { this.frameKey = ''; this.get('.composer-announcement').textContent = 'Couldn’t resize the composer'; }
    this.availableWidth();
  }

  private saveDraft(): void {
    try {
      sessionStorage.setItem('kaji-composer-draft', this.input.value);
      sessionStorage.setItem('kaji-composer-question', JSON.stringify(this.question ? { question: this.question, answer: this.answer } : null));
    } catch {}
  }

  private restoreDraft(): void {
    try { this.input.value = sessionStorage.getItem('kaji-composer-draft') ?? ''; } catch {}
    this.get<HTMLButtonElement>('.composer-editor button[type="submit"]').disabled = !this.input.value.trim();
  }
}

async function initComposer(): Promise<void> {
  await store.init();
  const root = document.getElementById('app');
  if (root) new Composer(root);
}

if (typeof window !== 'undefined') window.addEventListener('DOMContentLoaded', () => { void initComposer(); });
