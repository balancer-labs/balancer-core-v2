import { ethers } from 'hardhat';
import { expect } from 'chai';
import { BigNumber, Contract, ContractReceipt } from 'ethers';
import { SignerWithAddress } from '@nomiclabs/hardhat-ethers/dist/src/signer-with-address';

import * as expectEvent from '@balancer-labs/v2-helpers/src/test/expectEvent';
import TokenList from '@balancer-labs/v2-helpers/src/models/tokens/TokenList';
import { advanceTime, DAY, MONTH } from '@balancer-labs/v2-helpers/src/time';
import { actionId } from '@balancer-labs/v2-helpers/src/models/misc/actions';
import { deploy, deployedAt } from '@balancer-labs/v2-helpers/src/contract';
import { JoinPoolRequest, ExitPoolRequest, PoolSpecialization, WeightedPoolEncoder } from '@balancer-labs/balancer-js';
import { BigNumberish, fp } from '@balancer-labs/v2-helpers/src/numbers';
import { ANY_ADDRESS, DELEGATE_OWNER, ZERO_ADDRESS } from '@balancer-labs/v2-helpers/src/constants';
import { Account } from '@balancer-labs/v2-helpers/src/models/types/types';
import TypesConverter from '@balancer-labs/v2-helpers/src/models/types/TypesConverter';
import { random } from 'lodash';
import { defaultAbiCoder } from 'ethers/lib/utils';
import Vault from '@balancer-labs/v2-helpers/src/models/vault/Vault';
import { sharedBeforeEach } from '@balancer-labs/v2-common/sharedBeforeEach';

