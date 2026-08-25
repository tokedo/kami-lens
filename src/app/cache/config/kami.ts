/**
 * kami-lens vendor port (AGPL-3.0 — see LICENSE).
 * upstream: Asphodel-OS/kamigotchi @ ef898fc9350a6085fb080419b12af96c2254e8f3
 * path:     packages/client/src/app/cache/config/kami.ts
 * changes:  isFalseyAST and isFalseyEfficacy treat a NON-FINITE value as
 *           falsey (SPEC §4.2, "the config re-read guard sees NaN"). Upstream
 *           compares each value against 0, and NaN === 0 is false — so the
 *           one poison shape that matters, an unhydrated config structuring
 *           to NaN, reads as a HEALTHY config and is stamped as good, while
 *           the harmless eight-zeros shape correctly triggers a re-read. The
 *           guard was inverted for exactly the case it exists to catch.
 *           Bodies otherwise verbatim.
 */

import { World } from 'engine/recs';

import { Components } from 'network/comps';
import { AsphoAST, Efficacy, KamiConfigs } from 'network/shapes/Kami';
import { getArray, getValue, processArray, processValue } from './base';

// construct the kami config object based on known keys and shapes
// NOTE: these values get cached with no live updates to the ui layer. updates require refresh
export const getConfig = (world: World, comps: Components): KamiConfigs => {
  return {
    harvest: {
      bounty: getAST(world, comps, 'KAMI_HARV_BOUNTY'),
      efficacy: {
        body: getEfficacy(world, comps, 'KAMI_HARV_EFFICACY_BODY'),
        hand: getEfficacy(world, comps, 'KAMI_HARV_EFFICACY_HAND'),
      },
      fertility: getAST(world, comps, 'KAMI_HARV_FERTILITY'),
      intensity: getAST(world, comps, 'KAMI_HARV_INTENSITY'),
      strain: getAST(world, comps, 'KAMI_HARV_STRAIN'),
    },
    liquidation: {
      animosity: getAST(world, comps, 'KAMI_LIQ_ANIMOSITY'),
      efficacy: getEfficacy(world, comps, 'KAMI_LIQ_EFFICACY'),
      threshold: getAST(world, comps, 'KAMI_LIQ_THRESHOLD'),
      salvage: getAST(world, comps, 'KAMI_LIQ_SALVAGE'),
      spoils: getAST(world, comps, 'KAMI_LIQ_SPOILS'),
      karma: getAST(world, comps, 'KAMI_LIQ_KARMA'),
      recoil: getAST(world, comps, 'KAMI_LIQ_RECOIL'),
      karmaEfficacy: getEfficacy(world, comps, 'KAMI_LIQ_KARMA_EFFICACY'),
    },
    rest: {
      metabolism: getAST(world, comps, 'KAMI_REST_METABOLISM'),
      recovery: getAST(world, comps, 'KAMI_REST_RECOVERY'),
    },
    general: {
      cooldown: getValue(world, comps, 'KAMI_STANDARD_COOLDOWN'),
      skills: getArray(world, comps, 'KAMI_TREE_REQ'),
    },
  };
};

// (re)process the kami config object based on known keys and shapes
export const processConfig = (world: World, comps: Components): KamiConfigs => {
  return {
    harvest: {
      bounty: processAST(world, comps, 'KAMI_HARV_BOUNTY'),
      efficacy: {
        body: processEfficacy(world, comps, 'KAMI_HARV_EFFICACY_BODY'),
        hand: processEfficacy(world, comps, 'KAMI_HARV_EFFICACY_HAND'),
      },
      fertility: processAST(world, comps, 'KAMI_HARV_FERTILITY'),
      intensity: processAST(world, comps, 'KAMI_HARV_INTENSITY'),
      strain: processAST(world, comps, 'KAMI_HARV_STRAIN'),
    },
    liquidation: {
      animosity: processAST(world, comps, 'KAMI_LIQ_ANIMOSITY'),
      efficacy: processEfficacy(world, comps, 'KAMI_LIQ_EFFICACY'),
      threshold: processAST(world, comps, 'KAMI_LIQ_THRESHOLD'),
      salvage: processAST(world, comps, 'KAMI_LIQ_SALVAGE'),
      spoils: processAST(world, comps, 'KAMI_LIQ_SPOILS'),
      karma: processAST(world, comps, 'KAMI_LIQ_KARMA'),
      recoil: processAST(world, comps, 'KAMI_LIQ_RECOIL'),
      karmaEfficacy: processEfficacy(world, comps, 'KAMI_LIQ_KARMA_EFFICACY'),
    },
    rest: {
      metabolism: processAST(world, comps, 'KAMI_REST_METABOLISM'),
      recovery: processAST(world, comps, 'KAMI_REST_RECOVERY'),
    },
    general: {
      cooldown: processValue(world, comps, 'KAMI_STANDARD_COOLDOWN'),
      skills: processArray(world, comps, 'KAMI_TREE_REQ'),
    },
  };
};

