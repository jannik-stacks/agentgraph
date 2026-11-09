import { Effect } from 'effect';
import { makePlugin } from '@jannik-stacks/agi/plugins';
import { DashboardData, DashboardSettings } from './dashboard/data.ts';
import { readDashboard } from './dashboard/read.ts';

export default makePlugin({
  name: 'dashboard',
  settingsSchema: DashboardSettings,
  studio: {
    title: 'Dashboard',
    page: new URL('./dashboard/DashboardPage.tsx', import.meta.url),
    dataSchema: DashboardData,
    read: (settings, hosts) =>
      Effect.forEach(Object.entries(hosts), ([instance, host]) =>
        'why' in host
          ? Effect.succeed({ instance, why: host.why })
          : Effect.map(readDashboard(settings, host), snapshot => ({ instance, ...snapshot }))
      ),
    watch: (_settings, hosts) => Object.values(hosts).flatMap(host => ('why' in host ? [] : [host.data])),
  },
});
