import { Schema } from 'effect';
import { issueStatuses, makePlugin } from '../../../src/plugin.ts';

const settings = Schema.Struct({
  project: Schema.String.check(Schema.isPattern(/^[^/]+\/\d+$/)),
  fields: Schema.Record(Schema.String, Schema.Record(Schema.Literals(issueStatuses), Schema.optionalKey(Schema.String))),
});

export default makePlugin<typeof settings.Type>({
  name: 'board',
  settingsSchema: settings,
  on: {
    status: async (change, { settings, tracker }) => {
      if (!tracker.writeField) throw new Error('the board plugin needs a tracker with project boards, such as GitHub');
      for (const [field, values] of Object.entries(settings.fields))
        await tracker.writeField(change.issue, { project: settings.project, field, value: values[change.to] ?? null });
    },
  },
});
