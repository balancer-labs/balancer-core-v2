import { ethers } from 'hardhat';
import { expect } from 'chai';
import { BigNumber } from 'ethers';
import { bn, fp, pct } from '@balancer-labs/v2-helpers/src/numbers';
import { MINUTE, advanceTime, currentTimestamp } from '@balancer-labs/v2-helpers/src/time';
import * as expectEvent from '@balancer-labs/v2-helpers/src/test/expectEvent';

import TokenList from '@balancer-labs/v2-helpers/src/models/tokens/TokenList';
import Vault from '@balancer-labs/v2-helpers/src/models/vault/Vault';
import WeightedPool from '@balancer-labs/v2-helpers/src/models/pools/weighted/WeightedPool';
import { WeightedPoolType } from '@balancer-labs/v2-helpers/src/models/pools/weighted/types';
import { expectEqualWithError } from '@balancer-labs/v2-helpers/src/test/relativeError';
import { expectBalanceChange } from '@balancer-labs/v2-helpers/src/test/tokenBalance';
import { SignerWithAddress } from '@nomiclabs/hardhat-ethers/dist/src/signer-with-address';
import { InvestmentPoolEncoder } from '@balancer-labs/balancer-js';

import { range } from 'lodash';

describe('InvestmentPool', function () {
  let allTokens: TokenList;
  let poolTokens: TokenList;
  let tooManyWeights: BigNumber[];
  let owner: SignerWithAddress, other: SignerWithAddress;
  let assetManager: SignerWithAddress;
  let pool: WeightedPool;

  before('setup signers', async () => {
    [, owner, other, assetManager] = await ethers.getSigners();
  });

  const MAX_TOKENS = 100;
  const TOKEN_COUNT = 20;

  const POOL_SWAP_FEE_PERCENTAGE = fp(0.01);
  const WEIGHTS = range(10000, 10000 + MAX_TOKENS); // These will be normalized to weights that are close to each other, but different

  const poolWeights: BigNumber[] = Array(TOKEN_COUNT).fill(fp(1 / TOKEN_COUNT)); //WEIGHTS.slice(0, TOKEN_COUNT).map(fp);
  const initialBalances = Array(TOKEN_COUNT).fill(fp(1));
  let sender: SignerWithAddress;

  sharedBeforeEach('deploy tokens', async () => {
    allTokens = await TokenList.create(MAX_TOKENS + 1, { sorted: true, varyDecimals: true });
    tooManyWeights = Array(allTokens.length).fill(fp(0.01));
    poolTokens = allTokens.subset(20);
    await poolTokens.mint({ to: [other], amount: fp(200) });
  });

  describe('weights and scaling factors', () => {
    for (const numTokens of range(2, MAX_TOKENS + 1)) {
      context(`with ${numTokens} tokens`, () => {
        let tokens: TokenList;

        sharedBeforeEach('deploy pool', async () => {
          tokens = allTokens.subset(numTokens);

          pool = await WeightedPool.create({
            poolType: WeightedPoolType.INVESTMENT_POOL,
            tokens,
            weights: WEIGHTS.slice(0, numTokens),
            swapFeePercentage: POOL_SWAP_FEE_PERCENTAGE,
          });
        });

        it('sets token weights', async () => {
          const normalizedWeights = await pool.getNormalizedWeights();

          for (let i = 0; i < numTokens; i++) {
            expectEqualWithError(normalizedWeights[i], pool.normalizedWeights[i], 0.0000001);
          }
        });

        it('sets scaling factors', async () => {
          const poolScalingFactors = await pool.getScalingFactors();
          const tokenScalingFactors = tokens.map((token) => fp(10 ** (18 - token.decimals)));

          expect(poolScalingFactors).to.deep.equal(tokenScalingFactors);
        });
      });
    }
  });

  context('with invalid creation parameters', () => {
    it('fails with < 2 tokens', async () => {
      const params = {
        tokens: allTokens.subset(1),
        weights: [fp(0.3)],
        owner,
        poolType: WeightedPoolType.INVESTMENT_POOL,
      };
      await expect(WeightedPool.create(params)).to.be.revertedWith('MIN_TOKENS');
    });

    it('fails with > 100 tokens', async () => {
      const params = {
        tokens: allTokens,
        weights: tooManyWeights,
        owner,
        poolType: WeightedPoolType.INVESTMENT_POOL,
      };
      await expect(WeightedPool.create(params)).to.be.revertedWith('MAX_TOKENS');
    });

    it('fails with mismatched tokens/weights', async () => {
      const params = {
        tokens: allTokens.subset(20),
        weights: tooManyWeights,
        owner,
        poolType: WeightedPoolType.INVESTMENT_POOL,
      };
      await expect(WeightedPool.create(params)).to.be.revertedWith('INPUT_LENGTH_MISMATCH');
    });
  });

  context('when deployed from factory', () => {
    sharedBeforeEach('deploy pool', async () => {
      const params = {
        tokens: poolTokens,
        weights: poolWeights,
        assetManagers: Array(poolTokens.length).fill(assetManager.address),
        owner,
        poolType: WeightedPoolType.INVESTMENT_POOL,
        fromFactory: true,
      };
      pool = await WeightedPool.create(params);
    });

    it('has asset managers', async () => {
      await poolTokens.asyncEach(async (token) => {
        const info = await pool.getTokenInfo(token);
        expect(info.assetManager).to.eq(assetManager.address);
      });
    });
  });

  describe('with valid creation parameters', () => {
    context('when initialized with swaps disabled', () => {
      sharedBeforeEach('deploy pool', async () => {
        const params = {
          tokens: poolTokens,
          weights: poolWeights,
          owner,
          poolType: WeightedPoolType.INVESTMENT_POOL,
          swapEnabledOnStart: false,
        };
        pool = await WeightedPool.create(params);
      });

      it('swaps show disabled on start', async () => {
        expect(await pool.instance.getSwapEnabled()).to.be.false;
      });

      it('swaps are blocked', async () => {
        await expect(pool.swapGivenIn({ in: 1, out: 0, amount: fp(0.1) })).to.be.revertedWith('SWAPS_DISABLED');
      });
    });

    context('when initialized with swaps enabled', () => {
      sharedBeforeEach('deploy pool', async () => {
        const params = {
          tokens: poolTokens,
          weights: poolWeights,
          owner,
          poolType: WeightedPoolType.INVESTMENT_POOL,
          swapEnabledOnStart: true,
        };
        pool = await WeightedPool.create(params);
      });

      it('swaps show enabled on start', async () => {
        expect(await pool.instance.getSwapEnabled()).to.be.true;
      });

      it('swaps are not blocked', async () => {
        await pool.init({ from: owner, initialBalances });

        await expect(pool.swapGivenIn({ in: 1, out: 0, amount: fp(0.1) })).to.not.be.reverted;
      });

      it('sets token weights', async () => {
        const normalizedWeights = await pool.getNormalizedWeights();

        // Not exactly equal due to weight compression
        expect(normalizedWeights).to.equalWithError(pool.normalizedWeights, 0.0001);
      });

      it('stores the initial weights as a zero duration weight change', async () => {
        const { startTime, endTime, endWeights } = await pool.getGradualWeightUpdateParams();

        expect(startTime).to.equal(endTime);
        expect(endWeights).to.equalWithError(pool.normalizedWeights, 0.0001);
      });
    });
  });

  describe('permissioned actions', () => {
    describe('enable/disable swaps', () => {
      sharedBeforeEach('deploy pool', async () => {
        const params = {
          tokens: poolTokens,
          weights: poolWeights,
          owner,
          poolType: WeightedPoolType.INVESTMENT_POOL,
          swapEnabledOnStart: true,
        };
        pool = await WeightedPool.create(params);
      });

      context('when the sender is not the owner', () => {
        it('non-owners cannot disable swaps', async () => {
          await expect(pool.setSwapEnabled(other, false)).to.be.revertedWith('SENDER_NOT_ALLOWED');
        });
      });

      context('when the sender is the owner', () => {
        beforeEach('set sender to owner', () => {
          sender = owner;
        });

        sharedBeforeEach('initialize pool', async () => {
          await pool.init({ from: sender, initialBalances });
        });

        it('swaps can be enabled and disabled', async () => {
          await pool.setSwapEnabled(sender, false);
          expect(await pool.instance.getSwapEnabled()).to.be.false;

          await pool.setSwapEnabled(sender, true);
          expect(await pool.instance.getSwapEnabled()).to.be.true;
        });

        it('disabling swaps emits an event', async () => {
          const receipt = await pool.setSwapEnabled(sender, false);

          expectEvent.inReceipt(await receipt.wait(), 'SwapEnabledSet', {
            swapEnabled: false,
          });
        });

        it('enabling swaps emits an event', async () => {
          const receipt = await pool.setSwapEnabled(sender, true);

          expectEvent.inReceipt(await receipt.wait(), 'SwapEnabledSet', {
            swapEnabled: true,
          });
        });

        context('with swaps disabled', () => {
          sharedBeforeEach(async () => {
            await pool.setSwapEnabled(sender, false);
          });

          context('proportional joins/exits', () => {
            it('allows proportionate joins', async () => {
              const startingBpt = await pool.balanceOf(sender);

              const { amountsIn } = await pool.joinAllGivenOut({ from: sender, bptOut: startingBpt });

              const endingBpt = await pool.balanceOf(sender);
              expect(endingBpt).to.be.gt(startingBpt);
              expect(amountsIn).to.deep.equal(initialBalances);
            });

            it('allows proportional exits', async () => {
              const previousBptBalance = await pool.balanceOf(sender);
              const bptIn = pct(previousBptBalance, 0.8);

              await expect(pool.multiExitGivenIn({ from: sender, bptIn })).to.not.be.reverted;

              const newBptBalance = await pool.balanceOf(sender);
              expect(newBptBalance).to.equalWithError(pct(previousBptBalance, 0.2), 0.001);
            });
          });

          context('disproportionate joins/exits', () => {
            it('prevents disproportionate joins (single token)', async () => {
              const bptOut = await pool.balanceOf(sender);

              await expect(pool.joinGivenOut({ from: sender, bptOut, token: poolTokens.get(0) })).to.be.revertedWith(
                'INVALID_JOIN_EXIT_KIND_WHILE_SWAPS_DISABLED'
              );
            });

            it('prevents disproportionate exits (single token)', async () => {
              const previousBptBalance = await pool.balanceOf(sender);
              const bptIn = pct(previousBptBalance, 0.5);

              await expect(
                pool.singleExitGivenIn({ from: sender, bptIn, token: poolTokens.get(0) })
              ).to.be.revertedWith('INVALID_JOIN_EXIT_KIND_WHILE_SWAPS_DISABLED');
            });

            it('prevents disproportionate joins (multi token)', async () => {
              const amountsIn = [...initialBalances];
              amountsIn[0] = 0;

              await expect(pool.joinGivenIn({ from: sender, amountsIn })).to.be.revertedWith(
                'INVALID_JOIN_EXIT_KIND_WHILE_SWAPS_DISABLED'
              );
            });

            it('prevents disproportionate exits (multi token)', async () => {
              const amountsOut = [...initialBalances];
              // Make it disproportionate (though it will fail with this exit type even if it's technically proportionate)
              amountsOut[0] = 0;

              await expect(pool.exitGivenOut({ from: sender, amountsOut })).to.be.revertedWith(
                'INVALID_JOIN_EXIT_KIND_WHILE_SWAPS_DISABLED'
              );
            });
          });
        });
      });
    });

    describe('update weights gradually', () => {
      sharedBeforeEach('deploy pool', async () => {
        const params = {
          tokens: poolTokens,
          weights: poolWeights,
          owner,
          poolType: WeightedPoolType.INVESTMENT_POOL,
          swapEnabledOnStart: true,
        };
        pool = await WeightedPool.create(params);
      });

      const UPDATE_DURATION = MINUTE * 60;

      context('when the sender is not the owner', () => {
        it('non-owners cannot update weights', async () => {
          const now = await currentTimestamp();

          await expect(pool.updateWeightsGradually(other, now, now, poolWeights)).to.be.revertedWith(
            'SENDER_NOT_ALLOWED'
          );
        });
      });

      context('when the sender is the owner', () => {
        beforeEach('set sender to owner', () => {
          sender = owner;
        });

        sharedBeforeEach('initialize pool', async () => {
          await pool.init({ from: sender, initialBalances });
        });

        context('with invalid parameters', () => {
          let now: BigNumber;

          sharedBeforeEach(async () => {
            now = await currentTimestamp();
          });

          it('fails if end weights are mismatched (too few)', async () => {
            await expect(pool.updateWeightsGradually(sender, now, now, WEIGHTS.slice(0, 1))).to.be.revertedWith(
              'INPUT_LENGTH_MISMATCH'
            );
          });

          it('fails if the end weights are mismatched (too many)', async () => {
            await expect(pool.updateWeightsGradually(sender, now, now, [...WEIGHTS, fp(0.5)])).to.be.revertedWith(
              'INPUT_LENGTH_MISMATCH'
            );
          });

          it('fails if start time > end time', async () => {
            await expect(pool.updateWeightsGradually(sender, now, now.sub(1), poolWeights)).to.be.revertedWith(
              'GRADUAL_UPDATE_TIME_TRAVEL'
            );
          });

          it('fails with an end weight below the minimum', async () => {
            const badWeights = [...poolWeights];
            badWeights[2] = fp(0.005);

            await expect(
              pool.updateWeightsGradually(sender, now.add(100), now.add(1000), badWeights)
            ).to.be.revertedWith('MIN_WEIGHT');
          });

          it('fails with invalid normalized end weights', async () => {
            const badWeights = Array(poolWeights.length).fill(fp(0.6));

            await expect(
              pool.updateWeightsGradually(sender, now.add(100), now.add(1000), badWeights)
            ).to.be.revertedWith('NORMALIZED_WEIGHT_INVARIANT');
          });

          context('with start time in the past', () => {
            let now: BigNumber, startTime: BigNumber, endTime: BigNumber;
            const endWeights = [...poolWeights];

            sharedBeforeEach('updateWeightsGradually (start time in the past)', async () => {
              now = await currentTimestamp();
              // Start an hour in the past
              startTime = now.sub(MINUTE * 60);
              endTime = now.add(UPDATE_DURATION);
            });

            it('fast-forwards start time to present', async () => {
              await pool.updateWeightsGradually(owner, startTime, endTime, endWeights);
              const updateParams = await pool.getGradualWeightUpdateParams();

              // Start time should be fast-forwarded to now
              expect(updateParams.startTime).to.equal(await currentTimestamp());
            });
          });
        });

        context('with valid parameters (ongoing weight update)', () => {
          // startWeights must equal "weights" above - just not using fp to keep math simple
          const startWeights = [...poolWeights];
          const endWeights = [...poolWeights];

          // Now generate endWeights (first weight doesn't change)
          for (let i = 2; i < poolWeights.length; i++) {
            endWeights[i] = 0 == i % 2 ? startWeights[i].add(fp(0.02)) : startWeights[i].sub(fp(0.02));
          }

          function getEndWeights(pct: number): BigNumber[] {
            const intermediateWeights = Array<BigNumber>(poolWeights.length);

            for (let i = 0; i < poolWeights.length; i++) {
              if (startWeights[i] < endWeights[i]) {
                // Weight is increasing
                intermediateWeights[i] = startWeights[i].add(endWeights[i].sub(startWeights[i]).mul(pct).div(100));
              } else {
                // Weight is decreasing (or not changing)
                intermediateWeights[i] = startWeights[i].sub(startWeights[i].sub(endWeights[i]).mul(pct).div(100));
              }
            }

            return intermediateWeights;
          }

          let now, startTime: BigNumber, endTime: BigNumber;
          const START_DELAY = MINUTE * 10;
          const finalEndWeights = getEndWeights(100);

          sharedBeforeEach('updateWeightsGradually', async () => {
            now = await currentTimestamp();
            startTime = now.add(START_DELAY);
            endTime = startTime.add(UPDATE_DURATION);

            await pool.updateWeightsGradually(owner, startTime, endTime, finalEndWeights);
          });

          it('updating weights emits an event', async () => {
            const receipt = await pool.updateWeightsGradually(owner, startTime, endTime, finalEndWeights);

            expectEvent.inReceipt(await receipt.wait(), 'GradualWeightUpdateScheduled', {
              startTime: startTime,
              endTime: endTime,
              // weights don't exactly match because of the compression
            });
          });

          it('stores the params', async () => {
            const updateParams = await pool.getGradualWeightUpdateParams();

            expect(updateParams.startTime).to.equalWithError(startTime, 0.001);
            expect(updateParams.endTime).to.equalWithError(endTime, 0.001);
            expect(updateParams.endWeights).to.equalWithError(finalEndWeights, 0.001);
          });

          it('gets start weights if called before the start time', async () => {
            const normalizedWeights = await pool.getNormalizedWeights();

            // Need to decrease precision
            expect(normalizedWeights).to.equalWithError(pool.normalizedWeights, 0.0001);
          });

          it('gets end weights if called after the end time', async () => {
            await advanceTime(endTime.add(MINUTE));
            const normalizedWeights = await pool.getNormalizedWeights();

            // Need to decrease precision
            expect(normalizedWeights).to.equalWithError(finalEndWeights, 0.0001);
          });

          for (let pct = 5; pct < 100; pct += 5) {
            it(`gets correct intermediate weights if called ${pct}% through`, async () => {
              await advanceTime(START_DELAY + (UPDATE_DURATION * pct) / 100);
              const normalizedWeights = await pool.getNormalizedWeights();

              // Need to decrease precision
              expect(normalizedWeights).to.equalWithError(getEndWeights(pct), 0.005);
            });
          }
        });
      });
    });

    describe('collect management fees', () => {
      let vault: Vault;

      sharedBeforeEach('deploy pool', async () => {
        vault = await Vault.create();

        const params = {
          tokens: poolTokens,
          weights: poolWeights,
          owner,
          poolType: WeightedPoolType.INVESTMENT_POOL,
          swapEnabledOnStart: true,
          vault,
        };
        pool = await WeightedPool.create(params);
      });

      it('collected fees are initially zero', async () => {
        const fees = await pool.getCollectedManagementFees();

        expect(fees.tokenAddresses).to.deep.equal(poolTokens.addresses);
        expect(fees.amounts).to.deep.equal(new Array(poolTokens.length).fill(bn(0)));
      });

      it('collected fees are reported in the same order as in the vault', async () => {
        const { tokenAddresses: feeTokenAddresses } = await pool.getCollectedManagementFees();
        const { tokens: vaultTokenAddresses } = await vault.getPoolTokens(await pool.getPoolId());

        expect(feeTokenAddresses).to.deep.equal(vaultTokenAddresses);
      });

      context('when the sender is not the owner', () => {
        it('reverts', async () => {
          await expect(pool.collectManagementFees(other)).to.be.revertedWith('SENDER_NOT_ALLOWED');
        });
      });

      context('when the sender is the owner', () => {
        beforeEach('set sender to owner', () => {
          sender = owner;
        });

        sharedBeforeEach('initialize pool', async () => {
          await poolTokens.mint({ to: sender, amount: fp(100) });
          await poolTokens.approve({ from: sender, to: await pool.getVault() });
          await pool.init({ from: sender, initialBalances });
        });

        it('management fees can be collected to to any account', async () => {
          await expectBalanceChange(() => pool.collectManagementFees(sender, other), poolTokens, {
            account: other,
            changes: {},
          });
        });

        it('reverts if the vault is called directly', async () => {
          await expect(
            vault.instance.connect(sender).exitPool(await pool.getPoolId(), sender.address, other.address, {
              assets: poolTokens.addresses,
              minAmountsOut: new Array(poolTokens.length).fill(bn(0)),
              userData: InvestmentPoolEncoder.exitForManagementFees(),
              toInternalBalance: false,
            })
          ).to.be.revertedWith('UNAUTHORIZED_EXIT');
        });
      });
    });
  });
});
