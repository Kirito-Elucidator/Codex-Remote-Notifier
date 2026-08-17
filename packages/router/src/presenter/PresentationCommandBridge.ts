import * as vscode from 'vscode';

import {
  assertMatchingPresentationReceipt,
  AttentionPresentationPort,
  COMMAND_EXCHANGE_PRESENTATION,
  parsePresentationExchange,
  parsePresentationReceipt,
  PresentationExchange,
  PresentationReceipt,
} from 'remote-notifier-shared';

export type PresentationCommandExecutor = (
  command: string,
  input: PresentationExchange,
) => Promise<unknown>;

export class PresentationCommandBridge implements AttentionPresentationPort {
  constructor(
    private readonly execute: PresentationCommandExecutor = async (command, input) =>
      vscode.commands.executeCommand(command, input),
  ) {}

  async exchange(input: PresentationExchange): Promise<PresentationReceipt> {
    const exchange = parsePresentationExchange(input);
    const result = await this.execute(COMMAND_EXCHANGE_PRESENTATION, exchange);
    let receipt: PresentationReceipt;
    try {
      receipt = parsePresentationReceipt(result);
    } catch (error) {
      if (result === undefined) {
        throw new Error('Main presentation command returned no receipt', { cause: error });
      }
      throw error;
    }
    assertMatchingPresentationReceipt(exchange, receipt);
    return receipt;
  }
}
