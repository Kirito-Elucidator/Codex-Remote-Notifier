import { vi } from 'vitest';

export const window = {
  showInformationMessage: vi.fn().mockResolvedValue(undefined),
  showWarningMessage: vi.fn().mockResolvedValue(undefined),
  showErrorMessage: vi.fn().mockResolvedValue(undefined),
  showQuickPick: vi.fn().mockResolvedValue(undefined),
  setStatusBarMessage: vi.fn(() => ({ dispose: vi.fn() })),
  createStatusBarItem: vi.fn(() => ({
    text: '',
    tooltip: '',
    command: '',
    show: vi.fn(),
    hide: vi.fn(),
    dispose: vi.fn(),
  })),
  withProgress: vi.fn((_options: unknown, task: (progress: any) => Promise<any>) =>
    task({ report: vi.fn() }),
  ),
  state: { focused: true, active: true },
  onDidChangeWindowState: vi.fn(() => ({ dispose: vi.fn() })),
  onDidChangeActiveTextEditor: vi.fn(() => ({ dispose: vi.fn() })),
  registerUriHandler: vi.fn(() => ({ dispose: vi.fn() })),
  createOutputChannel: vi.fn(() => ({
    appendLine: vi.fn(),
    append: vi.fn(),
    clear: vi.fn(),
    show: vi.fn(),
    hide: vi.fn(),
    dispose: vi.fn(),
  })),
};

export const extensions = {
  getExtension: vi.fn().mockReturnValue(undefined),
  all: [],
};

export const commands = {
  registerCommand: vi.fn((_cmd: string, _handler: (...args: unknown[]) => unknown) => ({
    dispose: vi.fn(),
  })),
  executeCommand: vi.fn().mockResolvedValue(undefined),
  getCommands: vi.fn().mockResolvedValue([]),
};

const _configStore: Record<string, unknown> = {};

export const workspace = {
  getConfiguration: vi.fn((_section?: string) => ({
    get: vi.fn((key: string, defaultValue?: unknown) => {
      const fullKey = _section ? `${_section}.${key}` : key;
      return fullKey in _configStore ? _configStore[fullKey] : defaultValue;
    }),
  })),
  workspaceFolders: [{ uri: { fsPath: '/test/workspace', toString: () => '/test/workspace' } }],
  onDidChangeConfiguration: vi.fn(() => ({ dispose: vi.fn() })),
  onDidChangeWorkspaceFolders: vi.fn(() => ({ dispose: vi.fn() })),
};

export function setMockConfig(key: string, value: unknown): void {
  _configStore[key] = value;
}

export function clearMockConfig(): void {
  for (const key of Object.keys(_configStore)) {
    delete _configStore[key];
  }
}

export const env = {
  clipboard: {
    writeText: vi.fn().mockResolvedValue(undefined),
    readText: vi.fn().mockResolvedValue(''),
  },
};

export const StatusBarAlignment = {
  Left: 1,
  Right: 2,
};

export const ProgressLocation = {
  SourceControl: 1,
  Window: 10,
  Notification: 15,
};

export const ExtensionMode = {
  Production: 1,
  Development: 2,
  Test: 3,
};

export class EventEmitter {
  event = vi.fn();
  fire = vi.fn();
  dispose = vi.fn();
}

export function createMockExtensionContext() {
  const workspaceState = createMockMemento();
  const globalState = createMockMemento();
  return {
    subscriptions: [] as { dispose: () => void }[],
    extensionPath: '/test/extension',
    extensionUri: { fsPath: '/test/extension' },
    storageUri: { fsPath: '/test/storage' },
    globalStorageUri: { fsPath: '/test/global-storage' },
    logUri: { fsPath: '/test/logs' },
    extensionMode: ExtensionMode.Test,
    environmentVariableCollection: createMockEnvCollection(),
    globalState,
    workspaceState,
  };
}

export function createMockEnvCollection() {
  const store = new Map<string, string>();
  return {
    replace: vi.fn((variable: string, value: string) => {
      store.set(variable, value);
    }),
    append: vi.fn(),
    prepend: vi.fn(),
    get: vi.fn((variable: string) => store.get(variable)),
    delete: vi.fn((variable: string) => store.delete(variable)),
    clear: vi.fn(() => store.clear()),
    forEach: vi.fn((callback: (variable: string, mutator: unknown) => void) => {
      store.forEach((_value, key) => callback(key, {}));
    }),
    persistent: true,
    description: '',
    [Symbol.iterator]: function* () {
      yield* store.entries();
    },
    _store: store,
  };
}

function createMockMemento() {
  const store = new Map<string, unknown>();
  return {
    get: vi.fn((key: string, defaultValue?: unknown) => store.get(key) ?? defaultValue),
    update: vi.fn((key: string, value: unknown) => {
      store.set(key, value);
      return Promise.resolve();
    }),
    keys: vi.fn(() => [...store.keys()]),
  };
}

export const Uri = {
  file: (path: string) => ({
    fsPath: path,
    scheme: 'file',
    path,
    toString: () => path,
    authority: '',
  }),
  parse: (uri: string) => ({
    fsPath: uri,
    scheme: 'file',
    path: uri,
    toString: () => uri,
    authority: '',
  }),
};
