// 跨平台 CI 入口的契约测试：镜像命名、标签策略、发布顺序、失败即停。
// 不连 Docker、不连注册表，只验证纯函数与命令序列。
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { imagePlan, runPublish, runVerify } from '../scripts/ci-common.mjs';

const revision = 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0';

test('CNB uses the repository slug from the platform', () => {
  const plan = imagePlan({ platform: 'cnb', repository: 'azurekiln/azurekiln-qfli-server', ref: 'refs/heads/main', revision });
  assert.equal(plan.image, 'docker.cnb.cool/azurekiln/azurekiln-qfli-server/qfli-server');
  assert.equal(plan.tag, 'sha-a1b2c3d4e5f6');
  assert.equal(plan.latest, true);
});

test('GitHub and GitLab images live in their own namespaces', () => {
  const github = imagePlan({ platform: 'github', repository: 'azurekiln2333/azurekiln-qfli-server', ref: 'refs/heads/main', revision });
  const gitlab = imagePlan({ platform: 'gitlab', repository: 'azurekiln-team/azurekiln-qfli-server', ref: 'refs/heads/main', revision });
  assert.equal(github.image, 'ghcr.io/azurekiln2333/azurekiln-qfli-server/qfli-server');
  assert.equal(gitlab.image, 'registry.gitlab.com/azurekiln-team/azurekiln-qfli-server/qfli-server');
});

test('a mixed-case owner is lowercased for Docker', () => {
  const plan = imagePlan({ platform: 'gitlab', repository: 'AzureKiln-Team/Project', ref: 'refs/heads/main', revision });
  assert.equal(plan.image, 'registry.gitlab.com/azurekiln-team/project/qfli-server');
});

test('the registry can be overridden for GitLab self-hosting', () => {
  const plan = imagePlan({
    platform: 'gitlab', repository: 'team/app', ref: 'refs/heads/main', revision,
    env: { CI_REGISTRY_HOST: 'registry.example.com', CI_IMAGE_NAME: 'api' },
  });
  assert.equal(plan.image, 'registry.example.com/team/app/api');
});

test('stable tags move latest, prereleases never do', () => {
  const stable = imagePlan({ platform: 'github', repository: 'o/r', ref: 'refs/tags/v1.2.3', revision });
  const pre = imagePlan({ platform: 'github', repository: 'o/r', ref: 'refs/tags/v1.2.3-rc.1', revision });
  assert.equal(stable.tag, 'v1.2.3');
  assert.equal(stable.latest, true);
  assert.equal(pre.tag, 'v1.2.3-rc.1');
  assert.equal(pre.latest, false);
});

test('branches other than main and loose tags are refused', () => {
  assert.throws(() => imagePlan({ platform: 'github', repository: 'o/r', ref: 'refs/heads/feature', revision }), /limited to main/);
  assert.throws(() => imagePlan({ platform: 'github', repository: 'o/r', ref: 'refs/tags/1.2.3', revision }), /vMAJOR/);
  assert.throws(() => imagePlan({ platform: 'github', repository: 'o/r', ref: 'refs/tags/v01.2.3', revision }), /vMAJOR/);
  assert.throws(() => imagePlan({ platform: 'github', repository: 'o/r', ref: 'refs/tags/v1.2.3;rm', revision }), /vMAJOR/);
});

test('a malformed repository or revision stops the build', () => {
  assert.throws(() => imagePlan({ platform: 'github', repository: 'o', ref: 'refs/heads/main', revision }), /repository path/);
  assert.throws(() => imagePlan({ platform: 'github', repository: 'o/r', ref: 'refs/heads/main', revision: 'HEAD' }), /revision/);
  assert.throws(() => imagePlan({ platform: 'bitbucket', repository: 'o/r', ref: 'refs/heads/main', revision }), /Platform/);
});

test('verify runs lint, deployment checks and tests in order', () => {
  const calls = [];
  runVerify((command, args) => calls.push(`${command} ${args.join(' ')}`));
  assert.deepEqual(calls, [
    'npm ci',
    'node scripts/check.mjs',
    'node scripts/check-deployment.mjs',
    'node --test test/*.test.js',
    'bash -n deployment/sqlbox/bootstrap.sh',
  ]);
});

test('publish validates first, then logs in, builds, pushes and tags latest', () => {
  const calls = [];
  const plan = runPublish({
    platform: 'gitlab',
    repository: 'team/app',
    ref: 'refs/heads/main',
    revision,
    env: { CI_REGISTRY_PASSWORD: 'secret', DOCKER_CONFIG: '.', CI_REGISTRY_USER: 'gitlab-ci-token' },
    login: false,
    run: (command, args) => calls.push(`${command} ${args.join(' ')}`),
  });
  assert.equal(plan.image, 'registry.gitlab.com/team/app/qfli-server');
  assert.equal(calls[0], 'npm ci');
  assert.deepEqual(calls.slice(-4), [
    'docker build --pull --file Dockerfile --tag registry.gitlab.com/team/app/qfli-server:sha-a1b2c3d4e5f6 .',
    'docker push registry.gitlab.com/team/app/qfli-server:sha-a1b2c3d4e5f6',
    'docker tag registry.gitlab.com/team/app/qfli-server:sha-a1b2c3d4e5f6 registry.gitlab.com/team/app/qfli-server:latest',
    'docker push registry.gitlab.com/team/app/qfli-server:latest',
  ]);
});

test('a failed test blocks the image push', () => {
  const calls = [];
  assert.throws(
    () => runPublish({
      platform: 'github',
      repository: 'o/r',
      ref: 'refs/heads/main',
      revision,
      env: { CI_REGISTRY_PASSWORD: 'x' },
      login: false,
      run: (command, args) => {
        const line = `${command} ${args.join(' ')}`;
        calls.push(line);
        if (line.startsWith('node --test')) throw new Error('tests failed');
      },
    }),
    /tests failed/,
  );
  assert.equal(calls.some(line => line.startsWith('docker build')), false);
});

test('publishing without a registry password is refused', () => {
  assert.throws(
    () => runPublish({ platform: 'cnb', repository: 'o/r', ref: 'refs/heads/main', revision, env: {}, run: () => {} }),
    /CI_REGISTRY_PASSWORD/,
  );
});

test('a malformed repository or revision stops the build', () => {
  assert.throws(() => imagePlan({ platform: 'github', repository: 'o', ref: 'refs/heads/main', revision }), /repository path/);
  assert.throws(() => imagePlan({ platform: 'github', repository: 'o/r', ref: 'refs/heads/main', revision: 'HEAD' }), /revision/);
  assert.throws(() => imagePlan({ platform: 'bitbucket', repository: 'o/r', ref: 'refs/heads/main', revision }), /Platform/);
});

