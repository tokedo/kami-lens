# Contract-formula parity — 2026-10-23 (1.1.0)

`test/formula-parity.test.ts` evaluates each contract formula beside the
lens's ported counterpart: a reference evaluation of the Solidity arithmetic,
transcribed with its integer precision slots, truncating division and clamps,
against the port the daemon runs, on the shapes it builds. Every case below is
asserted by the test — an equal case as equal to the unit, a divergent one as
the divergence documented here (its class and its size). Regenerate the tables
with `FORMULA_PARITY_RECORD=<file> npx vitest run test/formula-parity.test.ts`.

**Sources.** The formula list — `generated/formulas.yaml`, 40 keys (38 plain
keys plus the two quoted overloads of `LibHarvest.calcEfficacy`) — is from the
Kami Atlas by Asphodel Studios, https://github.com/Asphodel-OS/kami-atlas
(commit `ac64364`), generated from kamigotchi at `04cb25f8f300`, licensed
CC BY 4.0. The transcriptions (`test/formula-parity.test.ts`,
`test/support/solidity.ts`) are this repository's own code (AGPL-3.0-only),
written against the contract source at Asphodel-OS/kamigotchi-open @
`04cb25f8` (AGPL-3.0-only). The transcendental pieces are transcribed from the
libraries the contracts use at that pin — Solady `FixedPointMathLib`
(`lnWad`, `expWad`, `powWad`; the contracts' Solmate copy for the Gaussian),
Solstat `Gaussian.cdf`/`erfc`, PRBMath 4.1.0 `SD59x18` (`pow`, `exp2`,
`log2`) — and reproduce the libraries' own published test vectors exactly
(asserted). Config: the live world's arrays (`test/support/mirror.ts`,
read 2026-10-03). Clock pinned at chain second 1,790,000,000.

## Summary

- **Mapping:** 40 manifest keys — **30 compared directly**, **3 through a
  composite** (`LibGDA.calc` through the listing and auction prices;
  `LibKill.calcAnimosity` and `LibKill.calcThresholdEfficacy`, module-private
  in the port, through `LibKill.calcThreshold`), **7 unported**
  (`LibKamiMarket.calcFee`, `LibKill.calculateHealthValues`,
  `LibPool.calcInitialLiquidity`, `LibTax.calcBill`,
  `LibTokenPortal.calcExportTax`, `LibTokenPortal.calcImportTax`,
  `NewbieVendorBuySystem.calcPrice` — none has a served counterpart).
- **Equal everywhere tested:** stamina recovery and `calcSync`, the efficacy
  shift table, the threshold (with animosity and threshold efficacy: 0 of
  4,000 swept), recoil efficacy, strain (0 / 4,000), resting recovery
  (0 / 4,000), level cost through level 118, the pool swap, bonus × level,
  rarity weights (tiers ≤ 31), the withdrawal delay, unclamped merchant
  prices and auction prices at prices up to 1e9 (0 / 3,543 and 0 / 3,617).
- **Divergence classes found:** float floor at a precision slot (fertility,
  intensity, max musu, and the bounty and spoils that inherit them — always
  one unit LOW); rounding (an odd fertility bonus on a NORMAL trait; stat
  totals; SCALED sell prices); missing branch / clamp / revert (spoils and
  salvage above ratio 1.0; efficacy below 0; stat totals below 0; an auction
  decayed to zero); client-only approximation (karma and metabolism kept
  unfloored — recoil HIGH by up to ⌈strain / 1000⌉ HP); precision slot (the
  merchant deficit clamp in whole seconds).

## Divergences in SERVED values — for a ruling (fix in 1.1.x, or a register row)

Serving sites are at the 1.1.0 head, `src/queries/build.ts` unless named.

1. **`node … --with-vitals <attacker>` → `liquidation.recoil`**
   (`build.ts:1533`, `calcLiqRecoil`). The port does not floor karma at
   `KARMA_PREC` (1e-3): the served recoil is HIGH by 0–3 HP — 858 of 3,000
   swept previews (1: 787, 2: 59, 3: 12). The bound is ⌈strain / 1000⌉.
   Every preview on the live config is affected in proportion to its strain.
