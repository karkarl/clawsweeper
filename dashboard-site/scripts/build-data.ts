// Build src/data/dashboard.json for one static dashboard deploy.
//
//   node scripts/build-data.ts --records <hydrated records dir> --state <state dir>
//
// Inputs: canonical records hydrated from the Worker (R2 snapshots), the public Worker
// APIs for live queue and coverage, and an incremental GitHub Actions history kept in the
// state directory between runs. Tokens: GITHUB_TOKEN for incremental reads and repository
// visibility; BOOTSTRAP_GITHUB_TOKEN (optional, higher rate limit) when no history exists yet.
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { loadActionsState, refreshActions, saveActionsState, summarizeActions } from './actions.ts';
import { aggregateRecords, type Visibility } from './records.ts';

const ORIGIN = 'https://clawsweeper.openclaw.ai';
const site = new URL('../', import.meta.url).pathname;

const { values } = parseArgs({ options: { records: { type: 'string' }, state: { type: 'string' } } });
if (!values.records || !values.state) throw new Error('usage: build-data.ts --records <dir> --state <dir>');
const stateDir = values.state;
await mkdir(stateDir, { recursive: true });

const token = process.env.GITHUB_TOKEN;
if (!token) throw new Error('GITHUB_TOKEN is required');

async function readJson<T>(path: string, fallback: T): Promise<T> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as T;
  } catch {
    return fallback;
  }
}

async function publicApi(path: string) {
  const response = await fetch(`${ORIGIN}${path}`, { headers: { Accept: 'application/json' } });
  if (!response.ok) throw new Error(`${path}: HTTP ${response.status}`);
  return response.json();
}

const visibilityPath = join(stateDir, 'visibility.json');
const visibility = await readJson<Visibility>(visibilityPath, {});
const corpus = await aggregateRecords(values.records, visibility, token);
await writeFile(visibilityPath, JSON.stringify(visibility));

const actionsPath = join(stateDir, 'actions.json');
const previous = await loadActionsState(actionsPath);
const actionsState = await refreshActions(previous, previous ? token : (process.env.BOOTSTRAP_GITHUB_TOKEN ?? token));
await saveActionsState(actionsPath, actionsState);

const [queue, coverage] = await Promise.all([publicApi('/api/exact-review-queue'), publicApi('/api/review-coverage')]);

const dashboard = {
  generatedAt: new Date().toISOString(),
  queue,
  coverage,
  actions: summarizeActions(actionsState),
  corpus,
};
await mkdir(join(site, 'src/data'), { recursive: true });
await writeFile(join(site, 'src/data/dashboard.json'), JSON.stringify(dashboard));
console.log(
  JSON.stringify({
    records: corpus.totals.records,
    repositories: corpus.totals.repositories,
    workflows: dashboard.actions.workflows.length,
    actionsFrom: dashboard.actions.coveredFrom,
  }),
);
