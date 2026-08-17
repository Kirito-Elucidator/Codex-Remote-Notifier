import {
  BrokerRuntimePaths,
  createDefaultBrokerRuntimePaths,
  PRESENTATION_BROKER_PROTOCOL_VERSION,
} from './broker/BrokerProtocol';
import { PresentationBrokerServer } from './broker/PresentationBrokerServer';

async function run(): Promise<void> {
  const paths = runtimePathsFromEnvironment();
  const protocolVersion = parseProtocolVersion(process.env.REMOTE_NOTIFIER_BROKER_PROTOCOL_VERSION);
  const broker = new PresentationBrokerServer({ paths, protocolVersion });
  const outcome = await broker.start();
  if (outcome === 'existing') return;

  process.once('SIGINT', () => void broker.stop('controlled'));
  process.once('SIGTERM', () => void broker.stop('controlled'));
  await broker.closed;
}

function runtimePathsFromEnvironment(): BrokerRuntimePaths {
  const discoveryFile = process.env.REMOTE_NOTIFIER_BROKER_DISCOVERY_FILE;
  const pipeAddress = process.env.REMOTE_NOTIFIER_BROKER_PIPE_ADDRESS;
  if (discoveryFile === undefined && pipeAddress === undefined) {
    return createDefaultBrokerRuntimePaths();
  }
  if (!discoveryFile || !pipeAddress) {
    throw new Error('Incomplete presentation broker runtime paths');
  }
  return { discoveryFile, pipeAddress };
}

function parseProtocolVersion(value: string | undefined): number {
  if (value === undefined) return PRESENTATION_BROKER_PROTOCOL_VERSION;
  const version = Number(value);
  if (!Number.isSafeInteger(version) || version < 0) {
    throw new Error('Invalid presentation broker protocol version');
  }
  return version;
}

void run().catch(() => {
  process.exitCode = 1;
});
