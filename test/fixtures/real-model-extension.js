import { Type } from '@earendil-works/pi-ai';

export default function fixture(pi) {
  pi.registerTool({ name: 'acceptance_question', label: 'Acceptance question',
    description: 'Ask the user for the acceptance token through a native input dialog. Call this when instructed.',
    parameters: Type.Object({}),
    execute: async (_id, _params, _signal, _update, ctx) => ({
      content: [{ type: 'text', text: (await ctx.ui.input('Acceptance token', 'Enter test token')) ?? 'Cancelled' }], details: {},
    }),
  });
}
