// What a change may touch and how big it may be. The safety, size and triage-brief checks read these.

/** The paths a change may touch. */
export const paths = ['src/', 'tests/', 'studio/src/', 'studio/seed.ts', 'studio/content/docs/', 'examples/'];

/** The most lines a change may add outside tests/. */
export const maxAddedLines = 300;

/** The most files outside tests/ a change may add to or change. */
export const maxFiles = 8;

/** Whether a file counts toward the caps: test files never do. */
export const capped = path => !path.startsWith('tests/');
