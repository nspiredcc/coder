import path from 'node:path';
import { cleanupRun, loadTaskCard, prepareRun, verifyRun } from './index.js';

function option(args: string[], name: string): string {
  const index = args.indexOf(name);
  if (index < 0 || !args[index + 1]) throw new Error(`missing required option ${name}`);
  return args[index + 1];
}

async function main(): Promise<void> {
  const [command, ...args] = process.argv.slice(2);
  if (command === 'prepare') {
    const card = await loadTaskCard(option(args, '--card'));
    const result = await prepareRun(card, option(args, '--repo'), args.includes('--work-root') ? option(args, '--work-root') : undefined);
    console.log(JSON.stringify(result, null, 2));
  } else if (command === 'verify') {
    const evidence = await verifyRun(option(args, '--run-dir'), option(args, '--evidence-dir'));
    console.log(JSON.stringify(evidence, null, 2));
    if (evidence.status !== 'VERIFIED') process.exitCode = 1;
  } else if (command === 'cleanup') {
    await cleanupRun(option(args, '--run-dir'));
  } else {
    throw new Error('usage: npm start -- prepare --card card.json --repo /path/to/repo [--work-root dir] | verify --run-dir dir --evidence-dir dir | cleanup --run-dir dir');
  }
}

main().catch(error => { console.error(error instanceof Error ? error.message : error); process.exitCode = 1; });
