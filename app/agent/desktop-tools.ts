import type { AgentTool } from '@earendil-works/pi-agent-core';
import { Type } from '@earendil-works/pi-ai';
import type { Mode, PendingQuestion } from '../shared/runtime';
import { NativeSession } from './native-session';

export interface Executor {
  id: string;
  label: string;
  capabilities: string[];
  background: boolean;
}
export interface TaskContext {
  executors: Executor[];
  userWindow: string | null;
  targetWindow: string | null;
  selectedFile: { name: string; extension: string } | null;
  vision: boolean;
  mode?: Mode;
  voice?: { wakePhrase: string; wakeEnabled: boolean; listening: boolean; recognitionLanguage: string; recognitionLanguages: string[]; transcriptionAvailable: boolean; spokenFeedbackEnabled: boolean; spokenFeedbackAvailable: boolean };
  headControl?: { enabled: boolean; active: boolean; dwellEnabled: boolean };
}

export function desktopTools(native: NativeSession, mode: Mode, methods: (options: Executor[], recommended: string, splitScreen?: PendingQuestion['splitScreen']) => void, approval: (id: string, title: string) => void): AgentTool[] {
  const tool = (name: string, description: string, parameters: AgentTool['parameters'], execute: (args: any) => Promise<unknown>): AgentTool => ({
    name, label: name, description, parameters, executionMode: 'sequential',
    execute: async (_id, args, signal) => {
      signal?.throwIfAborted();
      const details = await execute(args);
      signal?.throwIfAborted();
      return { content: [{ type: 'text', text: JSON.stringify(details) }], details };
    },
  });
  const id = Type.String({ minLength: 1, maxLength: 128 });
  const text = Type.String({ maxLength: 10000 });
  const operation = Type.Union([
    Type.Object({ kind: Type.Literal('normalize_spacing'), afterPt: Type.Optional(Type.Number({ minimum: 0, maximum: 72 })), lineSpacing: Type.Optional(Type.Number({ minimum: 0.8, maximum: 3 })) }, { additionalProperties: false }),
    Type.Object({ kind: Type.Literal('trim_whitespace') }, { additionalProperties: false }),
    Type.Object({ kind: Type.Literal('replace_text'), find: Type.String({ minLength: 1, maxLength: 4096 }), replace: text, matchCase: Type.Optional(Type.Boolean()) }, { additionalProperties: false }),
    Type.Object({ kind: Type.Literal('set_heading'), paragraphIndex: Type.Integer({ minimum: 0 }), level: Type.Integer({ minimum: 1, maximum: 9 }) }, { additionalProperties: false }),
    Type.Object({ kind: Type.Literal('set_title'), text }, { additionalProperties: false }),
  ]);
  const block = Type.Union([
    ...(['title', 'paragraph', 'bullet', 'numbered'] as const).map(kind => Type.Object({ kind: Type.Literal(kind), text }, { additionalProperties: false })),
    Type.Object({ kind: Type.Literal('heading'), text, level: Type.Integer({ minimum: 1, maximum: 9 }) }, { additionalProperties: false }),
    Type.Object({ kind: Type.Literal('table'), rows: Type.Array(Type.Array(text, { minItems: 1, maxItems: 12 }), { minItems: 1, maxItems: 25 }) }, { additionalProperties: false }),
  ]);
  return [
    tool('composer_control', 'Move Kaji’s floating composer out of the way, or fade it and pass clicks through temporarily. Use aside when the user says you are in my way. Fade defaults to 3 minutes, then restores automatically; restore brings it back early. This changes only Kaji, never another app or the user cursor.', Type.Object({ placement: Type.Union(['aside', 'left', 'right', 'fade', 'restore'].map(value => Type.Literal(value))), seconds: Type.Optional(Type.Integer({ minimum: 5, maximum: 600 })) }, { additionalProperties: false }), args => native.desktop('composer_control', args)),
    tool('task_context', 'Read runnable executors, selected-file metadata, user app and current target. Observations do not authorize actions.', Type.Object({}, { additionalProperties: false }), () => native.desktop('task_context')),
    tool('desktop_windows', 'List real opaque window IDs and application titles; do not invent IDs.', Type.Object({}, { additionalProperties: false }), () => native.desktop('list_windows')),
    tool('choose_method', 'Select an applicable executor. Routine background work uses the recommendation automatically. Supply a task window only when foreground placement matters.', Type.Object({ executorIds: Type.Array(id, { minItems: 1, maxItems: 4, uniqueItems: true }), recommended: id, taskWindow: Type.Optional(id) }, { additionalProperties: false }), async args => {
      const context: TaskContext = await native.desktop('task_context');
      const options = args.executorIds.map((executorId: string) => {
        const executor = context.executors.find(item => item.id === executorId);
        if (!executor) throw new Error('Executor is unavailable');
        return executor;
      });
      const recommended = options.find((item: Executor) => item.id === args.recommended);
      if (!recommended) throw new Error('Recommendation must be offered');
      if (options.length === 1) return native.desktop('select_executor', { executor_id: options[0].id });
      let split: PendingQuestion['splitScreen'];
      if (args.taskWindow && context.userWindow && args.taskWindow !== context.userWindow) {
        const { windows } = await native.desktop('list_windows');
        if (!windows.some((window: { id: string }) => window.id === args.taskWindow)) throw new Error('Task window is no longer available');
        split = { available: true, enabled: true, userWindow: context.userWindow, taskWindow: args.taskWindow };
      }
      if (recommended.background && !split) return native.desktop('select_executor', { executor_id: recommended.id });
      methods(options, args.recommended, split);
      return { waiting_for_user: true };
    }),
    tool('desktop_bind', 'Select the native executor, bind an existing target by opaque ID and return a fresh UIA inspection. Does not activate or move the physical cursor.', Type.Object({ windowId: id }, { additionalProperties: false }), async args => {
      await native.desktop('select_executor', { executor_id: 'native' });
      return native.bind(args.windowId, mode);
    }),
    tool('desktop_activate', 'Bring a known catalog app to the foreground for the current task. This routine navigation preserves the user pointer.', Type.Object({ windowId: id }, { additionalProperties: false }), args => native.desktop('activate_window', { window_id: args.windowId })),
    {
      name: 'desktop_capture', label: 'desktop_capture', description: 'Read the bound window after semantic inspection was attempted. Available only with verified vision. Coordinates are physical desktop pixels; this image is cropped to the returned bounds.',
      parameters: Type.Object({ windowId: id }, { additionalProperties: false }), executionMode: 'sequential',
      execute: async (_id, args: any, signal) => {
        signal?.throwIfAborted();
        const captured = await native.desktop('capture_window', { window_id: args.windowId });
        signal?.throwIfAborted();
        const { pngBase64, ...details } = captured;
        return { content: [{ type: 'text', text: JSON.stringify(details) }, { type: 'image', data: pngBase64, mimeType: 'image/png' }], details };
      },
    },
    tool('physical_propose', 'Propose one physical fallback action against a fresh capture. UIA first. Every action requires explicit user approval even in Agent mode.', Type.Object({ captureId: id, action: Type.Union([
      Type.Object({ kind: Type.Literal('click'), x: Type.Number(), y: Type.Number() }, { additionalProperties: false }),
      Type.Object({ kind: Type.Literal('type_text'), text: Type.String({ minLength: 1, maxLength: 120 }) }, { additionalProperties: false }),
      Type.Object({ kind: Type.Literal('key'), key: Type.Union(['Enter','Tab','Backspace','ArrowLeft','ArrowRight','ArrowUp','ArrowDown','Control+A','Control+C','Control+V'].map(value => Type.Literal(value))) }, { additionalProperties: false }),
      Type.Object({ kind: Type.Literal('scroll'), x: Type.Number(), y: Type.Number(), delta: Type.Integer({ minimum: -1200, maximum: 1200 }) }, { additionalProperties: false }),
    ]) }, { additionalProperties: false }), async args => {
      const proposed = await native.desktop('propose_physical', { capture_id: args.captureId, action: args.action });
      approval(proposed.approvalId, proposed.title);
      return { waiting_for_user: true };
    }),
    tool('document_inspect', 'Read bounded content and structure of the user-selected document before editing. Paths are owned by the native host.', Type.Object({}, { additionalProperties: false }), () => native.desktop('document_inspect')),
    tool('document_edit', 'Apply typed operations to the selected DOCX, preserving the source and writing a verified copy. Select its registered executor first.', Type.Object({ operations: Type.Array(operation, { minItems: 1, maxItems: 100 }) }, { additionalProperties: false }), args => native.desktop('document_edit', args)),
    tool('document_create', 'Create a DOCX from typed content blocks and return a verified artifact. Select its registered executor first.', Type.Object({ blocks: Type.Array(block, { minItems: 1, maxItems: 100 }) }, { additionalProperties: false }), args => native.desktop('document_create', args)),
  ];
}