2. **`liquidation.spoils`** (`build.ts:1531`, `calcLiqSpoils`). (a) The chain
   tests `ratio / precision > 1` in INTEGER division, so a killer whose spoils
   ratio is in (1.0, 2.0) — power 56–154 with no bonus on the live config
   `[45, 2, 0, 3]` — is paid `amount × ratio`, up to 1.99 × what remains of
   the bounty; the port caps at `min(1, ratio)` (killer power 60: chain 787,
   port 750). (b) A float floor one unit low, 2 of 3,000 swept.
3. **`liquidation.salvage`** (`build.ts:1532`, `calcLiqSalvage`). A victim
   whose salvage ratio is in (1.0, 2.0) — power 101–199 with no bonus,
   `[0, 2, 0, 3]` — makes the chain's `bounty - salvage` underflow: the
   liquidation REVERTS, while the port serves a salvage above the bounty and
   an eligible preview. From ratio 2.0 the chain pays the bounty and the port
   `bounty × ratio`. (The port also hard-codes `power / 100` where the chain
   scales by `10^(config[3] − config[1])`: equal on the live config.) Equal
   in all 3,000 swept at ordinary power (5–50).
4. **`hp.total`, `stats.*.total`** (`kami`, `party`, node vitals; `build.ts`
   `vitalsOf` 793, node rows 1502, `statsOf` 640; `network/shapes/Stats`).
   The chain's `LibStat.calcTotal` truncates `(1000 + boost)·(base + shift)
   / 1000` to an int32 and floors at 0; the port serves the float (base 13,
   boost 50: chain 13, port 13.65; base + shift −3: chain 0, port −3).
   Latent while stat boosts are 0 — all 21 kamis of the 2026-10-03 G2.d
   sample have boost 0.
5. **`merchant <npc>` → `buyPrice`** (`build.ts:2480`). When the GDA deficit
   clamp binds and `prevSold·period / rate` is not a whole number of seconds,
   the chain's cap is floored to whole seconds and its price is a little
   higher: the port is ONE unit low in 52 of 348 such cases (equal when
   unclamped, 0 / 3,543).
6. **`merchant <npc>` → `sellPrice`** (`build.ts:2489`). A SCALED sell price
   is served as `scale × buyPrice` without the chain's floor of
   `(price × scale_raw) / 1e9` (0.3 of 86: chain 25, port 25.8).
7. **`musu.accrued` / `vitals.musuAccrued`** (`build.ts:813`, 1506) and the
   musu rates (814–815). (a) Fertility and intensity are floored at 1e-6 in
   floats: one unit LOW at exact integers (84 and 15 of 4,000 swept); over a
   long harvest the unit becomes a MUSU (1,000,000 s on the fertility
   boundary: chain 117,861, port 117,860; the bounty sweep found none in
   4,000). (b) A NORMAL body or hand halves the fertility bonus: the chain
   truncates `bonus / 2` toward zero, the port keeps the half (bonus 25:
   efficacy 1387 vs 1387.5). (c) The chain floors the summed efficacy at 0,
   the port does not (latent: needs a large negative bonus). The `hp.current`
   of a HARVESTING kami inherits (a) through the strain of the bounty.
8. **`auctions` → `price`** (`src/queries/feeds.ts:499`). Equal at realistic
   prices; an auction decayed until its cost rounds to 0 makes the chain
   REVERT ("LibAuction: negative GDA cost") while the port serves 1; an
   exponent beyond PRBMath's range reverts on chain while the port serves a
   float.
9. **`xpRequired`** (`build.ts:300`). Equal through level 118; from level 119
   (≥ 2.5e13 XP) `Math.pow` is one XP below Solady's `powWad`.

Not served, recorded for completeness: the metabolism rate (a display string;
the port keeps the unfloored rate, the served `hp.current` is equal in all
4,000 swept); karma itself (served only through recoil); the trade tax (a
float floor: MUSU 100 at 29 % → chain 29, port 28); an unset `LastTime`
(the port reads 0).

## Latent, not exercised by the live config

- `calcThreshold`: the port adds `KAMI_LIQ_THRESHOLD[4]` (the shift slot),
  which the chain never reads (`[4]` is 0 live).
- `LibAffinity.getShifts` ignores an efficacy config's precision slot `[0]`;
  the port divides by it — equal while it matches the target's precision
  (3 live).
- `calcCurrentStamina` falls back to 60 s when `ACCOUNT_STAMINA[1]` is 0; the
  chain would divide by zero.
- Rarity tiers ≥ 32: JavaScript's 32-bit `<<` (tiers at the pin are ≤ 9).
- A node with more than two affinities: the chain reverts, the port returns
  no shift.

### Divergent cases (hand-picked; each asserted by the test)

| Formula | Inputs | Chain | Port | Class |
|---|---|---|---|---|
| `LibHarvest.calcEfficacy(string,string,Shifts,string)` | NORMAL body, EERIE hand on EERIE, bonus 25 | 1387 | 1387.5 | rounding: int256 bonus.up / 2 truncates; the port keeps .5 |
| `LibHarvest.calcEfficacy(string,string,Shifts,string)` | NORMAL/NORMAL, bonus −25 | 976 | 975 | rounding: toward zero on chain; the port keeps −.5 per trait |
| `LibHarvest.calcEfficacy(uint256,uint256,uint256)` | NORMAL/NORMAL, bonus −2500 | 0 | -1500 | missing clamp: efficacy < 0 → 0 on chain |
| `LibHarvest.calcDuration` | no LastTime | 1790000000 | 0 | guard: an unset LastTime reads 0 in the port |
| `LibHarvest.calcFertility` | power 78, INSECT/EERIE on SCRAP | 21125 | 21124 | float floor at RATE_PREC |
| `LibHarvest.calcIntensity` | violence 57, reset 47750 s ago | 6250 | 6249 | float floor at RATE_PREC |
| `LibHarvest.calcMaxMusu` | hp 1649, harmony 45, strain bonus −224 | 21250 | 21249 | float floor |
| `LibHarvest.calcBounty` | power 78, INSECT/EERIE on SCRAP, 1,000,000 s | 117861 | 117860 | float floor (inherited from fertility) |
| `LibKami.calcMetabolism` | harmony 15 | 5833333 | 5833333.333333334 | unfloored rate (display) |
| `LibKill.calcKarma` | defender violence 25, attacker harmony 22 | 1101 | 1101.7191599332664 | unfloored at KARMA_PREC |
| `LibKill.calcKarma` | defender violence 40, attacker harmony 30 | 1226 | 1226.4098857318056 | unfloored at KARMA_PREC |
| `LibKill.calcRecoil` | defender violence 73, attacker harmony 9, strain 598 | 1771 | 1772 | unfloored karma (KARMA_PREC) |
| `LibKill.calcSpoils` | killer power 60, victim power 25, bounty 1000 | 787 | 750 | missing branch: ratio / precision > 1 is integer division |
| `LibKill.calcSalvage` | victim power 120 (the liquidation reverts on chain) | revert | 1200 | missing branch: bounty − salvage underflows on chain |
| `LibKill.calcSalvage` | victim power 250 | 1000 | 2500 | missing branch: ratio / precision > 1 → amt |
| `LibExperience.calcLevelCost` | level 119 | 25415352880253 | 25415352880252 | float power at ≥ 2.5e13 XP |
| `LibStat.calcTotal` | base 13, boost 50 | 13 | 13.65 | rounding: int32 truncation |
| `LibStat.calcTotal` | base 33, boost −100 | 29 | 29.7 | rounding: int32 truncation |
| `LibStat.calcTotal` | base −5, shift 2 | 0 | -3 | missing clamp at 0 |
| `LibListing.calcBuyPrice` | clamped, 20·3600 / 69 not whole | 12215 | 12214 | precision slot: cap = floor(prevSold·period/rate) s |
| `LibListing.calcSellPrice` | SCALED 0.3 of a buy price of 86 | 25 | 25.8 | rounding: no floor on price × scale |
| `LibAuction.calcBuy` | decayed 600 periods at 0.5 | revert | 1 | missing revert (the cost rounds to 0) |
| `LibTrade.calcTax` | MUSU 100 at 29/100 | 29 | 28 | float floor (0.29 × 100 = 28.999…) |

### Seeded sweeps

Seed 20261023. A difference outside the stated set fails the test, and the divergent count is asserted, so the figures below are what the test checks.

| Formula | Samples | Divergent | port − chain: count | Class | First example |
|---|---|---|---|---|---|
| `LibHarvest.calcFertility` | 4000 | 84 | -1: 84, 0: 3916 | float floor at RATE_PREC | power 33, SCRAP/INSECT on SCRAP, +338: chain 25960, port 25959 |
| `LibHarvest.calcIntensity` | 4000 | 15 | -1: 15, 0: 3985 | float floor at RATE_PREC | violence 81, reset 8150 s ago: chain 3125, port 3124 |
| `LibHarvest.calcBounty` | 4000 | 0 | 0: 4000 | float floor (inherited) — none in this sample; see the hand-picked case | — |
| `LibHarvest.calcMaxMusu` | 4000 | 0 | 0: 4000 | float floor — none in this sample; see the hand-picked case | — |
| `LibKami.calcStrain` | 4000 | 0 | 0: 4000 | equal | — |
| `LibKami.calcRecovery` | 4000 | 0 | 0: 4000 | equal | — |
| `LibKill.calcThreshold` | 4000 | 0 | 0: 4000 | equal | — |
| `LibKill.calcSalvage` | 3000 | 0 | 0: 3000 | equal | — |
| `LibKill.calcSpoils` | 3000 | 2 | -1: 2, 0: 2998 | float floor | attacker 61/65/47 EERIE/EERIE, defender 29/65/19 EERIE/EERIE, bounty 9505, strain bonus 31: chain 7084, port 7083 |
| `LibKill.calcRecoil` | 3000 | 858 | 0: 2142, 1: 787, 2: 59, 3: 12 | unfloored karma (KARMA_PREC): up to ⌈strain / 1000⌉ HP high | attacker 29/49/19 EERIE/EERIE, defender 45/33/37 EERIE/EERIE, bounty 15009, strain bonus 33: chain 1137, port 1138 |
| `LibListing.calcBuyPrice` | 3543 | 0 | 0: 3543 | equal (unclamped) | — |
| `LibListing.calcBuyPrice` | 348 | 52 | -1: 52, 0: 296 | precision slot: cap = floor(prevSold·period/rate) s (clamped, not whole) | 14849, period 3600, decay 811080, rate 33, sold 38, 17349 s: chain 7924, port 7923 |
| `LibAuction.calcBuy` | 3617 | 0 | 0: 3617 | equal | — |

### Equal cases (hand-picked)

| Formula | Inputs | Chain = port |
|---|---|---|
| `LibAccount.calcStaminaRecovery` | an exact multiple of the period | 50 |
| `LibAccount.calcStaminaRecovery` | one second short of the next point | 50 |
| `LibAccount.calcStaminaRecovery` | clamped at the total | 100 |
| `LibAccount.calcStaminaRecovery` | from empty | 1 |
| `LibAccount.calcStaminaRecovery` | no time passed | 7 |
| `LibStat.calcSync` | 5 + -9 of 100 | 0 |
| `LibStat.calcSync` | 99 + 3 of 100 | 100 |
| `LibStat.calcSync` | 40 + 7 of 100 | 47 |
| `LibAffinity.calcEfficacyShift` | Strong (body) | 650 |
| `LibAffinity.calcEfficacyShift` | Strong + a 120 fertility bonus | 770 |
| `LibAffinity.calcEfficacyShift` | Weak (hand) | -100 |
| `LibAffinity.calcEfficacyShift` | Neutral (the bonus does not apply) | 0 |
| `LibHarvest.calcEfficacy(uint256,uint256,uint256)` | EERIE/SCRAP on EERIE | 1550 |
| `LibHarvest.calcEfficacy(uint256,uint256,uint256)` | INSECT/INSECT on SCRAP-INSECT, bonus 40 | 1590 |
| `LibHarvest.calcEfficacy(uint256,uint256,uint256)` | SCRAP/EERIE on EERIE-SCRAP (the favourable order) | 2000 |
| `LibHarvest.calcEfficacy(string,string,Shifts,string)` | NORMAL body, EERIE hand on EERIE, bonus 40 | 1410 |
| `LibHarvest.calcDuration` | last 1234 s ago | 1234 |
| `LibHarvest.calcIntensityDuration` | reset 98765 s ago | 98765 |
| `LibHarvest.calcFertility` | power 20, EERIE/SCRAP on EERIE | 12916 |
| `LibHarvest.calcFertility` | power 55, INSECT/INSECT on INSECT | 45833 |
| `LibHarvest.calcFertility` | power 37, SCRAP/EERIE on EERIE-SCRAP | 30833 |
| `LibHarvest.calcIntensity` | violence 22, reset 9999 s ago | 1597 |
| `LibHarvest.calcMaxMusu` | hp 200, harmony 30 | 1538 |
| `LibHarvest.calcBounty` | an hour on a matching node | 50 |
| `LibHarvest.calcBounty` | capped by max musu | 953 |
| `LibHarvest.calcBounty` | a fresh harvest | 23 |
| `LibKami.calcStrain` | an exact quotient | 13 |
| `LibKami.calcStrain` | a remainder rounds up | 7 |
| `LibKami.calcStrain` | with a −100 strain bonus | 117 |
| `LibKami.calcStrain` | with a +50 strain bonus | 214 |
| `LibKami.calcRecovery` | 10 minutes resting | 53 |
| `LibKami.calcRecovery` | an hour and a second | 40 |
| `LibKami.calcRecovery` | one second | 100 |
| `LibKami.calcRecovery` | clamped at the total | 200 |
| `LibKill.calcThreshold` | EERIE hand on a SCRAP body (Strong) | 65 |
| `LibKill.calcThreshold` | NORMAL on NORMAL (Special) | 94 |
| `LibKill.calcThreshold` | SCRAP hand on an EERIE body (Weak) | 15 |
| `LibKill.calcThreshold` | a weak attacker (low animosity) | 0 |
| `LibKill.calcThreshold` | ratio +120/−40, shift +15/−5 | 111 |
| `LibKill.calcRecoilEfficacy` | EERIE hand vs EERIE body | 1000 |
| `LibKill.calcRecoilEfficacy` | EERIE hand vs SCRAP body | 2000 |
| `LibKill.calcRecoilEfficacy` | EERIE hand vs INSECT body | 0 |
| `LibKill.calcRecoilEfficacy` | EERIE hand vs NORMAL body | 1000 |
| `LibKill.calcRecoilEfficacy` | SCRAP hand vs EERIE body | 0 |
| `LibKill.calcRecoilEfficacy` | SCRAP hand vs SCRAP body | 1000 |
| `LibKill.calcRecoilEfficacy` | SCRAP hand vs INSECT body | 2000 |
| `LibKill.calcRecoilEfficacy` | SCRAP hand vs NORMAL body | 1000 |
| `LibKill.calcRecoilEfficacy` | INSECT hand vs EERIE body | 2000 |
| `LibKill.calcRecoilEfficacy` | INSECT hand vs SCRAP body | 0 |
| `LibKill.calcRecoilEfficacy` | INSECT hand vs INSECT body | 1000 |
| `LibKill.calcRecoilEfficacy` | INSECT hand vs NORMAL body | 1000 |
| `LibKill.calcRecoilEfficacy` | NORMAL hand vs EERIE body | 1000 |
| `LibKill.calcRecoilEfficacy` | NORMAL hand vs SCRAP body | 1000 |
| `LibKill.calcRecoilEfficacy` | NORMAL hand vs INSECT body | 1000 |
| `LibKill.calcRecoilEfficacy` | NORMAL hand vs NORMAL body | 1400 |
| `LibKill.calcKarma` | defender violence 15, attacker harmony 15 | 1000 |
| `LibKill.calcSalvage` | victim power 18, bounty 1000 | 180 |
| `LibKill.calcSpoils` | killer power 20, victim power 18, bounty 1000 | 533 |
| `LibExperience.calcLevelCost` | level 1 | 40 |
| `LibExperience.calcLevelCost` | level 2 | 50 |
| `LibExperience.calcLevelCost` | level 10 | 317 |
| `LibExperience.calcLevelCost` | level 30 | 31827 |
| `LibExperience.calcLevelCost` | level 60 | 31884386 |
| `LibStat.calcTotal` | base 70, shift 110, boost 0 | 180 |
| `LibStat.calcTotal` | base 20, shift 5, boost 200 | 30 |
| `LibListing.calcBuyPrice` | FIXED 37 × 3 | 111 |
| `LibListing.calcSellPrice` | FIXED 37 × 3 | 111 |
| `LibListing.calcBuyPrice` | two periods, below rate | 86 |
| `LibListing.calcBuyPrice` | ahead of rate | 83 |
| `LibListing.calcBuyPrice` | a multi-day decay, clamped (an exact cap) | 125 |
| `LibAuction.calcBuy` | two periods, below rate | 86 |
| `LibAuction.calcBuy` | a multi-day decay (no clamp on auctions) | 91 |
| `LibAuction.calcBuy` | ahead of rate | 83 |
| `LibPool.calcAmountOut` | 1000 in, reserves 20000/5000, fee 30 | 237 |
| `LibPool.calcAmountOut` | 1 in, reserves 1000000/3, fee 30 | 0 |
| `LibPool.calcAmountOut` | 123456 in, reserves 987654/55555, fee 0 | 6172 |
| `LibBonus.calcSingle` | value 250 × level 3 | 750 |
| `LibBonus.calcSingle` | value -40 × level 5 | -200 |
| `LibBonus.calcSingle` | value 1 × level 1 | 1 |
| `LibRandom.calcRarityWeight` | tiers 9, 6, 1, 0 (as odds) | 88.6% 11.1% 0.3% 0.0% |
| `LibTrade.calcTax` | MUSU 12345 at 25/1000 | 308 |
| `LibTrade.calcTax` | item 2 (not MUSU) | 0 |
| `LibTokenPortal.calcWithdrawalDelay` | config 86400 | 86400 |

### The mapping (40 manifest keys)

| Formula | Port | Served at | Compared |
|---|---|---|---|
| `LibAccount.calcStaminaRecovery` | app/cache/account/calcs.calcCurrentStamina | account stamina.current | direct |
| `LibAffinity.calcEfficacyShift` | app/cache/harvest/calcs.calcEfficacyShift | via fertility → musu accrued | direct |
| `LibAuction.calcBuy` | network/explorer/auctions/pricing.calcPrice (app/cache/auction/functions.calcPrice is the same copy) | auctions price | direct |
| `LibBonus.calcSingle` | network/shapes/Bonus/types.getValue | every bonus-dependent value | direct |
| `LibExperience.calcLevelCost` | network/shapes/Kami/progress.calcExperienceRequirement | kami / party / node xpRequired | direct |
| `LibGDA.calc` | inlined in app/cache/npc/calcs.calcBuyPriceGDA and the auctions calcPrice | merchant buyPrice, auctions price | through LibListing.calcBuyPrice and LibAuction.calcBuy |
| `LibHarvest.calcBounty` | app/cache/kami/calcs/harvest.calcOutput (calcRawNetBounty capped by calcMaxMusu) | kami musu.accrued, node vitals.musuAccrued | direct |
| `LibHarvest.calcDuration` | app/cache/harvest/calcs.calcIdleTime | via the bounty | direct |
| `LibHarvest.calcEfficacy(string,string,Shifts,string)` | app/cache/harvest/calcs.calcEfficacyShifts (one trait) | via fertility → musu accrued | direct |
| `LibHarvest.calcEfficacy(uint256,uint256,uint256)` | app/cache/harvest/calcs.calcEfficacyShifts + the fertility boost | via fertility → musu accrued | direct |
| `LibHarvest.calcFertility` | app/cache/harvest/calcs.calcFertility | via the bounty; kami musu rates | direct |
| `LibHarvest.calcIntensity` | app/cache/harvest/calcs.calcIntensity (.average) | via the bounty; kami musu rates | direct |
| `LibHarvest.calcIntensityDuration` | app/cache/harvest/calcs.calcIntensityTime | via intensity | direct |
| `LibHarvest.calcMaxMusu` | app/cache/kami/calcs/harvest.calcMaxMusu | via the bounty cap | direct |
| `LibKami.calcMetabolism` | app/cache/kami/calcs/base.calcHealthRate (RESTING) | kami hpRatePerHr (a display string) | direct |
| `LibKami.calcRecovery` | app/cache/kami/calcs/base.calcHealth (RESTING) | kami / party / node hp.current | direct |
| `LibKami.calcStrain` | app/cache/kami/calcs/harvest.calcStrainFromBalance (round up) | hp.current of a harvesting kami; the recoil strain | direct |
| `LibKamiMarket.calcFee` | — | not served | unported — the lens serves no kami-market fee |
| `LibKill.calcAnimosity` | app/cache/kami/calcs/liquidation.calcAnimosity (module-private) | node liquidation.threshold | through LibKill.calcThreshold |
| `LibKill.calcKarma` | app/cache/kami/calcs/liquidation.calcKarma | via node liquidation.recoil | direct |
| `LibKill.calcRecoil` | app/cache/kami/calcs/liquidation.calcRecoil | node liquidation.recoil | direct |
| `LibKill.calcRecoilEfficacy` | app/cache/kami/calcs/liquidation.calcRecoilEfficacy | via node liquidation.recoil | direct |
| `LibKill.calcSalvage` | app/cache/kami/calcs/liquidation.calcSalvage | node liquidation.salvage | direct |
| `LibKill.calcSpoils` | app/cache/kami/calcs/liquidation.calcSpoils | node liquidation.spoils | direct |
| `LibKill.calcThreshold` | app/cache/kami/calcs/liquidation.calcThreshold | node liquidation.threshold, margin, eligible | direct |
| `LibKill.calcThresholdEfficacy` | app/cache/kami/calcs/liquidation.calcEfficacy (module-private) | node liquidation.threshold | through LibKill.calcThreshold |
| `LibKill.calculateHealthValues` | — | not served | unported — a (sync, total) pair; the client reads both off the Stats shape |
| `LibListing.calcBuyPrice` | app/cache/npc/calcs.calcBuyPrice | merchant buyPrice | direct |
| `LibListing.calcSellPrice` | app/cache/npc/calcs.calcSellPrice | merchant sellPrice | direct |
| `LibPool.calcAmountOut` | network/shapes/Pool/pricing.calcAmountOut | quote amountOut | direct |
| `LibPool.calcInitialLiquidity` | — | not served | unported — pool creation (admin); the lens serves no LP share |
| `LibRandom.calcRarityWeight` | inlined in network/shapes/Droptable.getDTDetails | droptable odds text (enrich) | direct |
| `LibStat.calcSync` | app/cache/account/calcs.sync | account stamina.current | direct |
| `LibStat.calcTotal` | network/shapes/Stats.getStatFromUint (.total) | hp.total, stats.*.total | direct |
| `LibTax.calcBill` | — | not served | unported — the harvest tax split; the lens serves no tax |
| `LibTokenPortal.calcExportTax` | — | not served | unported — the portal tax config is ported (app/cache/config/portal), its arithmetic is not |
| `LibTokenPortal.calcImportTax` | — | not served | unported — as calcExportTax |
| `LibTokenPortal.calcWithdrawalDelay` | app/cache/config/portal.getConfig (.delay) | not served | direct |
| `LibTrade.calcTax` | app/cache/trade/functions.calcTax | not served | direct |
| `NewbieVendorBuySystem.calcPrice` | — | not served | unported — the lens serves the vendor display window, not its price (a cheapest-listing scan) |
