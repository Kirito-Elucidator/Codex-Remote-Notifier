import * as vscode from 'vscode';
import { AutoConfigRegistry } from './AutoConfigRegistry';
import { ClaudeCodeAutoConfigProvider } from './ClaudeCodeAutoConfigProvider';
import { CodexAutoConfigProvider } from './CodexAutoConfigProvider';
import { GeminiAutoConfigProvider } from './GeminiAutoConfigProvider';

export function createAutoConfigRegistry(log?: vscode.OutputChannel): AutoConfigRegistry {
  const registry = new AutoConfigRegistry();
  registry.register(new ClaudeCodeAutoConfigProvider(log));
  registry.register(new CodexAutoConfigProvider(log));
  registry.register(new GeminiAutoConfigProvider(log));
  return registry;
}
