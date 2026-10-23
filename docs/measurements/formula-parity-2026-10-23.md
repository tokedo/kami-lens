# Contract-formula parity — 2026-10-23 (1.1.0)

`test/formula-parity.test.ts` evaluates each contract formula beside the
lens's ported counterpart: a reference evaluation of the Solidity arithmetic,
transcribed with its integer precision slots, truncating division and clamps,
against the code the daemon runs, on the shapes it builds. Every case below is
asserted by the test. Regenerate the tables with
`FORMULA_PARITY_RECORD=<file> npx vitest run test/formula-parity.test.ts`.

**Status: every divergence in a served value found here is RESOLVED in
1.1.0** (release item 7: a served value that disagrees with the chain is a
wrong reading). The test's assertions for them now require agreement; they
fail on the ports as 1.1.0 found them (24 of 89 cases red at the commit
before the fix, all green after), and every sweep requires zero divergent
samples. What 1.0.5 served is kept below as the record.

**Sources.** The formula list — `generated/formulas.yaml`, 40 keys (38 plain
keys plus the two quoted overloads of `LibHarvest.calcEfficacy`) — is from the
Kami Atlas by Asphodel Studios, https://github.com/Asphodel-OS/kami-atlas
(commit `ac64364`), generated from kamigotchi at `04cb25f8f300`, licensed
CC BY 4.0. The transcriptions (`test/formula-parity.test.ts`,
`test/support/solidity.ts`) are this repository's own code (AGPL-3.0-only),
written against the contract source at Asphodel-OS/kamigotchi-open @
`04cb25f8` (AGPL-3.0-only). The transcendental pieces follow the libraries the
contracts use at that pin — Solady `FixedPointMathLib` (`lnWad`, `expWad`,
`powWad`; the contracts' Solmate copy for the Gaussian), Solstat
`Gaussian.cdf`/`erfc`, PRBMath 4.1.0 `SD59x18` (`pow`, `exp2`, `log2`) — and
reproduce the libraries' own published test vectors exactly (asserted).
Config: the live world's arrays (`test/support/mirror.ts`, read
2026-10-03). Clock pinned at chain second 1,790,000,000.

## Summary

- **Mapping:** 40 manifest keys — **30 compared directly**, **3 through a
  composite** (`LibGDA.calc` through the listing and auction prices;
  `LibKill.calcAnimosity` and `LibKill.calcThresholdEfficacy`, module-private
  in the port, through `LibKill.calcThreshold`), **7 unported**
  (`LibKamiMarket.calcFee`, `LibKill.calculateHealthValues`,
  `LibPool.calcInitialLiquidity`, `LibTax.calcBill`,
  `LibTokenPortal.calcExportTax`, `LibTokenPortal.calcImportTax`,
  `NewbieVendorBuySystem.calcPrice` — none has a served counterpart).
- **At 1.1.0, every served value agrees with the chain** in every
  hand-picked case and every swept sample. Three divergences stay documented
  and none is served as a number: the metabolism rate (a display string),
  an unset `LastTime` guard, and the trade-tax display helper.
- **Gate G2.a** (the ported calcs against the pinned client, 22,222 kamis of
  the snapshot) now names the 1.1.0 departures from the CLIENT on
  `threshold` and counts them: 7,582 clamps to 0 where the client served a
  negative threshold, 1 float floor (the chain's 8 for the client's 7).
  Every other field is still equal to the client on that snapshot.

## The served divergences of 1.0.5 — each RESOLVED in 1.1.0

Serving sites are `src/queries/build.ts` unless named; the correction is in
the named module, whose header now says what changed and which chain line
it matches.

1. **`liquidation.recoil`** — 1.0.5 did not floor karma at `KARMA_PREC`
   (1e-3), so the recoil read HIGH by up to ⌈strain / 1000⌉ HP (858 of 3,000
   swept previews, by 1–3). **Resolved:** `calcKarma` floors it, on the
   contracts' own `Gaussian.cdf(lnWad(…))` (`src/utils/fixed-point.ts`), and
   `calcRecoil` computes `((karma + efficacy) · strain · boost) /
   10^(c1+c3+c7)` in integers (`app/cache/kami/calcs/liquidation.ts`).
2. **`liquidation.spoils`** — the chain tests `ratio / precision > 1` in
   INTEGER division, so a killer whose spoils ratio is in (1.0, 2.0) (power
   56–154 with no bonus on the live config `[45, 2, 0, 3]`) is paid `amount
   × ratio`, up to 1.99 × what the salvage leaves; 1.0.5 capped it at the
   amount (killer power 60: chain 787, 1.0.5 750), and floored a float (2 of
   3,000 one low). **Resolved:** `calcSpoils` = the chain's integer body.
