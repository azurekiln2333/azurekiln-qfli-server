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
const composeCi = read('.github/workflows/build-and-push.yml');
const gitlabCi = read('.gitlab-ci.yml');
const gitcodeCi = read('.gitcode/workflows/verify.yml');
const ciPlatforms = read('deploy/ci-platforms.md');

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

// Every required key must be present and empty, so a copy-paste deploy cannot
// silently ship a guessed value.
const requiredEmpty = [
  'QFLI_JWT_SECRET', 'MYSQL_PASSWORD', 'AZK_OAUTH2_BASE_URL', 'AZK_OAUTH2_CLIENT_ID',
  'AZK_OAUTH2_CLIENT_SECRET', 'QFLI_TERMINAL_SECRET', 'MODERATION_BASE_URL',
  'MODERATION_API_KEY', 'MODERATION_ADMIN_KEY', 'QFLI_MODERATION_SUBJECT_SALT',
  'QFLI_AI_API_KEY',
];
// MODERATION_APP_ID must equal the app id the moderation service registered.
require(/^MODERATION_APP_ID=qflistudio$/m.test(envExample), '.env.example must fix the moderation app id');
for (const key of requiredEmpty) {
  require(new RegExp(`^${key}=$`, 'm').test(envExample), `.env.example must list ${key} with an empty value`);
}
// The compose file reads these; a missing key makes the default image unset.
require(/^QFLI_SERVER_IMAGE=docker\.cnb\.cool\/azurekiln\/azurekiln-qfli-server:latest$/m.test(envExample),
  '.env.example must name the default CNB image');
for (const key of ['QFLI_SERVER_WATCHTOWER_IMAGE', 'WATCHTOWER_POLL_INTERVAL', 'QFLI_SERVER_MEMORY', 'QFLI_SERVER_CPUS', 'QFLI_SERVER_UID', 'QFLI_SERVER_GID']) {
  require(new RegExp(`^${key}=`, 'm').test(envExample), `.env.example must list the compose setting ${key}`);
}
require(/^TERMINAL_RATE_LIMIT=/m.test(envExample), '.env.example must list TERMINAL_RATE_LIMIT');

// The compose default and the image the CNB pipeline publishes must agree.
require(/docker\.cnb\.cool\/azurekiln\/azurekiln-qfli-server:latest/.test(compose),
  'the default compose image must be the published CNB image');
require(!/qflistudio-next/.test(compose), 'the retired qflistudio-next image path must be gone');

require(/CNB_REPO_SLUG_LOWERCASE/.test(ci), 'CI must namespace the image by the CNB repository slug');
require(!/CI_IMAGE_NAME/.test(ci), 'the CNB image is the repository path, without a sub-name');
require(!/azurekiln-qfli-server\/qfli-server/.test(compose + envExample), 'the retired azurekiln-qfli-server/qfli-server image path must be gone');
require(/services:\s*\n\s*- docker/.test(ci), 'CI image pipeline needs the docker service');
// Every CNB job that runs node must pin an image that actually has node. The
// platform default build image does not, which fails with `node: command not
// found` only once the pipeline runs. Job entries are `NNNN- name:` list items.
// Job entries sit at four spaces under a trigger; stage entries nest deeper.
const cnbJobs = ci.split(/(?=^ {4}- name: )/m).filter(chunk => /^ {4}- name: /.test(chunk));
require(cnbJobs.length >= 3, 'the CNB config must list its jobs');
// Resolve `docker: *anchor` against the anchor definition before judging a job.
const cnbAnchors = Object.fromEntries(
  [...ci.matchAll(/&([\w-]+)\s*\n\s*image:\s*(\S+)/g)].map(match => [match[1], match[2]]),
);
for (const job of cnbJobs) {
  const name = job.match(/^ {4}- name: (.+)$/m)[1].trim();
  if (!/scripts\/ci-common\.mjs/.test(job)) continue;
  // The image lives in the header, above the stages list.
  const header = job.slice(0, job.indexOf('stages:'));
  const literal = header.match(/image:\s*(\S+)/);
  const alias = header.match(/docker:\s*\*([\w-]+)/);
  const image = literal ? literal[1] : cnbAnchors[alias && alias[1]];
  require(image === 'node:24.15.0-bookworm',
    `CNB job "${name}" runs node, so it must use node:24.15.0-bookworm (got ${image || 'no image'})`);
}
require(!/cnbcool\/default-build-env/.test(ci), 'the CNB default build image has no node; do not use it for node jobs');
// CI validation commands live in one place so four pipelines cannot drift.
require(/\['npm', \['ci'\]\]/.test(read('scripts/ci-common.mjs')), 'the shared CI script must install dependencies before tests');

for (const [file, text, platform] of [
  ['.cnb.yml', ci, 'cnb'],
  ['.github/workflows/build-and-push.yml', composeCi, 'github'],
  ['.gitlab-ci.yml', gitlabCi, 'gitlab'],
]) {
  require(new RegExp(`scripts/ci-common\\.mjs publish[\\s\\S]*--platform ${platform}`).test(text),
    `${file} must publish through scripts/ci-common.mjs --platform ${platform}`);
  require(/scripts\/ci-common\.mjs verify/.test(text), `${file} must verify through scripts/ci-common.mjs`);
}
require(!/docker\.login|\.npmrc/.test(gitlabCi), 'GitLab must use the predefined registry credentials, not a stored secret');
require(/services:\s*\n\s*- name: \$DOCKER_DIND_IMAGE/.test(gitlabCi), 'GitLab needs the dind service to build');
require(/scripts\/ci-common\.mjs verify/.test(gitcodeCi), 'GitCode validates only');
require(!/docker\s+(build|push)/.test(gitcodeCi), 'GitCode must not publish an image');
require(/# Gitee：不加工作流/.test(ciPlatforms), 'deploy/ci-platforms.md must state the Gitee decision');
// GitHub logs in in its own step; the script must not try a second login.
require(/--no-login/.test(composeCi), 'the GitHub publish step must reuse the workflow login');
require(/docker login ghcr\.io/.test(composeCi), 'the GitHub workflow must log in to GHCR');
require(/--steps push/.test(composeCi), 'the GitHub workflow must split build and push so a failure names the stage');
// CNB defines CNB_TOKEN rather than CI_REGISTRY_PASSWORD; its docker service
// logs in for you.
require(/--no-login/.test(ci), 'the CNB publish steps must reuse the docker service login');
require(/refs\/heads\/\$\{CNB_BRANCH\}/.test(ci), 'the CNB ref must be built from CNB_BRANCH');
require(/# GitCode \/ AtomGit：只加校验/.test(ciPlatforms), 'deploy/ci-platforms.md must state the GitCode decision');

if (failures.length) {
  for (const failure of failures) console.error(`FAIL ${failure}`);
  process.exitCode = 1;
} else {
  console.log(`deployment contract OK (${fileURLToPath(root)})`);
}
