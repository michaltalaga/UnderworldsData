import type { AiClient, ContentPart } from '../ai';
import { completeJson } from '../ai/json';
import type { Limiter } from './limit';

export const png = (data: Buffer): ContentPart => ({ type: 'image', mediaType: 'image/png', data });
export const text = (value: string): ContentPart => ({ type: 'text', text: value });

/** What every reading script shares: the client, the limit on parallel requests, and the counters. */
export interface ReadContext {
  ai: AiClient;
  limiter: Limiter;
}

/** One AI request (plus one repair request if the reply is not valid JSON), within the parallel limit. */
export function askJson<T>(ctx: ReadContext, prompt: ContentPart[], maxTokens = 4000): Promise<T> {
  return ctx.limiter.run(() => completeJson<T>(ctx.ai, { prompt, maxTokens }));
}

export function slugify(value: string): string {
  return value
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/['’]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

export function isInt(value: unknown): value is number {
  return Number.isInteger(value) && (value as number) >= 0;
}
