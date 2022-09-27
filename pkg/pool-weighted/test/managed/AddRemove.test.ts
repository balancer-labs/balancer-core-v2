import { toNormalizedWeights } from '@balancer-labs/balancer-js';
import { sharedBeforeEach } from '@balancer-labs/v2-common/sharedBeforeEach';
import { MAX_UINT256, ZERO_ADDRESS } from '@balancer-labs/v2-helpers/src/constants';
import { deploy } from '@balancer-labs/v2-helpers/src/contract';
import { WeightedPoolType } from '@balancer-labs/v2-helpers/src/models/pools/weighted/types';
import WeightedPool from '@balancer-labs/v2-helpers/src/models/pools/weighted/WeightedPool';
import Token from '@balancer-labs/v2-helpers/src/models/tokens/Token';
import TokenList from '@balancer-labs/v2-helpers/src/models/tokens/TokenList';
import Vault from '@balancer-labs/v2-helpers/src/models/vault/Vault';
import { bn, fp, fpDiv } from '@balancer-labs/v2-helpers/src/numbers';
import { advanceToTimestamp, currentTimestamp, DAY, MONTH } from '@balancer-labs/v2-helpers/src/time';
import { SignerWithAddress } from '@nomiclabs/hardhat-ethers/signers';
import { expect } from 'chai';
import { BigNumber, Contract } from 'ethers';
import { ethers } from 'hardhat';
import { random, range } from 'lodash';
import * as expectEvent from '@balancer-labs/v2-helpers/src/test/expectEvent';

