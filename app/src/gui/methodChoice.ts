import type { PendingQuestion, RuntimeAction } from '../../shared/runtime';

export function taskRequestAction(text: string, conversationId?: string): RuntimeAction {
  return {
    type: 'request',
    text,
    source: 'text',
    ...(conversationId ? { conversationId } : {}),
  };
}

export function methodChoiceAction(question: PendingQuestion, executorId: string, splitScreen: boolean): RuntimeAction {
  return {
    type: 'method',
    taskId: question.taskId,
    questionId: question.id,
    method: executorId,
    splitScreen: !!question.splitScreen?.available && splitScreen,
  };
}
