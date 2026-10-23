/**
 * kami-lens vendor port (AGPL-3.0 — see LICENSE).
 * upstream: Asphodel-OS/kamigotchi-open @ 04cb25f8f3009ca9b89e62e20bd3d7afa12e98ad
 * path:     packages/client/src/engine/encoders/encode.ts
 * changes:  none
 */

import { AbiCoder } from 'ethers';

import { ContractSchemaValue, ContractSchemaValueId } from './types';

/**
 * Creates a function to automatically encode component values given a contract component schema.
 *
 * @param keys Schema keys
 * @param valueTypes Schema value types
 * @returns Function to encode component values
 */
export function createEncoder<D extends { [key: string]: unknown }>(
  keys: (keyof D)[],
  valueTypes: ContractSchemaValue[]
): (value: D) => string {
  return (value) => {
    const contractArgTypes = [] as string[];
    const contractArgs = Object.values(value);

    for (const componentValueProp of Object.keys(value)) {
      const index = keys.findIndex((key) => key === componentValueProp);
      contractArgTypes.push(ContractSchemaValueId[valueTypes[index] as ContractSchemaValue]);
    }

    return AbiCoder.defaultAbiCoder().encode(contractArgTypes, contractArgs);
  };
}