describe('ManagedPoolSettings - add/remove token', () => {
  let vault: Vault;
  let assetManager: Contract;
  let allTokens: TokenList;
  let owner: SignerWithAddress, lp: SignerWithAddress, other: SignerWithAddress;

  before('setup signers', async () => {
    [, owner, lp, other] = await ethers.getSigners();
  });

  const MIN_TOKENS = 2;
  const MAX_TOKENS = 38;

  sharedBeforeEach('deploy vault', async () => {
    vault = await Vault.create();
  });

  sharedBeforeEach('deploy tokens', async () => {
    allTokens = await TokenList.create(MAX_TOKENS, { varyDecimals: true, sorted: true });

    await allTokens.mint({ to: [lp, owner], amount: fp(100) });
    await allTokens.approve({ from: lp, to: vault });
  });

  sharedBeforeEach('deploy asset manager', async () => {
    assetManager = await deploy('MockWithdrawDepositAssetManager', { args: [vault.address] });
  });

  async function createPool(
    numberOfTokens: number,
    weights?: Array<BigNumber>
  ): Promise<{ pool: WeightedPool; poolTokens: TokenList }> {
    const poolTokens = allTokens.subset(numberOfTokens);
    if (weights == undefined) {
      // We pick random weights, but ones that are not so far apart as to cause issues due to minimum weights. The
      // deployer will normalize them.
      weights = range(numberOfTokens).map(() => fp(20 + random(50)));
    }

    const pool = await WeightedPool.create({
      tokens: poolTokens,
      weights,
      owner: owner.address,
      poolType: WeightedPoolType.MANAGED_POOL,
      assetManagers: Array(numberOfTokens).fill(assetManager.address),
      swapEnabledOnStart: true,
      vault,
    });

    return { pool, poolTokens };
  }

  describe('add token', () => {
    it('reverts if the pool is at the maximum number of tokens', async () => {
      const { pool, poolTokens } = await createPool(MAX_TOKENS);
      const newToken = await Token.create({ decimals: random(0, 18) });
      await pool.init({ from: lp, initialBalances: range(poolTokens.length).map(() => fp(10 + random(10))) });

      await expect(pool.addToken(owner, newToken, ZERO_ADDRESS, fp(0.1))).to.be.revertedWith('MAX_TOKENS');
    });

    it('add token (example from comments)', async () => {
      // Pool with 25/75% weights.
      const { pool, poolTokens } = await createPool(2, [fp(0.25), fp(0.75)]);
      const newToken = await Token.create({ decimals: random(0, 18) });
      await pool.init({ from: lp, initialBalances: range(poolTokens.length).map(() => fp(10)) });

      // Add a token at 80%
      await pool.addToken(owner, newToken, ZERO_ADDRESS, fp(0.8));

      const afterWeights = await pool.getNormalizedWeights();
      // The final weights should be 5/15/80%.
      expect(afterWeights[0]).to.equal(fp(0.05));
      expect(afterWeights[1]).to.equal(fp(0.15));
      expect(afterWeights[2]).to.equal(fp(0.8));
    });

    itAddsATokenAtTokenCount(MIN_TOKENS);
    itAddsATokenAtTokenCount(10);
    itAddsATokenAtTokenCount(30);
    itAddsATokenAtTokenCount(MAX_TOKENS - 1);

    function itAddsATokenAtTokenCount(poolTokenCount: number) {
      let pool: WeightedPool;
      let poolTokens: TokenList;

      context(`when the pool has ${poolTokenCount} tokens`, () => {
        sharedBeforeEach('deploy pool', async () => {
          ({ pool, poolTokens } = await createPool(poolTokenCount));
        });

        let newToken: Token;
        sharedBeforeEach('deploy new token and asset manager', async () => {
          newToken = await Token.create({ decimals: random(0, 18) });

          await newToken.mint(owner, fp(100));
          await newToken.approve(assetManager, MAX_UINT256, { from: owner });
        });

        it('reverts if the pool is uninitialized', async () => {
          await expect(pool.addToken(owner, newToken, assetManager, fp(0.1))).to.be.revertedWith('UNINITIALIZED');
        });

        context('once initialized', () => {
          sharedBeforeEach('initialize pool', async () => {
            // Random non-zero balances
            await pool.init({ from: lp, initialBalances: range(poolTokens.length).map(() => fp(10 + random(10))) });
          });

          describe('failure modes', () => {
            it('reverts when not called by the owner', async () => {
              await expect(pool.addToken(other, newToken, assetManager, fp(0.1))).to.be.revertedWith(
                'SENDER_NOT_ALLOWED'
              );
            });

            it('reverts if the token is already in the pool', async () => {
              await expect(pool.addToken(owner, poolTokens.first, assetManager, fp(0.1))).to.be.revertedWith(
                'TOKEN_ALREADY_REGISTERED'
              );
            });

            it('reverts if the token to add is the BPT itself', async () => {
              await expect(pool.addToken(owner, pool.address, assetManager, fp(0.1))).to.be.revertedWith(
                'ADD_OR_REMOVE_BPT'
              );
            });

            it("reverts if the new token's weight is too high", async () => {
              const weightTooHigh = fp(0.99);
              // We get a MIN_WEIGHT error because the large weight causes for one of the other tokens to end up below
              // the minimum weight. The maximum valid weight depends on the current weights.
              await expect(pool.addToken(owner, newToken, assetManager, weightTooHigh)).to.be.revertedWith(
                'MIN_WEIGHT'
              );
            });

            it("reverts if the new token's weight is the maximum weight", async () => {
              const invalidWeight = fp(1);
              // We get a MIN_WEIGHT error because the large weight causes for one of the other tokens to end up below
              // the minimum weight - there's no room for any other weight.
              await expect(pool.addToken(owner, newToken, assetManager, invalidWeight)).to.be.revertedWith(
                'MIN_WEIGHT'
              );
            });

            it("reverts if the new token's weight is above the maximum weight", async () => {
              const invalidWeight = fp(1).add(1);
              await expect(pool.addToken(owner, newToken, assetManager, invalidWeight)).to.be.revertedWith(
                'SUB_OVERFLOW'
              );
            });

            it("reverts if the new token's weight is too low", async () => {
              const weightTooLow = fp(0.005);
              await expect(pool.addToken(owner, newToken, assetManager, weightTooLow)).to.be.revertedWith('MIN_WEIGHT');
            });

            it('reverts if the pool is paused', async () => {
              await pool.pause();
              await expect(pool.addToken(owner, newToken, assetManager, fp(0.1))).to.be.revertedWith('PAUSED');
            });

            it('reverts with a scheduled weight change', async () => {
              const startTime = (await currentTimestamp()).add(DAY);
              const endTime = startTime.add(MONTH);

              // We need to renormalize the weights as the pool returns weights that are not exactly normalized
              await pool.updateWeightsGradually(
                owner,
                startTime,
                endTime,
                toNormalizedWeights(await pool.getNormalizedWeights())
              );

              await expect(pool.addToken(owner, newToken, assetManager, fp(0.1))).to.be.revertedWith(
                'CHANGE_TOKENS_PENDING_WEIGHT_CHANGE'
              );
            });

            it('reverts with an ongoing weight change', async () => {
              const startTime = (await currentTimestamp()).add(DAY);
              const endTime = startTime.add(MONTH);

              // We need to renormalize the weights as the pool returns weights that are not exactly normalized
              await pool.updateWeightsGradually(
                owner,
                startTime,
                endTime,
                toNormalizedWeights(await pool.getNormalizedWeights())
              );

              await advanceToTimestamp(startTime.add(DAY));

              await expect(pool.addToken(owner, newToken, assetManager, fp(0.1))).to.be.revertedWith(
                'CHANGE_TOKENS_DURING_WEIGHT_CHANGE'
              );
            });
          });

          context('with swaps enabled', () => {
            sharedBeforeEach('enable swaps', async () => {
              await pool.setSwapEnabled(owner, true);
            });

            itAddsATokenWithNoErrors();
          });

          context('with swaps disabled', () => {
            sharedBeforeEach('disable swaps', async () => {
              await pool.setSwapEnabled(owner, false);
            });

            itAddsATokenWithNoErrors();
          });

          function itAddsATokenWithNoErrors() {
            it('adds a new token to the end of the array of tokens in the pool', async () => {
              await pool.addToken(owner, newToken, assetManager, fp(0.1));

              const { tokens: afterAddTokens } = await pool.getTokens();
              expect(afterAddTokens.length).to.equal(poolTokens.length + 1);

              expect(afterAddTokens.slice(0, -1)).to.deep.equal(poolTokens.addresses);
              expect(afterAddTokens[afterAddTokens.length - 1]).to.be.eq(newToken.address);
            });

            it('the new token starts with no balance', async () => {
              await pool.addToken(owner, newToken, assetManager, fp(0.1));

              const { balances } = await pool.getTokens();
              expect(balances[balances.length - 1]).to.be.eq(0);
            });

            it('leaves all other balances unchanged', async () => {
              const { tokens: beforeAddTokens, balances: beforeAddBalances } = await pool.getTokens();

              await pool.addToken(owner, newToken, assetManager, fp(0.1));

              const { tokens: afterAddTokens, balances: afterAddBalances } = await pool.getTokens();

              beforeAddTokens.forEach((token, index) => {
                const newIndex = afterAddTokens.indexOf(token);
                expect(afterAddBalances[newIndex]).to.equal(beforeAddBalances[index]);
              });
            });

            it(`sets the token's asset manager`, async () => {
              const normalizedWeight = fp(0.1);
              await pool.addToken(owner, newToken, assetManager, normalizedWeight);

              const { assetManager: actualAssetManager } = await pool.getTokenInfo(newToken);
              expect(actualAssetManager).to.equal(assetManager.address);
            });

            it(`sets the token's weight`, async () => {
              const normalizedWeight = fp(0.1);
              await pool.addToken(owner, newToken, assetManager, normalizedWeight);

              const { tokens: afterAddTokens } = await pool.getTokens();
              const afterAddWeights = await pool.getNormalizedWeights();

              expect(afterAddWeights[afterAddTokens.indexOf(newToken.address)]).to.equalWithError(
                normalizedWeight,
                1e-12
              );
            });

            it('scales weights of all other tokens', async () => {
              const { tokens: beforeTokens } = await pool.getTokens();
              const beforeWeights = await pool.getNormalizedWeights();

              const beforeTokenWeights = range(beforeTokens.length).map((i) => ({
                token: beforeTokens[i],
                weight: beforeWeights[i],
              }));

              await pool.addToken(owner, newToken, assetManager, fp(0.1));

              const { tokens: afterTokens } = await pool.getTokens();
              const afterWeights = await pool.getNormalizedWeights();

              const afterTokenWeights = range(afterTokens.length).map((i) => ({
                token: afterTokens[i],
                weight: afterWeights[i],
              }));

              // In this test, we make no assumptions about the internal behavior of the pool and simply check the
              // observable state: the weights should roughly add up to fp(1), and their old ratios should remain

              expect(afterTokenWeights.reduce((sum, tokenData) => sum.add(tokenData.weight), bn(0))).to.equal(fp(1));

              beforeTokenWeights.forEach((someToken) => {
                beforeTokenWeights
                  .filter((tk) => tk.token !== someToken.token)
                  .forEach((otherToken) => {
                    const someTokenAfterIndex = afterTokens.indexOf(someToken.token);
                    const otherTokenAfterIndex = afterTokens.indexOf(otherToken.token);

                    const beforeWeightRatio = fpDiv(someToken.weight, otherToken.weight);
                    const afterWeightRatio = fpDiv(
                      afterTokenWeights[someTokenAfterIndex].weight,
                      afterTokenWeights[otherTokenAfterIndex].weight
                    );

                    expect(afterWeightRatio).to.equalWithError(beforeWeightRatio, 1e-12);
                  });
              });
            });

            it('emits an event', async () => {
              const normalizedWeight = fp(0.1);
              const tx = await pool.addToken(owner, newToken, assetManager, normalizedWeight);

              expectEvent.inReceipt(await tx.wait(), 'TokenAdded', {
                token: newToken.address,
                normalizedWeight,
              });
            });

            context('with a zero mint amount', () => {
              it('mints no BPT', async () => {
                const supplyBefore = await pool.totalSupply();
                await pool.addToken(owner, newToken, assetManager, fp(0.1), 0);
                const supplyAfter = await pool.totalSupply();

                expect(supplyAfter).to.equal(supplyBefore);
              });
            });

            context('with a non-zero mint amount', () => {
              it('mints BPT to the specified address', async () => {
                const bptBalanceBefore = await pool.balanceOf(other.address);

                const mintAmount = fp(17);
                await pool.addToken(owner, newToken, assetManager, fp(0.1), mintAmount, other.address);

                const bptBalanceAfter = await pool.balanceOf(other.address);

                expect(bptBalanceAfter.sub(bptBalanceBefore)).to.equal(mintAmount);
              });
            });
          }
        });
      });
    }
  });

  describe('remove token', () => {
    it('reverts if the pool is at the minimum number of tokens', async () => {
      const { pool, poolTokens } = await createPool(MIN_TOKENS);
      await pool.init({ from: lp, initialBalances: range(poolTokens.length).map(() => fp(10 + random(10))) });

      const tokenToRemove = poolTokens.first;
      const { cash } = await pool.vault.getPoolTokenInfo(pool.poolId, tokenToRemove.address);
      await assetManager.withdrawFromPool(pool.poolId, tokenToRemove.address, cash);
      await expect(pool.removeToken(owner, tokenToRemove.address, ZERO_ADDRESS)).to.be.revertedWith('MIN_TOKENS');
    });

    it('remove token (example from comments)', async () => {
      // Pool with 5/15/80% weights.
      const { pool, poolTokens } = await createPool(3, [fp(0.05), fp(0.15), fp(0.8)]);
      await pool.init({ from: lp, initialBalances: range(poolTokens.length).map(() => fp(10)) });

      // Remove the 80% token
      const tokenToRemove = poolTokens.get(poolTokens.length - 1);
      const { cash } = await pool.vault.getPoolTokenInfo(pool.poolId, tokenToRemove.address);
      await assetManager.withdrawFromPool(pool.poolId, tokenToRemove.address, cash);

      await pool.removeToken(owner, tokenToRemove.address);

      const afterWeights = await pool.getNormalizedWeights();
      // The final weights should be 25/75%.
      expect(afterWeights[0]).to.equal(fp(0.25));
      expect(afterWeights[1]).to.equal(fp(0.75));
    });

    itRemovesATokenAtTokenCount(MIN_TOKENS + 1);
    itRemovesATokenAtTokenCount(10);
    itRemovesATokenAtTokenCount(30);
    itRemovesATokenAtTokenCount(MAX_TOKENS);

    function itRemovesATokenAtTokenCount(poolTokenCount: number) {
      let pool: WeightedPool;
      let poolTokens: TokenList;

      context(`when the pool has ${poolTokenCount} tokens`, () => {
        sharedBeforeEach('deploy pool', async () => {
          ({ pool, poolTokens } = await createPool(poolTokenCount));
        });

        let tokenToRemove: Token;

        sharedBeforeEach('select token to remove', async () => {
          tokenToRemove = poolTokens.get(random(0, poolTokenCount - 1));
        });

        it('reverts if the pool is uninitialized', async () => {
          await expect(pool.removeToken(owner, tokenToRemove)).to.be.revertedWith('UNINITIALIZED');
        });

        context('once initialized', () => {
          sharedBeforeEach('initialize pool', async () => {
            // Random non-zero balances
            await pool.init({ from: lp, initialBalances: range(poolTokens.length).map(() => fp(10 + random(10))) });
          });

          sharedBeforeEach('withdraw all tokens', async () => {
            // Tokens can only be fully withdrawn via the asset manager. This assumes there's no managed balance.
            const { cash, managed } = await pool.vault.getPoolTokenInfo(pool.poolId, tokenToRemove);
            expect(managed).to.equal(0);

            await assetManager.withdrawFromPool(pool.poolId, tokenToRemove.address, cash);
          });

          describe('failure modes', () => {
            it('reverts when not called by the owner', async () => {
              await expect(pool.removeToken(other, tokenToRemove)).to.be.revertedWith('SENDER_NOT_ALLOWED');
            });

            it('reverts if the token is not in the pool', async () => {
              const otherToken = await Token.create({ decimals: random(0, 18) });
              await expect(pool.removeToken(owner, otherToken)).to.be.revertedWith('TOKEN_NOT_REGISTERED');
            });

            it('reverts if the token to remove is the BPT itself', async () => {
              await expect(pool.removeToken(owner, pool.address)).to.be.revertedWith('ADD_OR_REMOVE_BPT');
            });

            it('reverts if the pool is paused', async () => {
              await pool.pause();
              await expect(pool.removeToken(owner, tokenToRemove)).to.be.revertedWith('PAUSED');
            });

            it('reverts with a scheduled weight change', async () => {
              const startTime = (await currentTimestamp()).add(DAY);
              const endTime = startTime.add(MONTH);

              // We need to renormalize the weights as the pool returns weights that are not exactly normalized
              await pool.updateWeightsGradually(
                owner,
                startTime,
                endTime,
                toNormalizedWeights(await pool.getNormalizedWeights())
              );

              await expect(pool.removeToken(owner, tokenToRemove)).to.be.revertedWith(
                'CHANGE_TOKENS_PENDING_WEIGHT_CHANGE'
              );
            });

            it('reverts with an ongoing weight change', async () => {
              const startTime = (await currentTimestamp()).add(DAY);
              const endTime = startTime.add(MONTH);

              // We need to renormalize the weights as the pool returns weights that are not exactly normalized
              await pool.updateWeightsGradually(
                owner,
                startTime,
                endTime,
                toNormalizedWeights(await pool.getNormalizedWeights())
              );

              await advanceToTimestamp(startTime.add(DAY));

              await expect(pool.removeToken(owner, tokenToRemove)).to.be.revertedWith(
                'CHANGE_TOKENS_DURING_WEIGHT_CHANGE'
              );
            });

            it('reverts if all tokens have not been withdrawn', async () => {
              // We've already withdrawn all tokens in this test, so we simply deposit some to generate a non-zero
              // balance (as if the tokens had not been removed).
              const amount = 42;
              await tokenToRemove.transfer(assetManager.address, amount, { from: lp });
              await assetManager.depositToPool(pool.poolId, tokenToRemove.address, amount);

              const { cash, managed } = await pool.vault.getPoolTokenInfo(pool.poolId, tokenToRemove);
              expect(cash.add(managed)).to.be.gt(0);

              await expect(pool.removeToken(owner, tokenToRemove)).to.be.revertedWith('NONZERO_TOKEN_BALANCE');
            });
          });

          context('with swaps enabled', () => {
            sharedBeforeEach('enable swaps', async () => {
              await pool.setSwapEnabled(owner, true);
            });

            itRemovesATokenWithNoErrors();
          });

          context('with swaps disabled', () => {
            sharedBeforeEach('disable swaps', async () => {
              await pool.setSwapEnabled(owner, false);
            });

            itRemovesATokenWithNoErrors();
          });

          function itRemovesATokenWithNoErrors() {
            it('removes the token', async () => {
              await pool.removeToken(owner, tokenToRemove);

              const { tokens: afterRemoveTokens } = await pool.getTokens();
              expect(afterRemoveTokens.length).to.equal(poolTokens.length - 1);

              // We need to sort when comparing as the order may have changed
              expect([...afterRemoveTokens].sort()).to.deep.equal(
                poolTokens.addresses.filter((address) => address != tokenToRemove.address).sort()
              );
            });

            it(`leaves all other balances unchanged`, async () => {
              const { tokens: beforeRemoveTokens, balances: beforeRemoveBalances } = await pool.getTokens();

              await pool.removeToken(owner, tokenToRemove);

              const { tokens: afterRemoveTokens, balances: afterRemoveBalances } = await pool.getTokens();

              afterRemoveTokens.forEach((token, index) => {
                const oldIndex = beforeRemoveTokens.indexOf(token);
                expect(afterRemoveBalances[index]).to.equal(beforeRemoveBalances[oldIndex]);
              });
            });

            it('scales weights of all other tokens', async () => {
              const { tokens: beforeTokens } = await pool.getTokens();
              const beforeWeights = await pool.getNormalizedWeights();

              const beforeTokenWeights = range(beforeTokens.length).map((i) => ({
                token: beforeTokens[i],
                weight: beforeWeights[i],
              }));

              await pool.removeToken(owner, tokenToRemove);

              const { tokens: afterTokens } = await pool.getTokens();
              const afterWeights = await pool.getNormalizedWeights();

              const afterTokenWeights = range(afterTokens.length).map((i) => ({
                token: afterTokens[i],
                weight: afterWeights[i],
              }));

              // In this test, we make no assumptions about the internal behavior of the pool and simply check the
              // observable state: the weights should roughly add up to fp(1), and their old ratios should remain

              expect(afterTokenWeights.reduce((sum, tokenData) => sum.add(tokenData.weight), bn(0))).to.equalWithError(
                fp(1),
                0.000001
              );

              afterTokenWeights.forEach((someToken) => {
                afterTokenWeights
                  .filter((tk) => tk.token !== someToken.token)
                  .forEach((otherToken) => {
                    const someTokenBeforeIndex = beforeTokens.indexOf(someToken.token);
                    const otherTokenBeforeIndex = beforeTokens.indexOf(otherToken.token);

                    const afterWeightRatio = fpDiv(someToken.weight, otherToken.weight);
                    const beforeWeightRatio = fpDiv(
                      beforeTokenWeights[someTokenBeforeIndex].weight,
                      beforeTokenWeights[otherTokenBeforeIndex].weight
                    );

                    expect(afterWeightRatio).to.equalWithError(beforeWeightRatio, 0.000001);
                  });
              });
            });

            it('emits an event', async () => {
              const tx = await pool.removeToken(owner, tokenToRemove);

              expectEvent.inReceipt(await tx.wait(), 'TokenRemoved', {
                token: tokenToRemove.address,
              });
            });

            context('with a zero burn amount', () => {
              it('burns no BPT', async () => {
                const supplyBefore = await pool.totalSupply();
                await pool.removeToken(owner, tokenToRemove, ZERO_ADDRESS, 0);
                const supplyAfter = await pool.totalSupply();

                expect(supplyAfter).to.equal(supplyBefore);
              });
            });

            context('with a non-zero burn amount', () => {
              it('burns BPT from the sender', async () => {
                const bptBalanceBefore = await pool.balanceOf(lp.address);

                const burnAmount = fp(17);
                await pool.removeToken(owner, tokenToRemove, lp.address, burnAmount);

                const bptBalanceAfter = await pool.balanceOf(lp.address);

                expect(bptBalanceBefore.sub(bptBalanceAfter)).to.equal(burnAmount);
              });

              it('reverts if burning from the zero address', async () => {
                await expect(pool.removeToken(owner, tokenToRemove, ZERO_ADDRESS, 1)).to.be.revertedWith(
                  'BURN_FROM_ZERO'
                );
              });
            });
          }
        });
      });
    }
  });
});
