import type { SpawnOptions } from "node:child_process";
import process from "node:process";

import { getCurrentGitRepositoryRoot } from "@code-chronicles/util/getCurrentGitRepositoryRoot";
import { only } from "@code-chronicles/util/only";
import { promiseAllLimitingConcurrency } from "@code-chronicles/util/promiseAllLimitingConcurrency";
import { readWorkspaces } from "@code-chronicles/util/readWorkspaces";
import { spawnWithSafeStdio } from "@code-chronicles/util/spawnWithSafeStdio";
import { stripPrefixOrThrow } from "@code-chronicles/util/stripPrefixOrThrow";

import { SCRIPTS, SCRIPTS_TO_SKIP_BY_WORKSPACE, type Script } from "./scripts";

type FailedCommand = {
  command: string;
  args: readonly string[];
  error: unknown;
};

export async function runCommands(
  script: Script,
  scriptArgs: readonly string[],
): Promise<void> {
  const failedCommands: FailedCommand[] = [];

  const run = async (
    command: string,
    args: readonly string[],
    options?: Omit<SpawnOptions, "env" | "shell" | "stdio">,
  ): Promise<void> => {
    const combinedArgs = [...args, ...scriptArgs];
    try {
      await spawnWithSafeStdio(command, combinedArgs, {
        ...options,
        env: { ...process.env, FORCE_COLOR: "1" },
        // Without a shell specified, `yarn` can fail to spawn in Windows
        // GitHub Actions for some reason. Maybe a PATH issue?
        shell: "bash",
      });
    } catch (error) {
      failedCommands.push({ command, args: combinedArgs, error });
      console.error(error);
    }
  };

  const commands = [
    async () => {
      const rootCommand = SCRIPTS[script]?.repositoryRootCommand;
      if (rootCommand != null) {
        const currentGitRepositoryRoot = await getCurrentGitRepositoryRoot();

        console.error(`Running script ${script} for repository root!`);
        await run.apply(null, [
          ...rootCommand,
          { cwd: currentGitRepositoryRoot },
        ]);
      }
    },

    ...(await readWorkspaces()).map((workspace) => async () => {
      const workspaceShortName = stripPrefixOrThrow(
        workspace,
        "@code-chronicles/",
      );
      if (SCRIPTS_TO_SKIP_BY_WORKSPACE[workspaceShortName]?.has(script)) {
        console.error(
          `Skipping script ${script} for workspace: ${workspaceShortName}`,
        );
        return;
      }

      console.error(
        `Running script ${script} for workspace: ${workspaceShortName}`,
      );
      await run("yarn", ["workspace", workspace, script]);
    }),
  ];

  await promiseAllLimitingConcurrency(
    commands,
    // TODO: support parallelization in GitHub Actions
    1,
  );

  if (failedCommands.length > 0) {
    console.error("Some commands did not complete successfully:");
    for (const { command, args } of failedCommands) {
      console.error({ command, args });
    }

    // TODO: turn this into a utility, perhaps
    const errors = failedCommands.map(({ error }) => error);
    throw errors.length === 1 ? only(errors) : new AggregateError(errors);
  }
}
