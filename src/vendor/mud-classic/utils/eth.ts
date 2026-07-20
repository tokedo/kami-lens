/**
 * kami-lens vendored dependency (MIT, compatible with this repo's AGPL-3.0).
 * package:   @mud-classic/utils@0.0.3 — the exact artifact the upstream client
 *            resolves (integrity matches upstream pnpm-lock.yaml at the pin).
 * source:    src/eth.ts, recovered verbatim from the published artifact's
 *            source maps.
 * copyright: (c) 2022-present Lattice Labs Ltd. (MIT License)
 * changes:   none
 */

/**
 * Pads start of a hex string with 0 to create a bit string of the given length
 * @param input Hex string
 * @param bits Number of bits in the output hex string
 * @returns Hex string of specified length
 */
export function padToBitLength(input: string, bits: number) {
  // Cut off 0x prefix
  if (input.substring(0, 2) == "0x") input = input.substring(2);
  // Pad start with 0 to get desired bit length
  const length = bits / 4;
  input = input.padStart(length, "0");
  input = input.substring(input.length - length);
  // Prefix with 0x
  return `0x${input}`;
}

/**
 * Pads start of a hex string with 0 to create a 160 bit hex string
 * which can be used as an Ethereum address
 * @param input Hex string
 * @returns 160 bit hex string
 */
export function toEthAddress(input: string) {
  return padToBitLength(input, 160);
}

/**
 * Pads start of a hex string with 0 to create a 256bit hex string
 * which can be used as an Ethereum address
 * @param input Hex string
 * @returns 256 bit hex string
 */
export function to256BitString(input: string) {
  return padToBitLength(input, 256);
}

export function extractEncodedArguments(input: string) {
  // Cutting off the first 4 bytes, which represent the function selector
  if (input[0] !== "0" && input[1] !== "x") throw new Error("Invalid hex string");
  return "0x" + input.substring(10);
}
