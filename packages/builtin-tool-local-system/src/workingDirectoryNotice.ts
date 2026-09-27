/**
 * `{{workingDirectory}}` when Local Sandbox is on but no directory is set.
 *
 * The default placeholder promises "use user Home directory as default", but a
 * sandboxed run is fenced to its working directory and the device refuses every
 * command without one. The prompt must say that instead, or the model keeps
 * retrying commands that can never run.
 */
export const LOCAL_SANDBOX_WORKING_DIRECTORY_UNSET =
  '(not set — Local Sandbox is on and only runs commands inside a working directory, so runCommand will be refused until the user sets one for this agent or topic. Ask the user to set it instead of retrying the command.)';
