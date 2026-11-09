import { isAbsolute } from 'node:path';
import { Schema } from 'effect';
import { makePlugin } from '../../../src/plugin.ts';
import { DashboardData, DashboardSettings } from './dashboard/data.ts';
import { readDashboard } from './dashboard/read.ts';

export default makePlugin<typeof DashboardSettings.Type, typeof DashboardData.Type>({
  name: 'dashboard',
  settingsSchema: DashboardSettings.check(
    Schema.makeFilter(settings => isAbsolute(settings.data), { message: 'dashboard.data must be an absolute path' })
  ),
  studio: {
    title: 'Dashboard',
    page: new URL('./dashboard/DashboardPage.tsx', import.meta.url),
    dataSchema: DashboardData,
    read: settings => readDashboard(settings),
    watch: settings => [settings.data],
  },
});