// check if any field of the KamiConfig is falsey
export const isFalsey = (configs: KamiConfigs) => {
  return (
    isFalseyAST(configs.harvest.bounty) ||
    isFalseyEfficacy(configs.harvest.efficacy.body) ||
    isFalseyEfficacy(configs.harvest.efficacy.hand) ||
    isFalseyAST(configs.harvest.fertility) ||
    isFalseyAST(configs.harvest.intensity) ||
    isFalseyAST(configs.harvest.strain) ||
    isFalseyAST(configs.liquidation.animosity) ||
    isFalseyEfficacy(configs.liquidation.efficacy) ||
    isFalseyAST(configs.liquidation.threshold) ||
    isFalseyAST(configs.liquidation.salvage) ||
    isFalseyAST(configs.liquidation.spoils) ||
    isFalseyAST(configs.liquidation.karma) ||
    isFalseyAST(configs.liquidation.recoil) ||
    isFalseyEfficacy(configs.liquidation.karmaEfficacy) ||
    isFalseyAST(configs.rest.metabolism) ||
    isFalseyAST(configs.rest.recovery)
  );
};

/////////////////
// AST NODES

// retrieve a full AsphoAST config from its key
const getAST = (world: World, comps: Components, key: string): AsphoAST => {
  const configArray = getArray(world, comps, key);
  return structureAST(configArray);
};

// process a full AsphoAST config from its key
const processAST = (world: World, comps: Components, key: string): AsphoAST => {
  const configArray = processArray(world, comps, key);
  return structureAST(configArray);
};

const structureAST = (config: number[]): AsphoAST => {
  return {
    nudge: {
      raw: config[0],
      precision: config[1],
      value: config[0] / 10 ** config[1],
    },
    ratio: {
      raw: config[2],
      precision: config[3],
      value: config[2] / 10 ** config[3],
    },
    shift: {
      raw: config[4],
      precision: config[5],
      value: config[4] / 10 ** config[5],
    },
    boost: {
      raw: config[6],
      precision: config[7],
      value: config[6] / 10 ** config[7],
    },
  };
};

/** Falsey OR unusable. A config value that is not a finite number cannot be
 * computed with, and treating it as healthy is what made the poison permanent
 * (§4.2). */
const unusable = (v: number) => !Number.isFinite(v) || v === 0;

const isFalseyAST = (node: AsphoAST) => {
  return (
    unusable(node.nudge.value) &&
    unusable(node.ratio.value) &&
    unusable(node.shift.value) &&
    unusable(node.boost.value)
  );
};

/////////////////
// EFFICACY NODES

// get an efficacy config node for liquidation
const getEfficacy = (world: World, comps: Components, key: string): Efficacy => {
  const configArray = getArray(world, comps, key);
  return structureEfficacy(configArray);
};

// process an efficacy config node for liquidation
const processEfficacy = (world: World, comps: Components, key: string): Efficacy => {
  const configArray = processArray(world, comps, key);
  return structureEfficacy(configArray);
};

const structureEfficacy = (config: number[]): Efficacy => {
  const precision = 10 ** config[0];
  return {
    base: config[1] / precision,
    up: config[2] / precision,
    down: -config[3] / precision,
    special: config[4] / precision,
  };
};

const isFalseyEfficacy = (efficacy: Efficacy) => {
  return (
    unusable(efficacy.base) &&
    unusable(efficacy.up) &&
    unusable(efficacy.down) &&
    unusable(efficacy.special)
  );
};
