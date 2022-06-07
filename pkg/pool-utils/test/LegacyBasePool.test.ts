import { ethers } from 'hardhat';
import { expect } from 'chai';
import { BigNumber, Contract } from 'ethers';
import { SignerWithAddress } from '@nomiclabs/hardhat-ethers/dist/src/signer-with-address';

import { deploy } from '@balancer-labs/v2-helpers/src/contract';
import { Account } from '@balancer-labs/v2-helpers/src/models/types/types';
import { actionId } from '@balancer-labs/v2-helpers/src/models/misc/actions';
import { BigNumberish, fp } from '@balancer-labs/v2-helpers/src/numbers';
import { JoinPoolRequest, ExitPoolRequest, PoolSpecialization } from '@balancer-labs/balancer-js';
import { advanceTime, DAY, MONTH } from '@balancer-labs/v2-helpers/src/time';
import { ANY_ADDRESS, ZERO_ADDRESS } from '@balancer-labs/v2-helpers/src/constants';
import { WeightedPoolEncoder } from '@balancer-labs/balancer-js';
import * as expectEvent from '@balancer-labs/v2-helpers/src/test/expectEvent';
import TokenList from '@balancer-labs/v2-helpers/src/models/tokens/TokenList';
import TypesConverter from '@balancer-labs/v2-helpers/src/models/types/TypesConverter';
import { defaultAbiCoder } from '@ethersproject/abi';
import { expectBalanceChange } from '@balancer-labs/v2-helpers/src/test/tokenBalance';
import { random } from 'lodash';

