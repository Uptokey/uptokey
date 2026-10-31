import { createUserMessage } from '@deepseek-ai/dsh-llm';
import { createPostEditVerificationHandler } from './post-edit-verification-core.mjs';

export const name = 'uptokey-post-edit-verification';
export const inject = ['tools'];

export function apply(ctx) {
  ctx.on('tools/post-execute', createPostEditVerificationHandler(ctx.tools, createUserMessage));
}
