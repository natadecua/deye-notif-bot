import { writeFile, rm } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, URL as NodeURL } from 'node:url';
import { join } from 'node:path';
import { errorCode } from '../src/errors.ts';
import { runDeployment } from './ci-deploy.ts';

const root = fileURLToPath(new NodeURL('../', import.meta.url));
const configPath = join(root, 'wrangler.jsonc');
let written = false;
try {
  await runDeployment(process.env, {
    writeConfig: async config => {
      written = true;
      await writeFile(configPath, JSON.stringify(config), { mode: 0o600 });
    },
    deploy: async () => {
      // Wrangler can print bindings/configuration even on success. Keep its output private.
      const result = spawnSync(process.execPath,
        [join(root, 'node_modules/wrangler/bin/wrangler.js'), 'deploy', '--config', configPath],
        { cwd: root, stdio: 'pipe', timeout: 120_000, maxBuffer: 2 * 1024 * 1024 });
      return result.status;
    },
  });
  console.log('Worker deployment command completed. Verify subsequent scheduled readings in Cloudflare.');
} catch (error) {
  console.error(`Deployment failed: ${errorCode(error)}. No configuration or provider output was logged.`);
  process.exitCode = 1;
} finally {
  if (written) await rm(configPath, { force: true });
}
