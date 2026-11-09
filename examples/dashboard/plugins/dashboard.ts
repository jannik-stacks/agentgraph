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
    read: readDashboard,
  },
});
