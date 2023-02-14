import { ethers } from 'hardhat';
import { expect } from 'chai';
import { Contract, ContractReceipt } from 'ethers';
import { SignerWithAddress } from '@nomiclabs/hardhat-ethers/dist/src/signer-with-address';
import * as expectEvent from '@balancer-labs/v2-helpers/src/test/expectEvent';
import { deploy } from '@balancer-labs/v2-helpers/src/contract';
import Vault from '@balancer-labs/v2-helpers/src/models/vault/Vault';
import { MAX_UINT256 } from '@balancer-labs/v2-helpers/src/constants';
import { actionId } from '@balancer-labs/v2-helpers/src/models/misc/actions';
import { sharedBeforeEach } from '@balancer-labs/v2-common/sharedBeforeEach';

describe('ProtocolIdRegistry', () => {
  let admin: SignerWithAddress, authorizedUser: SignerWithAddress, other: SignerWithAddress;
  let authorizer: Contract, vault: Contract;
  let registry: Contract;

  before(async () => {
    [, admin, authorizedUser, other] = await ethers.getSigners();
  });

  sharedBeforeEach('deploy vault and ProtocolIdRegistry', async () => {
    ({ instance: vault, authorizer } = await Vault.create({ admin }));
    registry = await deploy('ProtocolIdRegistry', {
      args: [vault.address],
    });
  });

  sharedBeforeEach('grant permissions', async () => {
    await authorizer.connect(admin).grantPermissions(
      ['registerProtocolId', 'renameProtocolId'].map((fn) => actionId(registry, fn)),
      authorizedUser.address,
      [registry.address, registry.address]
    );
  });

  describe('Constructor', () => {
    it('events are emitted for protocols initialized in the constructor', async () => {
      expect(
        await deploy('ProtocolIdRegistry', {
          args: [vault.address],
        })
      ).to.emit('ProtocolIdRegistry', 'ProtocolIdRegistered');
    });

    context('Aave v1 protocol is registered with protocol id 0', async () => {
      it('Protocol Id is valid', async () => {
        expect(await registry.isValidProtocolId(0)).to.equal(true);
      });

      it('Protocol name is correct', async () => {
        expect(await registry.getProtocolName(0)).to.equal('Aave v1');
      });
    });
  });

  describe('Registration', () => {
    const newProtocolId = 1000000000;
    const newProtocolName = 'Test Protocol';
    let transactionReceipt: ContractReceipt;

    context('authorized user', async () => {
      sharedBeforeEach('register protocol', async () => {
        transactionReceipt = await (
          await registry.connect(authorizedUser).registerProtocolId(newProtocolId, newProtocolName)
        ).wait();
      });

      it('event emitted', async () => {
        expectEvent.inReceipt(transactionReceipt, 'ProtocolIdRegistered', {
          protocolId: newProtocolId,
          name: newProtocolName,
        });
      });

      it('new ID is valid', async () => {
        expect(await registry.isValidProtocolId(newProtocolId)).to.equal(true);
      });
      it('name matches ID', async () => {
        expect(await registry.getProtocolName(newProtocolId)).to.equal(newProtocolName);
      });
      it('reverts when registering existing ID', async () => {
        await expect(registry.connect(authorizedUser).registerProtocolId(0, 'Test Protocol')).to.be.revertedWith(
          'Protocol ID already registered'
        );
      });
    });

    context('non-authorized user', async () => {
      it('registration gets reverted', async () => {
        await expect(registry.connect(other).registerProtocolId(newProtocolId, newProtocolName)).to.be.revertedWith(
          'BAL#401'
        );
      });
    });
  });

  describe('Unregistered queries', () => {
    it('searching for name in non-existent protocol ID', async () => {
      await expect(registry.getProtocolName(MAX_UINT256)).to.be.revertedWith('Non-existent protocol ID');
    });
    it('check non-valid ID', async () => {
      expect(await registry.isValidProtocolId(MAX_UINT256)).to.equal(false);
    });
  });

  describe('renaming protocol IDs', async () => {
    const newName = 'Test Protocol';

    it('successful renaming with authorized user', async () => {
      await registry.connect(authorizedUser).renameProtocolId(0, newName);
      expect(await registry.getProtocolName(0)).is.equal(newName);
    });

    it('trying to rename a non-registered Id', async () => {
      await expect(registry.connect(authorizedUser).renameProtocolId(MAX_UINT256, newName)).to.be.revertedWith(
        'Protocol ID not registered'
      );
    });

    it('Unauthorized user not able to rename an ID', async () => {
      await expect(registry.connect(other).renameProtocolId(1, newName)).to.be.revertedWith('BAL#401');
    });
  });
});
