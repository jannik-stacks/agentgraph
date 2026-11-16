import { Schema } from 'effect';
import { findRequest, makePlugin } from '@jannik-stacks/agi/plugins';

const settings = Schema.Struct({ words: Schema.Array(Schema.String) });

export default makePlugin<typeof settings.Type>({
  name: 'mention',
  settingsSchema: settings,
  on: {
    event: ({ event }, { settings }) => {
      if (event.kind !== 'comment' || event.comment?.agentRequest) return undefined;
      return findRequest(event.comment?.body ?? '', settings.words) ? 'answer' : 'none';
    },
  },
});
