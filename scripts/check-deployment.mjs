#!/usr/bin/env node
// Static deployment contract checks. No Docker or Linux runtime is required.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = new URL('../', import.meta.url);
const read = path => readFileSync(new URL(path, root), 'utf8');
const failures = [];

function require(condition, message) {
  if (!condition) failures.push(message);
}

const dockerfile = read('Dockerfile');
const dockerfileDirectives = dockerfile.split('\n').filter(line => !line.trimStart().startsWith('#')).join('\n');
const compose = read('docker-compose.yaml');
const buildCompose = read('docker-compose.build.yaml');
const envExample = read('.env.example');
const ci = read('.cnb.yml');

require(/FROM node:/.test(dockerfile), 'Dockerfile must start from a pinned Node image');
require(!/executor/.test(dockerfileDirectives), 'business image must not embed the terminal executor');
require(/HEALTHCHECK/.test(dockerfile), 'business image needs a health check');
require(!/docker\.sock/.test(dockerfile), 'business image must not reference a Docker socket');

require(!/^\s+build:/m.test(compose), 'production compose must not build');
require(!/^\s+depends_on:/m.test(compose), 'business stack must not depend on another stack');
require(/^\s+build:/m.test(buildCompose), 'the development override must hold the build directive');
require(/start_period:/.test(compose), 'health check must use the underscore start_period key');
require(!/start-period:/.test(compose), 'kebab-case health check keys are rejected by Compose');
require(/network_mode: host/.test(compose), 'business container keeps host networking for local MySQL and executor URLs');
require(/com.centurylinklabs.watchtower.scope: qfli-server/.test(compose), 'business update scope must be qfli-server');
require(!/qfli-terminal/.test(compose.replace(/QFLI_TERMINAL_[A-Z_]+/g, '')), 'business compose must not define a terminal service');

const serverService = compose.slice(compose.indexOf('  server:'), compose.indexOf('  watchtower:'));
require(!/\/var\/run\/docker\.sock/.test(serverService), 'the business service must not mount the Docker socket');
require(/read_only: true/.test(serverService), 'business root filesystem must be read-only');
require(/cap_drop:\s*\n\s*- ALL/.test(serverService), 'business service must drop all capabilities');
require(/no-new-privileges:true/.test(serverService), 'business service must set no-new-privileges');
require(/mem_limit:/.test(serverService), 'business service needs a memory limit');
require(/pids_limit:/.test(serverService), 'business service needs a PID limit');
require(/\.\/data:\/app\/data/.test(serverService), 'business data must persist in ./data');

const watchtower = compose.slice(compose.indexOf('  watchtower:'));
require(/\/var\/run\/docker\.sock:\/var\/run\/docker\.sock/.test(watchtower),
  'the updater is the only process that holds the host Docker socket');
require(/watchtower\.scope: qfli-server/.test(watchtower), 'updater scope must match the business stack');

require(/QFLI_TERMINAL_NODES=/.test(envExample), '.env.example must document the node pool setting');
require(/QFLI_TERMINAL_URL=/.test(envExample), '.env.example must keep the legacy single-node setting');
require(!/QFLI_TERMINAL_SECRET=.+/.test(envExample), '.env.example must not ship a terminal secret');

require(/CNB_REPO_SLUG_LOWERCASE/.test(ci), 'CI must namespace the image by the CNB repository slug');
require(/qfli-server/.test(ci), 'CI must publish the qfli-server image name');
require(/services:\s*\n\s*- docker/.test(ci), 'CI image pipeline needs the docker service');
require(/case "\$VERSION" in[\s\S]*\*-\*\)/.test(ci), 'prerelease tags must be detected by a dash suffix');
require(/npm ci/.test(ci), 'every CI job that runs tests must install dependencies first');

if (failures.length) {
  for (const failure of failures) console.error(`FAIL ${failure}`);
  process.exitCode = 1;
} else {
  console.log(`deployment contract OK (${fileURLToPath(root)})`);
}
