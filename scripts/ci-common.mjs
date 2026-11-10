#!/usr/bin/env node
// Shared CI entry for every platform (CNB, GitHub Actions, GitLab CI).
//
// One implementation keeps the four pipelines honest: the same validation
// runs everywhere, and only the publish mode and registry details differ.
// Zero dependencies: node:crypto and node:child_process only.
//
//   node scripts/ci-common.mjs verify
//   node scripts/ci-common.mjs publish --platform github --ref refs/heads/main --revision abc1234
//   node scripts/ci-common.mjs publish --platform gitlab --ref v1.0.0 --registry registry.gitlab.com/x/y --username gitlab-ci-token --password-stdin
import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { URL } from 'node:url';
import { fileURLToPath, pathToFileURL } from 'node:url';

// Refuse tag shapes that would let a commit message decide an image name.
const PART = '[a-z0-9]+(?:[._-][a-z0-9]+)*';
const NUMBER = '(?:0|[1-9][0-9]*)';
const IDENTIFIER = `(?:${NUMBER}|[0-9]*[A-Za-z-][0-9A-Za-z-]*)`;
const SEMVER = new RegExp(`^v${NUMBER}\\.${NUMBER}\\.${NUMBER}(?:-${IDENTIFIER}(?:\\.${IDENTIFIER})*)?$`);

// Each platform keeps its own namespace so a hijacked pipeline cannot
// overwrite another platform's image. The image is the repository path itself;
// CI_IMAGE_NAME appends a sub-name only when a pipeline sets one.
const PLATFORMS = {
  cnb: { registry: 'docker.cnb.cool', repository: null },
  github: { registry: 'ghcr.io', repository: 'github.repository' },
  gitlab: { registry: 'registry.gitlab.com', repository: 'CI_PROJECT_PATH' },
};

const COMMANDS = {
  verify: [
    ['npm', ['ci']],
    ['node', ['scripts/check.mjs']],
    ['node', ['scripts/check-deployment.mjs']],
    ['node', ['--test', 'test/*.test.js']],
    ['bash', ['-n', 'deployment/sqlbox/bootstrap.sh']],
  ],
};

export function dockerName(repository) {
  // Docker repository names are lowercase; registry paths keep their case.
  return repository.toLowerCase();
}

export function imagePlan({ platform, repository, ref, revision, env = {} }) {
  const known = PLATFORMS[platform];
  if (!known) throw new Error('Platform must be cnb, github or gitlab');
  const host = env.CI_REGISTRY_HOST || known.registry;
  if (!host) throw new Error(`Platform ${platform} has no registry host; pass CI_REGISTRY_HOST`);
  if (!new RegExp(`^${PART}(?:/${PART})+$`, 'i').test(repository || '')) {
    throw new Error('Registry repository path is missing or malformed');
  }
  const name = env.CI_IMAGE_NAME || '';
  if (name && !new RegExp(`^${PART}$`).test(name)) throw new Error('Image name is malformed');
  if (!/^[a-f0-9]{7,40}$/.test(revision || '')) throw new Error('Invalid commit revision');
  const hash = env.CI_COMMIT_SHORT || revision.slice(0, 12);
  const image = `${host}/${dockerName(repository)}${name ? `/${name}` : ''}`;

  if (ref === 'refs/heads/main') return { image, tag: `sha-${hash}`, latest: true, mode: 'main' };
  if (!ref.startsWith('refs/tags/')) throw new Error('Publishing is limited to main and v* tags');
  const tag = ref.slice('refs/tags/'.length);
  if (tag.length > 128 || !SEMVER.test(tag)) {
    throw new Error('Tag must be vMAJOR.MINOR.PATCH with an optional semver prerelease');
  }
  // A prerelease must never move `latest`; that is the one tag servers track.
  return { image, tag, latest: !tag.includes('-'), mode: 'tag' };
}