describe('BasePool', function () {
  let admin: SignerWithAddress, poolOwner: SignerWithAddress, deployer: SignerWithAddress, other: SignerWithAddress;
  let authorizer: Contract, vault: Contract;
  let tokens: TokenList;

  const MIN_SWAP_FEE_PERCENTAGE = fp(0.000001);
  const MAX_SWAP_FEE_PERCENTAGE = fp(0.1);

  const PAUSE_WINDOW_DURATION = MONTH * 3;
  const BUFFER_PERIOD_DURATION = MONTH;

  before(async () => {
    [, admin, poolOwner, deployer, other] = await ethers.getSigners();
  });

  sharedBeforeEach(async () => {
    ({ instance: vault, authorizer } = await Vault.create({ admin }));
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
    if (!pauseWindowDuration) pauseWindowDuration = MONTH;
    if (!bufferPeriodDuration) bufferPeriodDuration = 0;
    if (!owner) owner = ZERO_ADDRESS;

    return deploy('MockBasePool', {
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
      await authorizer.connect(admin).grantPermission(action, admin.address, ANY_ADDRESS);

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

  describe('protocol fees', () => {
    let pool: Contract;

    sharedBeforeEach(async () => {
      pool = await deployBasePool();
    });

    it('skips zero value mints', async () => {
      const tx = await pool.payProtocolFees(0);

      expectEvent.notEmitted(await tx.wait(), 'Transfer');
    });

    it('mints bpt to the protocol fee collector', async () => {
      const feeCollector = await pool.getProtocolFeesCollector();

      const balanceBefore = await pool.balanceOf(feeCollector);
      await pool.payProtocolFees(fp(42));
      const balanceAfter = await pool.balanceOf(feeCollector);

      expect(balanceAfter.sub(balanceBefore)).to.equal(fp(42));
    });
  });

  describe('swap fee', () => {
    context('initialization', () => {
      it('has an initial swap fee', async () => {
        const swapFeePercentage = fp(0.003);
        const pool = await deployBasePool({ swapFeePercentage });

        expect(await pool['getSwapFeePercentage()']()).to.equal(swapFeePercentage);
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

            expect(await pool['getSwapFeePercentage()']()).to.equal(newSwapFeePercentage);
          });

          it('emits an event', async () => {
            const receipt = await (await pool.connect(sender).setSwapFeePercentage(newSwapFeePercentage)).wait();

            expectEvent.inReceipt(receipt, 'SwapFeePercentageChanged', { swapFeePercentage: newSwapFeePercentage });
          });

          context('when paused', () => {
            sharedBeforeEach('pause pool', async () => {
              const action = await actionId(pool, 'pause');
              await authorizer.connect(admin).grantPermission(action, admin.address, ANY_ADDRESS);
              await pool.connect(admin).pause();
            });

            it('reverts', async () => {
              await expect(pool.connect(sender).setSwapFeePercentage(newSwapFeePercentage)).to.be.revertedWith(
                'PAUSED'
              );
            });
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
            await authorizer.connect(admin).grantPermission(action, sender.address, ANY_ADDRESS);
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
              await authorizer.connect(admin).grantPermission(action, sender.address, ANY_ADDRESS);
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

    function itCanPause() {
      it('can pause', async () => {
        await pool.connect(sender).pause();

        const { paused } = await pool.getPausedState();
        expect(paused).to.be.true;
      });

      context('when paused', () => {
        let poolId: string;
        let initialBalances: BigNumber[];

        sharedBeforeEach('deploy and initialize pool', async () => {
          initialBalances = Array(tokens.length).fill(fp(1000));
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

        sharedBeforeEach('pause pool', async () => {
          await pool.connect(sender).pause();
        });

        it('joins revert', async () => {
          const OTHER_JOIN_KIND = 1;

          const request: JoinPoolRequest = {
            assets: tokens.addresses,
            maxAmountsIn: Array(tokens.length).fill(0),
            userData: defaultAbiCoder.encode(['uint256'], [OTHER_JOIN_KIND]),
            fromInternalBalance: false,
          };

          await expect(
            vault.connect(poolOwner).joinPool(poolId, poolOwner.address, poolOwner.address, request)
          ).to.be.revertedWith('PAUSED');
        });

        it('exits revert', async () => {
          const OTHER_EXIT_KIND = 1;

          const request: ExitPoolRequest = {
            assets: tokens.addresses,
            minAmountsOut: Array(tokens.length).fill(0),
            userData: defaultAbiCoder.encode(['uint256'], [OTHER_EXIT_KIND]),
            toInternalBalance: false,
          };

          await expect(
            vault.connect(poolOwner).exitPool(poolId, poolOwner.address, poolOwner.address, request)
          ).to.be.revertedWith('PAUSED');
        });
      });

      it('can unpause', async () => {
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
          await authorizer.connect(admin).grantPermission(pauseAction, sender.address, ANY_ADDRESS);
          await authorizer.connect(admin).grantPermission(unpauseAction, sender.address, ANY_ADDRESS);
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
            await authorizer.connect(admin).grantPermission(pauseAction, sender.address, ANY_ADDRESS);
            await authorizer.connect(admin).grantPermission(unpauseAction, sender.address, ANY_ADDRESS);
          });

          itCanPause();
        });
      });
    });
  });

  describe('recovery mode', () => {
    let pool: Contract;
    let sender: SignerWithAddress;

    function itCanEnableRecoveryMode() {
      it('can enable recovery mode', async () => {
        await pool.connect(sender).enableRecoveryMode();

        const recoveryMode = await pool.inRecoveryMode();
        expect(recoveryMode).to.be.true;
      });

      it('enabling recovery mode emits an event', async () => {
        const tx = await pool.connect(sender).enableRecoveryMode();
        const receipt = await tx.wait();
        expectEvent.inReceipt(receipt, 'RecoveryModeStateChanged', { enabled: true });
      });

      context('when recovery mode is enabled', () => {
        sharedBeforeEach('enable recovery mode', async () => {
          await pool.connect(sender).enableRecoveryMode();
        });

        it('can disable recovery mode', async () => {
          await pool.connect(sender).disableRecoveryMode();

          const recoveryMode = await pool.inRecoveryMode();
          expect(recoveryMode).to.be.false;
        });

        it('cannot enable recovery mode again', async () => {
          await expect(pool.connect(sender).enableRecoveryMode()).to.be.revertedWith('IN_RECOVERY_MODE');
        });

        it('disabling recovery mode emits an event', async () => {
          const tx = await pool.connect(sender).disableRecoveryMode();
          const receipt = await tx.wait();
          expectEvent.inReceipt(receipt, 'RecoveryModeStateChanged', { enabled: false });

          const recoveryMode = await pool.inRecoveryMode();
          expect(recoveryMode).to.be.false;
        });
      });

      context('when recovery mode is disabled', () => {
        it('cannot be disabled again', async () => {
          const recoveryMode = await pool.inRecoveryMode();
          expect(recoveryMode).to.be.false;

          await expect(pool.connect(sender).disableRecoveryMode()).to.be.revertedWith('NOT_IN_RECOVERY_MODE');
        });
      });

      it('reverts when calling functions in the wrong mode', async () => {
        await expect(pool.notCallableInRecovery()).to.not.be.reverted;
        await expect(pool.onlyCallableInRecovery()).to.be.revertedWith('NOT_IN_RECOVERY_MODE');

        await pool.connect(sender).enableRecoveryMode();

        await expect(pool.doNotCallInRecovery()).to.be.revertedWith('IN_RECOVERY_MODE');
        await expect(pool.notCallableInRecovery()).to.be.revertedWith('IN_RECOVERY_MODE');
        await expect(pool.onlyCallableInRecovery()).to.not.be.reverted;
      });
    }

    function itRevertsWithUnallowedSender() {
      it('reverts', async () => {
        await expect(pool.connect(sender).enableRecoveryMode()).to.be.revertedWith('SENDER_NOT_ALLOWED');
        await expect(pool.connect(sender).disableRecoveryMode()).to.be.revertedWith('SENDER_NOT_ALLOWED');
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

      it('stores the vault (in RecoveryMode contract)', async () => {
        expect(await pool.vault()).to.equal(vault.address);
      });

      context('when the sender does not have the recovery mode permission in the authorizer', () => {
        itRevertsWithUnallowedSender();
      });

      context('when the sender has the recovery mode permission in the authorizer', () => {
        sharedBeforeEach('grant permission', async () => {
          const enableRecoveryAction = await actionId(pool, 'enableRecoveryMode');
          const disableRecoveryAction = await actionId(pool, 'disableRecoveryMode');
          await authorizer.connect(admin).grantPermission(enableRecoveryAction, sender.address, ANY_ADDRESS);
          await authorizer.connect(admin).grantPermission(disableRecoveryAction, sender.address, ANY_ADDRESS);
        });

        itCanEnableRecoveryMode();
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
            const enableRecoveryAction = await actionId(pool, 'enableRecoveryMode');
            const disableRecoveryAction = await actionId(pool, 'disableRecoveryMode');
            await authorizer.connect(admin).grantPermission(enableRecoveryAction, sender.address, ANY_ADDRESS);
            await authorizer.connect(admin).grantPermission(disableRecoveryAction, sender.address, ANY_ADDRESS);
          });

          itCanEnableRecoveryMode();
        });
      });
    });

    context('exit', () => {
      const RECOVERY_MODE_EXIT_KIND = 255;
      let poolId: string;
      let initialBalances: BigNumber[];
      let pool: Contract;

      let normalJoin: () => Promise<ContractReceipt>;
      let normalExit: () => Promise<ContractReceipt>;

      const PROTOCOL_SWAP_FEE_PERCENTAGE = fp(0.3);

      sharedBeforeEach('deploy and initialize pool', async () => {
        initialBalances = Array(tokens.length).fill(fp(1000));
        pool = await deployBasePool({ pauseWindowDuration: MONTH });
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

      sharedBeforeEach('set a non-zero protocol swap fee percentage', async () => {
        const feesCollector = await deployedAt(
          'v2-vault/ProtocolFeesCollector',
          await vault.getProtocolFeesCollector()
        );

        await authorizer
          .connect(admin)
          .grantPermission(await actionId(feesCollector, 'setSwapFeePercentage'), admin.address, ANY_ADDRESS);

        await feesCollector.connect(admin).setSwapFeePercentage(PROTOCOL_SWAP_FEE_PERCENTAGE);

        expect(await feesCollector.getSwapFeePercentage()).to.equal(PROTOCOL_SWAP_FEE_PERCENTAGE);
      });

      before('prepare normal join and exit', () => {
        const OTHER_JOIN_KIND = 1;

        const joinRequest: JoinPoolRequest = {
          assets: tokens.addresses,
          maxAmountsIn: Array(tokens.length).fill(0),
          userData: defaultAbiCoder.encode(['uint256'], [OTHER_JOIN_KIND]),
          fromInternalBalance: false,
        };

        normalJoin = async () =>
          (await vault.connect(poolOwner).joinPool(poolId, poolOwner.address, poolOwner.address, joinRequest)).wait();

        const OTHER_EXIT_KIND = 1;

        const exitRequest: ExitPoolRequest = {
          assets: tokens.addresses,
          minAmountsOut: Array(tokens.length).fill(0),
          userData: defaultAbiCoder.encode(['uint256'], [OTHER_EXIT_KIND]),
          toInternalBalance: false,
        };

        normalExit = async () =>
          (await vault.connect(poolOwner).exitPool(poolId, poolOwner.address, poolOwner.address, exitRequest)).wait();
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

        describe('normal joins', () => {
          it('do not revert', async () => {
            await expect(normalJoin()).to.not.be.reverted;
          });

          it('receive the real protocol swap fee percentage value', async () => {
            const receipt = await normalJoin();
            expectEvent.inIndirectReceipt(receipt, pool.interface, 'InnerOnJoinPoolCalled', {
              protocolSwapFeePercentage: PROTOCOL_SWAP_FEE_PERCENTAGE,
            });
          });
        });

        describe('normal exits', () => {
          it('do not revert', async () => {
            await expect(normalExit()).to.not.be.reverted;
          });

          it('receive the real protocol swap value fee percentage value', async () => {
            const receipt = await normalExit();
            expectEvent.inIndirectReceipt(receipt, pool.interface, 'InnerOnExitPoolCalled', {
              protocolSwapFeePercentage: PROTOCOL_SWAP_FEE_PERCENTAGE,
            });
          });
        });
      });

      context('when in recovery mode', () => {
        sharedBeforeEach('enable recovery mode', async () => {
          const enableRecoveryAction = await actionId(pool, 'enableRecoveryMode');
          const disableRecoveryAction = await actionId(pool, 'disableRecoveryMode');
          await authorizer.connect(admin).grantPermission(enableRecoveryAction, admin.address, ANY_ADDRESS);
          await authorizer.connect(admin).grantPermission(disableRecoveryAction, admin.address, ANY_ADDRESS);

          await pool.connect(admin).enableRecoveryMode();
        });

        describe('normal joins', () => {
          it('do not revert', async () => {
            await expect(normalJoin()).to.not.be.reverted;
          });

          it('receive 0 as the protocol swap fee percentage value', async () => {
            const receipt = await normalJoin();
            expectEvent.inIndirectReceipt(receipt, pool.interface, 'InnerOnJoinPoolCalled', {
              protocolSwapFeePercentage: 0,
            });
          });
        });

        describe('normal exits', () => {
          it('do not revert', async () => {
            await expect(normalExit()).to.not.be.reverted;
          });

          it('receive 0 as the protocol swap fee percentage value', async () => {
            const receipt = await normalExit();
            expectEvent.inIndirectReceipt(receipt, pool.interface, 'InnerOnExitPoolCalled', {
              protocolSwapFeePercentage: 0,
            });
          });
        });

        function itExitsViaRecoveryModeCorrectly() {
          it('the recovery mode exit can be used', async () => {
            const preExitBPT = await pool.balanceOf(poolOwner.address);
            const exitBPT = preExitBPT.div(3);

            const request: ExitPoolRequest = {
              assets: tokens.addresses,
              minAmountsOut: Array(tokens.length).fill(0),
              userData: defaultAbiCoder.encode(['uint256', 'uint256'], [RECOVERY_MODE_EXIT_KIND, exitBPT]),
              toInternalBalance: false,
            };

            const totalSupply = await pool.totalSupply();
            const tx = await vault.connect(poolOwner).exitPool(poolId, poolOwner.address, poolOwner.address, request);
            expectEvent.inIndirectReceipt(await tx.wait(), pool.interface, 'RecoveryModeExit', {
              totalSupply,
              balances: initialBalances,
              bptAmountIn: exitBPT,
            });

            // Exit BPT was burned
            const afterExitBalance = await pool.balanceOf(poolOwner.address);
            expect(afterExitBalance).to.equal(preExitBPT.sub(exitBPT));
          });
        }

        itExitsViaRecoveryModeCorrectly();

        context('when paused', () => {
          sharedBeforeEach('pause pool', async () => {
            await authorizer.connect(admin).grantPermission(await actionId(pool, 'pause'), admin.address, ANY_ADDRESS);

            await pool.connect(admin).pause();
          });

          itExitsViaRecoveryModeCorrectly();
        });

        context('when _beforeSwapJoinExit() reverts', () => {
          sharedBeforeEach(async () => {
            await pool.setFailBeforeSwapJoinExit(true);
          });

          it('normal joins revert', async () => {
            await expect(normalJoin()).to.be.revertedWith('FAIL_BEFORE_SWAP_JOIN_EXIT');
          });

          it('normal exits revert', async () => {
            await expect(normalExit()).to.be.revertedWith('FAIL_BEFORE_SWAP_JOIN_EXIT');
          });

          itExitsViaRecoveryModeCorrectly();
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
      expect(await pool['getSwapFeePercentage()']()).to.equal(swapFeePercentage);

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
});
