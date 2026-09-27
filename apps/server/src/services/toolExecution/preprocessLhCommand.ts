import { OFFICIAL_URL } from '@lobechat/const';
import debug from 'debug';

import { appEnv } from '@/envs/app';
import { signUserJWT } from '@/libs/trpc/utils/internalJwt';
import { isDev } from '@/utils/env';

const log = debug('lobe-server:lh-command');

/** Error surfaced when an Agent Share visitor's sandbox command tries to invoke the `lh` CLI. */
export const SHARE_VISITOR_LH_BLOCKED_MESSAGE =
  'The LobeHub CLI is unavailable in shared conversations.';

export interface PreprocessResult {
  command: string;
  error?: string;
  isLhCommand: boolean;
  skipSkillLookup: boolean;
}

/**
 * `lh` as a standalone word anywhere in the command — not a path segment
 * (`./lh`, `/opt/lh`), a filename (`lh.js`) or part of a longer word
 * (`lhtest`).
 *
 * This used to require **shell command position**, which only covers an `lh`
 * the invoking shell resolves itself. Models just as often reach it through
 * another process — `timeout 60 lh …`, `bash -c '… lh …'`, `xargs lh`,
 * `subprocess.run(["lh", …])`, `execFileSync('lh', …)` — and every one of those
 * got no credentials, fell through to the sandbox's own unauthenticated `lh`
 * install, and failed with "No authentication found" mid-session.
 *
 * This is a DETECTION-only heuristic: the command itself is never rewritten
 * (see `preprocessLhCommand`), so a false positive costs one unused shim while
 * a false negative costs a broken `lh` invocation. Erring permissive is
 * therefore the right trade — e.g. `echo 'use lh'` matches even though the
 * `lh` is quoted text.
 */
const LH_COMMAND_PATTERN = /(?<![\w./~-])lh(?![\w./-])/;

export const isLhCommand = (command: string): boolean => LH_COMMAND_PATTERN.test(command);

/**
 * Env overrides for a workspace run executing ON THE USER'S DEVICE rather than
 * in the sandbox.
 *
 * A device shell has its own `lh` and its own stored credentials, so nothing
 * needs rewriting there — but without `LOBEHUB_WORKSPACE_ID` the CLI resolves
 * to personal scope, and a workspace agent asked to edit itself silently reads
 * and writes the wrong tenancy instead of failing.
 *
 * Applied to EVERY command of a workspace run, deliberately not gated on
 * `isLhCommand`. The device merges this into the spawned process environment,
 * so every descendant inherits it — which is the only way to reach an `lh` the
 * command invokes indirectly: `bash -lc 'lh whoami'`, a shell script, a
 * Makefile target, an npm script. Command-position detection sees none of
 * those, and unlike the sandbox path there is nothing here worth gating: this
 * mints no credential, it exports a non-secret scope id that only the LobeHub
 * CLI reads, so setting it on a command that never calls `lh` costs nothing.
 *
 * `LOBEHUB_JWT` is deliberately NOT sent: on a personal device the stored
 * credentials already are the caller's, so it buys nothing, while a workspace
 * device belongs to another member and shipping the caller's token onto their
 * machine would be a real credential leak. Auth stays with the device; only the
 * scope travels. A device owner who is not a member of that workspace now gets
 * an explicit error rather than a silent personal-scope write.
 */
export const buildDeviceLhEnv = (
  workspaceId: string | undefined,
): Record<string, string> | undefined =>
  workspaceId ? { LOBEHUB_WORKSPACE_ID: workspaceId } : undefined;

/** Shell variable holding the per-command directory the `lh` wrapper is written to. */
const LH_SHIM_DIR_VAR = '__lobehub_lh_bin';
const LH_SHIM_EOF = '__LOBEHUB_LH_SHIM__';

/** POSIX single-quoting, safe for any value including quotes and newlines. */
const shellSingleQuote = (value: string): string => `'${value.replaceAll("'", String.raw`'\''`)}'`;

