import { describe, expect, it, vi } from 'vitest';

import { launchDetachedPresentationBroker } from '../../src/PresentationBrokerClient';

describe('launchDetachedPresentationBroker', () => {
  it('launches the broker detached and hidden without passing an epoch credential', () => {
    const unref = vi.fn();
    const spawnProcess = vi.fn(() => ({ unref }));

    launchDetachedPresentationBroker({
      executable: 'Code.exe',
      paths: {
        discoveryFile: 'C:\\Users\\test\\AppData\\Local\\broker.json',
        pipeAddress: '\\\\.\\pipe\\remote-notifier-test',
      },
      protocolVersion: 7,
      scriptPath: 'C:\\extension\\dist\\presentation-broker.js',
      spawnProcess,
    });

    expect(spawnProcess).toHaveBeenCalledOnce();
    const [command, args, options] = spawnProcess.mock.calls[0];
    expect(command).toBe('Code.exe');
    expect(args).toEqual(['C:\\extension\\dist\\presentation-broker.js']);
    expect(options).toMatchObject({
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
      env: {
        ELECTRON_RUN_AS_NODE: '1',
        REMOTE_NOTIFIER_BROKER_DISCOVERY_FILE: 'C:\\Users\\test\\AppData\\Local\\broker.json',
        REMOTE_NOTIFIER_BROKER_PIPE_ADDRESS: '\\\\.\\pipe\\remote-notifier-test',
        REMOTE_NOTIFIER_BROKER_PROTOCOL_VERSION: '7',
      },
    });
    expect(JSON.stringify(options)).not.toContain('credential');
    expect(unref).toHaveBeenCalledOnce();
  });
});
