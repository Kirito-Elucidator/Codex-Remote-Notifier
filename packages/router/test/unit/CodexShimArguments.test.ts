import * as path from 'path';

import { describe, expect, it } from 'vitest';

import {
  injectRemoteArguments,
  isCodexProtocolVersion,
  planCodexInvocation,
} from '../../src/codex/CodexShimArguments';

describe('Codex shim argument planning', () => {
  it('forwards app-server config flags and resolves -C without consuming typed TUI options', () => {
    const args = [
      '-c',
      'model_reasoning_effort="high"',
      '--enable',
      'collaboration_modes',
      '--disable=otel',
      '--strict-config',
      '-C',
      'nested/repo',
      '--model',
      'gpt-5',
      '--sandbox',
      'workspace-write',
      '--search',
      'hello',
    ];
    const result = planCodexInvocation(args, path.resolve('C:/workspace'));

    expect(result).toMatchObject({
      mode: 'protocol',
      command: 'tui',
      cwd: path.resolve('C:/workspace/nested/repo'),
      appServerArgs: [
        'app-server',
        '--stdio',
        '--config',
        'model_reasoning_effort="high"',
        '--enable',
        'collaboration_modes',
        '--disable',
        'otel',
        '--strict-config',
      ],
      tuiArgs: args,
    });
  });

  it('injects remote options after resume and fork subcommands', () => {
    const resume = planCodexInvocation(['-c', 'foo=true', 'resume', '--last'], '/work');
    const fork = planCodexInvocation(['fork', 'thread-id', 'continue'], '/work');
    expect(resume.mode).toBe('protocol');
    expect(fork.mode).toBe('protocol');
    if (resume.mode !== 'protocol' || fork.mode !== 'protocol') return;

    expect(injectRemoteArguments(resume, 'ws://127.0.0.1:4567', 'TOKEN')).toEqual([
      '-c',
      'foo=true',
      'resume',
      '--remote',
      'ws://127.0.0.1:4567',
      '--remote-auth-token-env',
      'TOKEN',
      '--last',
    ]);
    expect(injectRemoteArguments(fork, 'ws://127.0.0.1:4567', 'TOKEN')).toEqual([
      'fork',
      '--remote',
      'ws://127.0.0.1:4567',
      '--remote-auth-token-env',
      'TOKEN',
      'thread-id',
      'continue',
    ]);
  });

  it.each([
    ['resume'],
    ['resume', '--all'],
    ['resume', '--include-non-interactive'],
    ['resume', '--last'],
    ['resume', 'thread-id'],
    ['fork'],
    ['fork', '--all'],
    ['fork', '--last'],
    ['fork', 'thread-id'],
  ])('uses protocol mode for the supported interactive invocation %j', (...args) => {
    expect(planCodexInvocation(args, '/work')).toMatchObject({
      mode: 'protocol',
      command: args[0],
    });
  });

  it.each([
    [['--profile', 'work'], 'profiles'],
    [['-p', 'work'], 'profiles'],
    [['--remote', 'ws://other:1234'], 'explicit remote'],
    [['--remote=ws://other:1234'], 'explicit remote'],
    [['--future-option'], 'unknown option'],
    [['--oss'], 'OSS provider'],
    [['exec', 'echo hello'], 'not an interactive'],
    [['e', 'echo hello'], 'not an interactive'],
    [['a'], 'not an interactive'],
    [['resume', 'one', 'two', 'three'], 'too many positional'],
  ])('fails open for unsupported invocation %j', (args, reason) => {
    expect(planCodexInvocation(args, '/work')).toMatchObject({
      mode: 'passthrough',
      reason: expect.stringContaining(reason),
      tuiArgs: args,
    });
  });

  it('accepts only known explicit OSS providers', () => {
    expect(planCodexInvocation(['--oss', '--local-provider', 'ollama'], '/work').mode).toBe(
      'protocol',
    );
    expect(
      planCodexInvocation(['--oss', '--local-provider', 'custom-provider'], '/work'),
    ).toMatchObject({ mode: 'passthrough' });
  });

  it('requires Codex 0.145 or newer for protocol mode', () => {
    expect(isCodexProtocolVersion('codex-cli 0.144.3')).toBe(false);
    expect(isCodexProtocolVersion('codex-cli 0.145.0')).toBe(true);
    expect(isCodexProtocolVersion('codex-cli 0.146.1-beta.1')).toBe(true);
    expect(isCodexProtocolVersion('codex-cli 1.0.0')).toBe(true);
    expect(isCodexProtocolVersion('unknown')).toBe(false);
  });
});
