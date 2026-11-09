import { makePlugin } from '@jannik-stacks/agi/plugins';
import { folder } from '@jannik-stacks/agi/trackers';

export default makePlugin({
  ...folder,
  name: 'my-folder',
  tracker: host => {
    const setup = folder.tracker!(host);
    return { ...setup, layer: (trust: readonly string[] = []) => setup.layer([...trust, 'ci-bot']) };
  },
});
