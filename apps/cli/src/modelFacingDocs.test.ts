import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

import type { Command } from 'commander';
import { describe, expect, it } from 'vitest';

import { createProgram } from './program';

/**
 * Prose that agents read and then copy into `lh` calls. When it names a command
 * or flag the CLI no longer has, the model burns a round on `unknown command` /
 * `unknown option` and often falls back to a worse path — so every `lh …`
 * snippet in these files is checked against the real command tree.
 */
const repoRoot = path.resolve(__dirname, '../../..');
const lobehubSkillDir = path.join(repoRoot, 'packages/builtin-skills/src/lobehub');

const MODEL_FACING_FILES = [
  path.join(lobehubSkillDir, 'content.ts'),
  ...readdirSync(path.join(lobehubSkillDir, 'references'))
    .filter((name) => name.endsWith('.ts') && !name.endsWith('.test.ts'))
    .map((name) => path.join(lobehubSkillDir, 'references', name)),
  path.join(repoRoot, 'apps/server/src/services/verify/executor.ts'),
];

const program = createProgram() as Command;

const findSubcommand = (cmd: Command, name: string) =>
  cmd.commands.find((sub) => sub.name() === name || sub.aliases().includes(name));

/** Every `lh …` inline code span and every code-block line starting with `lh `. */
const extractSnippets = (source: string): string[] => {
  const text = source.replaceAll('\\`', '`');
  const snippets = new Set<string>();
  for (const match of text.matchAll(/`((?:[^\n`]*?\s)?lh [a-z][^\n`]*)`/g)) snippets.add(match[1]);
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (/^lh [a-z]/.test(trimmed)) snippets.add(trimmed);
  }
  return [...snippets];
};

const checkSnippet = (snippet: string): string[] => {
  const tokens = snippet.replace(/^.*?\blh /, '').split(/\s+/);
  let cmd = program;
  const commandPath: string[] = [];

  for (const token of tokens) {
    if (cmd.commands.length === 0 || !/^[a-z][\w-]*$/.test(token)) break;
    const sub = findSubcommand(cmd, token);
    if (!sub) {
      // A command that takes positional args may legitimately be followed by a word.
      if (cmd.registeredArguments.length > 0) break;
      return [`unknown command "lh ${[...commandPath, token].join(' ')}"`];
    }
    cmd = sub;
    commandPath.push(token);
  }
  if (cmd === program) return [];

  const problems: string[] = [];
  for (const match of snippet.matchAll(/(?<![\w-])(--?[a-z][\w-]*)(\s+\S+)?/gi)) {
    const flag = match[1];
    if (flag === '--help' || flag === '-h') continue;
    const option = cmd.options.find((opt) => opt.long === flag || opt.short === flag);
    if (!option) {
      problems.push(`unknown option ${flag} on "lh ${commandPath.join(' ')}"`);
      continue;
    }
    const next = match[2]?.trim();
    if (option.required && (!next || next.startsWith('-') || next.startsWith(']'))) {
      problems.push(`option ${flag} on "lh ${commandPath.join(' ')}" requires a value`);
    }
  }
  return problems;
};

describe('model-facing lh CLI docs', () => {
  it.each(MODEL_FACING_FILES.map((file) => [path.relative(repoRoot, file), file]))(
    '%s only references commands and flags the CLI accepts',
    (_label, file) => {
      const problems = extractSnippets(readFileSync(file, 'utf8')).flatMap((snippet) =>
        checkSnippet(snippet).map((problem) => `${problem}  <- ${snippet}`),
      );
      expect(problems).toEqual([]);
    },
  );

  it('flags a stale command and a stale option', () => {
    expect(checkSnippet('lh config whoami')).toEqual(['unknown command "lh config"']);
    expect(checkSnippet('lh eval run get --run-id <id>')).toEqual([
      'unknown option --run-id on "lh eval run get"',
    ]);
    expect(checkSnippet('lh agent run -a <id> --replay')).toEqual([
      'option --replay on "lh agent run" requires a value',
    ]);
    expect(checkSnippet('lh whoami --json')).toEqual([]);
  });
});
