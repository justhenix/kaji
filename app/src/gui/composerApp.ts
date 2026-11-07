import { AgentMark, type AgentState } from './components/AgentMark';
import { dispatchRuntime, onRuntimeUpdate, openMainWindow, openSettingsWindow, setComposerFrame, startWindowDrag } from './ipc';
import { store } from './store';
import type { ArtifactReference, PendingQuestion, RuntimeAction, RuntimeSnapshot } from '../../shared/runtime';
import { taskRequestAction } from './methodChoice';
import { dwellFeedback, isFreshRuntimeSnapshot } from './runtimeState';

export interface ComposerQuestion {
  id: string;
  title: string;
  options: { id: string; label: string; value: string }[];
  allowCustom?: boolean;
  optional?: boolean;
  kind?: PendingQuestion['kind'];
  taskId?: string;
  splitScreen?: PendingQuestion['splitScreen'];
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
  voicePhase?: RuntimeSnapshot['voice']['phase'];
  speechPending?: boolean;
  failureSettings?: 'voice' | 'head' | null;
  dwellEnabled?: boolean;
  dwellReady?: boolean;
  headSessionId?: number;
  headPhase?: string;
  headReason?: string;
  dwellTarget?: string;
  dwellProgress?: number;
  attachments?: ArtifactReference[];
}

