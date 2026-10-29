import { readFile } from 'node:fs/promises';
import { URL as NodeURL } from 'node:url';
import { runSetupWalkthrough } from './setup-walkthrough.ts';
import { errorCode } from '../src/errors.ts';

try {
  // Only the public committed template is read. Never import the live CLI, whose
  // setup adapter reads ignored owner files and can call real services.
  const template = JSON.parse(await readFile(new NodeURL('../wrangler.example.jsonc', import.meta.url), 'utf8'));
  await runSetupWalkthrough(template.vars.MONITOR_CONFIG, text => console.log(text));
} catch (error) {
  console.error(`Synthetic walkthrough failed: ${errorCode(error)}`);
  process.exitCode = 1;
}
