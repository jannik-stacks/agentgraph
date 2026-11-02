import { Schema } from 'effect';
import { issueStatuses, makePlugin } from '../../../src/plugin.ts';

const settings = Schema.Struct({
  project: Schema.String.pipe(Schema.pattern(/^[^/]+\/\d+$/)),
  status: Schema.partial(Schema.Record({ key: Schema.Literal(...issueStatuses), value: Schema.String })),
});

const find = `query($owner: String!, $name: String!, $issue: Int!, $login: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    issue(number: $issue) { id projectItems(first: 100) { nodes { id project { id } } } }
  }
  repositoryOwner(login: $login) {
    ... on ProjectV2Owner {
      projectV2(number: $number) {
        id
        field(name: "Status") { ... on ProjectV2SingleSelectField { id options { id name } } }
      }
    }
  }
}`;
const add = `mutation($project: ID!, $content: ID!) {
  addProjectV2ItemById(input: { projectId: $project, contentId: $content }) { item { id } }
}`;
const move = `mutation($project: ID!, $item: ID!, $field: ID!, $option: String!) {
  updateProjectV2ItemFieldValue(
    input: { projectId: $project, itemId: $item, fieldId: $field, value: { singleSelectOptionId: $option } }
  ) { projectV2Item { id } }
}`;

type Found = {
  repository: { issue: { id: string; projectItems: { nodes: { id: string; project: { id: string } }[] } } };
  repositoryOwner: {
    projectV2: { id: string; field: { id: string; options: { id: string; name: string }[] } | null } | null;
  } | null;
};

export default makePlugin<typeof settings.Type>({
  name: 'board',
  settingsSchema: settings,
  on: {
    status: async (change, { settings, forge }) => {
      const column = settings.status[change.to];
      if (column === undefined) return;
      if (!forge.graphql) throw new Error('the board plugin needs a GitHub forge');
      const [owner, name] = change.repo.split('/');
      const [login, number] = settings.project.split('/');
      const found = (await forge.graphql(find, {
        owner,
        name,
        issue: change.issue,
        login,
        number: Number(number),
      })) as Found;
      const project = found.repositoryOwner?.projectV2;
      const option = project?.field?.options.find(o => o.name === column);
      if (!project?.field || !option) throw new Error(`project ${settings.project} has no Status option ${column}`);
      const { issue } = found.repository;
      const item =
        issue.projectItems.nodes.find(i => i.project.id === project.id)?.id ??
        ((await forge.graphql(add, { project: project.id, content: issue.id })) as {
          addProjectV2ItemById: { item: { id: string } };
        }).addProjectV2ItemById.item.id;
      await forge.graphql(move, { project: project.id, item, field: project.field.id, option: option.id });
    },
  },
});