function execute(command, args, options = {}) {
  const windows = process.platform === 'win32' && command === 'npm';
  if (windows && args.some(arg => !/^[a-z-]+$/.test(arg))) throw new Error('Unsupported npm CI argument');
  const result = windows
    ? spawnSync('cmd.exe', ['/d', '/s', '/c', ['npm.cmd', ...args].join(' ')], { stdio: 'inherit', windowsHide: true, ...options })
    : spawnSync(command, args, { stdio: 'inherit', windowsHide: true, ...options });
  if (result.error || result.status !== 0) throw new Error(`CI command failed: ${command} ${args.join(' ')}`);
  return result;
}

export function runVerify(run = execute) {
  for (const [command, args] of COMMANDS.verify) run(command, args);
}

export function runPublish({ platform, repository, ref, revision, env = process.env, run = execute, login = true, steps = 'all' }) {
  if (!ref || !revision) throw new Error('Publishing needs --ref and --revision');
  if (!['all', 'build', 'push'].includes(steps)) throw new Error('Steps must be all, build or push');
  const plan = imagePlan({ platform, repository, ref, revision, env });
  const source = `${plan.image}:${plan.tag}`;

  if (steps === 'push') {
    // The build step already pushed the commit tag, so only latest can be left.
    if (!plan.latest) {
      console.log(`${source} is a prerelease; latest stays untouched`);
      return plan;
    }
    const latest = `${plan.image}:latest`;
    run('docker', ['tag', source, latest]);
    run('docker', ['push', latest]);
    return plan;
  }

  if (steps === 'all') runVerify(run);
  if (login) {
    const user = env.CI_REGISTRY_USER || 'gitlab-ci-token';
    if (!env.CI_REGISTRY_PASSWORD) throw new Error('CI_REGISTRY_PASSWORD is required to publish');
    const host = new URL(`https://${plan.image}`).host;
    // A non-zero exit is the only reliable signal: credential stores (desktop
    // helper, DOCKER_CONFIG, remote helpers) do not have to write config.json.
    // The password arrives on stdin so it never appears in the process list.
    run('docker', ['login', host, '-u', user, '--password-stdin'], { input: env.CI_REGISTRY_PASSWORD });
  }
  run('docker', ['build', '--pull', '--file', 'Dockerfile', '--tag', source, '.']);
  run('docker', ['push', source]);
  if (steps === 'build') return plan;
  if (plan.latest) {
    const latest = `${plan.image}:latest`;
    run('docker', ['tag', source, latest]);
    run('docker', ['push', latest]);
  }
  return plan;
}

function parseArguments(argv) {
  const options = { mode: argv[0] };
  for (let index = 1; index < argv.length; index += 1) {
    const key = argv[index];
    if (!key.startsWith('--')) throw new Error(`Unexpected argument ${key}`);
    const name = key.slice(2).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
    // --no-login is a switch, not a key/value pair.
    if (key === '--no-login') {
      options[name] = 'true';
      continue;
    }
    const value = argv[index + 1];
    if (value === undefined || value.startsWith('--')) throw new Error(`Missing value for ${key}`);
    options[name] = value;
    index += 1;
  }
  return options;
}

export function main(argv, env = process.env) {
  const options = parseArguments(argv);
  if (options.mode === 'verify') {
    runVerify();
    console.log('CI validation passed');
    return null;
  }
  if (options.mode === 'publish') {
    const repository = options.repository || env.CI_PROJECT_PATH;
    const revision = options.revision || env.CI_COMMIT_SHA;
    // A platform that already logged in (CNB docker service, GitHub login step)
    // keeps the credential in its own store; relogging in would need a secret
    // this script may not have.
    const login = options.noLogin !== 'true';
    const steps = options.steps || 'all';
    const plan = runPublish({ platform: options.platform, repository, ref: options.ref, revision, env, login, steps });
    console.log(`Published ${plan.image}:${plan.tag}; latest=${plan.latest}`);
    return plan;
  }
  throw new Error('Expected verify or publish as the first argument');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