export type ComposerAction =
  | { type: 'request'; text: string }
  | { type: 'listen' | 'dwell'; enabled: boolean }
  | { type: 'file.select' }
  | { type: 'artifact.open'; artifactId: string }
  | { type: 'answer'; taskId: string; questionId: string; answer: string }
  | { type: 'confirm'; taskId: string; questionId: string; approved: boolean }
  | { type: 'method'; taskId: string; questionId: string; method: string; splitScreen: boolean }
  | { type: 'dismiss' | 'skip'; taskId: string; questionId: string }
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
  private dwellEnabled = false;
  private dwellReady = false;
  private dwellCheckTimer: ReturnType<typeof setTimeout> | undefined;
  private headPhase = 'stopped';
  private headReason = '';
  private splitScreen = true;
  private generation = 0;
  private motion: Animation | null = null;
  private frameKey = '';
  private frameUpdates = Promise.resolve();
  private leaving = false;
  private replyTaskId: string | null = null;
  private replyTimer: ReturnType<typeof setTimeout> | undefined;
  private voicePhase: RuntimeSnapshot['voice']['phase'] = 'off';
  private speechPending = false;
  private failureSettings: 'voice' | 'head' | null = null;

  constructor(root: HTMLElement) {
    this.stage.className = 'composer-stage';
    this.stage.setAttribute('aria-label', 'Kaji composer');
    this.stage.innerHTML = `
      <section class="composer-panel" hidden>
        <form class="composer-editor" hidden aria-label="Type a request">
          <label class="sr-only" for="composer-input">Your request</label>
          <textarea id="composer-input" placeholder="Type a request…" rows="2" spellcheck="true"></textarea>
          <div class="composer-attachments" aria-live="polite" hidden></div>
          <div class="composer-editor-footer">
            <span class="composer-key-hint">Enter to send</span>
            <button class="composer-secondary composer-attach" type="button" data-attach><i class="ri-attachment-2" aria-hidden="true"></i> Attach file</button>
            <button class="composer-primary" type="submit" disabled>Send <i class="ri-arrow-up-line" aria-hidden="true"></i></button>
          </div>
        </form>
        <section class="composer-question" hidden aria-labelledby="composer-question-title">
          <header class="composer-question-header">
            <h2 id="composer-question-title"></h2>
            <button class="composer-icon" type="button" data-dismiss aria-label="Dismiss question" title="Dismiss question"><i class="ri-close-line" aria-hidden="true"></i></button>
          </header>
          <div class="composer-options" role="group" aria-label="Answer options"></div>
          <label class="composer-split-option" hidden><input type="checkbox" checked /><span></span></label>
          <label class="composer-custom" hidden>
            <span class="sr-only">Your answer</span>
            <input type="text" placeholder="Another answer…" autocomplete="off" />
          </label>
          <p class="composer-answer" role="status" aria-live="polite" hidden></p>
          <footer class="composer-question-footer">
            <span class="composer-step"></span>
            <button class="composer-secondary" type="button" data-skip hidden>Skip</button>
            <button class="composer-secondary" type="button" data-rephrase hidden>Ask differently</button>
            <button class="composer-secondary" type="button" data-cancel>Cancel</button>
            <button class="composer-primary" type="button" data-continue disabled>Continue</button>
          </footer>
        </section>
        <section class="composer-notice" hidden>
          <div class="composer-notice-header"><span class="composer-notice-title"></span>
            <button class="composer-icon" type="button" data-collapse aria-label="Collapse details" title="Collapse details"><i class="ri-subtract-line" aria-hidden="true"></i></button>
          </div>
          <p class="composer-notice-text" role="status"></p>
          <div class="composer-reply-files" hidden></div>
          <button class="composer-secondary" type="button" data-edit-request hidden>Edit request</button>
          <button class="composer-secondary" type="button" data-failure-settings hidden></button>
          <button class="composer-secondary" type="button" data-retry-dwell hidden>Try dwell again</button>
        </section>
      </section>
      <div class="composer-pill" data-tauri-drag-region>
        <span class="composer-brand" title="Drag to move"></span>
        <button class="composer-prompt" type="button" aria-label="Type a request" aria-expanded="false" aria-controls="composer-panel"><span>Ask Kaji…</span></button>
        <span class="composer-divider" aria-hidden="true"></span>
        <button class="composer-icon composer-voice" type="button" data-dwell-id="voice" aria-label="Start listening" title="Start listening" aria-pressed="false"><i class="ri-mic-line" aria-hidden="true"></i></button>
        <button class="composer-icon composer-dwell" type="button" data-dwell-id="dwell" aria-label="Start dwell" title="Start dwell with head control" aria-pressed="false"><i class="ri-cursor-line" aria-hidden="true"></i><span class="composer-dwell-copy"><span>Dwell</span><span class="composer-dwell-status">Off</span></span></button>
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
    this.get('.composer-brand').onpointerdown = (event) => {
      if (event.button !== 0) return;
      event.stopPropagation();
      void startWindowDrag();
    };
    this.prompt.onclick = (event) => {
      const intent = this.recordingVoice || this.state === 'failed' ? 'notice' : this.question ? 'question' : ['working', 'thinking'].includes(this.state) ? 'notice' : 'editor';
      const next = this.desiredPanel === intent ? null : intent;
      if (next === 'question') { this.state = 'question'; this.renderState(); }
      void this.openPanel(next, event.detail > 0).then(() => {
        if (next === 'editor') this.input.focus({ preventScroll: true });
      });
    };
    this.voice.onclick = () => {
      if (this.recordingVoice) {
        this.emit({ type: 'listen', enabled: false });
        return;
      }
      if (this.state === 'thinking' || this.state === 'working') {
        this.emit({ type: 'stop' });
        void this.openPanel(null, false);
        return;
      }
      this.emit({ type: 'listen', enabled: true });
    };
    this.dwell.onclick = () => {
      this.emit({ type: 'dwell', enabled: !this.dwellEnabled });
    };
    this.get<HTMLButtonElement>('[data-retry-dwell]').onclick = () => {
      this.emit({ type: 'dwell', enabled: true });
      void this.openPanel(null, false);
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
    this.get<HTMLButtonElement>('[data-attach]').onclick = () => this.emit({ type: 'file.select' });
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
        if (this.question?.taskId) this.emit({ type: 'dismiss', taskId: this.question.taskId, questionId: this.question.id });
        this.saveDraft();
        void this.openPanel(null, event.detail > 0);
      };
    }
    this.get<HTMLButtonElement>('[data-collapse]').onclick = (event) => { void this.openPanel(null, event.detail > 0); };
    this.get<HTMLButtonElement>('[data-edit-request]').onclick = () => {
      void this.openPanel('editor').then(() => this.input.focus({ preventScroll: true }));
    };
    this.get<HTMLButtonElement>('[data-failure-settings]').onclick = async () => {
      if (!this.failureSettings || this.leaving) return;
      this.leaving = true;
      try {
        await this.frameUpdates;
        await openSettingsWindow(this.failureSettings);
      } catch {
        this.leaving = false;
        this.update({ state: 'failed', message: 'Couldn’t open settings. Try again.' });
      }
    };
    this.get<HTMLButtonElement>('[data-skip]').onclick = () => {
      if (!this.question?.optional) return;
      const questionId = this.question.id;
      const taskId = this.question.taskId;
      this.update({ question: null, state: 'ready' });
      if (taskId) this.emit({ type: 'skip', taskId, questionId });
    };
    this.get<HTMLButtonElement>('[data-rephrase]').onclick = () => {
      if (this.question?.kind !== 'method' || !this.question.taskId) return;
      const question = this.question;
      const taskId = question.taskId;
      if (!taskId) return;
      this.update({ question: null, state: 'ready' });
      this.emit({ type: 'method', taskId, questionId: question.id, method: 'rephrase', splitScreen: false });
    };
    this.get<HTMLButtonElement>('[data-continue]').onclick = () => this.submitAnswer();
    window.addEventListener('kaji:composer-update', ((event: CustomEvent<ComposerUpdate>) => this.update(event.detail)) as EventListener);
    window.addEventListener('resize', () => this.availableWidth());
    window.addEventListener('keydown', (event) => {
      if (event.key !== 'Escape' || !this.currentPanel) return;
      if (this.question && this.currentPanel === 'question') {
        if (this.question.taskId) this.emit({ type: 'dismiss', taskId: this.question.taskId, questionId: this.question.id });
      }
      void this.openPanel(null, false).then(() => this.prompt.focus({ preventScroll: true }));
    });
  }

  update(update: ComposerUpdate): void {
    if (update.questionId && update.questionId !== this.question?.id) return;
    const speechWasBusy = this.speechPending || this.voicePhase === 'speaking';
    const wasDwellReady = this.dwellReady && this.dwellEnabled && this.headPhase === 'tracking';
    const showFailure = update.state === 'failed' && this.state !== 'failed';
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
    if (update.voicePhase !== undefined) this.voicePhase = update.voicePhase;
    if (update.speechPending !== undefined) this.speechPending = update.speechPending;
    if (this.state !== 'ready' || this.question || this.speechPending || this.voicePhase === 'speaking') clearTimeout(this.replyTimer);
    else if (speechWasBusy && this.replyTaskId) this.scheduleReplyDismiss();
    if (update.failureSettings !== undefined) this.failureSettings = update.failureSettings;
    if (update.message !== undefined) this.get('.composer-notice-text').textContent = update.message;
    if (update.transcript !== undefined) {
      this.prompt.querySelector('span')!.textContent = update.transcript || this.statusLabel();
      this.prompt.dataset.transcript = update.transcript ? 'true' : 'false';
    } else if (update.state || update.question !== undefined) delete this.prompt.dataset.transcript;
    if (update.answer !== undefined && this.question) this.setAnswer(update.answer);
    if (update.dwellEnabled !== undefined) this.dwellEnabled = update.dwellEnabled;
    if (update.dwellReady !== undefined) this.dwellReady = update.dwellReady;
    if (update.headPhase !== undefined) this.headPhase = update.headPhase;
    if (update.headReason !== undefined) this.headReason = update.headReason;
    if (update.attachments !== undefined) this.renderAttachments(update.attachments);
    if (update.dwellProgress !== undefined) {
      for (const element of this.stage.querySelectorAll<HTMLElement>('[data-dwell-id]')) {
        const active = element.dataset.dwellId === update.dwellTarget && update.dwellProgress > 0;
        element.dataset.dwelling = String(active);
        element.style.setProperty('--dwell-progress', active ? `${Math.max(0, Math.min(1, update.dwellProgress)) * 360}deg` : '0deg');
      }
    }
    if (update.state || update.question !== undefined || update.dwellEnabled !== undefined || update.dwellReady !== undefined || update.headPhase !== undefined || update.headReason !== undefined) this.renderState();
    if (update.audioLevel !== undefined) this.mark.setAudioLevel(this.voicePhase === 'listening' ? update.audioLevel : 0);
    if (update.question !== undefined || update.answer !== undefined) this.saveDraft();
    if (showFailure && this.desiredPanel === 'notice') void this.openPanel(null, false);
    if (this.headPhase !== 'tracking' || !this.dwellEnabled || this.state !== 'ready') {
      clearTimeout(this.dwellCheckTimer);
      delete this.mark.element.dataset.dwellCheck;
    } else if (this.dwellReady && !wasDwellReady) {
      clearTimeout(this.dwellCheckTimer);
      this.mark.element.dataset.dwellCheck = 'true';
      this.get('.composer-announcement').textContent = 'Dwell ready. Hold still to click.';
      this.dwellCheckTimer = setTimeout(() => { delete this.mark.element.dataset.dwellCheck; }, 3000);
    }
  }

  private renderAttachments(attachments: ArtifactReference[]): void {
    const list = this.get('.composer-attachments');
    list.replaceChildren();
    for (const artifact of attachments) {
      const item = document.createElement('span'); item.className = 'composer-attachment';
      const icon = document.createElement('i'); icon.className = 'ri-attachment-2'; icon.setAttribute('aria-hidden', 'true');
      const name = document.createElement('span'); name.textContent = artifact.name;
      item.append(icon, name); list.append(item);
    }
    list.hidden = attachments.length === 0;
    void this.resize();
  }

  private statusLabel(): string {
    if (this.state === 'failed' && this.failureSettings === 'head') return 'Dwell unavailable';
    if (this.state === 'failed' && this.failureSettings === 'voice') return 'Mic unavailable';
    if (this.voicePhase === 'starting') return 'Opening mic…';
    if (this.voicePhase === 'wake' && this.state === 'ready') return 'Say “Hey Kaji”…';
    return this.voicePhase === 'transcribing' ? 'Transcribing…' : labels[this.state];
  }

  private get recordingVoice(): boolean {
    return this.voicePhase === 'starting' || this.voicePhase === 'listening' || this.voicePhase === 'transcribing';
  }

  private renderState(): void {
    this.stage.dataset.state = this.state;
    this.mark.setState(this.state);
    if (this.prompt.dataset.transcript !== 'true') this.prompt.querySelector('span')!.textContent = this.statusLabel();
    const busy = this.state === 'thinking' || this.state === 'working';
    const listening = this.recordingVoice;
    const label = listening ? 'Cancel recording' : busy ? 'Stop task' : this.voicePhase === 'wake' ? 'Speak now' : 'Start listening';
    this.voice.setAttribute('aria-label', label);
    this.voice.title = this.voicePhase === 'wake' && !busy ? 'Listening for “Hey Kaji”. Click to speak now.' : label;
    this.voice.setAttribute('aria-pressed', String(listening));
    this.voice.querySelector('i')!.className = listening ? 'ri-mic-fill' : busy ? 'ri-stop-line' : 'ri-mic-line';
    this.dwell.setAttribute('aria-pressed', String(this.dwellEnabled));
    this.dwell.setAttribute('aria-label', this.dwellEnabled ? 'Stop dwell' : 'Start dwell');
    const feedback = dwellFeedback({enabled:this.dwellEnabled, dwellEnabled:this.dwellEnabled, dwellReady:this.dwellReady, phase:this.headPhase, reason:this.headReason});
    this.dwell.dataset.ready = String(this.dwellReady && this.dwellEnabled);
    this.dwell.querySelector('.composer-dwell-status')!.textContent = feedback.status;
    this.dwell.title = feedback.hint;
    this.get('.composer-notice-title').textContent = listening ? this.statusLabel() : this.state === 'failed' ? this.failureSettings === 'head' ? 'Dwell unavailable' : 'Couldn’t continue' : this.replyTaskId ? 'Kaji’s reply' : labels[this.state];
    this.get('[data-edit-request]').hidden = this.state !== 'failed' || this.failureSettings !== null;
    const settings = this.get('[data-failure-settings]');
    settings.hidden = this.state !== 'failed' || this.failureSettings === null;
    settings.textContent = this.failureSettings === 'head' ? 'Head Control' : 'Voice & Audio';
    this.get('[data-retry-dwell]').hidden = this.state !== 'failed' || this.failureSettings !== 'head';
    this.prompt.setAttribute('aria-label', listening ? 'Show recording status' : this.state === 'failed' ? 'Show error details' : this.question ? 'Open question' : busy ? 'Show task details' : 'Type a request');
    if (this.mark.element.dataset.dwellCheck !== 'true') this.get('.composer-announcement').textContent = this.statusLabel();
  }

  private renderQuestion(): void {
    const question = this.question!;
    this.get('#composer-question-title').textContent = question.title;
    const options = this.get('.composer-options');
    options.replaceChildren();
    const choices = this.questionOptions();
    for (const [index, option] of choices.entries()) {
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
    const splitOption = this.get<HTMLLabelElement>('.composer-split-option');
    const split = question.splitScreen;
    splitOption.hidden = question.kind !== 'method' || !split?.available;
    this.splitScreen = !!split?.available && split.enabled;
    if (!splitOption.hidden && split) {
      const checkbox = splitOption.querySelector<HTMLInputElement>('input')!;
      checkbox.checked = split.enabled;
      splitOption.querySelector('span')!.textContent = `Split screen: ${split.userWindow} | ${split.taskWindow}`;
      checkbox.onchange = () => { this.splitScreen = checkbox.checked; };
    }
    this.customAnswer.value = '';
    this.get('.composer-custom').hidden = !question.allowCustom;
    this.get('[data-skip]').hidden = !question.optional;
    this.get('[data-rephrase]').hidden = question.kind !== 'method' || question.options.some((option) => option.value === 'rephrase');
    this.get('[data-cancel]').hidden = !!question.optional && question.kind !== 'method';
    this.get('[data-continue]').textContent = question.kind === 'approval' ? 'Confirm' : 'Continue';
    this.get('.composer-step').textContent = question.total && question.step ? `${question.step} of ${question.total}` : '';
    this.setAnswer('');
  }

  private setAnswer(value: string): void {
    this.answer = value.trim();
    const choices = this.questionOptions();
    for (const button of this.stage.querySelectorAll<HTMLButtonElement>('.composer-option')) {
      const option = choices.find((item) => item.id === button.dataset.optionId);
      button.setAttribute('aria-pressed', String(!!this.answer && option?.value.toLocaleLowerCase() === this.answer.toLocaleLowerCase()));
    }
    const option = choices.find((item) => item.value.toLocaleLowerCase() === this.answer.toLocaleLowerCase());
    const valid = !!this.answer && (!!this.question?.allowCustom || !!option || (this.question?.kind === 'approval' && ['approve', 'reject'].includes(this.answer)));
    const caption = this.get('.composer-answer');
    caption.hidden = !this.answer;
    caption.textContent = valid ? `Your answer: ${option?.label ?? this.answer}` : 'Choose one of the available answers.';
    this.get<HTMLButtonElement>('[data-continue]').disabled = !valid;
    this.saveDraft();
    if (this.currentPanel === 'question') void this.resize();
  }

  private questionOptions(): ComposerQuestion['options'] {
    if (this.question?.kind === 'approval') return [
      { id: 'approve', label: 'Approve', value: 'approve' },
      { id: 'reject', label: 'Reject', value: 'reject' },
    ];
    return this.question?.options ?? [];
  }

  private submitAnswer(): void {
    if (!this.question || this.get<HTMLButtonElement>('[data-continue]').disabled) return;
    const question = this.question;
    const taskId = question.taskId;
    if (!taskId) return;
    const action: ComposerAction = question.kind === 'approval'
      ? { type: 'confirm', taskId, questionId: question.id, approved: this.answer === 'approve' }
      : question.kind === 'method'
        ? { type: 'method', taskId, questionId: question.id, method: this.answer, splitScreen: this.splitScreen }
        : { type: 'answer', taskId, questionId: question.id, answer: this.answer };
    this.update({ question: null, state: 'thinking', message: this.answer });
    this.emit(action);
  }

  restoreRequest(text: string): void {
    this.input.value = text;
    this.saveDraft();
    this.get<HTMLButtonElement>('.composer-editor button[type="submit"]').disabled = !text.trim();
    void this.openPanel('editor').then(() => this.input.focus({ preventScroll: true }));
  }

  clearSubmittedRequest(text: string): void {
    if (this.input.value.trim() !== text) return;
    this.input.value = '';
    this.saveDraft();
    this.get<HTMLButtonElement>('.composer-editor button[type="submit"]').disabled = true;
  }

  showReply(taskId: string | null, artifacts: ArtifactReference[]): void {
    if (taskId === this.replyTaskId) return;
    clearTimeout(this.replyTimer);
    this.replyTaskId = taskId;
    const files = this.get('.composer-reply-files');
    files.replaceChildren();
    files.hidden = !taskId || !artifacts.length;
    if (!taskId) return;
    for (const artifact of artifacts) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'composer-secondary';
      button.textContent = artifact.name;
      button.onclick = () => this.emit({ type: 'artifact.open', artifactId: artifact.id });
      files.append(button);
    }
    this.renderState();
    void this.openPanel('notice');
    if (!this.speechPending && this.voicePhase !== 'speaking') this.scheduleReplyDismiss();
  }

  private scheduleReplyDismiss(): void {
    clearTimeout(this.replyTimer);
    const taskId = this.replyTaskId;
    this.replyTimer = setTimeout(() => {
      if (this.replyTaskId === taskId && this.state === 'ready' && !this.question && this.desiredPanel === 'notice') void this.openPanel(null);
    }, 3000);
  }

  private async openPanel(next: Panel, animate = true): Promise<void> {
    if (next === this.desiredPanel) return this.frameUpdates;
    const generation = ++this.generation;
    this.desiredPanel = next;
    const restoreFocus = this.panel.contains(document.activeElement);
    const wasVisible = !this.panel.hidden;
    const previous = getComputedStyle(this.panel);
    const opacity = previous.opacity;
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
    if (next && animate && !reduced) {
      this.motion = this.panel.animate([
        { opacity: wasVisible ? opacity : 0 },
        { opacity: 1 },
      ], { duration: 160, easing: 'cubic-bezier(0.23, 1, 0.32, 1)' });
    }
    await this.resize();
    if (generation !== this.generation) return;
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
  if (!root) return;
  const composer = new Composer(root);
  let current: RuntimeSnapshot | null = null;
  let revision = -1;
  const apply = (snapshot: RuntimeSnapshot) => {
    if (!isFreshRuntimeSnapshot(snapshot, revision)) return;
    const questionChanged = snapshot.question?.id !== current?.question?.id;
    current = snapshot;
    revision = snapshot.revision;
    const phase = snapshot.task?.phase;
    const headFault = dwellFeedback(snapshot.head).failed;
    const state: AgentState = phase === 'paused' || snapshot.head.phase === 'paused' ? 'paused'
      : snapshot.voice.phase === 'error' ? 'failed'
      : snapshot.voice.phase === 'starting' ? 'thinking'
      : snapshot.voice.phase === 'listening' ? 'listening'
      : snapshot.voice.phase === 'transcribing' ? 'thinking'
      : snapshot.question ? 'question'
      : phase === 'error' || phase === 'blocked' ? 'failed'
      : phase === 'planning' ? 'thinking'
      : phase === 'working' || phase === 'verifying' ? 'working'
      : headFault ? 'failed'
      : 'ready';
    const failureSettings = snapshot.voice.phase === 'error' ? 'voice'
      : state === 'failed' && headFault && phase !== 'error' && phase !== 'blocked' ? 'head' : null;
    const pending = snapshot.question;
    const question: ComposerQuestion | null = pending ? {
      id: pending.id,
      taskId: pending.taskId,
      title: pending.title,
      kind: pending.kind,
      options: pending.options,
      allowCustom: pending.allowCustom,
      optional: pending.optional,
      splitScreen: pending.splitScreen,
    } : null;
    composer.update({
      state,
      message: snapshot.voice.phase === 'starting' ? 'Waiting for audio from your microphone.'
        : snapshot.voice.phase === 'listening' ? 'Speak now. Pause when you’re done to send.'
        : snapshot.voice.phase === 'transcribing' ? 'Turning your speech into a request.'
        : snapshot.voice.phase === 'error' ? snapshot.voice.reason
        : failureSettings === 'head' ? (snapshot.head.reason.includes('manual takeover')
          ? 'Mouse or keyboard input stopped dwell. Start Dwell again and hold still to calibrate.'
          : snapshot.head.reason)
        : snapshot.task?.message || snapshot.message,
      failureSettings,
      transcript: ['starting', 'listening', 'transcribing', 'error'].includes(snapshot.voice.phase) ? '' : snapshot.voice.transcript,
      voicePhase: snapshot.voice.phase,
      speechPending: !!snapshot.voice.pendingSpeech,
      ...(questionChanged ? { question } : {}),
      audioLevel: snapshot.voice.audioLevel,
      attachments: snapshot.task?.artifacts ?? [],
      dwellEnabled: snapshot.head.enabled && snapshot.head.dwellEnabled,
      dwellReady: snapshot.head.dwellReady,
      headSessionId: snapshot.head.sessionId,
      headPhase: snapshot.head.phase,
      headReason: snapshot.head.reason,
      dwellProgress: snapshot.overlay.dwellProgress,
      dwellTarget: undefined,
    });
    composer.showReply(phase === 'complete' && snapshot.task ? snapshot.task.id : null, snapshot.task?.artifacts ?? []);
  };
  const unlisten = onRuntimeUpdate(apply, () => composer.update({ state: 'failed', message: 'Kaji runtime is unavailable.' }));
  const onAction = async (event: Event) => {
    const action = (event as CustomEvent<ComposerAction>).detail;
    let command: RuntimeAction;
    switch (action.type) {
      case 'request': command = taskRequestAction(action.text, current?.activeConversationId ?? undefined); break;
      case 'listen': command = { type: 'listen', enabled: action.enabled, immediate: true }; break;
      case 'dwell': command = { type: 'dwell', enabled: action.enabled }; break;
      case 'file.select': command = { type: 'file.select' }; break;
      case 'artifact.open': command = action; break;
      case 'answer': command = { type: 'answer', taskId: action.taskId, questionId: action.questionId, answer: action.answer }; break;
      case 'confirm': command = { type: 'confirm', taskId: action.taskId, questionId: action.questionId, approved: action.approved }; break;
      case 'method': command = { type: 'method', taskId: action.taskId, questionId: action.questionId, method: action.method, splitScreen: action.splitScreen }; break;
      case 'dismiss': case 'skip': command = { type: action.type, taskId: action.taskId, questionId: action.questionId }; break;
      case 'stop': command = { type: 'stop', taskId: current?.task?.id }; break;
    }
    const rephrase = action.type === 'method' && action.method === 'rephrase';
    const originalRequest = current?.task?.request ?? '';
    try {
      const snapshot = await dispatchRuntime(command);
      apply(snapshot);
      if (action.type === 'request' && snapshot.task?.request === action.text) composer.clearSubmittedRequest(action.text);
      if (rephrase) composer.restoreRequest(snapshot.task?.request || originalRequest);
    } catch (error) {
      composer.update({ state: 'failed', message: error instanceof Error ? error.message : 'Could not reach Kaji runtime.' });
    }
  };
  window.addEventListener('kaji:composer-action', onAction);
  window.addEventListener('pagehide', () => { unlisten(); window.removeEventListener('kaji:composer-action', onAction); }, { once: true });
  await unlisten.ready;
}

if (typeof window !== 'undefined') window.addEventListener('DOMContentLoaded', () => { void initComposer(); });
