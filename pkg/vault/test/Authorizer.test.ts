import { ethers } from 'hardhat';
import { Contract } from 'ethers';
import { SignerWithAddress } from '@nomiclabs/hardhat-ethers/dist/src/signer-with-address';

import { deploy } from '@balancer-labs/v2-helpers/src/contract';
import { expect } from 'chai';
import { ZERO_ADDRESS } from '@balancer-labs/v2-helpers/src/constants';

describe('Authorizer', () => {
  let authorizer: Contract;
  let admin: SignerWithAddress, grantee: SignerWithAddress;

  const ANYWHERE = ZERO_ADDRESS;

  before('setup signers', async () => {
    [, admin, grantee] = await ethers.getSigners();
  });

  const ROLE_1 = '0x0000000000000000000000000000000000000000000000000000000000000001';
  const ROLE_2 = '0x0000000000000000000000000000000000000000000000000000000000000002';

  const ROLES = [ROLE_1, ROLE_2];
  const WHERE = [ethers.Wallet.createRandom().address, ethers.Wallet.createRandom().address];
  const NOT_WHERE = ethers.Wallet.createRandom().address;

  sharedBeforeEach('deploy authorizer', async () => {
    authorizer = await deploy('Authorizer', { args: [admin.address] });
  });

  describe('grantRoles', () => {
    context('when the sender is the admin', () => {
      beforeEach('set sender', async () => {
        authorizer = authorizer.connect(admin);
      });

      it('grants a list of roles globally', async () => {
        await authorizer.grantRolesGlobally(ROLES, grantee.address);

        for (const role of ROLES) {
          expect(await authorizer.canPerform(role, grantee.address, ANYWHERE)).to.be.true;
          expect(await authorizer.canPerform(role, grantee.address, NOT_WHERE)).to.be.true;
        }
      });

      it('grants a list of roles for a list of contracts', async () => {
        await authorizer.grantRoles(ROLES, grantee.address, WHERE);

        for (const role of ROLES) {
          for (const where of WHERE) {
            expect(await authorizer.canPerform(role, grantee.address, where)).to.be.true;
            expect(await authorizer.canPerform(role, grantee.address, NOT_WHERE)).to.be.false;
          }
        }
      });
    });

    context('when the sender is not the admin', () => {
      beforeEach('set sender', async () => {
        authorizer = authorizer.connect(grantee);
      });

      it('reverts globally', async () => {
        await expect(authorizer.grantRolesGlobally(ROLES, grantee.address)).to.be.revertedWith(
          'GRANT_SENDER_NOT_ADMIN'
        );
      });
      it('reverts for specific roles', async () => {
        await expect(authorizer.grantRoles(ROLES, grantee.address, WHERE)).to.be.revertedWith('GRANT_SENDER_NOT_ADMIN');
      });
    });
  });

  describe('revokeRoles', () => {
    context('when the sender is the admin', () => {
      beforeEach('set sender', async () => {
        authorizer = authorizer.connect(admin);
      });

      context('when the roles ANYWHERE granted to a set of contracts', () => {
        sharedBeforeEach('grant permissions', async () => {
          await authorizer.grantRoles(ROLES, grantee.address, WHERE);
        });

        it('revokes a list of roles', async () => {
          await authorizer.revokeRoles(ROLES, grantee.address, WHERE);

          for (const role of ROLES) {
            for (const where of WHERE) {
              expect(await authorizer.canPerform(role, grantee.address, where)).to.be.false;
            }
          }
        });
      });

      context('when the roles granted globally', () => {
        sharedBeforeEach('grant permissions', async () => {
          await authorizer.grantRolesGlobally(ROLES, grantee.address);
        });

        it('revokes a list of roles', async () => {
          await authorizer.revokeRolesGlobally(ROLES, grantee.address);

          for (const role of ROLES) {
            expect(await authorizer.canPerform(role, grantee.address, ANYWHERE)).to.be.false;
          }
        });
      });

      context('when one of the roles was not granted for a set of contracts', () => {
        sharedBeforeEach('grant one role', async () => {
          await authorizer.grantRoles([ROLE_1], grantee.address, WHERE);
        });

        it('ignores the request', async () => {
          await authorizer.revokeRoles(ROLES, grantee.address, WHERE);

          for (const role of ROLES) {
            for (const where of WHERE) {
              expect(await authorizer.canPerform(role, grantee.address, where)).to.be.false;
            }
          }
        });
      });

      context('when one of the roles was not granted globally', () => {
        sharedBeforeEach('grant one role', async () => {
          await authorizer.grantRolesGlobally([ROLE_1], grantee.address);
        });

        it('ignores the request', async () => {
          await authorizer.revokeRolesGlobally(ROLES, grantee.address);

          for (const role of ROLES) {
            expect(await authorizer.canPerform(role, grantee.address, ANYWHERE)).to.be.false;
          }
        });
      });
    });

    context('when the sender is not the admin', () => {
      beforeEach('set sender', async () => {
        authorizer = authorizer.connect(grantee);
      });

      it('reverts globally', async () => {
        await expect(authorizer.revokeRolesGlobally(ROLES, grantee.address)).to.be.revertedWith(
          'REVOKE_SENDER_NOT_ADMIN'
        );
      });

      it('reverts for a set of contracts', async () => {
        await expect(authorizer.revokeRoles(ROLES, grantee.address, WHERE)).to.be.revertedWith(
          'REVOKE_SENDER_NOT_ADMIN'
        );
      });
    });
  });

  describe('renounceRoles', () => {
    context('when the sender does not have the role', () => {
      it('ignores the request', async () => {
        await expect(authorizer.connect(grantee).renounceRoles(ROLES, WHERE)).not.to.be.reverted;
      });
    });

    context('when the sender has the role', () => {
      context('when the sender has the role for a specific contract', () => {
        sharedBeforeEach('grant permissions', async () => {
          await authorizer.connect(admin).grantRoles(ROLES, grantee.address, WHERE);
        });

        it('revokes the requested roles', async () => {
          await authorizer.connect(grantee).renounceRoles(ROLES, WHERE);

          for (const role of ROLES) {
            for (const where of WHERE) {
              expect(await authorizer.canPerform(role, grantee.address, where)).to.be.false;
            }
          }
        });
      });

      context('when the sender has the role globally', () => {
        sharedBeforeEach('grant permissions', async () => {
          await authorizer.connect(admin).grantRolesGlobally(ROLES, grantee.address);
        });

        it('does not revoke the role', async () => {
          await authorizer.connect(grantee).renounceRoles(ROLES, WHERE);

          for (const role of ROLES) {
            for (const where of WHERE) {
              expect(await authorizer.canPerform(role, grantee.address, where)).to.be.true;
            }
          }
        });
      });
    });
  });

  describe('renounceRolesGlobally', () => {
    context('when the sender does not have the role', () => {
      it('ignores the request', async () => {
        await expect(authorizer.connect(grantee).renounceRolesGlobally(ROLES)).not.to.be.reverted;
      });
    });

    context('when the sender has the role', () => {
      context('when the sender has the role for a specific contract', () => {
        sharedBeforeEach('grant permissions', async () => {
          await authorizer.connect(admin).grantRoles(ROLES, grantee.address, WHERE);
        });

        it('does not revoke the requested roles', async () => {
          await authorizer.connect(grantee).renounceRolesGlobally(ROLES);

          for (const role of ROLES) {
            for (const where of WHERE) {
              expect(await authorizer.canPerform(role, grantee.address, where)).to.be.true;
            }
          }
        });
      });

      context('when the sender has the role globally', () => {
        sharedBeforeEach('grant permissions', async () => {
          await authorizer.connect(admin).grantRolesGlobally(ROLES, grantee.address);
        });

        it('revokes the requested roles', async () => {
          await authorizer.connect(grantee).renounceRolesGlobally(ROLES);

          for (const role of ROLES) {
            for (const where of WHERE) {
              expect(await authorizer.canPerform(role, grantee.address, where)).to.be.false;
            }
          }
        });
      });
    });
  });
});
