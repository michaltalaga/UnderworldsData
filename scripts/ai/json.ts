import type { AiClient, ChatMessage } from './index';
import { jobNote } from './jobs';

export function stripCodeFences(raw: string): string {
  return raw.replace(/^```json?\n?/, '').replace(/\n?```$/, '').trim();
}

function parseJsonSafe<T>(raw: string): T | null {
  try {
    return JSON.parse(stripCodeFences(raw)) as T;
  } catch {
    return null;
  }
}

/**
 * Sends a prompt that asks for JSON and parses the reply. If the reply is not valid
 * JSON, asks once more with `repairInstruction` and the broken reply attached.
 */
export async function completeJson<T>(
  ai: AiClient,
  options: { prompt: ChatMessage['content']; maxTokens: number; repairInstruction?: string },
): Promise<T> {
  const request: ChatMessage = { role: 'user', content: options.prompt };
  const repairInstruction =
    options.repairInstruction ??
    'Your JSON output was invalid and failed to parse. Return the same content as valid JSON, with all quotes and special characters inside strings properly escaped. Return ONLY the fixed JSON.';

  const rawText = await ai.complete({ messages: [request], maxTokens: options.maxTokens });
  const parsed = parseJsonSafe<T>(rawText);
  if (parsed !== null) return parsed;

  jobNote('reply was not valid JSON, asking for a repaired one');
  const repairText = await ai.complete({
    messages: [request, { role: 'assistant', content: rawText }, { role: 'user', content: repairInstruction }],
    maxTokens: options.maxTokens,
  });
  const repaired = parseJsonSafe<T>(repairText);
  if (repaired !== null) return repaired;

  throw new Error(`Invalid JSON after retry. Last response starts with: ${repairText.substring(0, 200)}...`);
}
