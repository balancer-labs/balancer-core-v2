import { ethers } from 'hardhat';
import { BigNumber, Contract } from 'ethers';
import { expect } from 'chai';
import { SignerWithAddress } from '@nomiclabs/hardhat-ethers/dist/src/signer-with-address';

import TokenList from '@balancer-labs/v2-helpers/src/models/tokens/TokenList';

import { bn, fp } from '@balancer-labs/v2-helpers/src/numbers';
import { MAX_INT256, MAX_UINT256, ZERO_ADDRESS } from '@balancer-labs/v2-helpers/src/constants';

import { deploy } from '@balancer-labs/v2-helpers/src/contract';
import { expectBalanceChange } from '@balancer-labs/v2-helpers/src/test/tokenBalance';
import Vault from '@balancer-labs/v2-helpers/src/models/vault/Vault';
import { GeneralPool } from '@balancer-labs/v2-helpers/src/models/vault/pools';
import { encodeJoin } from '@balancer-labs/v2-helpers/src/models/pools/mockPool';
import * as expectEvent from '@balancer-labs/v2-helpers/src/test/expectEvent';
import { calcRebalanceAmount, calcRebalanceFee } from './helpers/rebalance';

const OVER_INVESTMENT_REVERT_REASON = 'investment amount exceeds target';
const UNDER_INVESTMENT_REVERT_REASON = 'withdrawal leaves insufficient balance invested';

const tokenInitialBalance = bn(200e18);

const setup = async () => {
  const [, lp, other] = await ethers.getSigners();

  const tokens = await TokenList.create(['DAI', 'MKR'], { sorted: true });

  // Deploy Balancer Vault
  const vault = await Vault.create();

  // Deploy Pool
  const pool = await deploy('v2-vault/MockPool', { args: [vault.address, GeneralPool] });
  const poolId = await pool.getPoolId();

  // Deploy Asset manager
  const assetManager = await deploy('TestAssetManager', {
    args: [vault.address, poolId, tokens.DAI.address],
  });

  await tokens.mint({ to: lp, amount: tokenInitialBalance.mul(2) });
  await tokens.approve({ to: vault.address, from: [lp] });

  // Assign assetManager to the DAI token, and other to the other token
  const assetManagers = [assetManager.address, other.address];

  await pool.registerTokens(tokens.addresses, assetManagers);

  await vault.instance.connect(lp).joinPool(poolId, lp.address, lp.address, {
    assets: tokens.addresses,
    maxAmountsIn: tokens.addresses.map(() => MAX_UINT256),
    fromInternalBalance: false,
    userData: encodeJoin(
      tokens.addresses.map(() => tokenInitialBalance),
      tokens.addresses.map(() => 0)
    ),
  });

  // Deploy Pool for liquidating fees
  const swapPool = await deploy('v2-vault/test/MockPool', { args: [vault.address, GeneralPool] });
  const swapPoolId = await swapPool.getPoolId();

  await swapPool.registerTokens(tokens.addresses, [ZERO_ADDRESS, ZERO_ADDRESS]);

  await vault.instance.connect(lp).joinPool(swapPoolId, lp.address, lp.address, {
    assets: tokens.addresses,
    maxAmountsIn: tokens.addresses.map(() => MAX_UINT256),
    fromInternalBalance: false,
    userData: encodeJoin(
      tokens.addresses.map(() => tokenInitialBalance),
      tokens.addresses.map(() => 0)
    ),
  });

  return {
    data: {
      poolId,
      swapPoolId,
    },
    contracts: {
      assetManager,
      tokens,
      pool,
      vault: vault.instance,
    },
  };
};