3. **`liquidation.salvage`** — for a victim whose salvage ratio is in
   (1.0, 2.0) (power 101–199 with no bonus, `[0, 2, 0, 3]`) the chain's
   salvage EXCEEDS the bounty and `bounty − salvage` underflows: the
   liquidation REVERTS. 1.0.5 served such a target as eligible, and from a
   ratio of 2.0 served `bounty × ratio` where the chain pays the bounty.
   **Resolved:** `calcSalvage` is the chain's integer body; the preview marks
   such a target `eligible: false`, reason `SALVAGE_EXCEEDS_BOUNTY` (after
   the attacker's gates and the threshold, as the chain checks them), serves
   spoils and recoil 0, and `--eligible-only` leaves it out — read off the
   row's own `salvage > vitals.musuAccrued` (`build.ts` node preview; G7.c's
   predicate carries the same term).
4. **`hp.total`, `stats.*.total`** — 1.0.5 served the float `(1 + boost/1e3)
   · (base + shift)`; the chain's `LibStat.calcTotal` truncates the int32
   product and floors at 0 (base 13, boost 50: 13 not 13.65; −3 → 0).
   **Resolved** in `network/shapes/Stats.ts`. Latent at the pin: no stat
   boost is set in the sampled live data.
5. **`merchant` → `buyPrice`** — the chain caps the GDA deficit in WHOLE
   seconds, `prevSold·period/rate` (integer) + 3·period; 1.0.5 capped the
   exponent at exactly 3 periods and read one unit LOW in 52 of 348 such
   cases. **Resolved** in `app/cache/npc/calcs.ts` (on whole-second time, as
   `block.timestamp` is).
6. **`merchant` → `sellPrice`** — a SCALED sell price is `(buyPrice ·
   scale) / 1e9` floored on chain; 1.0.5 served the product (25.8 for 25).
   **Resolved** in `app/cache/npc/calcs.ts`.
