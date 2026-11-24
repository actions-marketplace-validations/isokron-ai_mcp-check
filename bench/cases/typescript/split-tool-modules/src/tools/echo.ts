import { z } from 'zod';

export const echoTool = {
  name: 'echo_text',
  config: {
    description: 'Returns the text it is given.',
    inputSchema: { text: z.string().describe('Text to return') },
    annotations: { readOnlyHint: true },
  },
  handler: async ({ text }: { text: string }) => ({ content: [{ type: 'text' as const, text }] }),
};