/**
 * Detect and prepare `lh` CLI commands for execution in the cloud sandbox.
 *
 * Instead of rewriting every `lh` occurrence (which can only ever cover the
 * shell forms the regex happens to know), the command is left **byte-identical**
 * and a prelude writes an `lh` executable into a fresh directory at the front
 * of `PATH`:
 *
 * ```sh
 * __lobehub_lh_bin=$(mktemp -d) && cat > "$__lobehub_lh_bin/lh" <<'…' && chmod +x … && export PATH=…
 * #!/bin/sh
 * LOBEHUB_JWT='…' LOBEHUB_SERVER='…' LOBEHUB_WORKSPACE_ID='…' exec npx -y @lobehub/cli "$@"
 * …
 * <original command>
 * ```
 *
 * It has to be an executable on `PATH`, not a shell function: a function only
 * exists inside the shell that defined it, so `timeout 60 lh …`, `bash -c 'lh …'`,
 * `xargs lh` or a Python/Node subprocess — all of which exec `lh` as a program —
 * never saw it and ran the sandbox's own unauthenticated `lh` instead. `PATH`
 * is inherited by every descendant, so each of those forms resolves the same
 * credentialed wrapper, while the JWT is still emitted exactly once.
 *
 * The credentials are assignment-prefixed to `npx` INSIDE the wrapper rather
 * than `export`ed around the script. Exporting would put a full user auth token
 * in the environment of every command the model wrote, where any later `env`,
 * `echo $LOBEHUB_JWT`, `curl` or child process could read it. Only `PATH` is
 * exported; the token stays scoped to the `npx` process the wrapper execs.
 *
 * `LOBEHUB_WORKSPACE_ID` is what keeps a workspace run's CLI calls in the
 * workspace: without it the CLI resolves to personal scope and a workspace
 * agent cannot even find itself.
 */
export const preprocessLhCommand = async (
  command: string,
  userId: string,
  workspaceId?: string,
  /**
   * Belt-and-braces guard: true when the caller is executing inside an Agent
   * Share visitor's run (`context.agentShareVisitor` set). The visitor's
   * shell command is model-supplied and the visitor fully controls it, so
   * minting `signUserJWT(userId)` here would hand them a JWT scoped to the
   * CREATOR's own account inside a shell they control.
   * `serverRuntimes/cloudSandbox.ts` already short-circuits before ever
   * reaching this function for a share-visitor `lh` command — this second
   * check exists so the refusal doesn't rely solely on that caller
   * remembering to keep re-checking it.
   */
  shareVisitorBlocked = false,
): Promise<PreprocessResult> => {
  if (!isLhCommand(command)) {
    return { command, isLhCommand: false, skipSkillLookup: false };
  }

  if (shareVisitorBlocked) {
    log('Refused lh command for Agent Share visitor run (user %s)', userId);
    return {
      command,
      error: SHARE_VISITOR_LH_BLOCKED_MESSAGE,
      isLhCommand: true,
      skipSkillLookup: true,
    };
  }

  try {
    const jwt = await signUserJWT(userId);

    const serverUrl = isDev ? OFFICIAL_URL : appEnv.APP_URL;

    const envAssignments = [
      `LOBEHUB_JWT=${shellSingleQuote(jwt)}`,
      `LOBEHUB_SERVER=${shellSingleQuote(serverUrl)}`,
      ...(workspaceId ? [`LOBEHUB_WORKSPACE_ID=${shellSingleQuote(workspaceId)}`] : []),
    ].join(' ');

    // Newline-separated (not `;`-separated) so a command whose first line is a
    // comment or a shebang cannot swallow the shim. The heredoc delimiter is
    // quoted, so the wrapper body is written verbatim.
    const finalCommand = [
      `${LH_SHIM_DIR_VAR}=$(mktemp -d) && cat > "$${LH_SHIM_DIR_VAR}/lh" <<'${LH_SHIM_EOF}' && chmod +x "$${LH_SHIM_DIR_VAR}/lh" && export PATH="$${LH_SHIM_DIR_VAR}:$PATH"`,
      '#!/bin/sh',
      `${envAssignments} exec npx -y @lobehub/cli "$@"`,
      LH_SHIM_EOF,
      command,
    ].join('\n');

    log(
      'Intercepted lh command for user %s (workspace %s), shim injected',
      userId,
      workspaceId ?? 'personal',
    );

    return { command: finalCommand, isLhCommand: true, skipSkillLookup: true };
  } catch (error) {
    log('Failed to sign user JWT for lh command: %O', error);
    return {
      command,
      error: 'Failed to authenticate for CLI execution',
      isLhCommand: true,
      skipSkillLookup: true,
    };
  }
};
