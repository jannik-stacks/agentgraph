import { Schema } from 'effect';
import { issueStatuses, makePlugin } from '../../../src/plugin.ts';

const settings = Schema.Struct({
  project: Schema.String.check(Schema.isPattern(/^[^/]+\/\d+$/)),
  status: Schema.Record(Schema.Literals(issueStatuses), Schema.optionalKey(Schema.String)),
});

export default makePlugin<typeof settings.Type>({
  name: 'board',
  settingsSchema: settings,
  on: {
    status: async (change, { settings, tracker }) => {
      const name = settings.status[change.to];
      if (name === undefined) return;
      if (!tracker.moveToColumn) throw new Error('the board plugin needs a tracker with project boards, such as GitHub');
      await tracker.moveToColumn(change.issue, { project: settings.project, name });
    },
  },
});
