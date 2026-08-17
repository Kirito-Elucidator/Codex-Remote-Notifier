import {
  assertMatchingPresentationReceipt,
  AttentionPresentationPort,
  parsePresentationExchange,
  parsePresentationReceipt,
  PresentationReceipt,
} from 'remote-notifier-shared';

export type PresentationExchangeCommandHandler = (input: unknown) => Promise<PresentationReceipt>;

export function createPresentationExchangeCommandHandler(
  endpoint: AttentionPresentationPort,
): PresentationExchangeCommandHandler {
  return async (input) => {
    const exchange = parsePresentationExchange(input);
    const receipt = parsePresentationReceipt(await endpoint.exchange(exchange));
    assertMatchingPresentationReceipt(exchange, receipt);
    return receipt;
  };
}

export function createUnavailablePresentationEndpoint(): AttentionPresentationPort {
  return {
    exchange: async ({ transactionId }) => ({
      kind: 'rejected',
      transactionId,
      reason: 'unavailable',
    }),
  };
}
