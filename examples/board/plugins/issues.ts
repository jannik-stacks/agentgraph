import { Schema } from 'effect';
import { makePlugin, tool } from '@jannik-stacks/agi/plugins';

export default makePlugin({
  name: 'issues',
  tools: {
    issues: tool({
      description: 'Search issues in this repository by keywords',
      inputSchema: Schema.Struct({
        query: Schema.String,
        state: Schema.optional(Schema.Literals(['open', 'closed', 'all'])),
      }),
      execute: async ({ query, state = 'open' }, ctx) =>
        (await ctx.tracker.searchIssues(query, { state, limit: 10 })).map(({ number, title, state, url, body }) => ({
          number,
          title,
          state,
          url,
          body: body.slice(0, 500),
        })),
    }),
  },
});
