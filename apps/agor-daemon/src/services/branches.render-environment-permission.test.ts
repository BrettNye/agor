/**
 * Regression tests for #2803: rendering an environment must honour the
 * documented "effective `all` branch permission OR admin" contract when the
 * call goes through the REGISTERED branches hook chain.
 *
 * `renderEnvironment` persists the rendered command strings with a self-patch.
 * The service-level tests in branches.test.ts call the method on a bare
 * instance, so that self-patch never meets `requireAdminForEnvConfig`. Here the
 * service is mounted on a real Feathers app and wrapped in the before-hooks
 * register-hooks.ts installs for `branches`, so `this.patch` re-enters them
 * exactly as it does in the daemon.
 */

import { BranchRepository, type Database, RepoRepository, UsersRepository } from '@agor/core/db';
import { feathers } from '@agor/core/feathers';
import type { Application, BranchID, HookContext, UserID } from '@agor/core/types';
import { describe, expect, vi } from 'vitest';
import { dbTest } from '../../../../packages/core/src/db/test-helpers';
import { type RegisterHooksContext, registerHooks } from '../register-hooks';
import { BranchesService } from './branches';

type RegisteredHook = (context: HookContext) => unknown;

/**
 * Run the real `registerHooks` against a recording stand-in and return the
 * before-hook chains it installs on `branches`.
 */
function captureBranchBeforeHooks(
  db: Database,
  branchRepository: BranchRepository,
  config: RegisterHooksContext['config']
): Record<string, RegisteredHook[]> {
  const before: Record<string, RegisteredHook[]> = {};
  const recordingApp = {
    service(path: string) {
      return {
        hooks(hooks: { before?: Record<string, RegisteredHook[]> }) {
          if (path.replace(/^\//, '') !== 'branches') return;
          for (const [method, chain] of Object.entries(hooks?.before ?? {})) {
            before[method] = [...(before[method] ?? []), ...(chain ?? [])];
          }
        },
      };
    },
    use() {},
    publish() {},
    io: { to: () => ({ emit() {} }) },
  };

  registerHooks({
    db: db as unknown as RegisterHooksContext['db'],
    app: recordingApp as unknown as RegisterHooksContext['app'],
    config,
    jwtSecret: 'render-environment-permission-test-secret',
    deployment: { mode: 'standalone' },
    requireAuth: async (context) => context,
    superadminOpts: { allowSuperadmin: true },
    sessionsService: {} as RegisterHooksContext['sessionsService'],
    messagesService: {} as RegisterHooksContext['messagesService'],
    boardsService: undefined,
    branchRepository: branchRepository as unknown as RegisterHooksContext['branchRepository'],
    usersRepository: {
      listUserIds: async () => [],
    } as unknown as RegisterHooksContext['usersRepository'],
    sessionsRepository: {} as RegisterHooksContext['sessionsRepository'],
  });

  return before;
}

async function createHookedBranchesHarness(db: Database) {
  const usersRepo = new UsersRepository(db);
  const repos = new RepoRepository(db);
  const branchRepository = new BranchRepository(db);

  const owner = await usersRepo.create({
    email: 'render-owner@example.com',
    name: 'Render Owner',
    role: 'member',
  });
  const outsider = await usersRepo.create({
    email: 'render-outsider@example.com',
    name: 'Render Outsider',
    role: 'member',
  });
  const repo = await repos.create({
    slug: 'render-permission',
    name: 'Render permission',
    repo_type: 'local',
    local_path: '/tmp/render-permission',
    default_branch: 'main',
    environment: {
      version: 2,
      default: 'dev',
      variants: {
        dev: { start: 'echo dev-start', stop: 'echo dev-stop' },
      },
    },
  });
  const branch = await branchRepository.create({
    repo_id: repo.repo_id,
    name: 'render-permission',
    ref: 'render-permission',
    path: '/tmp/render-permission/render-permission',
    branch_unique_id: 9803,
    created_by: owner.user_id,
    others_can: 'view',
    environment_instance: { status: 'stopped' },
  });

  const config = {
    database: { dialect: 'sqlite' },
    multi_tenancy: { mode: 'static', static_tenant_id: 'render-permission-test' },
    execution: {},
  } as RegisterHooksContext['config'];

  const app = feathers() as unknown as Application;
  app.set('config', config);
  app.use('repos', {
    async get(id: string) {
      return repos.findById(id);
    },
  } as never);
  app.use('branches', new BranchesService(db, app) as never);

  const before = captureBranchBeforeHooks(db, branchRepository, config);
  app.service('branches').hooks({ before } as never);

  const branchesService = app.service('branches') as unknown as BranchesService;
  return { branchesService, branchRepository, branch, owner, outsider };
}

function externalParams(user_id: UserID) {
  return {
    provider: 'rest',
    user: { user_id, role: 'member' },
  } as never;
}

describe('BranchesService.renderEnvironment through the registered branches hooks', () => {
  dbTest(
    'lets a member with effective all permission render and persists the commands',
    async ({ db }) => {
      const { branchesService, branchRepository, branch, owner } =
        await createHookedBranchesHarness(db);
      expect(await branchRepository.resolveUserPermission(branch, owner.user_id)).toBe('all');

      await expect(
        branchesService.renderEnvironment(
          branch.branch_id as BranchID,
          { variant: 'dev' },
          externalParams(owner.user_id as UserID)
        )
      ).resolves.toMatchObject({
        branch_id: branch.branch_id,
        environment_variant: 'dev',
        start_command: 'echo dev-start',
      });

      expect(await branchRepository.findById(branch.branch_id)).toMatchObject({
        environment_variant: 'dev',
        start_command: 'echo dev-start',
        stop_command: 'echo dev-stop',
      });
    }
  );

  dbTest('refuses a member without all permission and writes nothing', async ({ db }) => {
    const { branchesService, branchRepository, branch, outsider } =
      await createHookedBranchesHarness(db);
    const patchSpy = vi.spyOn(BranchRepository.prototype, 'update');

    await expect(
      branchesService.renderEnvironment(
        branch.branch_id as BranchID,
        { variant: 'dev' },
        externalParams(outsider.user_id as UserID)
      )
    ).rejects.toThrow(/'all' branch permission or admin access/);

    expect(patchSpy).not.toHaveBeenCalled();
    const stored = await branchRepository.findById(branch.branch_id);
    expect(stored?.start_command ?? null).toBeNull();
    expect(stored?.environment_variant ?? null).toBeNull();
    patchSpy.mockRestore();
  });

  dbTest(
    'still refuses a member with all permission patching env-command fields directly',
    async ({ db }) => {
      const { branchesService, branchRepository, branch, owner } =
        await createHookedBranchesHarness(db);

      await expect(
        branchesService.patch(
          branch.branch_id as BranchID,
          { start_command: 'echo attacker-controlled' },
          externalParams(owner.user_id as UserID)
        )
      ).rejects.toThrow(/You need admin access to modify environment commands/);

      expect((await branchRepository.findById(branch.branch_id))?.start_command ?? null).toBeNull();
    }
  );
});