describe('Rewards Asset manager', function () {
  let tokens: TokenList, vault: Contract, assetManager: Contract;

  let lp: SignerWithAddress, other: SignerWithAddress;
  let poolId: string, swapPoolId: string;

  before('deploy base contracts', async () => {
    [, lp, other] = await ethers.getSigners();
  });

  sharedBeforeEach('set up asset manager', async () => {
    const { data, contracts } = await setup();
    poolId = data.poolId;
    swapPoolId = data.swapPoolId;

    assetManager = contracts.assetManager;
    tokens = contracts.tokens;
    vault = contracts.vault;
  });

  describe('deployment', () => {
    it('different managers can be set for different tokens', async () => {
      expect((await vault.getPoolTokenInfo(poolId, tokens.DAI.address)).assetManager).to.equal(assetManager.address);
      expect((await vault.getPoolTokenInfo(poolId, tokens.MKR.address)).assetManager).to.equal(other.address);
    });
  });

  describe('setPoolConfig', () => {
    let poolController: SignerWithAddress;

    sharedBeforeEach(async () => {
      poolController = lp; // TODO
    });

    it('allows a pool controller to set the pools target investment config', async () => {
      const updatedConfig = {
        targetPercentage: 3,
        upperCriticalPercentage: 4,
        lowerCriticalPercentage: 2,
        feePercentage: 1,
      };
      await assetManager.connect(poolController).setPoolConfig(poolId, updatedConfig);

      const result = await assetManager.getPoolConfig(poolId);
      expect(result.targetPercentage).to.equal(updatedConfig.targetPercentage);
      expect(result.upperCriticalPercentage).to.equal(updatedConfig.upperCriticalPercentage);
      expect(result.lowerCriticalPercentage).to.equal(updatedConfig.lowerCriticalPercentage);
      expect(result.feePercentage).to.equal(updatedConfig.feePercentage);
    });

    it('reverts when setting upper critical over 100%', async () => {
      const badPoolConfig = {
        targetPercentage: 0,
        upperCriticalPercentage: fp(1).add(1),
        lowerCriticalPercentage: 0,
        feePercentage: 0,
      };
      await expect(assetManager.connect(poolController).setPoolConfig(poolId, badPoolConfig)).to.be.revertedWith(
        'Upper critical level must be less than or equal to 100%'
      );
    });

    it('reverts when setting upper critical below target', async () => {
      const badPoolConfig = {
        targetPercentage: 1,
        upperCriticalPercentage: 0,
        lowerCriticalPercentage: 0,
        feePercentage: 0,
      };
      await expect(assetManager.connect(poolController).setPoolConfig(poolId, badPoolConfig)).to.be.revertedWith(
        'Target must be less than or equal to upper critical level'
      );
    });

    it('reverts when setting lower critical above target', async () => {
      const badPoolConfig = {
        targetPercentage: 1,
        upperCriticalPercentage: 2,
        lowerCriticalPercentage: 2,
        feePercentage: 0,
      };
      await expect(assetManager.connect(poolController).setPoolConfig(poolId, badPoolConfig)).to.be.revertedWith(
        'Lower critical level must be less than or equal to target'
      );
    });

    it('reverts when setting fee percentage over 100%', async () => {
      const badPoolConfig = {
        targetPercentage: 0,
        upperCriticalPercentage: 0,
        lowerCriticalPercentage: 0,
        feePercentage: fp(0.1).add(1),
      };
      await expect(assetManager.connect(poolController).setPoolConfig(poolId, badPoolConfig)).to.be.revertedWith(
        'Fee on critical rebalances must be less than or equal to 10%'
      );
    });

    it('prevents an unauthorized user from setting the pool config');
  });

  describe('capitalIn', () => {
    context('when a token is below its investment target', () => {
      let poolController: SignerWithAddress; // TODO
      const poolConfig = {
        targetPercentage: fp(0.5),
        upperCriticalPercentage: fp(1),
        lowerCriticalPercentage: 0,
        feePercentage: 0,
      };

      sharedBeforeEach(async () => {
        poolController = lp; // TODO
        await assetManager.connect(poolController).setPoolConfig(poolId, poolConfig);
      });

      it('allows anyone to deposit pool assets to an investment manager to get to the target investable %', async () => {
        const amountToDeposit = await assetManager.maxInvestableBalance(poolId);

        await expectBalanceChange(() => assetManager.connect(lp).capitalIn(poolId, amountToDeposit), tokens, [
          { account: assetManager.address, changes: { DAI: amountToDeposit } },
          { account: vault.address, changes: { DAI: amountToDeposit.mul(-1) } },
        ]);
      });

      it('prevents depositing pool assets to an investment manager over the target investable %', async () => {
        const maxInvestment = await assetManager.maxInvestableBalance(poolId);
        const overInvestmentAmount = maxInvestment.add(1);

        expect(assetManager.connect(lp).capitalIn(poolId, overInvestmentAmount)).to.be.revertedWith(
          OVER_INVESTMENT_REVERT_REASON
        );
      });

      it("updates the pool's managed balance", async () => {
        const amountToDeposit = await assetManager.maxInvestableBalance(poolId);

        await assetManager.connect(lp).capitalIn(poolId, amountToDeposit);

        const { managed } = await vault.getPoolTokenInfo(poolId, tokens.DAI.address);
        const actualManagedBalance = await assetManager.readAUM();

        expect(managed).to.be.eq(actualManagedBalance);
      });
    });

    context('when a token is above its investment target', () => {
      let poolController: SignerWithAddress; // TODO

      sharedBeforeEach(async () => {
        const poolConfig = {
          targetPercentage: fp(0.5),
          upperCriticalPercentage: fp(1),
          lowerCriticalPercentage: 0,
          feePercentage: 0,
        };
        poolController = lp; // TODO
        await assetManager.connect(poolController).setPoolConfig(poolId, poolConfig);

        const { poolCash } = await assetManager.getPoolBalances(poolId);
        await tokens.DAI.mint(assetManager.address, poolCash.mul(101).div(100));

        // should be overinvested
        const maxInvestableBalance = await assetManager.maxInvestableBalance(poolId);
        expect(maxInvestableBalance).to.be.lt(0);
      });

      it('reverts', async () => {
        const minimalInvestment = 1;
        await expect(assetManager.connect(lp).capitalIn(poolId, minimalInvestment)).revertedWith(
          OVER_INVESTMENT_REVERT_REASON
        );
      });
    });
  });

  describe('capitalOut', () => {
    context('when a token is below its investment target', () => {
      let poolController: SignerWithAddress; // TODO

      sharedBeforeEach(async () => {
        poolController = lp; // TODO
        const poolConfig = {
          targetPercentage: fp(0.5),
          upperCriticalPercentage: fp(1),
          lowerCriticalPercentage: 0,
          feePercentage: 0,
        };
        await assetManager.connect(poolController).setPoolConfig(poolId, poolConfig);

        const { poolCash } = await assetManager.getPoolBalances(poolId);
        await tokens.DAI.mint(assetManager.address, poolCash.mul(99).div(100));

        // should be under invested
        const maxInvestableBalance = await assetManager.maxInvestableBalance(poolId);
        expect(maxInvestableBalance).to.gt(0);
      });

      it('reverts', async () => {
        const minimalWithdrawal = 100;
        await expect(assetManager.connect(lp).capitalOut(poolId, minimalWithdrawal)).revertedWith(
          UNDER_INVESTMENT_REVERT_REASON
        );
      });
    });

    context('when a token is above its investment target', () => {
      let poolController: SignerWithAddress; // TODO

      sharedBeforeEach(async () => {
        poolController = lp; // TODO
        const poolConfig = {
          targetPercentage: fp(0.5),
          upperCriticalPercentage: fp(1),
          lowerCriticalPercentage: 0,
          feePercentage: 0,
        };
        poolController = lp; // TODO
        await assetManager.connect(poolController).setPoolConfig(poolId, poolConfig);

        const { poolCash } = await assetManager.getPoolBalances(poolId);
        await tokens.DAI.mint(assetManager.address, poolCash.mul(101).div(100));

        // should be overinvested
        const maxInvestableBalance = await assetManager.maxInvestableBalance(poolId);
        expect(maxInvestableBalance).to.be.lt(0);
      });

      it('allows anyone to withdraw assets to a pool to get to the target investable %', async () => {
        const amountToWithdraw = (await assetManager.maxInvestableBalance(poolId)).mul(-1);

        await expectBalanceChange(() => assetManager.connect(lp).capitalOut(poolId, amountToWithdraw), tokens, [
          { account: assetManager.address, changes: { DAI: amountToWithdraw.mul(-1) } },
          { account: vault.address, changes: { DAI: amountToWithdraw } },
        ]);
      });

      it('prevents depositing pool assets to an investment manager over the target investable %', async () => {
        const maxDivestment = (await assetManager.maxInvestableBalance(poolId)).mul(-1);
        const overDivestmentAmount = maxDivestment.add(1);

        expect(assetManager.connect(lp).capitalOut(poolId, overDivestmentAmount)).to.be.revertedWith(
          UNDER_INVESTMENT_REVERT_REASON
        );
      });

      it("updates the pool's managed balance", async () => {
        const maxInvestableBalance = await assetManager.maxInvestableBalance(poolId);

        // return a portion of the return to the vault to serve as a buffer
        const amountToWithdraw = maxInvestableBalance.abs();

        await assetManager.connect(lp).capitalOut(poolId, amountToWithdraw);

        const { managed } = await vault.getPoolTokenInfo(poolId, tokens.DAI.address);
        const actualManagedBalance = await assetManager.readAUM();

        expect(managed.sub(actualManagedBalance)).to.be.lt(10);
      });

      it('allows withdrawing returns which are greater than the current managed balance', async () => {
        const { poolCash, poolManaged } = await assetManager.getPoolBalances(poolId);
        const poolAssets = poolCash.add(poolManaged);

        // Asset manager experiences gains far in excess of pool value
        await tokens.DAI.mint(assetManager.address, poolAssets.mul(10));

        const amountToWithdraw = (await assetManager.maxInvestableBalance(poolId)).mul(-1);

        await expectBalanceChange(() => assetManager.connect(lp).capitalOut(poolId, amountToWithdraw), tokens, [
          { account: assetManager.address, changes: { DAI: -amountToWithdraw } },
          { account: vault.address, changes: { DAI: amountToWithdraw } },
        ]);
      });
    });
  });

  describe('getRebalanceFee', () => {
    context('when pool is in the non-critical range', () => {
      const poolConfig = {
        targetPercentage: fp(0.5),
        upperCriticalPercentage: fp(1),
        lowerCriticalPercentage: fp(0.1),
        feePercentage: fp(0.1),
      };

      sharedBeforeEach(async () => {
        const poolController = lp; // TODO

        await assetManager.connect(poolController).setPoolConfig(poolId, poolConfig);
        const { poolCash } = await assetManager.getPoolBalances(poolId);
        await tokens.DAI.mint(assetManager.address, poolCash.mul(99).div(100));

        // Ensure that the pool is invested below its target level but above than critical level
        const maxInvestableBalance = await assetManager.maxInvestableBalance(poolId);
        expect(maxInvestableBalance).to.be.gt(1);
      });

      it('returns 0', async () => {
        expect(await assetManager.getRebalanceFee(poolId)).to.be.eq(0);
      });
    });

    context('when pool is above upper critical investment level', () => {
      let poolController: SignerWithAddress; // TODO
      const poolConfig = {
        targetPercentage: fp(0.5),
        upperCriticalPercentage: fp(0.6),
        lowerCriticalPercentage: fp(0.1),
        feePercentage: fp(0.1),
      };

      sharedBeforeEach(async () => {
        poolController = lp; // TODO

        await assetManager.connect(poolController).setPoolConfig(poolId, poolConfig);

        const { poolCash } = await assetManager.getPoolBalances(poolId);
        // Results in an investment percentage of 75%
        await tokens.DAI.mint(assetManager.address, poolCash.mul(3));
      });

      context('when fee percentage is zero', () => {
        it('returns 0', async () => {
          await assetManager.connect(poolController).setPoolConfig(poolId, { ...poolConfig, feePercentage: 0 });
          const expectedFee = 0;
          expect(await assetManager.getRebalanceFee(poolId)).to.be.eq(expectedFee);
        });
      });

      context('when fee percentage is non-zero', () => {
        it('returns the expected fee', async () => {
          const { poolCash, poolManaged } = await assetManager.getPoolBalances(poolId);
          const expectedFee = calcRebalanceFee(poolCash, poolManaged, poolConfig);
          expect(expectedFee).to.be.gt(0);
          expect(await assetManager.getRebalanceFee(poolId)).to.be.eq(expectedFee);
        });
      });
    });

    context('when pool is below critical investment level', () => {
      const poolConfig = {
        targetPercentage: fp(0.5),
        upperCriticalPercentage: fp(1),
        lowerCriticalPercentage: fp(0.1),
        feePercentage: fp(0.1),
      };

      context('when fee percentage is zero', () => {
        sharedBeforeEach(async () => {
          const poolController = lp; // TODO

          await assetManager.connect(poolController).setPoolConfig(poolId, { ...poolConfig, feePercentage: bn(0) });
        });

        it('returns 0', async () => {
          const expectedFee = 0;
          expect(await assetManager.getRebalanceFee(poolId)).to.be.eq(expectedFee);
        });
      });

      context('when fee percentage is non-zero', () => {
        sharedBeforeEach(async () => {
          const poolController = lp; // TODO

          await assetManager.connect(poolController).setPoolConfig(poolId, poolConfig);
        });

        it('returns the expected fee', async () => {
          const { poolCash, poolManaged } = await assetManager.getPoolBalances(poolId);
          const expectedFee = calcRebalanceFee(poolCash, poolManaged, poolConfig);
          expect(expectedFee).to.be.gt(0);
          expect(await assetManager.getRebalanceFee(poolId)).to.be.eq(expectedFee);
        });
      });
    });
  });

  describe('rebalance', () => {
    context('when pool is above target investment level', () => {
      context('when pool is in non-critical range', () => {
        const poolConfig = {
          targetPercentage: fp(0.5),
          upperCriticalPercentage: fp(1),
          lowerCriticalPercentage: fp(0.1),
          feePercentage: fp(0.1),
        };

        sharedBeforeEach(async () => {
          const poolController = lp; // TODO
          await assetManager.connect(poolController).setPoolConfig(poolId, poolConfig);

          const { poolCash } = await assetManager.getPoolBalances(poolId);
          await tokens.DAI.mint(assetManager.address, poolCash.mul(101).div(100));

          // should be overinvested
          const maxInvestableBalance = await assetManager.maxInvestableBalance(poolId);
          expect(maxInvestableBalance).to.be.lt(0);
        });

        it('transfers the expected number of tokens to the Vault', async () => {
          const { poolCash, poolManaged } = await assetManager.getPoolBalances(poolId);
          const expectedRebalanceAmount = calcRebalanceAmount(poolCash, poolManaged, poolConfig);

          await expectBalanceChange(() => assetManager.rebalance(poolId), tokens, [
            { account: assetManager.address, changes: { DAI: expectedRebalanceAmount } },
            { account: vault.address, changes: { DAI: expectedRebalanceAmount.mul(-1) } },
          ]);
        });

        it('returns the pool to its target allocation', async () => {
          await assetManager.rebalance(poolId);
          const differenceFromTarget = await assetManager.maxInvestableBalance(poolId);
          expect(differenceFromTarget.abs()).to.be.lte(1);
        });
      });

      context('when pool is above critical investment level', () => {
        const poolConfig = {
          targetPercentage: fp(0.5),
          upperCriticalPercentage: fp(0.6),
          lowerCriticalPercentage: fp(0.1),
          feePercentage: fp(0.1),
        };

        context('when fee percentage is zero', () => {
          sharedBeforeEach(async () => {
            const poolController = lp; // TODO
            await assetManager.connect(poolController).setPoolConfig(poolId, poolConfig);

            const { poolCash } = await assetManager.getPoolBalances(poolId);
            await tokens.DAI.mint(assetManager.address, poolCash.mul(101).div(100));

            // should be overinvested
            const maxInvestableBalance = await assetManager.maxInvestableBalance(poolId);
            expect(maxInvestableBalance).to.be.lt(0);
          });

          it('transfers the expected number of tokens from the Vault', async () => {
            const { poolCash, poolManaged } = await assetManager.getPoolBalances(poolId);
            const expectedRebalanceAmount = calcRebalanceAmount(poolCash, poolManaged, poolConfig);

            await expectBalanceChange(() => assetManager.rebalance(poolId), tokens, [
              { account: assetManager.address, changes: { DAI: expectedRebalanceAmount } },
              { account: vault.address, changes: { DAI: expectedRebalanceAmount.mul(-1) } },
            ]);
          });

          it('returns the pool to its target allocation', async () => {
            await assetManager.rebalance(poolId);
            const differenceFromTarget = await assetManager.maxInvestableBalance(poolId);
            expect(differenceFromTarget.abs()).to.be.lte(1);
          });
        });

        context('when fee percentage is non-zero', () => {
          const poolConfig = {
            targetPercentage: fp(0.5),
            upperCriticalPercentage: fp(1),
            lowerCriticalPercentage: fp(0.1),
            feePercentage: fp(0.1),
          };

          sharedBeforeEach(async () => {
            const poolController = lp; // TODO

            await assetManager.connect(poolController).setPoolConfig(poolId, poolConfig);
          });

          it('transfers the expected number of tokens from the Vault', async () => {
            const { poolCash, poolManaged } = await assetManager.getPoolBalances(poolId);
            const expectedFeeAmount = calcRebalanceFee(poolCash, poolManaged, poolConfig);
            const zeroFeeRebalanceAmount = calcRebalanceAmount(poolCash, poolManaged, poolConfig);

            const investmentFeeAdjustment = expectedFeeAmount.mul(poolConfig.targetPercentage).div(fp(1));
            const expectedInvestmentAmount = zeroFeeRebalanceAmount.sub(investmentFeeAdjustment);

            const expectedVaultRemovedAmount = expectedInvestmentAmount.add(expectedFeeAmount);

            await expectBalanceChange(() => assetManager.connect(lp).rebalance(poolId), tokens, [
              { account: assetManager.address, changes: { DAI: expectedInvestmentAmount } },
              { account: vault.address, changes: { DAI: expectedVaultRemovedAmount.mul(-1) } },
            ]);
          });

          it('pays the correct fee to the rebalancer', async () => {
            const { poolCash, poolManaged } = await assetManager.getPoolBalances(poolId);
            const expectedFeeAmount = calcRebalanceFee(poolCash, poolManaged, poolConfig);
            expect(expectedFeeAmount).to.be.gt(0);
            await expectBalanceChange(() => assetManager.connect(lp).rebalance(poolId), tokens, [
              { account: lp.address, changes: { DAI: expectedFeeAmount } },
            ]);
          });

          it('returns the pool to its target allocation', async () => {
            await assetManager.rebalance(poolId);
            const differenceFromTarget = await assetManager.maxInvestableBalance(poolId);
            expect(differenceFromTarget.abs()).to.be.lte(1);
          });
        });
      });
    });

    context('when pool is below target investment level', () => {
      context('when pool is in non-critical range', () => {
        const poolConfig = {
          targetPercentage: fp(0.5),
          upperCriticalPercentage: fp(1),
          lowerCriticalPercentage: fp(0.1),
          feePercentage: fp(0.1),
        };

        sharedBeforeEach(async () => {
          const poolController = lp; // TODO

          await assetManager.connect(poolController).setPoolConfig(poolId, poolConfig);
          // Ensure that the pool is invested below its target level but above than critical level
          const targetInvestmentAmount = await assetManager.maxInvestableBalance(poolId);
          await assetManager.connect(poolController).capitalIn(poolId, targetInvestmentAmount.div(2));
        });

        it('transfers the expected number of tokens from the Vault', async () => {
          const { poolCash, poolManaged } = await assetManager.getPoolBalances(poolId);
          const expectedRebalanceAmount = calcRebalanceAmount(poolCash, poolManaged, poolConfig);

          await expectBalanceChange(() => assetManager.rebalance(poolId), tokens, [
            { account: assetManager.address, changes: { DAI: expectedRebalanceAmount } },
            { account: vault.address, changes: { DAI: expectedRebalanceAmount.mul(-1) } },
          ]);
        });

        it('returns the pool to its target allocation', async () => {
          await assetManager.rebalance(poolId);
          expect(await assetManager.maxInvestableBalance(poolId)).to.be.eq(0);
        });
      });

      context('when pool is below critical investment level', () => {
        let poolController: SignerWithAddress; // TODO

        describe('when fee percentage is zero', () => {
          const poolConfig = {
            targetPercentage: fp(0.5),
            upperCriticalPercentage: fp(1),
            lowerCriticalPercentage: fp(0.1),
            feePercentage: fp(0),
          };
          sharedBeforeEach(async () => {
            poolController = lp; // TODO

            await assetManager.connect(poolController).setPoolConfig(poolId, poolConfig);
          });

          it('transfers the expected number of tokens from the Vault', async () => {
            const { poolCash, poolManaged } = await assetManager.getPoolBalances(poolId);
            const expectedRebalanceAmount = calcRebalanceAmount(poolCash, poolManaged, poolConfig);

            await expectBalanceChange(() => assetManager.rebalance(poolId), tokens, [
              { account: assetManager.address, changes: { DAI: expectedRebalanceAmount } },
              { account: vault.address, changes: { DAI: expectedRebalanceAmount.mul(-1) } },
            ]);
          });

          it('returns the pool to its target allocation', async () => {
            await assetManager.rebalance(poolId);
            expect(await assetManager.maxInvestableBalance(poolId)).to.be.eq(0);
          });
        });

        context('when fee percentage is non-zero', () => {
          const poolConfig = {
            targetPercentage: fp(0.5),
            upperCriticalPercentage: fp(1),
            lowerCriticalPercentage: fp(0.1),
            feePercentage: fp(0.1),
          };
          sharedBeforeEach(async () => {
            poolController = lp; // TODO

            await assetManager.connect(poolController).setPoolConfig(poolId, poolConfig);
          });

          it('transfers the expected number of tokens from the Vault', async () => {
            const { poolCash, poolManaged } = await assetManager.getPoolBalances(poolId);
            const zeroFeeRebalanceAmount = calcRebalanceAmount(poolCash, poolManaged, poolConfig);
            const expectedFeeAmount = calcRebalanceFee(poolCash, poolManaged, poolConfig);

            const investmentFeeAdjustment = expectedFeeAmount.mul(poolConfig.targetPercentage).div(fp(1));
            const expectedInvestmentAmount = zeroFeeRebalanceAmount.sub(investmentFeeAdjustment);

            const expectedVaultRemovedAmount = expectedInvestmentAmount.add(expectedFeeAmount);

            await expectBalanceChange(() => assetManager.connect(lp).rebalance(poolId), tokens, [
              { account: assetManager.address, changes: { DAI: expectedInvestmentAmount } },
              { account: vault.address, changes: { DAI: expectedVaultRemovedAmount.mul(-1) } },
            ]);
          });

          it('pays the correct fee to the rebalancer', async () => {
            const { poolCash, poolManaged } = await assetManager.getPoolBalances(poolId);
            const expectedFeeAmount = calcRebalanceFee(poolCash, poolManaged, poolConfig);
            await expectBalanceChange(() => assetManager.connect(lp).rebalance(poolId), tokens, [
              { account: lp.address, changes: { DAI: expectedFeeAmount } },
            ]);
          });

          it('returns the pool to its target allocation', async () => {
            await assetManager.rebalance(poolId);
            expect(await assetManager.maxInvestableBalance(poolId)).to.be.eq(0);
          });

          it("update the pool's cash and managed balances correctly");
        });
      });
    });
  });

  describe('rebalanceAndSwap', () => {
    let swap: any;
    sharedBeforeEach(async () => {
      swap = {
        swaps: [
          {
            poolId: swapPoolId,
            assetInIndex: 0,
            assetOutIndex: 1,
            amount: 0,
            userData: '0x',
          },
        ],
        assets: [tokens.DAI.address, tokens.MKR.address],
        funds: {
          sender: assetManager.address,
          fromInternalBalance: false,
          recipient: lp.address,
          toInternalBalance: false,
        },
        limits: [MAX_INT256, -1],
        deadline: MAX_UINT256,
      };
    });

    context('when pool is above target investment level', () => {
      context('when pool is within the non-critical range', () => {
        const poolConfig = {
          targetPercentage: fp(0.5),
          upperCriticalPercentage: fp(1),
          lowerCriticalPercentage: fp(0.1),
          feePercentage: fp(0.1),
        };

        sharedBeforeEach(async () => {
          const poolController = lp; // TODO
          await assetManager.connect(poolController).setPoolConfig(poolId, poolConfig);

          const { poolCash } = await assetManager.getPoolBalances(poolId);
          await tokens.DAI.mint(assetManager.address, poolCash.mul(101).div(100));

          // should be overinvested
          const maxInvestableBalance = await assetManager.maxInvestableBalance(poolId);
          expect(maxInvestableBalance).to.lt(0);
        });

        it('transfers the expected number of tokens from the Vault', async () => {
          const { poolCash, poolManaged } = await assetManager.getPoolBalances(poolId);
          const expectedRebalanceAmount = calcRebalanceAmount(poolCash, poolManaged, poolConfig);

          await expectBalanceChange(() => assetManager.rebalanceAndSwap(poolId, swap), tokens, [
            { account: vault.address, changes: { DAI: expectedRebalanceAmount.mul(-1) } },
          ]);
        });

        it('returns the pool to its target allocation', async () => {
          await assetManager.rebalanceAndSwap(poolId, swap);
          expect(await assetManager.maxInvestableBalance(poolId)).to.be.eq(0);
        });

        it("doesn't perform the swap", async () => {
          const receipt = await (await assetManager.rebalanceAndSwap(poolId, swap)).wait();
          expectEvent.notEmitted(receipt, 'Swap');
        });
      });

      context('when pool is above critical investment level', () => {
        context('when fee percentage is zero', () => {
          const poolConfig = {
            targetPercentage: fp(0.5),
            upperCriticalPercentage: fp(1),
            lowerCriticalPercentage: fp(0.1),
            feePercentage: fp(0),
          };
          sharedBeforeEach(async () => {
            const poolController = lp; // TODO

            await assetManager.connect(poolController).setPoolConfig(poolId, poolConfig);
          });

          it('transfers the expected number of tokens from the Vault', async () => {
            const { poolCash, poolManaged } = await assetManager.getPoolBalances(poolId);
            const expectedRebalanceAmount = calcRebalanceAmount(poolCash, poolManaged, poolConfig);

            await expectBalanceChange(() => assetManager.rebalanceAndSwap(poolId, swap), tokens, [
              { account: assetManager.address, changes: { DAI: expectedRebalanceAmount } },
              { account: vault.address, changes: { DAI: expectedRebalanceAmount.mul(-1) } },
            ]);
          });

          it('returns the pool to its target allocation', async () => {
            await assetManager.rebalanceAndSwap(poolId, swap);
            expect(await assetManager.maxInvestableBalance(poolId)).to.be.eq(0);
          });

          it("doesn't perform the swap", async () => {
            const receipt = await (await assetManager.rebalanceAndSwap(poolId, swap)).wait();
            expectEvent.notEmitted(receipt, 'Swap');
          });
        });

        context('when fee percentage is non-zero', () => {
          const poolConfig = {
            targetPercentage: fp(0.5),
            upperCriticalPercentage: fp(1),
            lowerCriticalPercentage: fp(0.1),
            feePercentage: fp(0.1),
          };

          sharedBeforeEach(async () => {
            const poolController = lp; // TODO

            await assetManager.connect(poolController).setPoolConfig(poolId, poolConfig);
          });

          it('transfers the expected number of tokens from the Vault');

          it("reverts if the funds aren't taken from the asset manager", async () => {
            const badSwap = {
              ...swap,
              funds: {
                sender: lp.address,
                fromInternalBalance: false,
                recipient: lp.address,
                toInternalBalance: false,
              },
            };
            await expect(assetManager.connect(lp).rebalanceAndSwap(poolId, badSwap)).to.be.revertedWith(
              'Asset Manager must be sender'
            );
          });

          it('reverts if the swap attempts to use a token other what is paid as a fee as a swap input', async () => {
            const badSwap = {
              ...swap,
              assets: [tokens.MKR.address, tokens.DAI.address],
            };
            await expect(assetManager.connect(lp).rebalanceAndSwap(poolId, badSwap)).to.be.revertedWith(
              "Must swap asset manager's token"
            );
          });

          it("reverts if the swap attempts to use the asset manager's internal balance", async () => {
            const badSwap = {
              ...swap,
              funds: {
                sender: assetManager.address,
                fromInternalBalance: true,
                recipient: lp.address,
                toInternalBalance: false,
              },
            };
            await expect(assetManager.connect(lp).rebalanceAndSwap(poolId, badSwap)).to.be.revertedWith(
              "Can't use Asset Manager's internal balance"
            );
          });

          it('transfers the expected number of tokens from the Vault', async () => {
            const { poolCash, poolManaged } = await assetManager.getPoolBalances(poolId);

            const expectedFeeAmount = calcRebalanceFee(poolCash, poolManaged, poolConfig);
            const investmentFeeAdjustment = expectedFeeAmount.mul(poolConfig.targetPercentage).div(fp(1));

            const zeroFeeRebalanceAmount = calcRebalanceAmount(poolCash, poolManaged, poolConfig);
            const expectedInvestmentAmount = zeroFeeRebalanceAmount.sub(investmentFeeAdjustment);

            // The fee does not feature in the DAI balance change of the vault as it is replaced during the swap
            await expectBalanceChange(() => assetManager.connect(lp).rebalanceAndSwap(poolId, swap), tokens, [
              { account: assetManager.address, changes: { DAI: expectedInvestmentAmount } },
              {
                account: vault.address,
                changes: {
                  DAI: expectedInvestmentAmount.mul(-1),
                  MKR: expectedFeeAmount.mul(-1),
                },
              },
            ]);
          });

          it('returns the pool to its target allocation', async () => {
            await assetManager.rebalanceAndSwap(poolId, swap);
            expect(await assetManager.maxInvestableBalance(poolId)).to.be.eq(0);
          });

          it('performs the expected swap', async () => {
            const { poolCash, poolManaged } = await assetManager.getPoolBalances(poolId);
            const expectedFeeAmount = calcRebalanceFee(poolCash, poolManaged, poolConfig);

            // Check that the expected swap occurs
            const receipt = await (await assetManager.rebalanceAndSwap(poolId, swap)).wait();
            expectEvent.inIndirectReceipt(receipt, vault.interface, 'Swap', {
              poolId: swapPoolId,
              tokenIn: tokens.DAI.address,
              tokenOut: tokens.MKR.address,
              amountIn: expectedFeeAmount,
              amountOut: expectedFeeAmount,
            });

            // Check that keeper holds expected number of tokens after swap
            expect(await tokens.MKR.balanceOf(lp.address)).to.be.eq(expectedFeeAmount);
          });

          it("update the pool's cash and managed balances correctly");
        });
      });
    });

    context('when pool is below target investment level', () => {
      const poolConfig = {
        targetPercentage: fp(0.5),
        upperCriticalPercentage: fp(1),
        lowerCriticalPercentage: fp(0.1),
        feePercentage: fp(0.1),
      };
      sharedBeforeEach(async () => {
        const poolController = lp; // TODO

        await assetManager.connect(poolController).setPoolConfig(poolId, poolConfig);
      });

      context('when pool is within critical range', () => {
        sharedBeforeEach(async () => {
          const poolController = lp; // TODO
          // Ensure that the pool is invested below its target level but above than critical level
          const targetInvestmentAmount = await assetManager.maxInvestableBalance(poolId);
          await assetManager.connect(poolController).capitalIn(poolId, targetInvestmentAmount.div(2));
        });

        it('transfers the expected number of tokens from the Vault', async () => {
          const { poolCash, poolManaged } = await assetManager.getPoolBalances(poolId);
          const expectedRebalanceAmount = calcRebalanceAmount(poolCash, poolManaged, poolConfig);

          await expectBalanceChange(() => assetManager.rebalanceAndSwap(poolId, swap), tokens, [
            { account: vault.address, changes: { DAI: expectedRebalanceAmount.mul(-1) } },
          ]);
        });

        it('returns the pool to its target allocation', async () => {
          await assetManager.rebalanceAndSwap(poolId, swap);
          expect(await assetManager.maxInvestableBalance(poolId)).to.be.eq(0);
        });

        it("doesn't perform the swap", async () => {
          const receipt = await (await assetManager.rebalanceAndSwap(poolId, swap)).wait();
          expectEvent.notEmitted(receipt, 'Swap');
        });
      });

      context('when pool is below critical investment level', () => {
        context('when fee percentage is zero', () => {
          sharedBeforeEach(async () => {
            const poolController = lp; // TODO

            await assetManager.connect(poolController).setPoolConfig(poolId, { ...poolConfig, feePercentage: 0 });
          });

          it('transfers the expected number of tokens from the Vault', async () => {
            const { poolCash, poolManaged } = await assetManager.getPoolBalances(poolId);
            const expectedRebalanceAmount = calcRebalanceAmount(poolCash, poolManaged, poolConfig);

            await expectBalanceChange(() => assetManager.rebalanceAndSwap(poolId, swap), tokens, [
              { account: assetManager.address, changes: { DAI: expectedRebalanceAmount } },
              { account: vault.address, changes: { DAI: expectedRebalanceAmount.mul(-1) } },
            ]);
          });

          it('returns the pool to its target allocation', async () => {
            await assetManager.rebalanceAndSwap(poolId, swap);
            expect(await assetManager.maxInvestableBalance(poolId)).to.be.eq(0);
          });

          it("doesn't perform the swap", async () => {
            const receipt = await (await assetManager.rebalanceAndSwap(poolId, swap)).wait();
            expectEvent.notEmitted(receipt, 'Swap');
          });
        });

        context('when fee percentage is non-zero', () => {
          const poolConfig = {
            targetPercentage: fp(0.5),
            upperCriticalPercentage: fp(1),
            lowerCriticalPercentage: fp(0.1),
            feePercentage: fp(0.1),
          };

          sharedBeforeEach(async () => {
            const poolController = lp; // TODO

            await assetManager.connect(poolController).setPoolConfig(poolId, poolConfig);
          });

          it("reverts if the funds aren't taken from the asset manager", async () => {
            const badSwap = {
              ...swap,
              funds: {
                sender: lp.address,
                fromInternalBalance: false,
                recipient: lp.address,
                toInternalBalance: false,
              },
            };
            await expect(assetManager.connect(lp).rebalanceAndSwap(poolId, badSwap)).to.be.revertedWith(
              'Asset Manager must be sender'
            );
          });

          it('reverts if the swap attempts to use a token other what is paid as a fee as a swap input', async () => {
            const badSwap = {
              ...swap,
              assets: [tokens.MKR.address, tokens.DAI.address],
            };
            await expect(assetManager.connect(lp).rebalanceAndSwap(poolId, badSwap)).to.be.revertedWith(
              "Must swap asset manager's token"
            );
          });

          it("reverts if the swap attempts to use the asset manager's internal balance", async () => {
            const badSwap = {
              ...swap,
              funds: {
                sender: assetManager.address,
                fromInternalBalance: true,
                recipient: lp.address,
                toInternalBalance: false,
              },
            };
            await expect(assetManager.connect(lp).rebalanceAndSwap(poolId, badSwap)).to.be.revertedWith(
              "Can't use Asset Manager's internal balance"
            );
          });

          it('transfers the expected number of tokens from the Vault', async () => {
            const { poolCash, poolManaged } = await assetManager.getPoolBalances(poolId);

            const expectedFeeAmount = calcRebalanceFee(poolCash, poolManaged, poolConfig);
            const investmentFeeAdjustment = expectedFeeAmount.mul(poolConfig.targetPercentage).div(fp(1));

            const zeroFeeRebalanceAmount = calcRebalanceAmount(poolCash, poolManaged, poolConfig);
            const expectedInvestmentAmount = zeroFeeRebalanceAmount.sub(investmentFeeAdjustment);

            // The fee does not feature in the DAI balance change of the vault as it is replaced during the swap
            await expectBalanceChange(() => assetManager.connect(lp).rebalanceAndSwap(poolId, swap), tokens, [
              { account: assetManager.address, changes: { DAI: expectedInvestmentAmount } },
              {
                account: vault.address,
                changes: {
                  DAI: expectedInvestmentAmount.mul(-1),
                  MKR: expectedFeeAmount.mul(-1),
                },
              },
            ]);
          });

          it('returns the pool to its target allocation', async () => {
            await assetManager.rebalanceAndSwap(poolId, swap);
            expect(await assetManager.maxInvestableBalance(poolId)).to.be.eq(0);
          });

          it('performs the expected swap', async () => {
            const { poolCash, poolManaged } = await assetManager.getPoolBalances(poolId);
            const expectedFeeAmount = calcRebalanceFee(poolCash, poolManaged, poolConfig);

            // Check that the expected swap occurs
            const receipt = await (await assetManager.rebalanceAndSwap(poolId, swap)).wait();
            expectEvent.inIndirectReceipt(receipt, vault.interface, 'Swap', {
              poolId: swapPoolId,
              tokenIn: tokens.DAI.address,
              tokenOut: tokens.MKR.address,
              amountIn: expectedFeeAmount,
              amountOut: expectedFeeAmount,
            });

            // Check that keeper holds expected number of tokens after swap
            expect(await tokens.MKR.balanceOf(lp.address)).to.be.eq(expectedFeeAmount);
          });
        });
      });
    });
  });
});
