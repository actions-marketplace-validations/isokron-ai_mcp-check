import { z } from 'zod';

export const upperTool = {
  name: 'upper_case',
  config: {
    description: 'Returns the text in upper case.',
    inputSchema: { text: z.string().describe('Text to convert') },
    annotations: { readOnlyHint: true },
  },
  handler: async ({ text }: { text: string }) => ({ content: [{ type: 'text' as const, text: text.toUpperCase() }] }),
};
