import { ethers } from 'hardhat';
import { expect } from 'chai';
import { BigNumber, Contract } from 'ethers';
import { SignerWithAddress } from '@nomiclabs/hardhat-ethers/dist/src/signer-with-address';

import * as expectEvent from '../../helpers/expectEvent';
import { expectEqualWithError } from '../../helpers/relativeError';
import {
  calculateInvariant,
  calcOutGivenIn,
  calcInGivenOut,
  calculateOneTokenAccumulatedSwapFees,
} from '../../helpers/math/stable';

import { deploy } from '../../../lib/helpers/deploy';
import { GeneralPool } from '../../../lib/helpers/pools';
import { bn, fp, decimal } from '../../../lib/helpers/numbers';
import { MAX_UINT256, ZERO_ADDRESS } from '../../../lib/helpers/constants';
import { encodeExitStablePool, encodeJoinStablePool } from '../../../lib/helpers/stablePoolEncoding';
import { deploySortedTokens, deployTokens, TokenList } from '../../../lib/helpers/tokens';

describe('StablePool', function () {
  let authorizer: Contract, vault: Contract, factory: Contract;
  let tokenList: TokenList, tokens: Array<Contract>;
  let admin: SignerWithAddress, lp: SignerWithAddress;
  let trader: SignerWithAddress, beneficiary: SignerWithAddress, other: SignerWithAddress;

  const POOL_SWAP_FEE = fp(0.01);

  const SYMBOLS = ['DAI', 'MKR', 'SNX', 'BAT'];
  const INITIAL_BALANCES = [bn(10e18), bn(11e18), bn(12e18), bn(13e18)];

  before('setup signers', async () => {
    [, admin, lp, trader, beneficiary, other] = await ethers.getSigners();
    authorizer = await deploy('Authorizer', { args: [admin.address] });
  });

  beforeEach('deploy tokens', async () => {
    vault = await deploy('Vault', { args: [authorizer.address] });
    factory = await deploy('StablePoolFactory', { args: [vault.address] });

    tokenList = await deploySortedTokens(SYMBOLS, [18, 18, 18, 18]);
    tokens = Object.values(tokenList);

    for (const token of tokens) {
      await token.mint(lp.address, bn(100e18));
      await token.connect(lp).approve(vault.address, MAX_UINT256);

      await token.mint(trader.address, bn(100e18));
      await token.connect(trader).approve(vault.address, MAX_UINT256);
    }
  });

  context('for a 1 token pool', () => {
    it('reverts if there is a single token', async () => {
      const poolTokens = tokens.map((token) => token.address).slice(0, 1);
      await expect(
        deploy('StablePool', {
          args: [vault.address, 'Balancer Pool Token', 'BPT', poolTokens, 0, 0],
        })
      ).to.be.revertedWith('MIN_TOKENS');
    });
  });

  context('for a 2 token pool', () => {
    itBehavesAsStablePool(2);
  });

  context('for a 3 token pool', () => {
    itBehavesAsStablePool(3);
  });

  context('for a too-many token pool', () => {
    it('reverts if there are too many tokens', async () => {
      // The maximum number of tokens is 16
      const manyTokens = await deployTokens(
        Array(17)
          .fill('TK')
          .map((v, i) => `${v}${i}`),
        Array(17).fill(18)
      );
      const poolTokens = Object.values(manyTokens).map((token) => token.address);

      await expect(
        deploy('StablePool', {
          args: [vault.address, 'Balancer Pool Token', 'BPT', poolTokens, 0, 0],
        })
      ).to.be.revertedWith('MAX_TOKENS');
    });
  });

  function itBehavesAsStablePool(numberOfTokens: number) {
    let poolTokens: string[];

    const ZEROS = Array(numberOfTokens).fill(bn(0));
    const poolAmplification = bn(100e18);
    const poolInitialBalances = INITIAL_BALANCES.slice(0, numberOfTokens);

    async function deployPool({
      tokens,
      amplification,
      swapFee,
      fromFactory,
    }: {
      tokens?: string[];
      amplification?: BigNumber;
      swapFee?: BigNumber;
      fromFactory?: boolean;
    }) {
      tokens = tokens ?? [];
      amplification = amplification ?? poolAmplification;
      swapFee = swapFee ?? POOL_SWAP_FEE;
      fromFactory = fromFactory ?? false;

      if (fromFactory) {
        const receipt = await (
          await factory.create('Balancer Pool Token', 'BPT', tokens, amplification, swapFee)
        ).wait();

        const event = expectEvent.inReceipt(receipt, 'PoolCreated');
        return ethers.getContractAt('StablePool', event.args.pool);
      } else {
        return deploy('StablePool', {
          args: [vault.address, 'Balancer Pool Token', 'BPT', tokens, amplification, swapFee],
        });
      }
    }

    beforeEach('define pool tokens', () => {
      poolTokens = tokens.map((token) => token.address).slice(0, numberOfTokens);
    });

    describe('creation', () => {
      context('when the creation succeeds', () => {
        let pool: Contract;

        beforeEach('deploy pool from factory', async () => {
          // Deploy from the Pool factory to test that it works properly
          pool = await deployPool({ tokens: poolTokens, fromFactory: true });
        });

        it('sets the vault', async () => {
          expect(await pool.getVault()).to.equal(vault.address);
        });

        it('uses general specialization', async () => {
          const poolId = await pool.getPoolId();
          expect(await vault.getPool(poolId)).to.have.members([pool.address, GeneralPool]);
        });

        it('registers tokens in the vault', async () => {
          const poolId = await pool.getPoolId();

          const { balances, tokens } = await vault.getPoolTokens(poolId);
          expect(tokens).to.have.members(poolTokens);
          expect(balances).to.deep.equal(ZEROS);
        });

        it('initializes the asset managers', async () => {
          const poolId = await pool.getPoolId();

          for (const token of poolTokens) {
            expect(await vault.getPoolAssetManager(poolId, token)).to.equal(ZERO_ADDRESS);
          }
        });

        it('starts with no BPT', async () => {
          expect(await pool.totalSupply()).to.deep.equal(0);
        });

        it('sets amplification', async () => {
          expect(await pool.getAmplification()).to.deep.equal(poolAmplification);
        });

        it('sets swap fee', async () => {
          expect(await pool.getSwapFee()).to.equal(POOL_SWAP_FEE);
        });

        it('sets the name', async () => {
          expect(await pool.name()).to.equal('Balancer Pool Token');
        });

        it('sets the symbol', async () => {
          expect(await pool.symbol()).to.equal('BPT');
        });

        it('sets the decimals', async () => {
          expect(await pool.decimals()).to.equal(18);
        });
      });

      context('when the creation fails', () => {
        it('reverts if there are repeated tokens', async () => {
          const tokens = new Array(numberOfTokens).fill(poolTokens[0]);

          await expect(deployPool({ tokens })).to.be.revertedWith('TOKEN_ALREADY_REGISTERED');
        });

        it('reverts if the swap fee is too high', async () => {
          const swapFee = fp(0.1).add(1);

          await expect(deployPool({ tokens: poolTokens, swapFee })).to.be.revertedWith('MAX_SWAP_FEE');
        });

        it('reverts if amplification coefficient is too high', async () => {
          const highAmp = bn(5000).mul(bn(10e18));

          await expect(deployPool({ tokens: poolTokens, amplification: highAmp })).to.be.revertedWith('MAX_AMP');
        });

        it('reverts if amplification coefficient is too low', async () => {
          const lowAmp = bn(10);

          await expect(deployPool({ tokens: poolTokens, amplification: lowAmp })).to.be.revertedWith('MIN_AMP');
        });
      });
    });

    describe('onJoinPool', () => {
      let pool: Contract;
      let poolId: string;

      beforeEach(async () => {
        //Use a mock vault
        vault = await deploy('MockVault', { args: [] });
        pool = await deployPool({ tokens: poolTokens });
        poolId = await pool.getPoolId();
      });

      it('fails if caller is not the vault', async () => {
        await expect(
          pool.connect(lp).onJoinPool(poolId, lp.address, other.address, [0], 0, 0, '0x')
        ).to.be.revertedWith('CALLER_NOT_VAULT');
      });

      it.skip('fails if wrong pool id'); // if Pools can only register themselves, this is unnecessary

      it('fails if no user data', async () => {
        await expect(vault.connect(lp).callJoinPool(pool.address, poolId, beneficiary.address, ZEROS, 0, '0x')).to.be
          .reverted;

        //NOTE
        //If use `to.be.be.revertedWith('Transaction reverted without a reason'), hardhat throws:
        // `AssertionError: Expected transaction to be reverted with Transaction reverted
        // without a reason, but other exception was thrown: Error: Transaction reverted
        //and Hardhat couldn't infer the reason. Please report this to help us improve Hardhat.`
      });

      it('fails if wrong user data', async () => {
        const wrongUserData = ethers.utils.defaultAbiCoder.encode(['address'], [lp.address]);

        await expect(
          vault.connect(lp).callJoinPool(pool.address, poolId, beneficiary.address, ZEROS, 0, 0, wrongUserData)
        ).to.be.reverted;

        //NOTE
        //Same problem with `revertedWith` as before
      });

      context('initialization', () => {
        let initialJoinUserData: string;

        beforeEach(async () => {
          initialJoinUserData = encodeJoinStablePool({ kind: 'Init', amountsIn: poolInitialBalances });
        });

        it('grants the invariant amount of BPT', async () => {
          const invariant = bn(calculateInvariant(poolAmplification, poolInitialBalances).toFixed(0));

          const receipt = await (
            await vault.callJoinPool(pool.address, poolId, beneficiary.address, ZEROS, 0, 0, initialJoinUserData)
          ).wait();

          const { amountsIn, dueProtocolFeeAmounts } = expectEvent.inReceipt(receipt, 'PoolJoined').args;

          // Amounts in should be the same as initial ones
          expect(amountsIn).to.deep.equal(poolInitialBalances);

          // Protocol fees should be zero
          expect(dueProtocolFeeAmounts).to.deep.equal(ZEROS);

          // Initial balances should equal invariant
          const bpt = await pool.balanceOf(beneficiary.address);
          expectEqualWithError(bpt, invariant, 0.001);
        });

        it('fails if already initialized', async () => {
          await vault.callJoinPool(pool.address, poolId, beneficiary.address, ZEROS, 0, 0, initialJoinUserData);

          await expect(
            vault.callJoinPool(
              pool.address,
              poolId,
              beneficiary.address,
              poolInitialBalances,
              0,
              0,
              initialJoinUserData
            )
          ).to.be.be.revertedWith('UNHANDLED_JOIN_KIND');
        });
      });

      context('join exact tokens in for BPT out', () => {
        it('fails if not initialized', async () => {
          const joinUserData = encodeJoinStablePool({ kind: 'AllTokensInForExactBPTOut', bptAmountOut: 0 });
          await expect(
            vault.callJoinPool(pool.address, poolId, beneficiary.address, ZEROS, 0, 0, joinUserData)
          ).to.be.be.revertedWith('UNINITIALIZED');
        });

        context('once initialized', () => {
          beforeEach(async () => {
            const initialJoinUserData = encodeJoinStablePool({ kind: 'Init', amountsIn: poolInitialBalances });
            await vault.callJoinPool(pool.address, poolId, beneficiary.address, ZEROS, 0, 0, initialJoinUserData);
          });

          it('grants exact BPT', async () => {
            const previousBPT = await pool.balanceOf(beneficiary.address);

            const bptAmountOut = bn(10e18);
            const joinUserData = encodeJoinStablePool({ kind: 'AllTokensInForExactBPTOut', bptAmountOut });

            const receipt = await (
              await vault
                .connect(lp)
                .callJoinPool(pool.address, poolId, beneficiary.address, poolInitialBalances, 0, 0, joinUserData)
            ).wait();

            const { dueProtocolFeeAmounts } = expectEvent.inReceipt(receipt, 'PoolJoined').args;

            // Protocol fees should be zero
            expect(dueProtocolFeeAmounts).to.deep.equal(ZEROS);

            const newBPT = await pool.balanceOf(beneficiary.address);
            expect(newBPT.sub(previousBPT)).to.equal(bptAmountOut);
          });
        });
      });
    });

    describe('onExitPool', () => {
      let pool: Contract;
      let poolId: string;

      beforeEach(async () => {
        //Use a mock vault
        vault = await deploy('MockVault', { args: [] });
        pool = await deployPool({ tokens: poolTokens });
        poolId = await pool.getPoolId();

        const initialJoinUserData = encodeJoinStablePool({ kind: 'Init', amountsIn: poolInitialBalances });
        await vault.callJoinPool(pool.address, poolId, lp.address, ZEROS, 0, 0, initialJoinUserData);
      });

      it('fails if caller is not the vault', async () => {
        await expect(
          pool.connect(lp).onExitPool(poolId, beneficiary.address, other.address, [0], 0, 0, '0x')
        ).to.be.revertedWith('CALLER_NOT_VAULT');
      });

      it.skip('fails if wrong pool id'); // if Pools can only register themselves, this is unnecessary

      it('fails if no user data', async () => {
        await expect(
          vault
            .connect(lp)
            .callExitPool(pool.address, poolId, beneficiary.address, poolInitialBalances, ZEROS, 0, 0, '0x')
        ).to.be.be.reverted;
      });

      it('fails if wrong user data', async () => {
        const wrongUserData = ethers.utils.defaultAbiCoder.encode(['address'], [lp.address]);

        await expect(
          vault
            .connect(lp)
            .callExitPool(pool.address, poolId, beneficiary.address, poolInitialBalances, 0, 0, wrongUserData)
        ).to.be.be.reverted;
      });

      context('exit exact BPT in for all tokens out', () => {
        it('grants all tokens for exact bpt', async () => {
          // Exit with half of BPT
          const prevBPT = await pool.balanceOf(lp.address);
          const exitUserData = encodeExitStablePool({ kind: 'ExactBPTInForAllTokensOut', bptAmountIn: prevBPT.div(2) });

          const receipt = await (
            await vault
              .connect(lp)
              .callExitPool(pool.address, poolId, beneficiary.address, poolInitialBalances, 0, 0, exitUserData)
          ).wait();

          const { amountsOut, dueProtocolFeeAmounts } = expectEvent.inReceipt(receipt, 'PoolExited').args;

          // Protocol fees should be zero
          expect(dueProtocolFeeAmounts).to.deep.equal(ZEROS);

          //All balances are extracted
          for (let i = 0; i < poolTokens.length; ++i) {
            expectEqualWithError(amountsOut[i], poolInitialBalances[i].div(2), 0.001);
          }

          expectEqualWithError(await pool.balanceOf(lp.address), prevBPT.div(2), 0.001);
        });

        it('fully exit', async () => {
          const prevBPT = await pool.balanceOf(lp.address);
          const exitUserData = encodeExitStablePool({ kind: 'ExactBPTInForAllTokensOut', bptAmountIn: prevBPT });

          const receipt = await (
            await vault
              .connect(lp)
              .callExitPool(pool.address, poolId, beneficiary.address, poolInitialBalances, 0, 0, exitUserData)
          ).wait();

          const { amountsOut, dueProtocolFeeAmounts } = expectEvent.inReceipt(receipt, 'PoolExited').args;

          // Protocol fees should be zero
          expect(dueProtocolFeeAmounts).to.deep.equal(ZEROS);

          //All balances are extracted
          expect(amountsOut).to.deep.equal(poolInitialBalances);

          expect(await pool.balanceOf(lp.address)).to.equal(0);
        });
      });
    });

    describe('swapRequests', () => {
      let pool: Contract;
      let poolId: string;

      let swapRequestData: {
        poolId: string;
        from: string;
        to: string;
        tokenIn: string;
        tokenOut: string;
        latestBlockNumberUsed: number;
        userData: string;
      };

      beforeEach('set default swapRequest data', async () => {
        pool = await deployPool({ tokens: poolTokens });
        poolId = await pool.getPoolId();

        swapRequestData = {
          poolId,
          from: other.address,
          to: other.address,
          tokenIn: tokenList.DAI.address,
          tokenOut: tokenList.MKR.address,
          latestBlockNumberUsed: 0,
          userData: '0x',
        };
      });

      context('given in', () => {
        it('calculates amount out', async () => {
          const amountIn = bn(1e18);

          const result = await pool.callStatic.onSwapGivenIn(
            { ...swapRequestData, amountIn },
            poolInitialBalances,
            0,
            1
          );

          const expectedAmountOut = calcOutGivenIn(poolAmplification, poolInitialBalances, 0, 1, amountIn);
          expectEqualWithError(result, bn(expectedAmountOut), 0.1);
        });

        it('reverts when querying invalid indexes', async () => {
          await expect(
            pool.onSwapGivenIn({ ...swapRequestData, amountIn: bn(1e18) }, poolInitialBalances, 10, 1)
          ).to.be.revertedWith('OUT_OF_BOUNDS');

          await expect(
            pool.onSwapGivenIn({ ...swapRequestData, amountIn: bn(1e18) }, poolInitialBalances, 0, 10)
          ).to.be.revertedWith('OUT_OF_BOUNDS');
        });
      });

      context('given out', () => {
        it('calculates amount in', async () => {
          const amountOut = bn(1e18);

          const result = await pool.callStatic.onSwapGivenOut(
            { ...swapRequestData, amountOut },
            poolInitialBalances,
            0,
            1
          );

          const expectedAmountIn = calcInGivenOut(poolAmplification, poolInitialBalances, 0, 1, amountOut);
          expectEqualWithError(result, bn(expectedAmountIn), 0.1);
        });

        it('reverts when querying invalid indexes', async () => {
          await expect(
            pool.onSwapGivenOut({ ...swapRequestData, amountOut: bn(1e18) }, poolInitialBalances, 10, 1)
          ).to.be.revertedWith('OUT_OF_BOUNDS');

          await expect(
            pool.onSwapGivenOut({ ...swapRequestData, amountOut: bn(1e18) }, poolInitialBalances, 0, 10)
          ).to.be.revertedWith('OUT_OF_BOUNDS');
        });
      });
    });

    describe('protocol swap fees', () => {
      let pool: Contract;
      let poolId: string;

      const protocolSwapFee = fp(0.1); // 10 %

      beforeEach('deploy and join pool', async () => {
        //Use a mock vault
        vault = await deploy('MockVault', { args: [] });
        pool = await deployPool({ tokens: poolTokens });
        poolId = await pool.getPoolId();

        const initialJoinUserData = encodeJoinStablePool({ kind: 'Init', amountsIn: poolInitialBalances });
        await vault.callJoinPool(pool.address, poolId, lp.address, ZEROS, 0, protocolSwapFee, initialJoinUserData);
      });

      const expectJoinProtocolSwapFeeEqualWithError = async (
        bptAmountOut: BigNumber,
        initialBalances: BigNumber[],
        expectedDueProtocolFeeAmounts: BigNumber[]
      ): Promise<BigNumber[]> => {
        const joinUserData = encodeJoinStablePool({ kind: 'AllTokensInForExactBPTOut', bptAmountOut: bptAmountOut });

        const receipt = await (
          await vault
            .connect(lp)
            .callJoinPool(pool.address, poolId, lp.address, initialBalances, 0, protocolSwapFee, joinUserData)
        ).wait();

        const { amountsIn, dueProtocolFeeAmounts } = expectEvent.inReceipt(receipt, 'PoolJoined').args;

        for (let index = 0; index < dueProtocolFeeAmounts.length; index++) {
          expectEqualWithError(dueProtocolFeeAmounts[index], expectedDueProtocolFeeAmounts[index], 0.001);
        }

        return initialBalances.map((balance: BigNumber, index: number) =>
          balance.add(amountsIn[index]).sub(dueProtocolFeeAmounts[index])
        );
      };

      const expectExitProtocolSwapFeeEqualWithError = async (
        bptAmountIn: BigNumber,
        initialBalances: BigNumber[],
        expectedDueProtocolFeeAmounts: BigNumber[]
      ): Promise<BigNumber[]> => {
        const exitUserData = encodeExitStablePool({ kind: 'ExactBPTInForAllTokensOut', bptAmountIn: bptAmountIn });

        const receipt = await (
          await vault
            .connect(lp)
            .callExitPool(pool.address, poolId, lp.address, initialBalances, 0, protocolSwapFee, exitUserData)
        ).wait();

        const { amountsOut, dueProtocolFeeAmounts } = expectEvent.inReceipt(receipt, 'PoolExited').args;

        for (let index = 0; index < dueProtocolFeeAmounts.length; index++) {
          expectEqualWithError(dueProtocolFeeAmounts[index], expectedDueProtocolFeeAmounts[index], 0.001);
        }

        return initialBalances.map((balance: BigNumber, index: number) =>
          balance.sub(amountsOut[index]).sub(dueProtocolFeeAmounts[index])
        );
      };

      it('joins and exits do not accumulate fees', async () => {
        let newBalances = await expectJoinProtocolSwapFeeEqualWithError(bn(10e18), poolInitialBalances, ZEROS);

        newBalances = await expectJoinProtocolSwapFeeEqualWithError(bn(10e18), newBalances, ZEROS);

        newBalances = await expectExitProtocolSwapFeeEqualWithError(bn(10e18), newBalances, ZEROS);

        newBalances = await expectExitProtocolSwapFeeEqualWithError(bn(10e18), newBalances, ZEROS);

        await expectJoinProtocolSwapFeeEqualWithError(bn(10e18), newBalances, ZEROS);
      });

      context('with swap', () => {
        let currentBalances: BigNumber[];
        let expectedDueProtocolFeeAmounts: BigNumber[];

        beforeEach(async () => {
          const previousBlockHash = (await ethers.provider.getBlock('latest')).hash;
          const paidTokenIndex = decimal(previousBlockHash).mod(numberOfTokens).toNumber();

          const lastInvariant = calculateInvariant(poolAmplification, poolInitialBalances);
          currentBalances = poolInitialBalances.map((balance) => balance.mul(2)); //twice the initial balances

          const feeAmount = calculateOneTokenAccumulatedSwapFees(
            poolAmplification,
            currentBalances,
            bn(lastInvariant),
            paidTokenIndex
          );

          const protocolFeeAmount = bn(feeAmount).mul(protocolSwapFee).div(bn(1e18));
          expectedDueProtocolFeeAmounts = Object.assign([], ZEROS);
          expectedDueProtocolFeeAmounts[paidTokenIndex] = protocolFeeAmount;
        });

        it('pays swap protocol fees on join', async () => {
          await expectJoinProtocolSwapFeeEqualWithError(bn(10e18), currentBalances, expectedDueProtocolFeeAmounts);
        });

        it('pays swap protocol fees on exit', async () => {
          await expectExitProtocolSwapFeeEqualWithError(bn(10e18), currentBalances, expectedDueProtocolFeeAmounts);
        });
      });
    });
  }
});