7. **`musu.accrued`, `vitals.musuAccrued` (and the musu rates)** — 1.0.5
   floored float rates at 1e-6 and read one unit LOW at exact values
   (fertility 84 and intensity 15 of 4,000; over 1,000,000 s a whole MUSU),
   kept the half of an odd fertility bonus on a NORMAL trait (efficacy
   1387.5 for the chain's 1387), did not floor a negative summed efficacy at
   0, and floored max musu as a float (one low at an exact quotient).
   **Resolved:** the harvest arithmetic is the chain's integers —
   fertility, intensity, the bounty (`app/cache/harvest/calcs.ts`) and max
   musu and the strain of an amount (`app/cache/kami/calcs/harvest.ts`).
8. **`auctions` → `price`** — when an auction's cost has decayed below the
   fixed point's resolution the chain REVERTS the buy ("LibAuction: negative
   GDA cost"); 1.0.5 served 1. **Resolved** in `src/queries/feeds.ts`:
   `price: null` with `priceUnavailable: COST_ROUNDS_TO_ZERO` (and
   `BEYOND_FIXED_POINT_RANGE` where PRBMath's exp2 would revert). The ported
   curve itself (the client's) is unchanged.
9. **`xpRequired`** — 1.0.5 used `Math.pow` and read one XP low from level
   119 (≥ 2.5e13 XP). **Resolved** in `network/shapes/Kami/progress.ts`:
   `base · powWad(…) / 1e18` with Solady's powWad; equal through level 200.
10. **`liquidation.threshold` (and `margin`)** — found by gate G2.a on the
    snapshot, not by the first sweep (whose inputs carried no defense
    bonuses): a defender's `DEF_THRESHOLD_SHIFT` bonus can push `base · ratio
    + shift` below 0, and 1.0.5 then served a NEGATIVE threshold where the
    chain returns 0 — 7,582 of 22,222 snapshot pairings — and floored one
    exact product low (the chain's 8 for 7). Eligibility was unaffected (a
    negative or zero threshold admits no target). **Resolved** in
    `app/cache/kami/calcs/liquidation.ts` (the threshold in integers);
    asserted in the parity test with defense bonuses (hand-picked and a
    4,000-sample sweep).

## Not served, still documented

The metabolism rate the port keeps unfloored feeds a display string
(`hpRatePerHr`); the served `hp.current` of a resting kami is equal in all
4,000 swept. An unset `LastTime` reads 0 in the port (the chain would
compute `block.timestamp − 0`; no live harvest lacks it). The trade-tax
helper (`app/cache/trade/functions.calcTax`) is not served and floors a float
(MUSU 100 at 29 %: 28 for the chain's 29).

## Latent, not exercised by the live config

- `LibAffinity.getShifts` ignores an efficacy config's precision slot `[0]`;
  the ports read efficacy shifts back to raw at the target's precision — equal
  while the two match (3 live).
- `LibStat.get` adds a `STAT_<X>_BOOST` bonus to a stat's boost slot; the
  client's stats read only `STAT_<X>_SHIFT`. No boost bonus exists in the game
  data at the pin.
- A negative salvage or spoils ratio bonus makes the chain revert (SafeCast);
  no such bonus exists at the pin.
- `calcCurrentStamina` falls back to 60 s when `ACCOUNT_STAMINA[1]` is 0; the
  chain would divide by zero.
- Rarity tiers ≥ 32: JavaScript's 32-bit `<<` (tiers at the pin are ≤ 9).
- A node with more than two affinities: the chain reverts, the port returns
  no shift.

## What 1.0.5 served (the first run of this test, kept for the record)

| Formula | 1.0.5 sweep: divergent of samples | Class |
|---|---|---|
| `LibHarvest.calcFertility` | 84 / 4,000 (−1) | float floor at RATE_PREC |
| `LibHarvest.calcIntensity` | 15 / 4,000 (−1) | float floor at RATE_PREC |
| `LibKill.calcSpoils` | 2 / 3,000 (−1) | float floor |
| `LibKill.calcRecoil` | 858 / 3,000 (+1: 787, +2: 59, +3: 12) | unfloored karma |
| `LibListing.calcBuyPrice` (clamped, not whole) | 52 / 348 (−1) | cap not in whole seconds |
| `LibKill.calcThreshold` (snapshot, G2.a) | 7,582 + 1 / 22,222 | no clamp at 0; float floor |

### Cases still documented as divergent (none served)

| Formula | Inputs | Chain | Port | Class |
|---|---|---|---|---|
| `LibHarvest.calcDuration` | no LastTime | 1790000000 | 0 | guard: an unset LastTime reads 0 in the port |
| `LibKami.calcMetabolism` | harmony 15 | 5833333 | 5833333.333333334 | unfloored rate (display) |
| `LibAuction.calcBuy` | decayed 600 periods at 0.5 (served) | revert | revert:COST_ROUNDS_TO_ZERO | resolved: served null with priceUnavailable |
| `LibTrade.calcTax` | MUSU 100 at 29/100 | 29 | 28 | float floor (0.29 × 100 = 28.999…) |

### Seeded sweeps at 1.1.0

Seed 20261023. A difference outside the stated set fails the test and the divergent count is asserted; at 1.1.0 every sweep requires zero.

| Formula | Samples | Divergent | port − chain: count | Class |
|---|---|---|---|---|
| `LibHarvest.calcFertility` | 4000 | 0 | 0: 4000 | equal (resolved in 1.1.0; 1.0.5: float floor at RATE_PREC, 84 low) |
| `LibHarvest.calcIntensity` | 4000 | 0 | 0: 4000 | equal (resolved in 1.1.0; 1.0.5: float floor at RATE_PREC, 15 low) |
| `LibHarvest.calcBounty` | 4000 | 0 | 0: 4000 | equal |
| `LibHarvest.calcMaxMusu` | 4000 | 0 | 0: 4000 | equal |
| `LibKami.calcStrain` | 4000 | 0 | 0: 4000 | equal |
| `LibKami.calcRecovery` | 4000 | 0 | 0: 4000 | equal |
| `LibKill.calcThreshold` | 4000 | 0 | 0: 4000 | equal with ratio/shift bonuses (resolved in 1.1.0: the clamp at 0 and the float floor) |
| `LibKill.calcThreshold` | 4000 | 0 | 0: 4000 | equal |
| `LibKill.calcSalvage` | 3000 | 0 | 0: 3000 | equal |
| `LibKill.calcSpoils` | 3000 | 0 | 0: 3000 | equal (resolved in 1.1.0; 1.0.5: float floor, 2 low) |
| `LibKill.calcRecoil` | 3000 | 0 | 0: 3000 | equal (resolved in 1.1.0; 1.0.5: unfloored karma, 858 high by 1–3) |
| `LibListing.calcBuyPrice` | 3543 | 0 | 0: 3543 | equal (unclamped) |
| `LibListing.calcBuyPrice` | 348 | 0 | 0: 348 | equal (clamped, not whole; resolved in 1.1.0 — 1.0.5: 52 one unit low) |
| `LibAuction.calcBuy` | 3617 | 0 | 0: 3617 | equal |

### Equal cases (hand-picked), at 1.1.0

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
| `LibHarvest.calcEfficacy(string,string,Shifts,string)` | NORMAL body, EERIE hand on EERIE, bonus 25 | 1387 |
| `LibHarvest.calcEfficacy(string,string,Shifts,string)` | NORMAL/NORMAL, bonus −25 | 976 |
| `LibHarvest.calcEfficacy(uint256,uint256,uint256)` | NORMAL/NORMAL, bonus −2500 (as the fertility it yields) | 0 |
| `LibHarvest.calcDuration` | last 1234 s ago | 1234 |
| `LibHarvest.calcIntensityDuration` | reset 98765 s ago | 98765 |
| `LibHarvest.calcFertility` | power 20, EERIE/SCRAP on EERIE | 12916 |
| `LibHarvest.calcFertility` | power 55, INSECT/INSECT on INSECT | 45833 |
| `LibHarvest.calcFertility` | power 37, SCRAP/EERIE on EERIE-SCRAP | 30833 |
| `LibHarvest.calcFertility` | power 78, INSECT/EERIE on SCRAP | 21125 |
| `LibHarvest.calcIntensity` | violence 22, reset 9999 s ago | 1597 |
| `LibHarvest.calcIntensity` | violence 57, reset 47750 s ago | 6250 |
| `LibHarvest.calcMaxMusu` | hp 200, harmony 30 | 1538 |
| `LibHarvest.calcMaxMusu` | hp 1649, harmony 45, strain bonus −224 | 21250 |
| `LibHarvest.calcBounty` | an hour on a matching node | 50 |
| `LibHarvest.calcBounty` | capped by max musu | 953 |
| `LibHarvest.calcBounty` | a fresh harvest | 23 |
| `LibHarvest.calcBounty` | power 78, INSECT/EERIE on SCRAP, 1,000,000 s | 117861 |
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
| `LibKill.calcThreshold` | violence 10 vs harmony 40 behind a 300/200 defense bonus | 0 |
| `LibKill.calcThreshold` | violence 18 vs harmony 18, SCRAP on INSECT, 300/200 defense bonus | 8 |
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
| `LibKill.calcKarma` | defender violence 25, attacker harmony 22 | 1101 |
| `LibKill.calcKarma` | defender violence 40, attacker harmony 30 | 1226 |
| `LibKill.calcKarma` | defender violence 73, attacker harmony 9 | 1963 |
| `LibKill.calcRecoil` | defender violence 73, attacker harmony 9, bounty 1133 | 402 |
| `LibKill.calcRecoil` | defender violence 73, attacker harmony 9, bounty 3000 | 1063 |
| `LibKill.calcSalvage` | victim power 18, bounty 1000 | 180 |
| `LibKill.calcSpoils` | killer power 20, victim power 18, bounty 1000 | 533 |
| `LibKill.calcSpoils` | killer power 60, victim power 25, bounty 1000 | 787 |
| `LibKill.calcSpoils` | killer power 154, victim power 25, bounty 1000 | 1492 |
| `LibKill.calcSpoils` | killer power 155, victim power 25, bounty 1000 | 750 |
| `LibKill.calcSalvage` | victim power 120 (the liquidation reverts on chain) | 1200 |
| `LibKill.calcSpoils` | killer power 20 on that victim (the chain reverts first; 0 served) | 0 |
| `LibKill.calcSalvage` | victim power 250 | 1000 |
| `LibExperience.calcLevelCost` | level 1 | 40 |
| `LibExperience.calcLevelCost` | level 2 | 50 |
| `LibExperience.calcLevelCost` | level 10 | 317 |
| `LibExperience.calcLevelCost` | level 30 | 31827 |
| `LibExperience.calcLevelCost` | level 60 | 31884386 |
| `LibExperience.calcLevelCost` | level 119 | 25415352880253 |
| `LibStat.calcTotal` | base 70, shift 110, boost 0 | 180 |
| `LibStat.calcTotal` | base 20, shift 5, boost 200 | 30 |
| `LibStat.calcTotal` | base 13, boost 50 | 13 |
| `LibStat.calcTotal` | base 33, boost −100 | 29 |
| `LibStat.calcTotal` | base −7, boost 150 (toward zero) | 0 |
| `LibStat.calcTotal` | base −5, shift 2 | 0 |
| `LibListing.calcBuyPrice` | FIXED 37 × 3 | 111 |
| `LibListing.calcSellPrice` | FIXED 37 × 3 | 111 |
| `LibListing.calcBuyPrice` | two periods, below rate | 86 |
| `LibListing.calcBuyPrice` | ahead of rate | 83 |
| `LibListing.calcBuyPrice` | a multi-day decay, clamped (an exact cap) | 125 |
| `LibListing.calcBuyPrice` | clamped, 20·3600 / 69 not whole | 12215 |
| `LibListing.calcSellPrice` | SCALED 0.3 of a buy price of 86 | 25 |
| `LibListing.calcSellPrice` | SCALED 0.123456789 of 86, amount 1 | 10 |
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