describe('LegacyBasePool', function () {
  let admin: SignerWithAddress,
    poolOwner: SignerWithAddress,
    deployer: SignerWithAddress,
    assetManager: SignerWithAddress,
    other: SignerWithAddress;
  let authorizer: Contract, vault: Contract;
  let tokens: TokenList;

  const MIN_SWAP_FEE_PERCENTAGE = fp(0.000001);
  const MAX_SWAP_FEE_PERCENTAGE = fp(0.1);
  const DELEGATE_OWNER = '0xBA1BA1ba1BA1bA1bA1Ba1BA1ba1BA1bA1ba1ba1B';

  const PAUSE_WINDOW_DURATION = MONTH * 3;
  const BUFFER_PERIOD_DURATION = MONTH;

  before(async () => {
    [, admin, poolOwner, deployer, assetManager, other] = await ethers.getSigners();
  });

  sharedBeforeEach(async () => {
    authorizer = await deploy('v2-vault/TimelockAuthorizer', { args: [admin.address, ZERO_ADDRESS, MONTH] });
    vault = await deploy('v2-vault/Vault', { args: [authorizer.address, ZERO_ADDRESS, 0, 0] });
    tokens = await TokenList.create(['DAI', 'MKR', 'SNX'], { sorted: true });
  });

  function deployBasePool(
    params: {
      tokens?: TokenList | string[];
      assetManagers?: string[];
      swapFeePercentage?: BigNumberish;
      pauseWindowDuration?: number;
      bufferPeriodDuration?: number;
      owner?: Account;
      from?: SignerWithAddress;
    } = {}
  ): Promise<Contract> {
    let {
      tokens: poolTokens,
      assetManagers,
      swapFeePercentage,
      pauseWindowDuration,
      bufferPeriodDuration,
      owner,
    } = params;
    if (!poolTokens) poolTokens = tokens;
    if (!assetManagers) assetManagers = Array(poolTokens.length).fill(ZERO_ADDRESS);
    if (!swapFeePercentage) swapFeePercentage = MIN_SWAP_FEE_PERCENTAGE;
    if (!pauseWindowDuration) pauseWindowDuration = 0;
    if (!bufferPeriodDuration) bufferPeriodDuration = 0;
    if (!owner) owner = ZERO_ADDRESS;

    return deploy('MockLegacyBasePool', {
      from: params.from,
      args: [
        vault.address,
        PoolSpecialization.GeneralPool,
        'Balancer Pool Token',
        'BPT',
        Array.isArray(poolTokens) ? poolTokens : poolTokens.addresses,
        assetManagers,
        swapFeePercentage,
        pauseWindowDuration,
        bufferPeriodDuration,
        TypesConverter.toAddress(owner),
      ],
    });
  }

  describe('deployment', () => {
    let assetManagers: string[];

    beforeEach(() => {
      assetManagers = [assetManager.address, ...Array(tokens.length - 1).fill(ZERO_ADDRESS)];
    });

    it('registers a pool in the vault', async () => {
      const pool = await deployBasePool({
        tokens,
        assetManagers,
      });
      const poolId = await pool.getPoolId();

      const [poolAddress, poolSpecialization] = await vault.getPool(poolId);
      expect(poolAddress).to.equal(pool.address);
      expect(poolSpecialization).to.equal(PoolSpecialization.GeneralPool);

      const { tokens: poolTokens } = await vault.getPoolTokens(poolId);
      expect(poolTokens).to.have.same.members(tokens.addresses);

      poolTokens.forEach(async (token: string, i: number) => {
        const { assetManager } = await vault.getPoolTokenInfo(poolId, token);
        expect(assetManager).to.equal(assetManagers[i]);
      });
    });

    it('reverts if the tokens are not sorted', async () => {
      await expect(deployBasePool({ tokens: tokens.addresses.reverse() })).to.be.revertedWith('UNSORTED_ARRAY');
    });
  });

  describe('authorizer', () => {
    let pool: Contract;

    sharedBeforeEach('deploy pool', async () => {
      pool = await deployBasePool();
    });

    it('uses the authorizer of the vault', async () => {
      expect(await pool.getAuthorizer()).to.equal(authorizer.address);
    });

    it('tracks authorizer changes in the vault', async () => {
      const action = await actionId(vault, 'setAuthorizer');
      await authorizer.connect(admin).grantPermissions([action], admin.address, [ANY_ADDRESS]);

      await vault.connect(admin).setAuthorizer(other.address);

      expect(await pool.getAuthorizer()).to.equal(other.address);
    });

    describe('action identifiers', () => {
      const selector = '0x12345678';

      context('with same pool creator', () => {
        it('pools share action identifiers', async () => {
          const pool = await deployBasePool({ tokens, from: deployer });
          const otherPool = await deployBasePool({ tokens, from: deployer });

          expect(await pool.getActionId(selector)).to.equal(await otherPool.getActionId(selector));
        });
      });

      context('with different pool creators', () => {
        it('pools have unique action identifiers', async () => {
          const pool = await deployBasePool({ tokens, from: deployer });
          const otherPool = await deployBasePool({ tokens, from: other });

          expect(await pool.getActionId(selector)).to.not.equal(await otherPool.getActionId(selector));
        });
      });
    });
  });

  describe('swap fee', () => {
    context('initialization', () => {
      it('has an initial swap fee', async () => {
        const swapFeePercentage = fp(0.003);
        const pool = await deployBasePool({ swapFeePercentage });

        expect(await pool.getSwapFeePercentage()).to.equal(swapFeePercentage);
      });
    });

    context('set swap fee percentage', () => {
      let pool: Contract;
      let sender: SignerWithAddress;

      function itSetsSwapFeePercentage() {
        context('when the new swap fee percentage is within bounds', () => {
          const newSwapFeePercentage = MAX_SWAP_FEE_PERCENTAGE.sub(1);

          it('can change the swap fee', async () => {
            await pool.connect(sender).setSwapFeePercentage(newSwapFeePercentage);

            expect(await pool.getSwapFeePercentage()).to.equal(newSwapFeePercentage);
          });

          it('emits an event', async () => {
            const receipt = await (await pool.connect(sender).setSwapFeePercentage(newSwapFeePercentage)).wait();

            expectEvent.inReceipt(receipt, 'SwapFeePercentageChanged', { swapFeePercentage: newSwapFeePercentage });
          });
        });

        context('when the new swap fee percentage is above the maximum', () => {
          const swapFeePercentage = MAX_SWAP_FEE_PERCENTAGE.add(1);

          it('reverts', async () => {
            await expect(pool.connect(sender).setSwapFeePercentage(swapFeePercentage)).to.be.revertedWith(
              'MAX_SWAP_FEE_PERCENTAGE'
            );
          });
        });

        context('when the new swap fee percentage is below the minimum', () => {
          const swapFeePercentage = MIN_SWAP_FEE_PERCENTAGE.sub(1);

          it('reverts', async () => {
            await expect(pool.connect(sender).setSwapFeePercentage(swapFeePercentage)).to.be.revertedWith(
              'MIN_SWAP_FEE_PERCENTAGE'
            );
          });
        });
      }

      function itRevertsWithUnallowedSender() {
        it('reverts', async () => {
          await expect(pool.connect(sender).setSwapFeePercentage(MIN_SWAP_FEE_PERCENTAGE)).to.be.revertedWith(
            'SENDER_NOT_ALLOWED'
          );
        });
      }

      context('with a delegated owner', () => {
        const owner = DELEGATE_OWNER;

        sharedBeforeEach('deploy pool', async () => {
          pool = await deployBasePool({ swapFeePercentage: fp(0.01), owner });
        });

        beforeEach('set sender', () => {
          sender = other;
        });

        context('when the sender has the set fee permission in the authorizer', () => {
          sharedBeforeEach('grant permission', async () => {
            const action = await actionId(pool, 'setSwapFeePercentage');
            await authorizer.connect(admin).grantPermissions([action], sender.address, [ANY_ADDRESS]);
          });

          itSetsSwapFeePercentage();
        });

        context('when the sender does not have the set fee permission in the authorizer', () => {
          itRevertsWithUnallowedSender();
        });
      });

      context('with an owner', () => {
        let owner: SignerWithAddress;

        sharedBeforeEach('deploy pool', async () => {
          owner = poolOwner;
          pool = await deployBasePool({ swapFeePercentage: fp(0.01), owner });
        });

        context('when the sender is the owner', () => {
          beforeEach(() => {
            sender = owner;
          });

          itSetsSwapFeePercentage();
        });

        context('when the sender is not the owner', () => {
          beforeEach(() => {
            sender = other;
          });

          context('when the sender does not have the set fee permission in the authorizer', () => {
            itRevertsWithUnallowedSender();
          });

          context('when the sender has the set fee permission in the authorizer', () => {
            sharedBeforeEach(async () => {
              const action = await actionId(pool, 'setSwapFeePercentage');
              await authorizer.connect(admin).grantPermissions([action], sender.address, [ANY_ADDRESS]);
            });

            itRevertsWithUnallowedSender();
          });
        });
      });
    });
  });

  describe('pause', () => {
    let pool: Contract;
    const PAUSE_WINDOW_DURATION = MONTH * 3;
    const BUFFER_PERIOD_DURATION = MONTH;

    let sender: SignerWithAddress;

    describe('set paused', () => {
      function itCanPause() {
        it('can pause', async () => {
          await pool.connect(sender).pause();

          const { paused } = await pool.getPausedState();
          expect(paused).to.be.true;
        });

        it('can unpause', async () => {
          await pool.connect(sender).pause();
          await pool.connect(sender).unpause();

          const { paused } = await pool.getPausedState();
          expect(paused).to.be.false;
        });

        it('cannot unpause after the pause window', async () => {
          await advanceTime(PAUSE_WINDOW_DURATION + DAY);
          await expect(pool.connect(sender).pause()).to.be.revertedWith('PAUSE_WINDOW_EXPIRED');
        });
      }

      function itRevertsWithUnallowedSender() {
        it('reverts', async () => {
          await expect(pool.connect(sender).pause()).to.be.revertedWith('SENDER_NOT_ALLOWED');
          await expect(pool.connect(sender).unpause()).to.be.revertedWith('SENDER_NOT_ALLOWED');
        });
      }

      context('with a delegated owner', () => {
        const owner = DELEGATE_OWNER;

        sharedBeforeEach('deploy pool', async () => {
          pool = await deployBasePool({
            pauseWindowDuration: PAUSE_WINDOW_DURATION,
            bufferPeriodDuration: BUFFER_PERIOD_DURATION,
            owner,
          });
        });

        beforeEach('set sender', () => {
          sender = other;
        });

        context('when the sender does not have the pause permission in the authorizer', () => {
          itRevertsWithUnallowedSender();
        });

        context('when the sender has the pause permission in the authorizer', () => {
          sharedBeforeEach('grant permission', async () => {
            const pauseAction = await actionId(pool, 'pause');
            const unpauseAction = await actionId(pool, 'unpause');
            await authorizer
              .connect(admin)
              .grantPermissions([pauseAction, unpauseAction], sender.address, [ANY_ADDRESS, ANY_ADDRESS]);
          });

          itCanPause();
        });
      });

      context('with an owner', () => {
        let owner: SignerWithAddress;

        sharedBeforeEach('deploy pool', async () => {
          owner = poolOwner;
          pool = await deployBasePool({
            pauseWindowDuration: PAUSE_WINDOW_DURATION,
            bufferPeriodDuration: BUFFER_PERIOD_DURATION,
            owner,
          });
        });

        context('when the sender is the owner', () => {
          beforeEach('set sender', () => {
            sender = owner;
          });

          itRevertsWithUnallowedSender();
        });

        context('when the sender is not the owner', () => {
          beforeEach('set sender', () => {
            sender = other;
          });

          context('when the sender does not have the pause permission in the authorizer', () => {
            itRevertsWithUnallowedSender();
          });

          context('when the sender has the pause permission in the authorizer', () => {
            sharedBeforeEach(async () => {
              const pauseAction = await actionId(pool, 'pause');
              const unpauseAction = await actionId(pool, 'unpause');
              await authorizer
                .connect(admin)
                .grantPermissions([pauseAction, unpauseAction], sender.address, [ANY_ADDRESS, ANY_ADDRESS]);
            });

            itCanPause();
          });
        });
      });
    });
  });

  describe('recovery mode', () => {
    let pool: Contract;
    let sender: SignerWithAddress;

    function itCanEnterRecoveryMode() {
      it('can enter recovery mode', async () => {
        await pool.connect(sender).enterRecoveryMode();

        const recoveryMode = await pool.inRecoveryMode();
        expect(recoveryMode).to.be.true;
      });

      it('entering recovery mode emits an event', async () => {
        const tx = await pool.connect(sender).enterRecoveryMode();
        const receipt = await tx.wait();
        expectEvent.inReceipt(receipt, 'RecoveryModeStateChanged', { recoveryMode: true });
      });

      it('entering recovery mode does not pause the pool', async () => {
        await pool.connect(sender).enterRecoveryMode();

        const recoveryMode = await pool.inRecoveryMode();
        expect(recoveryMode).to.be.true;
        const { paused } = await pool.getPausedState();
        expect(paused).to.be.false;
      });

      it('can exit recovery mode', async () => {
        await pool.connect(sender).enterRecoveryMode();
        await pool.connect(sender).exitRecoveryMode();

        const recoveryMode = await pool.inRecoveryMode();
        expect(recoveryMode).to.be.false;
      });

      it('exiting recovery mode emits an event', async () => {
        await pool.connect(sender).enterRecoveryMode();
        const tx = await pool.connect(sender).exitRecoveryMode();
        const receipt = await tx.wait();
        expectEvent.inReceipt(receipt, 'RecoveryModeStateChanged', { recoveryMode: false });

        const recoveryMode = await pool.inRecoveryMode();
        expect(recoveryMode).to.be.false;
      });

      it('reverts when calling functions in the wrong mode', async () => {
        await expect(pool.notCallableInRecovery()).to.not.be.reverted;
        await expect(pool.onlyCallableInRecovery()).to.be.revertedWith('NOT_IN_RECOVERY_MODE');

        await pool.connect(sender).enterRecoveryMode();

        await expect(pool.doNotCallInRecovery()).to.be.revertedWith('IN_RECOVERY_MODE');
        await expect(pool.notCallableInRecovery()).to.be.revertedWith('IN_RECOVERY_MODE');
        await expect(pool.onlyCallableInRecovery()).to.not.be.reverted;
      });
    }

    function itRevertsWithUnallowedSender() {
      it('reverts', async () => {
        await expect(pool.connect(sender).enterRecoveryMode()).to.be.revertedWith('SENDER_NOT_ALLOWED');
        await expect(pool.connect(sender).exitRecoveryMode()).to.be.revertedWith('SENDER_NOT_ALLOWED');
      });
    }

    context('with a delegated owner', () => {
      const owner = DELEGATE_OWNER;

      sharedBeforeEach('deploy pool', async () => {
        pool = await deployBasePool({
          pauseWindowDuration: PAUSE_WINDOW_DURATION,
          bufferPeriodDuration: BUFFER_PERIOD_DURATION,
          owner,
        });
      });

      beforeEach('set sender', () => {
        sender = other;
      });

      context('when the sender does not have the recovery mode permission in the authorizer', () => {
        itRevertsWithUnallowedSender();
      });

      context('when the sender has the recovery mode permission in the authorizer', () => {
        sharedBeforeEach('grant permission', async () => {
          const enterRecoveryAction = await actionId(pool, 'enterRecoveryMode');
          const exitRecoveryAction = await actionId(pool, 'exitRecoveryMode');
          await authorizer
            .connect(admin)
            .grantPermissions([enterRecoveryAction, exitRecoveryAction], sender.address, [ANY_ADDRESS, ANY_ADDRESS]);
        });

        itCanEnterRecoveryMode();
      });
    });

    context('with an owner', () => {
      let owner: SignerWithAddress;

      sharedBeforeEach('deploy pool', async () => {
        owner = poolOwner;
        pool = await deployBasePool({
          pauseWindowDuration: PAUSE_WINDOW_DURATION,
          bufferPeriodDuration: BUFFER_PERIOD_DURATION,
          owner,
        });
      });

      context('when the sender is the owner', () => {
        beforeEach('set sender', () => {
          sender = owner;
        });

        itRevertsWithUnallowedSender();
      });

      context('when the sender is not the owner', () => {
        beforeEach('set sender', () => {
          sender = other;
        });

        context('when the sender does not have the recovery mode permission in the authorizer', () => {
          itRevertsWithUnallowedSender();
        });

        context('when the sender has the recovery mode permission in the authorizer', () => {
          sharedBeforeEach('grant permission', async () => {
            const enterRecoveryAction = await actionId(pool, 'enterRecoveryMode');
            const exitRecoveryAction = await actionId(pool, 'exitRecoveryMode');
            await authorizer
              .connect(admin)
              .grantPermissions([enterRecoveryAction, exitRecoveryAction], sender.address, [ANY_ADDRESS, ANY_ADDRESS]);
          });

          itCanEnterRecoveryMode();
        });
      });
    });

    context('exit', () => {
      const RECOVERY_MODE_EXIT_KIND = 255;
      let poolId: string;
      let initialBalances: BigNumber[];
      let pool: Contract;

      sharedBeforeEach('deploy and initialize pool', async () => {
        initialBalances = Array(tokens.length).fill(fp(1000));
        pool = await deployBasePool();
        poolId = await pool.getPoolId();

        const request: JoinPoolRequest = {
          assets: tokens.addresses,
          maxAmountsIn: initialBalances,
          userData: WeightedPoolEncoder.joinInit(initialBalances),
          fromInternalBalance: false,
        };

        await tokens.mint({ to: poolOwner, amount: fp(1000 + random(1000)) });
        await tokens.approve({ from: poolOwner, to: vault });

        await vault.connect(poolOwner).joinPool(poolId, poolOwner.address, poolOwner.address, request);
      });

      context('when not in recovery mode', () => {
        it('the recovery mode exit reverts', async () => {
          const preExitBPT = await pool.balanceOf(poolOwner.address);
          const exitBPT = preExitBPT.div(3);

          const request: ExitPoolRequest = {
            assets: tokens.addresses,
            minAmountsOut: Array(tokens.length).fill(0),
            userData: defaultAbiCoder.encode(['uint256', 'uint256'], [RECOVERY_MODE_EXIT_KIND, exitBPT]),
            toInternalBalance: false,
          };

          await expect(
            vault.connect(poolOwner).exitPool(poolId, poolOwner.address, poolOwner.address, request)
          ).to.be.revertedWith('NOT_IN_RECOVERY_MODE');
        });
      });

      context('when in recovery mode', () => {
        sharedBeforeEach('enter recovery mode', async () => {
          const enterRecoveryAction = await actionId(pool, 'enterRecoveryMode');
          const exitRecoveryAction = await actionId(pool, 'exitRecoveryMode');
          await authorizer
            .connect(admin)
            .grantPermissions([enterRecoveryAction, exitRecoveryAction], admin.address, [ANY_ADDRESS, ANY_ADDRESS]);

          await pool.connect(admin).enterRecoveryMode();
        });

        it('the recovery mode exit can be used', async () => {
          const preExitBPT = await pool.balanceOf(poolOwner.address);
          const exitBPT = preExitBPT.div(3);

          const request: ExitPoolRequest = {
            assets: tokens.addresses,
            minAmountsOut: Array(tokens.length).fill(0),
            userData: defaultAbiCoder.encode(['uint256', 'uint256'], [RECOVERY_MODE_EXIT_KIND, exitBPT]),
            toInternalBalance: false,
          };

          // The sole BPT holder is the owner, so they own the initial balances
          const expectedChanges = tokens.reduce(
            (changes, token, i) => ({ ...changes, [token.symbol]: ['very-near', initialBalances[i].div(3)] }),
            {}
          );
          await expectBalanceChange(
            () => vault.connect(poolOwner).exitPool(poolId, poolOwner.address, poolOwner.address, request),
            tokens,
            { account: poolOwner, changes: expectedChanges }
          );

          // Exit BPT was burned
          const afterExitBalance = await pool.balanceOf(poolOwner.address);
          expect(afterExitBalance).to.equal(preExitBPT.sub(exitBPT));
        });

        it('other join kinds can be used', async () => {
          const OTHER_JOIN_KIND = 1;

          const request: JoinPoolRequest = {
            assets: tokens.addresses,
            maxAmountsIn: Array(tokens.length).fill(0),
            userData: defaultAbiCoder.encode(['uint256'], [OTHER_JOIN_KIND]),
            fromInternalBalance: false,
          };

          const receipt = await (
            await vault.connect(poolOwner).joinPool(poolId, poolOwner.address, poolOwner.address, request)
          ).wait();

          expectEvent.inIndirectReceipt(receipt, pool.interface, 'InnerOnJoinPoolCalled');
        });

        it('other exit kinds can be used', async () => {
          const OTHER_EXIT_KIND = 1;

          const request: ExitPoolRequest = {
            assets: tokens.addresses,
            minAmountsOut: Array(tokens.length).fill(0),
            userData: defaultAbiCoder.encode(['uint256'], [OTHER_EXIT_KIND]),
            toInternalBalance: false,
          };

          const receipt = await (
            await vault.connect(poolOwner).exitPool(poolId, poolOwner.address, poolOwner.address, request)
          ).wait();

          expectEvent.inIndirectReceipt(receipt, pool.interface, 'InnerOnExitPoolCalled');
        });
      });
    });
  });

  describe('pause and recovery mode interactions', () => {
    let pool: Contract;
    let sender: SignerWithAddress;

    function pauseAndRecoveryDoNotInteract() {
      it('pause does not enter recovery mode', async () => {
        await pool.connect(sender).pause();

        const { paused } = await pool.getPausedState();
        expect(paused).to.be.true;
        expect(await pool.inRecoveryMode()).to.be.false;
      });

      it('unpause does not exit recovery mode', async () => {
        const enterRecoveryAction = await actionId(pool, 'enterRecoveryMode');
        await authorizer.connect(admin).grantPermissions([enterRecoveryAction], sender.address, [ANY_ADDRESS]);

        await pool.connect(sender).enterRecoveryMode();
        await pool.connect(sender).pause();
        await pool.connect(sender).unpause();

        const { paused } = await pool.getPausedState();
        expect(paused).to.be.false;
        expect(await pool.inRecoveryMode()).to.be.true;
      });
    }

    function itRevertsWithUnallowedSender() {
      it('reverts', async () => {
        await expect(pool.connect(sender).enterRecoveryMode()).to.be.revertedWith('SENDER_NOT_ALLOWED');
        await expect(pool.connect(sender).exitRecoveryMode()).to.be.revertedWith('SENDER_NOT_ALLOWED');
      });
    }

    context('with a delegated owner', () => {
      const owner = DELEGATE_OWNER;

      sharedBeforeEach('deploy pool', async () => {
        pool = await deployBasePool({
          pauseWindowDuration: PAUSE_WINDOW_DURATION,
          bufferPeriodDuration: BUFFER_PERIOD_DURATION,
          owner,
        });
      });

      beforeEach('set sender', () => {
        sender = other;
      });

      context('when the sender does not have the pause/recovery mode permission in the authorizer', () => {
        itRevertsWithUnallowedSender();
      });

      context('when the sender has the pause/recovery mode permission in the authorizer', () => {
        sharedBeforeEach('grant permission', async () => {
          const pauseAction = await actionId(pool, 'pause');
          const unpauseAction = await actionId(pool, 'unpause');
          const enterRecoveryAction = await actionId(pool, 'pause');
          const exitRecoveryAction = await actionId(pool, 'unpause');
          await authorizer
            .connect(admin)
            .grantPermissions([pauseAction, unpauseAction, enterRecoveryAction, exitRecoveryAction], sender.address, [
              ANY_ADDRESS,
              ANY_ADDRESS,
              ANY_ADDRESS,
              ANY_ADDRESS,
            ]);
        });

        pauseAndRecoveryDoNotInteract();
      });
    });

    context('with an owner', () => {
      let owner: SignerWithAddress;

      sharedBeforeEach('deploy pool', async () => {
        owner = poolOwner;
        pool = await deployBasePool({
          pauseWindowDuration: PAUSE_WINDOW_DURATION,
          bufferPeriodDuration: BUFFER_PERIOD_DURATION,
          owner,
        });
      });

      context('when the sender is the owner', () => {
        beforeEach('set sender', () => {
          sender = owner;
        });

        itRevertsWithUnallowedSender();
      });

      context('when the sender is not the owner', () => {
        beforeEach('set sender', () => {
          sender = other;
        });

        context('when the sender does not have the pause/recovery mode permission in the authorizer', () => {
          itRevertsWithUnallowedSender();
        });

        context('when the sender has the pause/recovery mode permission in the authorizer', () => {
          sharedBeforeEach(async () => {
            const pauseAction = await actionId(pool, 'pause');
            const unpauseAction = await actionId(pool, 'unpause');
            const enterRecoveryAction = await actionId(pool, 'pause');
            const exitRecoveryAction = await actionId(pool, 'unpause');
            await authorizer
              .connect(admin)
              .grantPermissions([pauseAction, unpauseAction, enterRecoveryAction, exitRecoveryAction], sender.address, [
                ANY_ADDRESS,
                ANY_ADDRESS,
                ANY_ADDRESS,
                ANY_ADDRESS,
              ]);
          });

          pauseAndRecoveryDoNotInteract();
        });
      });
    });
  });

  describe('misc data', () => {
    let pool: Contract;
    const swapFeePercentage = fp(0.02);

    sharedBeforeEach('deploy pool', async () => {
      pool = await deployBasePool({ swapFeePercentage });
    });

    it('stores the swap fee pct in the most-significant 64 bits', async () => {
      expect(await pool.getSwapFeePercentage()).to.equal(swapFeePercentage);

      const swapFeeHex = swapFeePercentage.toHexString().slice(2); // remove 0x
      const expectedMiscData = swapFeeHex.padStart(16, '0').padEnd(64, '0'); // pad first 8 bytes and fill with zeros

      const miscData = await pool.getMiscData();
      expect(miscData).to.be.equal(`0x${expectedMiscData}`);
    });

    it('can store up-to 192 bits of extra data', async () => {
      const swapFeeHex = `0x${swapFeePercentage.toHexString().slice(2).padStart(16, '0')}`;

      const assertMiscData = async (data: string): Promise<void> => {
        await pool.setMiscData(data);
        const expectedMiscData = `${swapFeeHex}${data.slice(18)}`; // 0x + 16 bits
        expect(await pool.getMiscData()).to.be.equal(expectedMiscData);
      };

      for (let i = 0; i <= 64; i++) {
        const data = `0x${'1'.repeat(i).padStart(64, '0')}`;
        await assertMiscData(data);
      }
    });
  });

  describe('recovery mode exit', () => {
    const RECOVERY_MODE_USER_DATA = 255;
    let poolId: string;
    let initialBalances: BigNumber[];
    let pool: Contract;

    sharedBeforeEach('deploy and initialize pool', async () => {
      initialBalances = Array(tokens.length).fill(fp(1000));
      pool = await deployBasePool();
      poolId = await pool.getPoolId();

      const request: JoinPoolRequest = {
        assets: tokens.addresses,
        maxAmountsIn: initialBalances,
        userData: WeightedPoolEncoder.joinInit(initialBalances),
        fromInternalBalance: false,
      };

      await tokens.mint({ to: poolOwner, amount: fp(1000) });
      await tokens.approve({ from: poolOwner, to: vault });

      await vault.connect(poolOwner).joinPool(poolId, poolOwner.address, poolOwner.address, request);
    });

    context('in recovery mode', () => {
      sharedBeforeEach('grant permission', async () => {
        const enterRecoveryAction = await actionId(pool, 'enterRecoveryMode');
        const exitRecoveryAction = await actionId(pool, 'exitRecoveryMode');
        await authorizer
          .connect(admin)
          .grantPermissions([enterRecoveryAction, exitRecoveryAction], admin.address, [ANY_ADDRESS, ANY_ADDRESS]);
      });

      it('enter recovery mode, and exit the pool', async () => {
        await pool.connect(admin).enterRecoveryMode();

        expect(await pool.inRecoveryMode()).to.be.true;

        let bptBalance = await pool.balanceOf(poolOwner.address);
        // Owner has BPT tokens
        expect(bptBalance).to.gt(0);
        // Token balances are now zero, after joining
        let tokenBalances = await Promise.all(tokens.map(async (token) => await token.balanceOf(poolOwner)));
        expect(tokenBalances).to.be.zeros;

        const exitUserData = defaultAbiCoder.encode(['uint256', 'uint256'], [RECOVERY_MODE_USER_DATA, bptBalance]);

        const request: ExitPoolRequest = {
          assets: tokens.addresses,
          minAmountsOut: Array(tokens.length).fill(0),
          userData: exitUserData,
          toInternalBalance: false,
        };

        await vault.connect(poolOwner).exitPool(poolId, poolOwner.address, poolOwner.address, request);

        // BPT balance should now be zero
        bptBalance = await pool.balanceOf(poolOwner.address);
        expect(bptBalance).to.be.zero;

        // Vault balances should be near zero (not exactly, because of minimum BPT)
        tokenBalances = await Promise.all(tokens.map(async (token) => await token.balanceOf(vault)));
        for (const balance of tokenBalances) {
          expect(balance).to.lt(fp(0.0001));
        }

        // Token balances should be restored to the owner
        tokenBalances = await Promise.all(tokens.map(async (token) => await token.balanceOf(poolOwner)));
        for (let i = 0; i < tokenBalances.length; i++) {
          expect(tokenBalances[i]).to.equalWithError(initialBalances[i], 0.000001);
        }
      });
    });
  });
});
