/**
 * kami-lens vendor port (AGPL-3.0 — see LICENSE).
 * upstream: Asphodel-OS/kamigotchi-open @ 8fb6ea58be5f773909a4d6d8db32f4726512b8e0
 * path:     packages/client/src/workers/sync/evm/topics.ts
 * changes:  none
 */

import { ethers } from 'ethers';

import { Contracts } from 'engine/types';

export type ContractTopics = {
  key: string;
  topics: string[][];
};

type TopicsConfig<C extends Contracts> = {
  [ContractType in keyof C]: {
    abi: ethers.Interface;
    topics: (keyof C[ContractType]['filters'])[];
  };
};

// we make some assumptions here on the input topic config being valid
export function createTopics<C extends Contracts>(config: TopicsConfig<C>): ContractTopics[] {
  const contractTopics: ContractTopics[] = [];
  for (const key of Object.keys(config)) {
    const { abi, topics } = config[key]!;
    const contractTopic = [topics.map((t) => abi.getEvent(t as string)!.topicHash || [])] as Array<
      string[]
    >;
    contractTopics.push({
      key,
      topics: contractTopic,
    });
  }
  return contractTopics;
}
