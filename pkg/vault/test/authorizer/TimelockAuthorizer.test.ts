import { expect } from 'chai';
import { ethers } from 'hardhat';
import { Contract } from 'ethers';
import { SignerWithAddress } from '@nomiclabs/hardhat-ethers/dist/src/signer-with-address';

import * as expectEvent from '@balancer-labs/v2-helpers/src/test/expectEvent';
import TimelockAuthorizer from '@balancer-labs/v2-helpers/src/models/authorizer/TimelockAuthorizer';
import { deploy } from '@balancer-labs/v2-helpers/src/contract';
import { actionId } from '@balancer-labs/v2-helpers/src/models/misc/actions';
import { BigNumberish } from '@balancer-labs/v2-helpers/src/numbers';
import { ZERO_ADDRESS } from '@balancer-labs/v2-helpers/src/constants';
import { advanceTime, currentTimestamp, DAY } from '@balancer-labs/v2-helpers/src/time';
import { MAX_UINT256 } from '@balancer-labs/v2-helpers/src/constants';
import Vault from '@balancer-labs/v2-helpers/src/models/vault/Vault';

describe('TimelockAuthorizer', () => {
  let authorizer: TimelockAuthorizer, vault: Contract, authenticatedContract: Contract;
  let root: SignerWithAddress,
    nextRoot: SignerWithAddress,
    grantee: SignerWithAddress,
    canceler: SignerWithAddress,
    revoker: SignerWithAddress,
    other: SignerWithAddress,
    from: SignerWithAddress;

  before('setup signers', async () => {
    [, root, nextRoot, grantee, canceler, revoker, other] = await ethers.getSigners();
  });

  const GLOBAL_CANCELER_SCHEDULED_EXECUTION_ID = MAX_UINT256;

  const ACTION_1 = '0x0000000000000000000000000000000000000000000000000000000000000001';
  const ACTION_2 = '0x0000000000000000000000000000000000000000000000000000000000000002';
  const ACTIONS = [ACTION_1, ACTION_2];

  const WHERE_1 = ethers.Wallet.createRandom().address;
  const WHERE_2 = ethers.Wallet.createRandom().address;
  const WHERE = [WHERE_1, WHERE_2];

  const GENERAL_PERMISSION_SPECIFIER = TimelockAuthorizer.GENERAL_PERMISSION_SPECIFIER;
  const EVERYWHERE = TimelockAuthorizer.EVERYWHERE;
  const NOT_WHERE = ethers.Wallet.createRandom().address;

  const MINIMUM_EXECUTION_DELAY = 5 * DAY;

  sharedBeforeEach('deploy authorizer', async () => {
    let authorizerContract: Contract;

    ({ instance: vault, authorizer: authorizerContract } = await Vault.create({
      admin: root,
      nextAdmin: nextRoot.address,
    }));

    authorizer = new TimelockAuthorizer(authorizerContract, root);
    authenticatedContract = await deploy('MockAuthenticatedContract', { args: [vault.address] });
  });

  describe('granters', () => {
    describe('addGranter', () => {
      context('in a specific contract', () => {
        it('grantee can grant permission for that action only in that contract', async () => {
          await authorizer.addGranter(ACTION_1, grantee, WHERE_1, { from: root });

          expect(await authorizer.isGranter(ACTION_1, grantee, WHERE_1)).to.be.true;
          expect(await authorizer.isGranter(ACTION_1, grantee, WHERE_2)).to.be.false;
          expect(await authorizer.isGranter(ACTION_1, grantee, EVERYWHERE)).to.be.false;
        });

        it('grantee cannot grant permission for any other action anywhere', async () => {
          await authorizer.addGranter(ACTION_1, grantee, WHERE_1, { from: root });

          expect(await authorizer.isGranter(ACTION_2, grantee, WHERE_1)).to.be.false;
          expect(await authorizer.isGranter(ACTION_2, grantee, WHERE_2)).to.be.false;
          expect(await authorizer.isGranter(ACTION_2, grantee, EVERYWHERE)).to.be.false;
        });

        it('emits a GranterAdded event', async () => {
          const receipt = await (await authorizer.addGranter(ACTION_1, grantee, WHERE_1, { from: root })).wait();
          expectEvent.inReceipt(receipt, 'GranterAdded', {
            actionId: ACTION_1,
            account: grantee.address,
            where: WHERE_1,
          });
        });

        it('reverts if the grantee is already a granter', async () => {
          await authorizer.addGranter(ACTION_1, grantee, WHERE_1, { from: root });
          await expect(authorizer.addGranter(ACTION_1, grantee, WHERE_1, { from: root })).to.be.revertedWith(
            'ACCOUNT_IS_ALREADY_GRANTER'
          );
        });

        it('reverts if the grantee is already a global granter', async () => {
          await authorizer.addGranter(ACTION_1, grantee, EVERYWHERE, { from: root });
          await expect(authorizer.addGranter(ACTION_1, grantee, WHERE_1, { from: root })).to.be.revertedWith(
            'ACCOUNT_IS_ALREADY_GRANTER'
          );
        });

        it('reverts if the grantee is root', async () => {
          await expect(authorizer.addGranter(ACTION_1, root, WHERE_1, { from: root })).to.be.revertedWith(
            'ACCOUNT_IS_ALREADY_GRANTER'
          );
        });

        it('reverts if the caller is not root', async () => {
          await expect(authorizer.addGranter(ACTION_1, grantee, WHERE_1, { from: other })).to.be.revertedWith(
            'SENDER_IS_NOT_ROOT'
          );
        });
      });

      context('in any contract', () => {
        it('grantee can grant permission for that action in any contract', async () => {
          await authorizer.addGranter(ACTION_1, grantee, EVERYWHERE, { from: root });

          expect(await authorizer.isGranter(ACTION_1, grantee, WHERE_1)).to.be.true;
          expect(await authorizer.isGranter(ACTION_1, grantee, WHERE_2)).to.be.true;
          expect(await authorizer.isGranter(ACTION_1, grantee, EVERYWHERE)).to.be.true;
        });

        it('grantee cannot grant permission for any other action anywhere', async () => {
          await authorizer.addGranter(ACTION_1, grantee, EVERYWHERE, { from: root });

          expect(await authorizer.isGranter(ACTION_2, grantee, WHERE_1)).to.be.false;
          expect(await authorizer.isGranter(ACTION_2, grantee, WHERE_2)).to.be.false;
          expect(await authorizer.isGranter(ACTION_2, grantee, EVERYWHERE)).to.be.false;
        });

        it('emits a GranterAdded event', async () => {
          const receipt = await (await authorizer.addGranter(ACTION_1, grantee, EVERYWHERE, { from: root })).wait();
          expectEvent.inReceipt(receipt, 'GranterAdded', {
            actionId: ACTION_1,
            account: grantee.address,
            where: EVERYWHERE,
          });
        });

        it('does not revert if the grantee is already a granter in a specific contract', async () => {
          await authorizer.addGranter(ACTION_1, grantee, WHERE_1, { from: root });

          const receipt = await (await authorizer.addGranter(ACTION_1, grantee, EVERYWHERE, { from: root })).wait();
          expectEvent.inReceipt(receipt, 'GranterAdded', {
            actionId: ACTION_1,
            account: grantee.address,
            where: EVERYWHERE,
          });
        });

        it('reverts if the grantee is already a global granter', async () => {
          await authorizer.addGranter(ACTION_1, grantee, EVERYWHERE, { from: root });
          await expect(authorizer.addGranter(ACTION_1, grantee, EVERYWHERE, { from: root })).to.be.revertedWith(
            'ACCOUNT_IS_ALREADY_GRANTER'
          );
        });

        it('reverts if the grantee is root', async () => {
          await expect(authorizer.addGranter(ACTION_1, root, EVERYWHERE, { from: root })).to.be.revertedWith(
            'ACCOUNT_IS_ALREADY_GRANTER'
          );
        });

        it('reverts if the caller is not root', async () => {
          await expect(authorizer.addGranter(ACTION_1, grantee, EVERYWHERE, { from: other })).to.be.revertedWith(
            'SENDER_IS_NOT_ROOT'
          );
        });
      });
    });

    describe('removeGranter', () => {
      context('in a specific contract', () => {
        it('revokee cannot grant permission for that action anywhere', async () => {
          await authorizer.addGranter(ACTION_1, grantee, WHERE_1, { from: root });
          await authorizer.removeGranter(ACTION_1, grantee, WHERE_1, { from: root });

          expect(await authorizer.isGranter(ACTION_1, grantee, WHERE_1)).to.be.false;
          expect(await authorizer.isGranter(ACTION_1, grantee, WHERE_2)).to.be.false;
          expect(await authorizer.isGranter(ACTION_1, grantee, EVERYWHERE)).to.be.false;
        });

        it('revokee cannot grant permission for any other action', async () => {
          await authorizer.addGranter(ACTION_1, grantee, WHERE_1, { from: root });
          await authorizer.removeGranter(ACTION_1, grantee, WHERE_1, { from: root });

          expect(await authorizer.isGranter(ACTION_2, grantee, WHERE_1)).to.be.false;
          expect(await authorizer.isGranter(ACTION_2, grantee, WHERE_2)).to.be.false;
          expect(await authorizer.isGranter(ACTION_2, grantee, EVERYWHERE)).to.be.false;
        });

        it('emits a GranterRemoved event', async () => {
          await authorizer.addGranter(ACTION_1, grantee, WHERE_1, { from: root });

          const receipt = await (await authorizer.removeGranter(ACTION_1, grantee, WHERE_1, { from: root })).wait();
          expectEvent.inReceipt(receipt, 'GranterRemoved', {
            actionId: ACTION_1,
            account: grantee.address,
            where: WHERE_1,
          });
        });

        it('reverts if the revokee is not a granter', async () => {
          await expect(authorizer.removeGranter(ACTION_1, grantee, WHERE_1, { from: root })).to.be.revertedWith(
            'ACCOUNT_IS_NOT_GRANTER'
          );
        });

        it('reverts if the revokee is a global granter', async () => {
          await authorizer.addGranter(ACTION_1, grantee, EVERYWHERE, { from: root });
          await expect(authorizer.removeGranter(ACTION_1, grantee, WHERE_1, { from: root })).to.be.revertedWith(
            'GRANTER_IS_GLOBAL'
          );
        });

        it('reverts if the revokee is root', async () => {
          await expect(authorizer.removeGranter(ACTION_1, root, WHERE_1, { from: root })).to.be.revertedWith(
            'CANNOT_REMOVE_ROOT_GRANTER'
          );
        });

        it('reverts if the caller is not root', async () => {
          await authorizer.addGranter(ACTION_1, grantee, WHERE_1, { from: root });
          await expect(authorizer.removeGranter(ACTION_1, grantee, WHERE_1, { from: other })).to.be.revertedWith(
            'SENDER_IS_NOT_ROOT'
          );
        });
      });

      context('in any contract', () => {
        it('revokee cannot grant permission for that action on any contract', async () => {
          await authorizer.addGranter(ACTION_1, grantee, EVERYWHERE, { from: root });
          await authorizer.removeGranter(ACTION_1, grantee, EVERYWHERE, { from: root });

          expect(await authorizer.isGranter(ACTION_1, grantee, WHERE_1)).to.be.false;
          expect(await authorizer.isGranter(ACTION_1, grantee, EVERYWHERE)).to.be.false;
        });

        it('revokee cannot grant permission for that any other action anywhere', async () => {
          await authorizer.addGranter(ACTION_1, grantee, EVERYWHERE, { from: root });
          await authorizer.removeGranter(ACTION_1, grantee, EVERYWHERE, { from: root });

          expect(await authorizer.isGranter(ACTION_2, grantee, WHERE_1)).to.be.false;
          expect(await authorizer.isGranter(ACTION_2, grantee, EVERYWHERE)).to.be.false;
        });

        it('emits a GranterRemoved event', async () => {
          await authorizer.addGranter(ACTION_1, grantee, EVERYWHERE, { from: root });

          const receipt = await (await authorizer.removeGranter(ACTION_1, grantee, EVERYWHERE, { from: root })).wait();
          expectEvent.inReceipt(receipt, 'GranterRemoved', {
            actionId: ACTION_1,
            account: grantee.address,
            where: EVERYWHERE,
          });
        });

        it('reverts if the revokee is not a global granter', async () => {
          await expect(authorizer.removeGranter(ACTION_1, grantee, EVERYWHERE, { from: root })).to.be.revertedWith(
            'ACCOUNT_IS_NOT_GRANTER'
          );
        });

        it('reverts if the revokee is a granter in a specific contract', async () => {
          await authorizer.addGranter(ACTION_1, grantee, WHERE_1, { from: root });
          await expect(authorizer.removeGranter(ACTION_1, grantee, EVERYWHERE, { from: root })).to.be.revertedWith(
            'ACCOUNT_IS_NOT_GRANTER'
          );
        });

        it('preserves granter status if revokee was granter over both a specific contract and globally', async () => {
          await authorizer.addGranter(ACTION_1, grantee, WHERE_1, { from: root });
          await authorizer.addGranter(ACTION_1, grantee, EVERYWHERE, { from: root });

          expect(await authorizer.isGranter(ACTION_1, grantee, WHERE_1)).to.be.true;
          expect(await authorizer.isGranter(ACTION_1, grantee, EVERYWHERE)).to.be.true;

          await authorizer.removeGranter(ACTION_1, grantee, EVERYWHERE, { from: root });

          expect(await authorizer.isGranter(ACTION_1, grantee, WHERE_1)).to.be.true;
          expect(await authorizer.isGranter(ACTION_1, grantee, EVERYWHERE)).to.be.false;

          await authorizer.removeGranter(ACTION_1, grantee, WHERE_1, { from: root });

          expect(await authorizer.isGranter(ACTION_1, grantee, WHERE_1)).to.be.false;
          expect(await authorizer.isGranter(ACTION_1, grantee, EVERYWHERE)).to.be.false;
        });

        it('reverts if the revokee is root', async () => {
          await expect(authorizer.removeGranter(ACTION_1, root, EVERYWHERE, { from: root })).to.be.revertedWith(
            'CANNOT_REMOVE_ROOT_GRANTER'
          );
        });

        it('reverts if the caller is not root', async () => {
          await authorizer.addGranter(ACTION_1, grantee, EVERYWHERE, { from: root });
          await expect(authorizer.removeGranter(ACTION_1, grantee, EVERYWHERE, { from: other })).to.be.revertedWith(
            'SENDER_IS_NOT_ROOT'
          );
        });
      });
    });
  });

  describe('revokers', () => {
    describe('addRevoker', () => {
      context('in a specific contract', () => {
        it('can revoke permission for that action only in that contract', async () => {
          await authorizer.addRevoker(ACTION_1, revoker, WHERE_1, { from: root });

          expect(await authorizer.isRevoker(ACTION_1, revoker, WHERE_1)).to.be.true;
          expect(await authorizer.isRevoker(ACTION_1, revoker, WHERE_2)).to.be.false;
          expect(await authorizer.isRevoker(ACTION_1, revoker, EVERYWHERE)).to.be.false;
        });

        it('cannot revoke permission for any other action anywhere', async () => {
          await authorizer.addRevoker(ACTION_1, revoker, WHERE_1, { from: root });

          expect(await authorizer.isRevoker(ACTION_2, revoker, WHERE_1)).to.be.false;
          expect(await authorizer.isRevoker(ACTION_2, revoker, WHERE_2)).to.be.false;
          expect(await authorizer.isRevoker(ACTION_2, revoker, EVERYWHERE)).to.be.false;
        });

        it('emits a RevokerAdded event', async () => {
          const receipt = await (await authorizer.addRevoker(ACTION_1, revoker, WHERE_1, { from: root })).wait();
          expectEvent.inReceipt(receipt, 'RevokerAdded', {
            actionId: ACTION_1,
            account: revoker.address,
            where: WHERE_1,
          });
        });

        it('reverts if already is a revoker', async () => {
          await authorizer.addRevoker(ACTION_1, revoker, WHERE_1, { from: root });
          await expect(authorizer.addRevoker(ACTION_1, revoker, WHERE_1, { from: root })).to.be.revertedWith(
            'ACCOUNT_IS_ALREADY_REVOKER'
          );
        });

        it('reverts if already is a global revoker', async () => {
          await authorizer.addRevoker(ACTION_1, revoker, EVERYWHERE, { from: root });
          await expect(authorizer.addRevoker(ACTION_1, revoker, WHERE_1, { from: root })).to.be.revertedWith(
            'ACCOUNT_IS_ALREADY_REVOKER'
          );
        });

        it('reverts if the revoker is root', async () => {
          await expect(authorizer.addRevoker(ACTION_1, root, WHERE_1, { from: root })).to.be.revertedWith(
            'ACCOUNT_IS_ALREADY_REVOKER'
          );
        });

        it('reverts if the caller is not root', async () => {
          await expect(authorizer.addRevoker(ACTION_1, revoker, WHERE_1, { from: other })).to.be.revertedWith(
            'SENDER_IS_NOT_ROOT'
          );
        });
      });

      context('in any contract', () => {
        it('can revoke permission for that action in any contract', async () => {
          await authorizer.addRevoker(ACTION_1, revoker, EVERYWHERE, { from: root });

          expect(await authorizer.isRevoker(ACTION_1, revoker, WHERE_1)).to.be.true;
          expect(await authorizer.isRevoker(ACTION_1, revoker, WHERE_2)).to.be.true;
          expect(await authorizer.isRevoker(ACTION_1, revoker, EVERYWHERE)).to.be.true;
        });

        it('cannot revoke permission for any other action anywhere', async () => {
          await authorizer.addRevoker(ACTION_1, revoker, EVERYWHERE, { from: root });

          expect(await authorizer.isRevoker(ACTION_2, revoker, WHERE_1)).to.be.false;
          expect(await authorizer.isRevoker(ACTION_2, revoker, WHERE_2)).to.be.false;
          expect(await authorizer.isRevoker(ACTION_2, revoker, EVERYWHERE)).to.be.false;
        });

        it('emits a RevokerAdded event', async () => {
          const receipt = await (await authorizer.addRevoker(ACTION_1, revoker, EVERYWHERE, { from: root })).wait();
          expectEvent.inReceipt(receipt, 'RevokerAdded', {
            actionId: ACTION_1,
            account: revoker.address,
            where: EVERYWHERE,
          });
        });

        it('does not revert if already a revoker in a specific contract', async () => {
          await authorizer.addRevoker(ACTION_1, revoker, WHERE_1, { from: root });

          const receipt = await (await authorizer.addRevoker(ACTION_1, revoker, EVERYWHERE, { from: root })).wait();
          expectEvent.inReceipt(receipt, 'RevokerAdded', {
            actionId: ACTION_1,
            account: revoker.address,
            where: EVERYWHERE,
          });
        });

        it('reverts if is already a global revoker', async () => {
          await authorizer.addRevoker(ACTION_1, revoker, EVERYWHERE, { from: root });
          await expect(authorizer.addRevoker(ACTION_1, revoker, EVERYWHERE, { from: root })).to.be.revertedWith(
            'ACCOUNT_IS_ALREADY_REVOKER'
          );
        });

        it('reverts if the revoker is root', async () => {
          await expect(authorizer.addRevoker(ACTION_1, root, EVERYWHERE, { from: root })).to.be.revertedWith(
            'ACCOUNT_IS_ALREADY_REVOKER'
          );
        });

        it('reverts if the caller is not root', async () => {
          await expect(authorizer.addRevoker(ACTION_1, revoker, EVERYWHERE, { from: other })).to.be.revertedWith(
            'SENDER_IS_NOT_ROOT'
          );
        });
      });
    });

    describe('removeRevoker', () => {
      context('in a specific contract', () => {
        it('cannot revoke permission for that action anywhere', async () => {
          await authorizer.addRevoker(ACTION_1, revoker, WHERE_1, { from: root });
          await authorizer.removeRevoker(ACTION_1, revoker, WHERE_1, { from: root });

          expect(await authorizer.isRevoker(ACTION_1, revoker, WHERE_1)).to.be.false;
          expect(await authorizer.isRevoker(ACTION_1, revoker, WHERE_2)).to.be.false;
          expect(await authorizer.isRevoker(ACTION_1, revoker, EVERYWHERE)).to.be.false;
        });

        it('cannot revoke permission for any other action', async () => {
          await authorizer.addRevoker(ACTION_1, revoker, WHERE_1, { from: root });
          await authorizer.removeRevoker(ACTION_1, revoker, WHERE_1, { from: root });

          expect(await authorizer.isRevoker(ACTION_2, revoker, WHERE_1)).to.be.false;
          expect(await authorizer.isRevoker(ACTION_2, revoker, WHERE_2)).to.be.false;
          expect(await authorizer.isRevoker(ACTION_2, revoker, EVERYWHERE)).to.be.false;
        });

        it('emits a RevokerRemoved event', async () => {
          await authorizer.addRevoker(ACTION_1, revoker, WHERE_1, { from: root });

          const receipt = await (await authorizer.removeRevoker(ACTION_1, revoker, WHERE_1, { from: root })).wait();
          expectEvent.inReceipt(receipt, 'RevokerRemoved', {
            actionId: ACTION_1,
            account: revoker.address,
            where: WHERE_1,
          });
        });

        it('reverts if the subject is not a revoker', async () => {
          await expect(authorizer.removeRevoker(ACTION_1, revoker, WHERE_1, { from: root })).to.be.revertedWith(
            'ACCOUNT_IS_NOT_REVOKER'
          );
        });

        it('reverts if the revokee is a global revoker', async () => {
          await authorizer.addRevoker(ACTION_1, revoker, EVERYWHERE, { from: root });
          await expect(authorizer.removeRevoker(ACTION_1, revoker, WHERE_1, { from: root })).to.be.revertedWith(
            'REVOKER_IS_GLOBAL'
          );
        });

        it('reverts if the revokee is root', async () => {
          await expect(authorizer.removeRevoker(ACTION_1, root, WHERE_1, { from: root })).to.be.revertedWith(
            'CANNOT_REMOVE_ROOT_REVOKER'
          );
        });

        it('reverts if the caller is not root', async () => {
          await authorizer.addRevoker(ACTION_1, revoker, WHERE_1, { from: root });
          await expect(authorizer.removeRevoker(ACTION_1, revoker, WHERE_1, { from: other })).to.be.revertedWith(
            'SENDER_IS_NOT_ROOT'
          );
        });
      });
      context('in any contract', () => {
        it('cannot revoke permission for that action on any contract', async () => {
          await authorizer.addRevoker(ACTION_1, revoker, EVERYWHERE, { from: root });
          await authorizer.removeRevoker(ACTION_1, revoker, EVERYWHERE, { from: root });

          expect(await authorizer.isRevoker(ACTION_1, revoker, WHERE_1)).to.be.false;
          expect(await authorizer.isRevoker(ACTION_1, revoker, EVERYWHERE)).to.be.false;
        });

        it('cannot revoke permission for that any other action anywhere', async () => {
          await authorizer.addRevoker(ACTION_1, revoker, EVERYWHERE, { from: root });
          await authorizer.removeRevoker(ACTION_1, revoker, EVERYWHERE, { from: root });

          expect(await authorizer.isRevoker(ACTION_2, revoker, WHERE_1)).to.be.false;
          expect(await authorizer.isRevoker(ACTION_2, revoker, EVERYWHERE)).to.be.false;
        });

        it('emits a RevokerRemoved event', async () => {
          await authorizer.addRevoker(ACTION_1, revoker, EVERYWHERE, { from: root });

          const receipt = await (await authorizer.removeRevoker(ACTION_1, revoker, EVERYWHERE, { from: root })).wait();
          expectEvent.inReceipt(receipt, 'RevokerRemoved', {
            actionId: ACTION_1,
            account: revoker.address,
            where: EVERYWHERE,
          });
        });

        it('reverts if the subject is not a global revoker', async () => {
          await expect(authorizer.removeRevoker(ACTION_1, revoker, EVERYWHERE, { from: root })).to.be.revertedWith(
            'ACCOUNT_IS_NOT_REVOKER'
          );
        });

        it('reverts if the subject is a revoker in a specific contract', async () => {
          await authorizer.addRevoker(ACTION_1, revoker, WHERE_1, { from: root });
          await expect(authorizer.removeRevoker(ACTION_1, revoker, EVERYWHERE, { from: root })).to.be.revertedWith(
            'ACCOUNT_IS_NOT_REVOKER'
          );
        });

        it('preserves revoker status if it was received over both a specific contract and globally', async () => {
          await authorizer.addRevoker(ACTION_1, revoker, WHERE_1, { from: root });
          await authorizer.addRevoker(ACTION_1, revoker, EVERYWHERE, { from: root });

          expect(await authorizer.isRevoker(ACTION_1, revoker, WHERE_1)).to.be.true;
          expect(await authorizer.isRevoker(ACTION_1, revoker, EVERYWHERE)).to.be.true;

          await authorizer.removeRevoker(ACTION_1, revoker, EVERYWHERE, { from: root });

          expect(await authorizer.isRevoker(ACTION_1, revoker, WHERE_1)).to.be.true;
          expect(await authorizer.isRevoker(ACTION_1, revoker, EVERYWHERE)).to.be.false;

          await authorizer.removeRevoker(ACTION_1, revoker, WHERE_1, { from: root });

          expect(await authorizer.isRevoker(ACTION_1, revoker, WHERE_1)).to.be.false;
          expect(await authorizer.isRevoker(ACTION_1, revoker, EVERYWHERE)).to.be.false;
        });

        it('reverts if the subject is root', async () => {
          await expect(authorizer.removeRevoker(ACTION_1, root, EVERYWHERE, { from: root })).to.be.revertedWith(
            'CANNOT_REMOVE_ROOT_REVOKER'
          );
        });

        it('reverts if the caller is not root', async () => {
          await authorizer.addRevoker(ACTION_1, revoker, EVERYWHERE, { from: root });
          await expect(authorizer.removeRevoker(ACTION_1, revoker, EVERYWHERE, { from: other })).to.be.revertedWith(
            'SENDER_IS_NOT_ROOT'
          );
        });
      });
    });
  });

  describe('addCanceler', () => {
    context('when the sender is the root', () => {
      context('when adding canceler', () => {
        context('for a specific scheduled execution id', () => {
          it('can add canceler for a specific execution id', async () => {
            expect(await authorizer.isCanceler(0, canceler)).to.be.false;

            await authorizer.addCanceler(0, canceler, { from: root });

            expect(await authorizer.isCanceler(0, canceler)).to.be.true;
            // test that canceler has only a specific permission
            expect(await authorizer.isCanceler(1, canceler)).to.be.false;
          });

          it('emits an event', async () => {
            const receipt = await authorizer.addCanceler(0, canceler, { from: root });

            expectEvent.inReceipt(await receipt.wait(), 'CancelerAdded', { scheduledExecutionId: 0 });
          });

          it('cannot be added twice', async () => {
            await authorizer.addCanceler(0, canceler, { from: root });

            await expect(authorizer.addCanceler(0, canceler, { from: root })).to.be.revertedWith(
              'ACCOUNT_IS_ALREADY_CANCELER'
            );
          });
        });

        context('for any scheduled execution id', () => {
          it('root is a canceler', async () => {
            expect(await authorizer.isCanceler(GLOBAL_CANCELER_SCHEDULED_EXECUTION_ID, root)).to.be.true;
          });

          it('cannot add root as a canceler', async () => {
            await expect(
              authorizer.addCanceler(GLOBAL_CANCELER_SCHEDULED_EXECUTION_ID, root, { from: root })
            ).to.be.revertedWith('ACCOUNT_IS_ALREADY_CANCELER');
          });

          it('can add canceler for any execution id', async () => {
            await authorizer.addCanceler(GLOBAL_CANCELER_SCHEDULED_EXECUTION_ID, canceler, { from: root });

            expect(await authorizer.isCanceler(GLOBAL_CANCELER_SCHEDULED_EXECUTION_ID, canceler)).to.be.true;
            // check that the canceler can cancel any action
            expect(await authorizer.isCanceler(0, canceler)).to.be.true;
            expect(await authorizer.isCanceler(1, canceler)).to.be.true;
            expect(await authorizer.isCanceler(2, canceler)).to.be.true;
          });

          it('emits an event', async () => {
            const receipt = await authorizer.addCanceler(GLOBAL_CANCELER_SCHEDULED_EXECUTION_ID, canceler, {
              from: root,
            });

            expectEvent.inReceipt(await receipt.wait(), 'CancelerAdded', {
              scheduledExecutionId: GLOBAL_CANCELER_SCHEDULED_EXECUTION_ID,
            });
          });

          it('can add specific canceler and then a global', async () => {
            let receipt = await authorizer.addCanceler(0, canceler, { from: root });
            expectEvent.inReceipt(await receipt.wait(), 'CancelerAdded', {
              scheduledExecutionId: 0,
            });
            receipt = await authorizer.addCanceler(GLOBAL_CANCELER_SCHEDULED_EXECUTION_ID, canceler, { from: root });
            expectEvent.inReceipt(await receipt.wait(), 'CancelerAdded', {
              scheduledExecutionId: GLOBAL_CANCELER_SCHEDULED_EXECUTION_ID,
            });

            expect(await authorizer.isCanceler(0, canceler)).to.be.true;
            expect(await authorizer.isCanceler(GLOBAL_CANCELER_SCHEDULED_EXECUTION_ID, canceler)).to.be.true;
          });

          it('cannot be added twice', async () => {
            await authorizer.addCanceler(GLOBAL_CANCELER_SCHEDULED_EXECUTION_ID, canceler, { from: root });

            await expect(
              authorizer.addCanceler(GLOBAL_CANCELER_SCHEDULED_EXECUTION_ID, canceler, { from: root })
            ).to.be.revertedWith('ACCOUNT_IS_ALREADY_CANCELER');
          });
        });
      });
    });

    context('when the sender is not the root', () => {
      it('reverts', async () => {
        await expect(authorizer.addCanceler(0, canceler, { from: other })).to.be.revertedWith('SENDER_IS_NOT_ROOT');
      });
    });
  });

  describe('removeCanceler', () => {
    context('when the sender is the root', () => {
      context('when removing canceler', () => {
        context('for a specific scheduled execution id', () => {
          it('can remove canceler for a specific execution id', async () => {
            await authorizer.addCanceler(0, canceler, { from: root });
            await authorizer.removeCanceler(0, canceler, { from: root });

            expect(await authorizer.isCanceler(0, canceler)).to.be.false;
          });

          it('emits an event', async () => {
            await authorizer.addCanceler(0, canceler, { from: root });
            const receipt = await authorizer.removeCanceler(0, canceler, { from: root });

            expectEvent.inReceipt(await receipt.wait(), 'CancelerRemoved', {
              scheduledExecutionId: 0,
              canceler: canceler.address,
            });
          });

          it('cannot remove if not canceler', async () => {
            await expect(authorizer.removeCanceler(0, canceler, { from: root })).to.be.revertedWith(
              'ACCOUNT_IS_NOT_CANCELER'
            );
          });

          it('cannot remove root', async () => {
            await expect(authorizer.removeCanceler(0, root, { from: root })).to.be.revertedWith(
              'CANNOT_REMOVE_ROOT_CANCELER'
            );
          });

          it('cannot remove global canceler for a specific execution id', async () => {
            await authorizer.addCanceler(GLOBAL_CANCELER_SCHEDULED_EXECUTION_ID, canceler, { from: root });
            await expect(authorizer.removeCanceler(0, canceler, { from: root })).to.be.revertedWith(
              'ACCOUNT_IS_GLOBAL_CANCELER'
            );
          });

          it('cannot be removed twice', async () => {
            await authorizer.addCanceler(0, canceler, { from: root });
            await authorizer.removeCanceler(0, canceler, { from: root });

            await expect(authorizer.removeCanceler(0, canceler, { from: root })).to.be.revertedWith(
              'ACCOUNT_IS_NOT_CANCELER'
            );
          });
        });

        context('for any scheduled execution id', () => {
          it('can remove canceler for any execution id', async () => {
            await authorizer.addCanceler(GLOBAL_CANCELER_SCHEDULED_EXECUTION_ID, canceler, { from: root });

            await authorizer.removeCanceler(GLOBAL_CANCELER_SCHEDULED_EXECUTION_ID, canceler, { from: root });

            expect(await authorizer.isCanceler(GLOBAL_CANCELER_SCHEDULED_EXECUTION_ID, canceler)).to.be.false;
          });

          it('emits an event', async () => {
            await authorizer.addCanceler(GLOBAL_CANCELER_SCHEDULED_EXECUTION_ID, canceler, { from: root });
            const receipt = await authorizer.removeCanceler(GLOBAL_CANCELER_SCHEDULED_EXECUTION_ID, canceler, {
              from: root,
            });

            expectEvent.inReceipt(await receipt.wait(), 'CancelerRemoved', {
              scheduledExecutionId: GLOBAL_CANCELER_SCHEDULED_EXECUTION_ID,
              canceler: canceler.address,
            });
          });

          it('cannot remove if not a canceler', async () => {
            await expect(
              authorizer.removeCanceler(GLOBAL_CANCELER_SCHEDULED_EXECUTION_ID, other, { from: root })
            ).to.be.revertedWith('ACCOUNT_IS_NOT_CANCELER');
          });

          it('cannot remove the root', async () => {
            await expect(
              authorizer.removeCanceler(GLOBAL_CANCELER_SCHEDULED_EXECUTION_ID, root, { from: root })
            ).to.be.revertedWith('CANNOT_REMOVE_ROOT_CANCELER');
          });

          it('cannot be removed twice', async () => {
            await authorizer.addCanceler(GLOBAL_CANCELER_SCHEDULED_EXECUTION_ID, canceler, { from: root });
            await authorizer.removeCanceler(GLOBAL_CANCELER_SCHEDULED_EXECUTION_ID, canceler, { from: root });

            await expect(
              authorizer.removeCanceler(GLOBAL_CANCELER_SCHEDULED_EXECUTION_ID, canceler, { from: root })
            ).to.be.revertedWith('ACCOUNT_IS_NOT_CANCELER');
          });

          it('can remove canceler for any execution id', async () => {
            await authorizer.addCanceler(0, canceler, { from: root });
            await authorizer.addCanceler(GLOBAL_CANCELER_SCHEDULED_EXECUTION_ID, canceler, { from: root });

            expect(await authorizer.isCanceler(0, canceler)).to.be.true;
            expect(await authorizer.isCanceler(1, canceler)).to.be.true;

            await authorizer.removeCanceler(GLOBAL_CANCELER_SCHEDULED_EXECUTION_ID, canceler, { from: root });

            expect(await authorizer.isCanceler(0, canceler)).to.be.true;
            expect(await authorizer.isCanceler(1, canceler)).to.be.false;

            await authorizer.removeCanceler(0, canceler, { from: root });

            expect(await authorizer.isCanceler(0, canceler)).to.be.false;
            expect(await authorizer.isCanceler(1, canceler)).to.be.false;
          });
        });
      });
    });

    context('when the sender is not the root', () => {
      it('reverts', async () => {
        await expect(authorizer.removeCanceler(0, canceler, { from: canceler })).to.be.revertedWith(
          'SENDER_IS_NOT_ROOT'
        );
      });
    });
  });

  describe('grantPermissions', () => {
    context('when the sender is the root', () => {
      context('when the target does not have the permission granted', () => {
        context('when there is no delay set to grant permissions', () => {
          it('grants permission to perform the requested actions for the requested contracts', async () => {
            await authorizer.grantPermissions(ACTIONS, grantee, WHERE, { from: root });

            expect(await authorizer.canPerform(ACTION_1, grantee, WHERE_1)).to.be.true;
            expect(await authorizer.canPerform(ACTION_2, grantee, WHERE_2)).to.be.true;
          });

          it('does not grant permission to perform the requested actions everywhere', async () => {
            await authorizer.grantPermissions(ACTIONS, grantee, WHERE, { from: root });

            expect(await authorizer.canPerform(ACTION_1, grantee, EVERYWHERE)).to.be.false;
            expect(await authorizer.canPerform(ACTION_2, grantee, EVERYWHERE)).to.be.false;
          });

          it('does not grant permission to perform the requested actions for other contracts', async () => {
            await authorizer.grantPermissions(ACTIONS, grantee, WHERE, { from: root });

            expect(await authorizer.canPerform(ACTION_1, grantee, NOT_WHERE)).to.be.false;
            expect(await authorizer.canPerform(ACTION_2, grantee, NOT_WHERE)).to.be.false;
          });

          it('emits an event', async () => {
            const receipt = await (await authorizer.grantPermissions(ACTIONS, grantee, WHERE, { from: root })).wait();

            ACTIONS.forEach((action, i) => {
              expectEvent.inReceipt(receipt, 'PermissionGranted', {
                actionId: action,
                account: grantee.address,
                where: WHERE[i],
              });
            });
          });
        });

        context.skip('when there is a delay set to grant permissions', () => {
          const delay = DAY;
          let grantActionId: string;

          sharedBeforeEach('set constants', async () => {
            grantActionId = await authorizer.getGrantPermissionActionId(ACTION_1);
          });

          sharedBeforeEach('set delay', async () => {
            const setAuthorizerAction = await actionId(vault, 'setAuthorizer');
            await authorizer.scheduleAndExecuteDelayChange(setAuthorizerAction, delay * 2, { from: root });
            await authorizer.scheduleAndExecuteDelayChange(grantActionId, delay, { from: root });
          });

          it('reverts', async () => {
            await expect(authorizer.grantPermissions(ACTION_1, grantee, WHERE_1, { from: root })).to.be.revertedWith(
              'SENDER_IS_NOT_GRANTER'
            );
          });

          it('can schedule a grant permission', async () => {
            const id = await authorizer.scheduleGrantPermission(ACTION_1, grantee, WHERE_1, [], { from: root });

            // should not be able to execute before delay
            await expect(authorizer.execute(id, { from: root })).to.be.revertedWith('ACTION_NOT_YET_EXECUTABLE');

            await advanceTime(delay);
            await authorizer.execute(id, { from: root });

            expect(await authorizer.canPerform(ACTION_1, grantee, WHERE_1)).to.be.true;
            expect(await authorizer.canPerform(ACTION_2, grantee, WHERE_2)).to.be.false;
          });
        });
      });

      context('when the target has the permission granted', () => {
        context('when the permission was granted for a set of contracts', () => {
          sharedBeforeEach('grant permissions', async () => {
            await authorizer.grantPermissions(ACTIONS, grantee, WHERE, { from: root });
          });

          it('ignores the request and can still perform those actions', async () => {
            await expect(authorizer.grantPermissions(ACTIONS, grantee, WHERE, { from: root })).not.to.reverted;

            expect(await authorizer.canPerform(ACTION_1, grantee, WHERE_1)).to.be.true;
            expect(await authorizer.canPerform(ACTION_2, grantee, WHERE_2)).to.be.true;
          });

          it('does not grant permission to perform the requested actions everywhere', async () => {
            await authorizer.grantPermissions(ACTIONS, grantee, WHERE, { from: root });

            expect(await authorizer.canPerform(ACTION_1, grantee, EVERYWHERE)).to.be.false;
            expect(await authorizer.canPerform(ACTION_2, grantee, EVERYWHERE)).to.be.false;
          });

          it('does not grant permission to perform the requested actions for other contracts', async () => {
            await authorizer.grantPermissions(ACTIONS, grantee, WHERE, { from: root });

            expect(await authorizer.canPerform(ACTION_1, grantee, NOT_WHERE)).to.be.false;
            expect(await authorizer.canPerform(ACTION_2, grantee, NOT_WHERE)).to.be.false;
          });

          it('does not emit an event', async () => {
            const tx = await authorizer.grantPermissions(ACTIONS, grantee, WHERE, { from: root });
            expectEvent.notEmitted(await tx.wait(), 'PermissionGranted');
          });
        });

        context('when the permission was granted globally', () => {
          sharedBeforeEach('grant permissions', async () => {
            await authorizer.grantPermissionsGlobally(ACTIONS, grantee, { from: root });
          });

          it('grants permission to perform the requested actions for the requested contracts', async () => {
            await authorizer.grantPermissions(ACTIONS, grantee, WHERE, { from: root });

            expect(await authorizer.canPerform(ACTION_1, grantee, WHERE_1)).to.be.true;
            expect(await authorizer.canPerform(ACTION_2, grantee, WHERE_1)).to.be.true;
            expect(await authorizer.canPerform(ACTION_1, grantee, WHERE_2)).to.be.true;
            expect(await authorizer.canPerform(ACTION_2, grantee, WHERE_2)).to.be.true;
          });

          it('still can perform the requested actions everywhere', async () => {
            await authorizer.grantPermissions(ACTIONS, grantee, WHERE, { from: root });

            expect(await authorizer.canPerform(ACTION_1, grantee, EVERYWHERE)).to.be.true;
            expect(await authorizer.canPerform(ACTION_2, grantee, EVERYWHERE)).to.be.true;
          });

          it('still can perform the requested actions for other contracts', async () => {
            await authorizer.grantPermissions(ACTIONS, grantee, WHERE, { from: root });

            expect(await authorizer.canPerform(ACTION_1, grantee, NOT_WHERE)).to.be.true;
            expect(await authorizer.canPerform(ACTION_2, grantee, NOT_WHERE)).to.be.true;
          });

          it('emits an event', async () => {
            const receipt = await (await authorizer.grantPermissions(ACTIONS, grantee, WHERE, { from: root })).wait();

            ACTIONS.forEach((action, i) => {
              expectEvent.inReceipt(receipt, 'PermissionGranted', {
                actionId: action,
                account: grantee.address,
                where: WHERE[i],
              });
            });
          });
        });
      });
    });

    context('when the sender is not the root', () => {
      it('reverts', async () => {
        await expect(authorizer.grantPermissions(ACTIONS, grantee, WHERE, { from: grantee })).to.be.revertedWith(
          'SENDER_IS_NOT_GRANTER'
        );
      });
    });
  });

  describe('grantPermissionsGlobally', () => {
    context('when the sender is the root', () => {
      context('when the target does not have the permission granted', () => {
        it('grants permission to perform the requested actions everywhere', async () => {
          await authorizer.grantPermissionsGlobally(ACTIONS, grantee, { from: root });

          expect(await authorizer.canPerform(ACTION_1, grantee, EVERYWHERE)).to.be.true;
          expect(await authorizer.canPerform(ACTION_2, grantee, EVERYWHERE)).to.be.true;
        });

        it('grants permission to perform the requested actions in any specific contract', async () => {
          await authorizer.grantPermissionsGlobally(ACTIONS, grantee, { from: root });

          expect(await authorizer.canPerform(ACTION_1, grantee, NOT_WHERE)).to.be.true;
          expect(await authorizer.canPerform(ACTION_2, grantee, NOT_WHERE)).to.be.true;
        });

        it('emits an event', async () => {
          const receipt = await (await authorizer.grantPermissionsGlobally(ACTIONS, grantee, { from: root })).wait();

          for (const action of ACTIONS) {
            expectEvent.inReceipt(receipt, 'PermissionGranted', {
              actionId: action,
              account: grantee.address,
              where: TimelockAuthorizer.EVERYWHERE,
            });
          }
        });
      });

      context('when the target has the permission granted', () => {
        context('when the permission was granted for a set of contracts', () => {
          sharedBeforeEach('grant permissions', async () => {
            await authorizer.grantPermissions(ACTIONS, grantee, WHERE, { from: root });
          });

          it('grants permission to perform the requested actions everywhere', async () => {
            await authorizer.grantPermissionsGlobally(ACTIONS, grantee, { from: root });

            expect(await authorizer.canPerform(ACTION_1, grantee, EVERYWHERE)).to.be.true;
            expect(await authorizer.canPerform(ACTION_2, grantee, EVERYWHERE)).to.be.true;
          });

          it('still can perform the requested actions for the previously granted contracts', async () => {
            await authorizer.grantPermissionsGlobally(ACTIONS, grantee, { from: root });

            expect(await authorizer.canPerform(ACTION_1, grantee, WHERE_1)).to.be.true;
            expect(await authorizer.canPerform(ACTION_2, grantee, WHERE_1)).to.be.true;
            expect(await authorizer.canPerform(ACTION_1, grantee, WHERE_2)).to.be.true;
            expect(await authorizer.canPerform(ACTION_2, grantee, WHERE_2)).to.be.true;
          });

          it('emits an event', async () => {
            const receipt = await (await authorizer.grantPermissionsGlobally(ACTIONS, grantee, { from: root })).wait();

            for (const action of ACTIONS) {
              expectEvent.inReceipt(receipt, 'PermissionGranted', {
                actionId: action,
                account: grantee.address,
                where: TimelockAuthorizer.EVERYWHERE,
              });
            }
          });
        });

        context('when the permission was granted globally', () => {
          sharedBeforeEach('grant permissions', async () => {
            await authorizer.grantPermissionsGlobally(ACTIONS, grantee, { from: root });
          });

          it('ignores the request and can still perform the requested actions everywhere', async () => {
            await expect(authorizer.grantPermissionsGlobally(ACTIONS, grantee, { from: root })).not.to.be.reverted;

            expect(await authorizer.canPerform(ACTION_1, grantee, EVERYWHERE)).to.be.true;
            expect(await authorizer.canPerform(ACTION_2, grantee, EVERYWHERE)).to.be.true;
          });

          it('ignores the request and can still perform the requested actions in any specific contract', async () => {
            await expect(authorizer.grantPermissionsGlobally(ACTIONS, grantee, { from: root })).not.to.be.reverted;

            expect(await authorizer.canPerform(ACTION_1, grantee, NOT_WHERE)).to.be.true;
            expect(await authorizer.canPerform(ACTION_2, grantee, NOT_WHERE)).to.be.true;
          });

          it('does not emit an event', async () => {
            const tx = await authorizer.grantPermissionsGlobally(ACTIONS, grantee, { from: root });
            expectEvent.notEmitted(await tx.wait(), 'PermissionGrantedGlobally');
          });
        });
      });
    });

    context('when the sender is not the root', () => {
      it('reverts', async () => {
        await expect(authorizer.grantPermissionsGlobally(ACTIONS, grantee, { from: grantee })).to.be.revertedWith(
          'SENDER_IS_NOT_GRANTER'
        );
      });
    });
  });

  describe('revokePermissions', () => {
    context('when the sender is the root', () => {
      context('when the target does not have the permission granted', () => {
        it('ignores the request and cannot perform the requested actions everywhere', async () => {
          await expect(authorizer.revokePermissions(ACTIONS, grantee, WHERE, { from: root })).not.to.be.reverted;

          expect(await authorizer.canPerform(ACTION_1, grantee, EVERYWHERE)).to.be.false;
          expect(await authorizer.canPerform(ACTION_2, grantee, EVERYWHERE)).to.be.false;
        });

        it('ignores the request and cannot perform the requested actions in any specific contract', async () => {
          await expect(authorizer.revokePermissions(ACTIONS, grantee, WHERE, { from: root })).not.to.be.reverted;

          expect(await authorizer.canPerform(ACTION_1, grantee, NOT_WHERE)).to.be.false;
          expect(await authorizer.canPerform(ACTION_2, grantee, NOT_WHERE)).to.be.false;
        });

        it('does not emit an event', async () => {
          const tx = await authorizer.grantPermissions(ACTIONS, grantee, WHERE, { from: root });
          expectEvent.notEmitted(await tx.wait(), 'PermissionRevoked');
        });
      });

      context('when the target has the permission granted', () => {
        context('when the permission was granted for a set of contracts', () => {
          sharedBeforeEach('grant permissions', async () => {
            await authorizer.grantPermissions(ACTIONS, grantee, WHERE, { from: root });
          });

          context('when there is no delay set to revoke permissions', () => {
            it('revokes the requested permission for the requested contracts', async () => {
              await authorizer.revokePermissions(ACTIONS, grantee, WHERE, { from: root });

              expect(await authorizer.canPerform(ACTION_1, grantee, WHERE_1)).to.be.false;
              expect(await authorizer.canPerform(ACTION_2, grantee, WHERE_1)).to.be.false;
              expect(await authorizer.canPerform(ACTION_1, grantee, WHERE_2)).to.be.false;
              expect(await authorizer.canPerform(ACTION_2, grantee, WHERE_2)).to.be.false;
            });

            it('still cannot perform the requested actions everywhere', async () => {
              await authorizer.revokePermissions(ACTIONS, grantee, WHERE, { from: root });

              expect(await authorizer.canPerform(ACTION_1, grantee, EVERYWHERE)).to.be.false;
              expect(await authorizer.canPerform(ACTION_2, grantee, EVERYWHERE)).to.be.false;
            });

            it('emits an event', async () => {
              const receipt = await (
                await authorizer.revokePermissions(ACTIONS, grantee, WHERE, { from: root })
              ).wait();

              ACTIONS.forEach((action, i) => {
                expectEvent.inReceipt(receipt, 'PermissionRevoked', {
                  actionId: action,
                  account: grantee.address,
                  where: WHERE[i],
                });
              });
            });
          });

          context.skip('when there is a delay set to revoke permissions', () => {
            const delay = DAY;
            let revokeActionId: string;

            sharedBeforeEach('set constants', async () => {
              revokeActionId = await authorizer.getRevokePermissionActionId(ACTION_1);
            });

            sharedBeforeEach('set delay', async () => {
              const setAuthorizerAction = await actionId(vault, 'setAuthorizer');
              await authorizer.scheduleAndExecuteDelayChange(setAuthorizerAction, delay * 2, { from: root });
              await authorizer.scheduleAndExecuteDelayChange(revokeActionId, delay, { from: root });
            });

            it('reverts', async () => {
              await expect(authorizer.revokePermissions(ACTION_1, grantee, WHERE_1, { from: root })).to.be.revertedWith(
                'SENDER_IS_NOT_REVOKER'
              );
            });

            it('can schedule a revoke permission', async () => {
              const id = await authorizer.scheduleRevokePermission(ACTION_1, grantee, WHERE_1, [], { from: root });

              // should not be able to execute before delay
              await expect(authorizer.execute(id, { from: root })).to.be.revertedWith('ACTION_NOT_YET_EXECUTABLE');

              await advanceTime(delay);
              await authorizer.execute(id, { from: root });

              expect(await authorizer.canPerform(ACTION_1, grantee, WHERE_1)).to.be.false;
              expect(await authorizer.canPerform(ACTION_2, grantee, WHERE_2)).to.be.true;
            });
          });
        });

        context('when the permission was granted globally', () => {
          sharedBeforeEach('grant permissions', async () => {
            await authorizer.grantPermissionsGlobally(ACTIONS, grantee, { from: root });
          });

          it('still can perform the requested actions for the requested contracts', async () => {
            await authorizer.revokePermissions(ACTIONS, grantee, WHERE, { from: root });

            expect(await authorizer.canPerform(ACTION_1, grantee, WHERE_1)).to.be.true;
            expect(await authorizer.canPerform(ACTION_2, grantee, WHERE_1)).to.be.true;
            expect(await authorizer.canPerform(ACTION_1, grantee, WHERE_2)).to.be.true;
            expect(await authorizer.canPerform(ACTION_2, grantee, WHERE_2)).to.be.true;
          });

          it('still can perform the requested actions everywhere', async () => {
            await authorizer.revokePermissions(ACTIONS, grantee, WHERE, { from: root });

            expect(await authorizer.canPerform(ACTION_1, grantee, EVERYWHERE)).to.be.true;
            expect(await authorizer.canPerform(ACTION_2, grantee, EVERYWHERE)).to.be.true;
          });

          it('does not emit an event', async () => {
            const tx = await authorizer.grantPermissions(ACTIONS, grantee, WHERE, { from: root });
            expectEvent.notEmitted(await tx.wait(), 'PermissionRevoked');
          });
        });
      });
    });

    context('when the sender is not the root', () => {
      it('reverts', async () => {
        await expect(authorizer.revokePermissions(ACTIONS, grantee, WHERE, { from: grantee })).to.be.revertedWith(
          'SENDER_IS_NOT_REVOKER'
        );
      });
    });
  });

  describe('revokePermissionsGlobally', () => {
    context('when the sender is the root', () => {
      context('when the sender does not have the permission granted', () => {
        it('ignores the request and cannot perform the requested actions everywhere', async () => {
          await expect(authorizer.revokePermissionsGlobally(ACTIONS, grantee, { from: root })).not.to.be.reverted;

          expect(await authorizer.canPerform(ACTION_1, grantee, EVERYWHERE)).to.be.false;
          expect(await authorizer.canPerform(ACTION_2, grantee, EVERYWHERE)).to.be.false;
        });

        it('ignores the request and cannot perform the requested actions in any specific contract', async () => {
          await expect(authorizer.revokePermissionsGlobally(ACTIONS, grantee, { from: root })).not.to.be.reverted;

          expect(await authorizer.canPerform(ACTION_1, grantee, NOT_WHERE)).to.be.false;
          expect(await authorizer.canPerform(ACTION_2, grantee, NOT_WHERE)).to.be.false;
        });

        it('does not emit an event', async () => {
          const tx = await authorizer.revokePermissionsGlobally(ACTIONS, grantee, { from: root });
          expectEvent.notEmitted(await tx.wait(), 'PermissionRevokedGlobally');
        });
      });

      context('when the grantee has the permission granted', () => {
        context('when the permission was granted for a set of contracts', () => {
          sharedBeforeEach('grant permissions', async () => {
            await authorizer.grantPermissions(ACTIONS, grantee, WHERE, { from: root });
          });

          it('still cannot perform the requested actions everywhere', async () => {
            await authorizer.revokePermissionsGlobally(ACTIONS, grantee, { from: root });

            expect(await authorizer.canPerform(ACTION_1, grantee, EVERYWHERE)).to.be.false;
            expect(await authorizer.canPerform(ACTION_2, grantee, EVERYWHERE)).to.be.false;
          });

          it('still can perform the requested actions for the previously granted permissions', async () => {
            await authorizer.revokePermissionsGlobally(ACTIONS, grantee, { from: root });

            expect(await authorizer.canPerform(ACTION_1, grantee, WHERE_1)).to.be.true;
            expect(await authorizer.canPerform(ACTION_2, grantee, WHERE_2)).to.be.true;
          });

          it('does not emit an event', async () => {
            const tx = await authorizer.revokePermissionsGlobally(ACTIONS, grantee, { from: root });
            expectEvent.notEmitted(await tx.wait(), 'PermissionRevokedGlobally');
          });
        });

        context('when the permission was granted globally', () => {
          sharedBeforeEach('grant permissions', async () => {
            await authorizer.grantPermissionsGlobally(ACTIONS, grantee, { from: root });
          });

          it('revokes the requested global permission and cannot perform the requested actions everywhere', async () => {
            await authorizer.revokePermissionsGlobally(ACTIONS, grantee, { from: root });

            expect(await authorizer.canPerform(ACTION_1, grantee, WHERE_1)).to.be.false;
            expect(await authorizer.canPerform(ACTION_2, grantee, WHERE_1)).to.be.false;
            expect(await authorizer.canPerform(ACTION_1, grantee, WHERE_2)).to.be.false;
            expect(await authorizer.canPerform(ACTION_2, grantee, WHERE_2)).to.be.false;
          });

          it('cannot perform the requested actions in any specific contract', async () => {
            await authorizer.revokePermissionsGlobally(ACTIONS, grantee, { from: root });

            expect(await authorizer.canPerform(ACTION_1, grantee, NOT_WHERE)).to.be.false;
            expect(await authorizer.canPerform(ACTION_2, grantee, NOT_WHERE)).to.be.false;
          });

          it('emits an event', async () => {
            const receipt = await (await authorizer.revokePermissionsGlobally(ACTIONS, grantee, { from: root })).wait();

            for (const action of ACTIONS) {
              expectEvent.inReceipt(receipt, 'PermissionRevoked', {
                actionId: action,
                account: grantee.address,
                where: TimelockAuthorizer.EVERYWHERE,
              });
            }
          });
        });
      });
    });

    context('when the sender is not the root', () => {
      it('reverts', async () => {
        await expect(authorizer.revokePermissionsGlobally(ACTIONS, grantee, { from: grantee })).to.be.revertedWith(
          'SENDER_IS_NOT_REVOKER'
        );
      });
    });
  });

  describe('renouncePermissions', () => {
    context('when the sender does not have the permission granted', () => {
      it('ignores the request and still cannot perform the requested actions everywhere', async () => {
        await expect(authorizer.renouncePermissions(ACTIONS, WHERE, { from: grantee })).not.to.be.reverted;

        expect(await authorizer.canPerform(ACTION_1, grantee, EVERYWHERE)).to.be.false;
        expect(await authorizer.canPerform(ACTION_2, grantee, EVERYWHERE)).to.be.false;
      });

      it('ignores the request and still cannot perform the requested actions in any specific contract', async () => {
        await expect(authorizer.renouncePermissions(ACTIONS, WHERE, { from: grantee })).not.to.be.reverted;

        expect(await authorizer.canPerform(ACTION_1, grantee, NOT_WHERE)).to.be.false;
        expect(await authorizer.canPerform(ACTION_2, grantee, NOT_WHERE)).to.be.false;
      });
    });

    context('when the sender has the permission granted', () => {
      context('when the sender has the permission granted for a specific contract', () => {
        sharedBeforeEach('grant permissions', async () => {
          await authorizer.grantPermissions(ACTIONS, grantee, WHERE, { from: root });
        });

        it('revokes the requested permission for the requested contracts', async () => {
          await authorizer.renouncePermissions(ACTIONS, WHERE, { from: grantee });

          expect(await authorizer.canPerform(ACTION_1, grantee, WHERE_1)).to.be.false;
          expect(await authorizer.canPerform(ACTION_2, grantee, WHERE_1)).to.be.false;
          expect(await authorizer.canPerform(ACTION_1, grantee, WHERE_2)).to.be.false;
          expect(await authorizer.canPerform(ACTION_2, grantee, WHERE_2)).to.be.false;
        });

        it('still cannot perform the requested actions everywhere', async () => {
          await authorizer.renouncePermissions(ACTIONS, WHERE, { from: grantee });

          expect(await authorizer.canPerform(ACTION_1, grantee, EVERYWHERE)).to.be.false;
          expect(await authorizer.canPerform(ACTION_2, grantee, EVERYWHERE)).to.be.false;
        });
      });

      context('when the sender has the permission granted globally', () => {
        sharedBeforeEach('grant permissions', async () => {
          await authorizer.grantPermissionsGlobally(ACTIONS, grantee, { from: root });
        });

        it('still can perform the requested actions for the requested contracts', async () => {
          await authorizer.renouncePermissions(ACTIONS, WHERE, { from: grantee });

          expect(await authorizer.canPerform(ACTION_1, grantee, WHERE_1)).to.be.true;
          expect(await authorizer.canPerform(ACTION_2, grantee, WHERE_1)).to.be.true;
          expect(await authorizer.canPerform(ACTION_1, grantee, WHERE_2)).to.be.true;
          expect(await authorizer.canPerform(ACTION_2, grantee, WHERE_2)).to.be.true;
        });

        it('still can perform the requested actions everywhere', async () => {
          await authorizer.renouncePermissions(ACTIONS, WHERE, { from: grantee });

          expect(await authorizer.canPerform(ACTION_1, grantee, EVERYWHERE)).to.be.true;
          expect(await authorizer.canPerform(ACTION_2, grantee, EVERYWHERE)).to.be.true;
        });
      });
    });
  });

  describe('renouncePermissionsGlobally', () => {
    context('when the sender does not have the permission granted', () => {
      it('ignores the request and still cannot perform the requested actions everywhere', async () => {
        await expect(authorizer.renouncePermissionsGlobally(ACTIONS, { from: grantee })).not.to.be.reverted;

        expect(await authorizer.canPerform(ACTION_1, grantee, EVERYWHERE)).to.be.false;
        expect(await authorizer.canPerform(ACTION_2, grantee, EVERYWHERE)).to.be.false;
      });

      it('ignores the request and still cannot perform the requested actions in any specific contract', async () => {
        await expect(authorizer.renouncePermissionsGlobally(ACTIONS, { from: grantee })).not.to.be.reverted;

        expect(await authorizer.canPerform(ACTION_1, grantee, NOT_WHERE)).to.be.false;
        expect(await authorizer.canPerform(ACTION_2, grantee, NOT_WHERE)).to.be.false;
      });
    });

    context('when the sender has the permission granted', () => {
      context('when the sender has the permission granted for a specific contract', () => {
        sharedBeforeEach('grant permissions', async () => {
          await authorizer.grantPermissions(ACTIONS, grantee, WHERE, { from: root });
        });

        it('still can perform the requested actions for the requested contracts', async () => {
          await authorizer.renouncePermissionsGlobally(ACTIONS, { from: grantee });

          expect(await authorizer.canPerform(ACTION_1, grantee, WHERE_1)).to.be.true;
          expect(await authorizer.canPerform(ACTION_2, grantee, WHERE_2)).to.be.true;
        });

        it('still cannot perform the requested actions everywhere', async () => {
          await authorizer.renouncePermissionsGlobally(ACTIONS, { from: grantee });

          expect(await authorizer.canPerform(ACTION_1, grantee, EVERYWHERE)).to.be.false;
          expect(await authorizer.canPerform(ACTION_2, grantee, EVERYWHERE)).to.be.false;
        });
      });

      context('when the sender has the permission granted globally', () => {
        sharedBeforeEach('grant permissions', async () => {
          await authorizer.grantPermissionsGlobally(ACTIONS, grantee, { from: root });
        });

        it('revokes the requested permissions everywhere', async () => {
          await authorizer.renouncePermissionsGlobally(ACTIONS, { from: grantee });

          expect(await authorizer.canPerform(ACTION_1, grantee, EVERYWHERE)).to.be.false;
          expect(await authorizer.canPerform(ACTION_2, grantee, EVERYWHERE)).to.be.false;
        });

        it('still cannot perform the requested actions in any specific contract', async () => {
          await authorizer.renouncePermissionsGlobally(ACTIONS, { from: grantee });

          expect(await authorizer.canPerform(ACTION_1, grantee, NOT_WHERE)).to.be.false;
          expect(await authorizer.canPerform(ACTION_2, grantee, NOT_WHERE)).to.be.false;
        });
      });
    });
  });

  describe('setDelay', () => {
    const action = ACTION_1;

    context('when the sender is the root', () => {
      context('when the new delay is less than 2 years', () => {
        const delay = DAY;

        context('when the action is scheduled', () => {
          let expectedData: string;

          sharedBeforeEach('compute expected data', async () => {
            expectedData = authorizer.instance.interface.encodeFunctionData('setDelay', [action, delay]);
          });

          context('when the delay is less than or equal to the delay to set the authorizer in the vault', () => {
            sharedBeforeEach('set delay to set authorizer', async () => {
              const setAuthorizerAction = await actionId(vault, 'setAuthorizer');
              await authorizer.scheduleAndExecuteDelayChange(setAuthorizerAction, delay * 2, { from: root });
            });

            function itSchedulesTheDelayChangeCorrectly(expectedDelay: number) {
              it('schedules a delay change', async () => {
                const id = await authorizer.scheduleDelayChange(action, delay, [], { from: root });

                const scheduledExecution = await authorizer.getScheduledExecution(id);
                expect(scheduledExecution.executed).to.be.false;
                expect(scheduledExecution.data).to.be.equal(expectedData);
                expect(scheduledExecution.where).to.be.equal(authorizer.address);
                expect(scheduledExecution.protected).to.be.false;
                expect(scheduledExecution.executableAt).to.be.at.almostEqual(
                  (await currentTimestamp()).add(expectedDelay)
                );
              });

              it('can be executed after the expected delay', async () => {
                const id = await authorizer.scheduleDelayChange(action, delay, [], { from: root });

                await advanceTime(expectedDelay);
                await authorizer.execute(id);
                expect(await authorizer.delay(action)).to.be.equal(delay);
              });

              it('emits an event', async () => {
                const id = await authorizer.scheduleDelayChange(action, delay, [], { from: root });

                await advanceTime(expectedDelay);
                const receipt = await authorizer.execute(id);
                expectEvent.inReceipt(await receipt.wait(), 'ActionDelaySet', { actionId: action, delay });
              });
            }

            context('when the delay is being increased', () => {
              context('when there was no previous delay', () => {
                itSchedulesTheDelayChangeCorrectly(MINIMUM_EXECUTION_DELAY);
              });

              context('when there was a previous delay set', () => {
                const previousDelay = delay / 2;

                sharedBeforeEach('set previous delay', async () => {
                  await authorizer.scheduleAndExecuteDelayChange(action, previousDelay, { from: root });
                });

                itSchedulesTheDelayChangeCorrectly(MINIMUM_EXECUTION_DELAY);
              });
            });

            context('when the delay is being decreased', () => {
              const previousDelay = delay * 2;
              const executionDelay = Math.max(previousDelay - delay, MINIMUM_EXECUTION_DELAY);

              sharedBeforeEach('set previous delay', async () => {
                await authorizer.scheduleAndExecuteDelayChange(action, previousDelay, { from: root });
              });

              itSchedulesTheDelayChangeCorrectly(executionDelay);
            });
          });

          context('when the delay is greater than the delay to set the authorizer in the vault', () => {
            it('reverts on execution', async () => {
              const id = await authorizer.scheduleDelayChange(action, delay, [], { from: root });
              await advanceTime(MINIMUM_EXECUTION_DELAY);
              await expect(authorizer.execute(id)).to.be.revertedWith('DELAY_EXCEEDS_SET_AUTHORIZER');
            });
          });
        });

        context('when the action is performed directly', () => {
          it('reverts', async () => {
            await expect(authorizer.instance.setDelay(action, delay)).to.be.revertedWith('CAN_ONLY_BE_SCHEDULED');
          });
        });
      });

      context('when the new delay is more than 2 years', () => {
        const delay = DAY * 900;

        it('reverts', async () => {
          await expect(authorizer.scheduleDelayChange(action, delay, [])).to.be.revertedWith('DELAY_TOO_LARGE');
        });
      });
    });

    context('when the sender is not the root', () => {
      sharedBeforeEach('grant permission', async () => {
        // We never check that the caller has this permission but if we were to check a permission
        // it would be this one, we then grant it to the caller so we can be sure about why the call is reverting.
        const setDelayActionId = await authorizer.getScheduleDelayActionId(action);
        await authorizer.grantPermissions(setDelayActionId, grantee, authorizer, { from: root });
      });

      it('reverts', async () => {
        await expect(authorizer.scheduleDelayChange(action, DAY, [], { from: grantee })).to.be.revertedWith(
          'SENDER_IS_NOT_ROOT'
        );
      });
    });
  });

  describe('schedule', () => {
    const delay = DAY * 5;
    const functionData = '0x0123456789abcdef';

    let where: Contract, action: string, data: string, executors: SignerWithAddress[];
    let anotherAuthenticatedContract: Contract;

    sharedBeforeEach('deploy sample instances', async () => {
      anotherAuthenticatedContract = await deploy('MockAuthenticatedContract', { args: [vault.address] });
    });

    sharedBeforeEach('set authorizer permission delay', async () => {
      // We must set a delay for the `setAuthorizer` function as well to be able to give one to `protectedFunction`
      const setAuthorizerAction = await actionId(vault, 'setAuthorizer');
      await authorizer.scheduleAndExecuteDelayChange(setAuthorizerAction, 2 * delay, { from: root });
    });

    const schedule = async (): Promise<number> => {
      data = authenticatedContract.interface.encodeFunctionData('protectedFunction', [functionData]);
      return authorizer.schedule(where, data, executors || [], { from: grantee });
    };

    context('when the target is not the authorizer', () => {
      sharedBeforeEach('set where', async () => {
        where = authenticatedContract;
      });

      context('when the sender has permission', () => {
        context('when the sender has permission for the requested action', () => {
          sharedBeforeEach('set action', async () => {
            action = await actionId(authenticatedContract, 'protectedFunction');
          });

          context('when the sender has permission for the requested contract', () => {
            sharedBeforeEach('grant permission', async () => {
              await authorizer.grantPermissions(action, grantee, authenticatedContract, { from: root });
            });

            context('when there is a delay set', () => {
              const delay = DAY * 5;

              sharedBeforeEach('set delay', async () => {
                await authorizer.scheduleAndExecuteDelayChange(action, delay, { from: root });
              });

              context('when no executors are specified', () => {
                sharedBeforeEach('set executors', async () => {
                  executors = [];
                });

                it('schedules a non-protected execution', async () => {
                  const id = await schedule();

                  const scheduledExecution = await authorizer.getScheduledExecution(id);
                  expect(scheduledExecution.executed).to.be.false;
                  expect(scheduledExecution.data).to.be.equal(data);
                  expect(scheduledExecution.where).to.be.equal(where.address);
                  expect(scheduledExecution.protected).to.be.false;
                  expect(scheduledExecution.executableAt).to.be.at.almostEqual((await currentTimestamp()).add(delay));
                });

                it('cannot execute the action immediately', async () => {
                  const id = await schedule();
                  await expect(authorizer.execute(id)).to.be.revertedWith('ACTION_NOT_YET_EXECUTABLE');
                });

                it('can be executed by anyone', async () => {
                  const id = await schedule();
                  await advanceTime(delay);

                  const receipt = await authorizer.execute(id);
                  expectEvent.inReceipt(await receipt.wait(), 'ExecutionExecuted', { scheduledExecutionId: id });

                  const scheduledExecution = await authorizer.getScheduledExecution(id);
                  expect(scheduledExecution.executed).to.be.true;

                  expectEvent.inIndirectReceipt(
                    await receipt.wait(),
                    authenticatedContract.interface,
                    'ProtectedFunctionCalled',
                    {
                      data: functionData,
                    }
                  );
                });

                it('cannot be executed twice', async () => {
                  const id = await schedule();
                  await advanceTime(delay);

                  await authorizer.execute(id);
                  await expect(authorizer.execute(id)).to.be.revertedWith('ACTION_ALREADY_EXECUTED');
                });

                it('receives canceler status', async () => {
                  const id = await schedule();

                  expect(await authorizer.isCanceler(id, grantee)).to.be.true;
                });

                it('can cancel the action immediately', async () => {
                  const id = await schedule();
                  // should not revert
                  const receipt = await authorizer.cancel(id, { from: grantee });
                  expectEvent.inReceipt(await receipt.wait(), 'ExecutionCancelled', { scheduledExecutionId: id });
                });
              });

              context('when an executor is specified', () => {
                sharedBeforeEach('set executors', async () => {
                  executors = [other];
                });

                it('schedules the requested execution', async () => {
                  const id = await schedule();

                  const scheduledExecution = await authorizer.getScheduledExecution(id);
                  expect(scheduledExecution.executed).to.be.false;
                  expect(scheduledExecution.data).to.be.equal(data);
                  expect(scheduledExecution.where).to.be.equal(where.address);
                  expect(scheduledExecution.protected).to.be.true;
                  expect(scheduledExecution.executableAt).to.be.at.almostEqual((await currentTimestamp()).add(delay));
                });

                it('emits ExecutorAdded events', async () => {
                  const receipt = await authorizer.instance.connect(grantee).schedule(
                    where.address,
                    data,
                    executors.map((e) => e.address)
                  );

                  for (const executor of executors) {
                    expectEvent.inReceipt(await receipt.wait(), 'ExecutorAdded', { executor: executor.address });
                  }
                });

                it('cannot execute the action immediately', async () => {
                  const id = await schedule();
                  await expect(authorizer.execute(id, { from: executors[0] })).to.be.revertedWith(
                    'ACTION_NOT_YET_EXECUTABLE'
                  );
                });

                it('can be executed by the executor only', async () => {
                  const id = await schedule();
                  await advanceTime(delay);

                  await expect(authorizer.execute(id, { from: grantee })).to.be.revertedWith('SENDER_IS_NOT_EXECUTOR');

                  const receipt = await authorizer.execute(id, { from: executors[0] });
                  expectEvent.inReceipt(await receipt.wait(), 'ExecutionExecuted', { scheduledExecutionId: id });

                  const scheduledExecution = await authorizer.getScheduledExecution(id);
                  expect(scheduledExecution.executed).to.be.true;

                  expectEvent.inIndirectReceipt(
                    await receipt.wait(),
                    authenticatedContract.interface,
                    'ProtectedFunctionCalled',
                    {
                      data: functionData,
                    }
                  );
                });

                it('cannot be executed twice', async () => {
                  const id = await schedule();
                  await advanceTime(delay);

                  await authorizer.execute(id, { from: executors[0] });
                  await expect(authorizer.execute(id, { from: executors[0] })).to.be.revertedWith(
                    'ACTION_ALREADY_EXECUTED'
                  );
                });
              });
            });

            context('when there is no delay set', () => {
              it('reverts', async () => {
                await expect(schedule()).to.be.revertedWith('CANNOT_SCHEDULE_ACTION');
              });
            });
          });

          context('when the sender has permissions for another contract', () => {
            sharedBeforeEach('grant permission', async () => {
              await authorizer.grantPermissions(action, grantee, anotherAuthenticatedContract, { from: root });
            });

            it('reverts', async () => {
              await expect(schedule()).to.be.revertedWith('SENDER_DOES_NOT_HAVE_PERMISSION');
            });
          });
        });

        context('when the sender has permissions for another action', () => {
          sharedBeforeEach('grant permission', async () => {
            action = await actionId(authenticatedContract, 'secondProtectedFunction');
            await authorizer.grantPermissions(action, grantee, authenticatedContract, { from: root });
          });

          it('reverts', async () => {
            await expect(schedule()).to.be.revertedWith('SENDER_DOES_NOT_HAVE_PERMISSION');
          });
        });
      });

      context('when the sender does not have permission', () => {
        it('reverts', async () => {
          await expect(schedule()).to.be.revertedWith('SENDER_DOES_NOT_HAVE_PERMISSION');
        });
      });
    });

    context('when the target is the authorizer', () => {
      sharedBeforeEach('set where', async () => {
        where = authorizer.instance;
      });

      it('reverts', async () => {
        await expect(schedule()).to.be.revertedWith('CANNOT_SCHEDULE_AUTHORIZER_ACTIONS');
      });
    });

    context('when the target is the executor', () => {
      sharedBeforeEach('set where', async () => {
        where = await authorizer.instance.getExecutor();
      });

      it('reverts', async () => {
        await expect(schedule()).to.be.revertedWith('ATTEMPTING_EXECUTOR_REENTRANCY');
      });
    });
  });

  describe('execute', () => {
    const delay = DAY;
    const functionData = '0x0123456789abcdef';
    let executors: SignerWithAddress[];

    sharedBeforeEach('grant protected function permission with delay', async () => {
      // We must set a delay for the `setAuthorizer` function as well to be able to give one to `protectedFunction`
      const setAuthorizerAction = await actionId(vault, 'setAuthorizer');
      await authorizer.scheduleAndExecuteDelayChange(setAuthorizerAction, delay, { from: root });

      const protectedFunctionAction = await actionId(authenticatedContract, 'protectedFunction');
      await authorizer.scheduleAndExecuteDelayChange(protectedFunctionAction, delay, { from: root });
      await authorizer.grantPermissions(protectedFunctionAction, grantee, authenticatedContract, { from: root });
    });

    const schedule = async (): Promise<number> => {
      const data = authenticatedContract.interface.encodeFunctionData('protectedFunction', [functionData]);
      return authorizer.schedule(authenticatedContract, data, executors || [], { from: grantee });
    };

    context('when the given id is valid', () => {
      let id: BigNumberish;

      context('when the action is protected', () => {
        sharedBeforeEach('set executors', async () => {
          executors = [root, other];
        });

        context('when the sender is an allowed executor', () => {
          itLetsExecutorExecute(0);
          itLetsExecutorExecute(1);

          function itLetsExecutorExecute(index: number) {
            context(`with executor #${index}`, () => {
              sharedBeforeEach('set sender', async () => {
                if (index >= executors.length) throw new Error('Invalid executor index');
                from = executors[index];
              });

              context('when the action was not cancelled', () => {
                sharedBeforeEach('schedule execution', async () => {
                  id = await schedule();
                });

                it('sender is marked as an executor', async () => {
                  expect(await authorizer.instance.isExecutor(id, from.address)).to.be.true;
                });

                context('when the delay has passed', () => {
                  sharedBeforeEach('advance time', async () => {
                    await advanceTime(delay);
                  });

                  it('executes the action', async () => {
                    const receipt = await authorizer.execute(id, { from });

                    const scheduledExecution = await authorizer.getScheduledExecution(id);
                    expect(scheduledExecution.executed).to.be.true;

                    expectEvent.inIndirectReceipt(
                      await receipt.wait(),
                      authenticatedContract.interface,
                      'ProtectedFunctionCalled',
                      { data: functionData }
                    );
                  });

                  it('emits an event', async () => {
                    const receipt = await authorizer.execute(id, { from });

                    expectEvent.inReceipt(await receipt.wait(), 'ExecutionExecuted', {
                      scheduledExecutionId: id,
                    });
                  });

                  it('cannot be executed twice', async () => {
                    await authorizer.execute(id, { from });

                    await expect(authorizer.execute(id, { from })).to.be.revertedWith('ACTION_ALREADY_EXECUTED');
                  });
                });

                context('when the delay has not passed', () => {
                  it('reverts', async () => {
                    await expect(authorizer.execute(id, { from })).to.be.revertedWith('ACTION_NOT_YET_EXECUTABLE');
                  });
                });
              });

              context('when the action was cancelled', () => {
                sharedBeforeEach('schedule and cancel action', async () => {
                  id = await schedule();
                  await authorizer.cancel(id, { from: grantee });
                });

                it('reverts', async () => {
                  await expect(authorizer.execute(id, { from })).to.be.revertedWith('ACTION_ALREADY_CANCELLED');
                });
              });
            });
          }
        });

        context('when the sender is not an allowed executor', () => {
          it('reverts', async () => {
            id = await schedule();
            await advanceTime(delay);

            await expect(authorizer.execute(id, { from: grantee })).to.be.revertedWith('SENDER_IS_NOT_EXECUTOR');
          });
        });
      });

      context('when the action is not protected', () => {
        sharedBeforeEach('set executors', async () => {
          executors = [];
        });

        it('can be executed by anyone', async () => {
          id = await schedule();
          await advanceTime(delay);

          const receipt = await authorizer.execute(id);

          const scheduledExecution = await authorizer.getScheduledExecution(id);
          expect(scheduledExecution.executed).to.be.true;

          expectEvent.inIndirectReceipt(
            await receipt.wait(),
            authenticatedContract.interface,
            'ProtectedFunctionCalled',
            {
              data: functionData,
            }
          );
        });
      });
    });

    context('when the given id is not valid', () => {
      it('reverts', async () => {
        await expect(authorizer.execute(100)).to.be.revertedWith('ACTION_DOES_NOT_EXIST');
      });
    });
  });

  describe('cancel', () => {
    const delay = DAY;
    let executors: SignerWithAddress[];

    sharedBeforeEach('grant protected function permission with delay', async () => {
      // We must set a delay for the `setAuthorizer` function as well to be able to give one to `protectedFunction`
      const setAuthorizerAction = await actionId(vault, 'setAuthorizer');
      await authorizer.scheduleAndExecuteDelayChange(setAuthorizerAction, delay, { from: root });

      const protectedFunctionAction = await actionId(authenticatedContract, 'protectedFunction');
      await authorizer.scheduleAndExecuteDelayChange(protectedFunctionAction, delay, { from: root });
      await authorizer.grantPermissions(protectedFunctionAction, grantee, authenticatedContract, { from: root });
    });

    const schedule = async (): Promise<number> => {
      const data = authenticatedContract.interface.encodeFunctionData('protectedFunction', ['0x']);
      return authorizer.schedule(authenticatedContract, data, executors || [], { from: grantee });
    };

    context('when the given id is valid', () => {
      let id: BigNumberish;

      function itCancelsTheScheduledAction() {
        context('when the action was not executed', () => {
          sharedBeforeEach('schedule execution', async () => {
            id = await schedule();
          });

          it('cancels the action', async () => {
            await authorizer.cancel(id, { from });

            const scheduledExecution = await authorizer.getScheduledExecution(id);
            expect(scheduledExecution.cancelled).to.be.true;
          });

          it('emits an event', async () => {
            const receipt = await authorizer.cancel(id, { from });

            expectEvent.inReceipt(await receipt.wait(), 'ExecutionCancelled', { scheduledExecutionId: id });
          });

          it('cannot be cancelled twice', async () => {
            await authorizer.cancel(id, { from });

            await expect(authorizer.cancel(id, { from })).to.be.revertedWith('ACTION_ALREADY_CANCELLED');
          });
        });

        context('when the action was executed', () => {
          sharedBeforeEach('schedule and execute action', async () => {
            id = await schedule();
            await advanceTime(delay);
            await authorizer.execute(id);
          });

          it('reverts', async () => {
            await expect(authorizer.cancel(id, { from })).to.be.revertedWith('ACTION_ALREADY_EXECUTED');
          });
        });
      }

      context('when the sender has permission for the requested action', () => {
        sharedBeforeEach('set sender', async () => {
          from = grantee;
        });

        itCancelsTheScheduledAction();
      });

      context('when the sender is root', () => {
        sharedBeforeEach('set sender', async () => {
          from = root;
        });

        itCancelsTheScheduledAction();
      });

      context('when the sender does not have permission for the requested action', () => {
        sharedBeforeEach('set sender', async () => {
          from = other;
        });

        it('reverts', async () => {
          id = await schedule();

          await expect(authorizer.cancel(id, { from })).to.be.revertedWith('SENDER_IS_NOT_CANCELER');
        });
      });
    });

    context('when the given id is not valid', () => {
      it('reverts', async () => {
        await expect(authorizer.cancel(100)).to.be.revertedWith('ACTION_DOES_NOT_EXIST');
      });
    });
  });

  describe('setPendingRoot', () => {
    let ROOT_CHANGE_DELAY: BigNumberish;

    beforeEach('fetch root change delay', async () => {
      ROOT_CHANGE_DELAY = await authorizer.instance.getRootTransferDelay();
    });

    it('sets the nextRoot as the pending root during construction', async () => {
      expect(await authorizer.instance.getPendingRoot()).to.equal(nextRoot.address);
    });

    context('when the sender is the root', async () => {
      context('when trying to execute it directly', async () => {
        it('reverts', async () => {
          await expect(authorizer.instance.setPendingRoot(grantee.address)).to.be.revertedWith('CAN_ONLY_BE_SCHEDULED');
        });
      });

      context('when trying to schedule a call', async () => {
        let newPendingRoot: SignerWithAddress;

        function itSetsThePendingRootCorrectly() {
          it('schedules a root change', async () => {
            const expectedData = authorizer.instance.interface.encodeFunctionData('setPendingRoot', [
              newPendingRoot.address,
            ]);

            const id = await authorizer.scheduleRootChange(newPendingRoot, [], { from: root });

            const scheduledExecution = await authorizer.getScheduledExecution(id);
            expect(scheduledExecution.executed).to.be.false;
            expect(scheduledExecution.data).to.be.equal(expectedData);
            expect(scheduledExecution.where).to.be.equal(authorizer.address);
            expect(scheduledExecution.protected).to.be.false;
            expect(scheduledExecution.executableAt).to.be.at.almostEqual(
              (await currentTimestamp()).add(ROOT_CHANGE_DELAY)
            );
          });

          it('can be executed after the delay', async () => {
            const id = await authorizer.scheduleRootChange(newPendingRoot, [], { from: root });

            await expect(authorizer.execute(id)).to.be.revertedWith('ACTION_NOT_YET_EXECUTABLE');

            await advanceTime(ROOT_CHANGE_DELAY);
            await authorizer.execute(id);

            expect(await authorizer.isRoot(root)).to.be.true;
            expect(await authorizer.isPendingRoot(newPendingRoot)).to.be.true;
          });

          it('emits an event', async () => {
            const id = await authorizer.scheduleRootChange(newPendingRoot, [], { from: root });

            await advanceTime(ROOT_CHANGE_DELAY);
            const receipt = await authorizer.execute(id);
            expectEvent.inReceipt(await receipt.wait(), 'PendingRootSet', { pendingRoot: newPendingRoot.address });
          });
        }

        before('set desired pending root', () => {
          newPendingRoot = grantee;
        });

        itSetsThePendingRootCorrectly();

        context('starting a new root transfer while pending root is set', () => {
          // We test this to ensure that executing an action which sets the pending root to an address which cannot
          // call `claimRoot` won't result in the Authorizer being unable to transfer root power to a different address.

          sharedBeforeEach('initiate a root transfer', async () => {
            const id = await authorizer.scheduleRootChange(grantee, [], { from: root });
            await advanceTime(ROOT_CHANGE_DELAY);
            await authorizer.execute(id);
          });

          before('set desired pending root', () => {
            newPendingRoot = other;
          });

          itSetsThePendingRootCorrectly();
        });
      });
    });

    context('when the sender is not the root', async () => {
      it('reverts', async () => {
        await expect(authorizer.scheduleRootChange(grantee, [], { from: grantee })).to.be.revertedWith(
          'SENDER_IS_NOT_ROOT'
        );
      });
    });
  });

  describe('claimRoot', () => {
    let ROOT_CHANGE_DELAY: BigNumberish;

    beforeEach('fetch root change delay', async () => {
      ROOT_CHANGE_DELAY = await authorizer.instance.getRootTransferDelay();
    });

    sharedBeforeEach('initiate a root transfer', async () => {
      const id = await authorizer.scheduleRootChange(grantee, [], { from: root });
      await advanceTime(ROOT_CHANGE_DELAY);
      await authorizer.execute(id);
    });

    context('when the sender is the pending root', async () => {
      it('transfers root powers from the current to the pending root', async () => {
        await authorizer.claimRoot({ from: grantee });
        expect(await authorizer.isRoot(root)).to.be.false;
        expect(await authorizer.isRoot(grantee)).to.be.true;
      });

      it('revokes powers to grant and revoke GENERAL_PERMISSION_SPECIFIER on EVERYWHERE from current root', async () => {
        expect(await authorizer.isGranter(GENERAL_PERMISSION_SPECIFIER, root, EVERYWHERE)).to.be.true;
        expect(await authorizer.isRevoker(GENERAL_PERMISSION_SPECIFIER, root, EVERYWHERE)).to.be.true;
        await authorizer.claimRoot({ from: grantee });
        expect(await authorizer.isGranter(GENERAL_PERMISSION_SPECIFIER, root, EVERYWHERE)).to.be.false;
        expect(await authorizer.isRevoker(GENERAL_PERMISSION_SPECIFIER, root, EVERYWHERE)).to.be.false;
      });

      it('grants powers to grant and revoke GENERAL_PERMISSION_SPECIFIER on EVERYWHERE to the pending root', async () => {
        expect(await authorizer.isGranter(GENERAL_PERMISSION_SPECIFIER, grantee, EVERYWHERE)).to.be.false;
        expect(await authorizer.isRevoker(GENERAL_PERMISSION_SPECIFIER, grantee, EVERYWHERE)).to.be.false;
        await authorizer.claimRoot({ from: grantee });
        expect(await authorizer.isGranter(GENERAL_PERMISSION_SPECIFIER, grantee, EVERYWHERE)).to.be.true;
        expect(await authorizer.isRevoker(GENERAL_PERMISSION_SPECIFIER, grantee, EVERYWHERE)).to.be.true;
      });

      it('resets the pending root address to the zero address', async () => {
        await authorizer.claimRoot({ from: grantee });
        expect(await authorizer.isPendingRoot(root)).to.be.false;
        expect(await authorizer.isPendingRoot(grantee)).to.be.false;
        expect(await authorizer.isPendingRoot(ZERO_ADDRESS)).to.be.true;
      });

      it('emits an event', async () => {
        const receipt = await authorizer.claimRoot({ from: grantee });
        expectEvent.inReceipt(await receipt.wait(), 'RootSet', { root: grantee.address });
        expectEvent.inReceipt(await receipt.wait(), 'PendingRootSet', { pendingRoot: ZERO_ADDRESS });
      });
    });

    context('when the sender is not the pending root', async () => {
      it('reverts', async () => {
        await expect(authorizer.claimRoot({ from: other })).to.be.revertedWith('SENDER_IS_NOT_PENDING_ROOT');
      });
    });
  });
});
