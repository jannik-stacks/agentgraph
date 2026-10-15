import { homedir } from 'node:os';
import { join } from 'node:path';
import { Config, Effect } from 'effect';

/**
 * The process settings from the environment: the one data path (`BOTHUB_DATA`), the address the runner listens on
 * (`BOTHUB_LISTEN`, `BOTHUB_PORT`) and where clients find it (`BOTHUB_URL`).
 */
export const Settings = Config.all({
  data: Config.string('BOTHUB_DATA').pipe(Config.withDefault(join(homedir(), '.bothub'))),
  listen: Config.string('BOTHUB_LISTEN').pipe(Config.withDefault('127.0.0.1')),
  port: Config.integer('BOTHUB_PORT').pipe(Config.withDefault(5181)),
  url: Config.string('BOTHUB_URL').pipe(Config.withDefault('http://127.0.0.1:5181')),
});

/** The settings now. */
export const settings = () => Effect.runSync(Settings);
