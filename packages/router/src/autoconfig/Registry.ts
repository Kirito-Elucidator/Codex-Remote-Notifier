import * as vscode from 'vscode';

import { AutoConfigRegistry } from './AutoConfigRegistry';
import { ClaudeCodeAutoConfigProvider } from './ClaudeCodeAutoConfigProvider';
import { CodexAutoConfigProvider } from './CodexAutoConfigProvider';
import { GeminiAutoConfigProvider } from './GeminiAutoConfigProvider';

export function createAutoConfigRegistry(
  log?: vscode.OutputChannel,
  codexProvider = new CodexAutoConfigProvider(log),
): AutoConfigRegistry {
  const registry = new AutoConfigRegistry();
  registry.register(new ClaudeCodeAutoConfigProvider(log));
  registry.register(codexProvider);
  registry.register(new GeminiAutoConfigProvider(log));
  return registry;
}
