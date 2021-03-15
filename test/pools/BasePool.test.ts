import { ethers } from 'hardhat';
import { expect } from 'chai';
import { Contract } from 'ethers';
import { SignerWithAddress } from '@nomiclabs/hardhat-ethers/dist/src/signer-with-address';

import TokenList from '../helpers/models/tokens/TokenList';
import { deploy } from '../../lib/helpers/deploy';
import { GeneralPool } from '../../lib/helpers/pools';
import { BigNumberish, fp } from '../../lib/helpers/numbers';
import { advanceTime, currentTimestamp, fromNow, DAY, MONTH } from '../../lib/helpers/time';

describe('BasePool', function () {
  let admin: SignerWithAddress, other: SignerWithAddress;
  let authorizer: Contract, vault: Contract;
  let tokens: TokenList;

  before(async () => {
    [, admin, other] = await ethers.getSigners();
  });

  sharedBeforeEach(async () => {
    authorizer = await deploy('Authorizer', { args: [admin.address] });
    vault = await deploy('Vault', { args: [authorizer.address] });
    tokens = await TokenList.create(['DAI', 'MKR', 'SNX'], { sorted: true });
  });

  function deployBasePool(params: {
    tokens?: TokenList | string[];
    swapFee?: BigNumberish;
    emergencyPeriod?: number;
    emergencyPeriodCheckExtension?: number;
  }): Promise<Contract> {
    let { tokens: poolTokens, swapFee, emergencyPeriod, emergencyPeriodCheckExtension } = params;
    if (!poolTokens) poolTokens = tokens;
    if (!swapFee) swapFee = 0;
    if (!emergencyPeriod) emergencyPeriod = 0;
    if (!emergencyPeriodCheckExtension) emergencyPeriodCheckExtension = 0;

    return deploy('MockBasePool', {
      args: [
        authorizer.address,
        vault.address,
        GeneralPool,
        'Balancer Pool Token',
        'BPT',
        Array.isArray(poolTokens) ? poolTokens : poolTokens.addresses,
        swapFee,
        emergencyPeriod,
        emergencyPeriodCheckExtension,
      ],
    });
  }

  describe('deployment', () => {
    it('registers a pool in the vault', async () => {
      const pool = await deployBasePool({ tokens });
      const poolId = await pool.getPoolId();

      const [poolAddress, poolSpecialization] = await vault.getPool(poolId);
      expect(poolAddress).to.equal(pool.address);
      expect(poolSpecialization).to.equal(GeneralPool);
    });

    it('reverts if the tokens are not sorted', async () => {
      await expect(deployBasePool({ tokens: tokens.addresses.reverse() })).to.be.revertedWith('UNSORTED_ARRAY');
    });
  });

  describe('swap fee', () => {
    it('has an initial swap fee', async () => {
      const swapFee = fp(0.003);
      const pool = await deployBasePool({ swapFee });

      expect(await pool.getSwapFee()).to.equal(swapFee);
    });

    it('can be initialized to the zero address', async () => {
      const swapFee = 0;
      const pool = await deployBasePool({ swapFee });

      expect(await pool.getSwapFee()).to.equal(swapFee);
    });
  });

  describe('set swap fee', () => {
    let pool: Contract;

    sharedBeforeEach('deploy pool', async () => {
      pool = await deployBasePool({ swapFee: fp(0.01) });
    });

    context('when the sender is has the role to do it', () => {
      let roleId: string;

      sharedBeforeEach('grant permission', async () => {
        roleId = await pool.CHANGE_POOL_SWAP_FEE_ROLE();
        await authorizer.connect(admin).grantRole(roleId, admin.address);
      });

      context('when the new swap fee is below the maximum', () => {
        it('can change the swap fee', async () => {
          expect(await pool.canChangeSwapFee(admin.address)).to.be.true;

          const newSwapFee = fp(0.000001);
          await pool.connect(admin).setSwapFee(newSwapFee);

          expect(await pool.getSwapFee()).to.equal(newSwapFee);
        });

        it('can change the swap fee to zero', async () => {
          expect(await pool.canChangeSwapFee(admin.address)).to.be.true;

          const newSwapFee = fp(0.000001);
          await pool.connect(admin).setSwapFee(newSwapFee);

          expect(await pool.getSwapFee()).to.equal(newSwapFee);
        });

        it('can not change the swap fee if the role was revoked', async () => {
          await authorizer.connect(admin).revokeRole(roleId, admin.address);

          expect(await pool.canChangeSwapFee(admin.address)).to.be.false;

          await expect(pool.connect(admin).setSwapFee(0)).to.be.revertedWith('SENDER_CANNOT_CHANGE_SWAP_FEE');
        });
      });

      context('when the new swap fee is not below the maximum', () => {
        const MAX_SWAP_FEE = fp(0.1);

        it('reverts', async () => {
          await expect(pool.connect(admin).setSwapFee(MAX_SWAP_FEE.add(1))).to.be.revertedWith('MAX_SWAP_FEE');
        });
      });
    });

    context('when the sender does not have the role to do it', () => {
      it('reverts', async () => {
        await expect(pool.connect(other).setSwapFee(0)).to.be.revertedWith('SENDER_CANNOT_CHANGE_SWAP_FEE');
      });
    });
  });

  describe('emergency period', () => {
    let pool: Contract;

    const assertEmergencyPeriod = async (
      expectedStatus: boolean,
      expectedEndDate?: BigNumberish,
      expectedCheckExtension?: BigNumberish
    ): Promise<void> => {
      const { active, endDate, checkEndDate } = await pool.getEmergencyPeriod();
      expect(active).to.equal(expectedStatus);
      if (expectedEndDate) expect(endDate).to.equal(expectedEndDate);
      if (expectedCheckExtension) expect(checkEndDate).to.equal(endDate.add(expectedCheckExtension));
    };

    context('initialization', () => {
      it('can be initialized with an emergency period', async () => {
        const emergencyPeriod = MONTH;
        const emergencyPeriodCheckExtension = MONTH;
        pool = await deployBasePool({ emergencyPeriod, emergencyPeriodCheckExtension });

        await assertEmergencyPeriod(false, await fromNow(emergencyPeriod), emergencyPeriodCheckExtension);
      });

      it('can be initialized without emergency period', async () => {
        const emergencyPeriod = 0;
        pool = await deployBasePool({ emergencyPeriod });

        await assertEmergencyPeriod(false, await currentTimestamp());
      });

      it('cannot be initialized with an emergency period greater than 90 days', async () => {
        const emergencyPeriod = DAY * 91;
        await expect(deployBasePool({ emergencyPeriod })).to.be.revertedWith('MAX_EMERGENCY_PERIOD');
      });

      it('cannot be initialized with an emergency period check extension greater than 30 days', async () => {
        const emergencyPeriod = MONTH;
        const emergencyPeriodCheckExtension = DAY * 31;
        await expect(deployBasePool({ emergencyPeriod, emergencyPeriodCheckExtension })).to.be.revertedWith(
          'MAX_EMERGENCY_PERIOD_CHECK_EXT'
        );
      });
    });

    context('setting the emergency period', () => {
      const EMERGENCY_PERIOD = MONTH * 3;
      const EMERGENCY_PERIOD_CHECK_EXTENSION = MONTH;

      sharedBeforeEach('deploy pool', async () => {
        pool = await deployBasePool({
          emergencyPeriod: EMERGENCY_PERIOD,
          emergencyPeriodCheckExtension: EMERGENCY_PERIOD_CHECK_EXTENSION,
        });
      });

      context('when the sender is has the role to do it', () => {
        let roleId: string;

        sharedBeforeEach('grant permission', async () => {
          roleId = await pool.CHANGE_POOL_EMERGENCY_PERIOD_ROLE();
          await authorizer.connect(admin).grantRole(roleId, admin.address);
        });

        context('before the emergency period end date', () => {
          sharedBeforeEach('advance some time', async () => {
            await advanceTime(EMERGENCY_PERIOD / 2);
          });

          it('can change the emergency period status', async () => {
            const { endDate: previousEndDate } = await pool.getEmergencyPeriod();
            expect(await pool.canChangeEmergencyPeriod(admin.address)).to.be.true;

            await pool.connect(admin).setEmergencyPeriod(true);

            await assertEmergencyPeriod(true, previousEndDate, EMERGENCY_PERIOD_CHECK_EXTENSION);
          });

          it('can change the emergency period status multiple times', async () => {
            const { endDate: previousEndDate } = await pool.getEmergencyPeriod();

            await pool.connect(admin).setEmergencyPeriod(true);
            await assertEmergencyPeriod(true, previousEndDate, EMERGENCY_PERIOD_CHECK_EXTENSION);

            await advanceTime(EMERGENCY_PERIOD / 4);

            await pool.connect(admin).setEmergencyPeriod(false);
            await assertEmergencyPeriod(false, previousEndDate, EMERGENCY_PERIOD_CHECK_EXTENSION);
          });

          it('can not change the emergency period if the role was revoked', async () => {
            await authorizer.connect(admin).revokeRole(roleId, admin.address);

            expect(await pool.canChangeEmergencyPeriod(admin.address)).to.be.false;

            await expect(pool.connect(admin).setEmergencyPeriod(true)).to.be.revertedWith(
              'CANNOT_CHANGE_EMERGENCY_PER'
            );
          });
        });

        context('when the emergency period end date has been reached', () => {
          context('when the emergency period was off', () => {
            sharedBeforeEach('advance time', async () => {
              await advanceTime(EMERGENCY_PERIOD);
            });

            function itCannotChangeTheEmergencyPeriod() {
              it('considers the emergency period off', async () => {
                await assertEmergencyPeriod(false);
              });

              it('cannot change the emergency period', async () => {
                await expect(pool.connect(admin).setEmergencyPeriod(true)).to.be.revertedWith(
                  'EMERGENCY_PERIOD_FINISHED'
                );
              });
            }

            context('before the check extension', () => {
              sharedBeforeEach('advance some time', async () => {
                await advanceTime(EMERGENCY_PERIOD_CHECK_EXTENSION / 2);
              });

              itCannotChangeTheEmergencyPeriod();
            });

            context('after the check extension', () => {
              sharedBeforeEach('reach the check extension', async () => {
                await advanceTime(EMERGENCY_PERIOD_CHECK_EXTENSION);
              });

              itCannotChangeTheEmergencyPeriod();
            });
          });

          context('when the emergency period was on', () => {
            sharedBeforeEach('turn on and advance time', async () => {
              await pool.connect(admin).setEmergencyPeriod(true);
              await advanceTime(EMERGENCY_PERIOD);
            });

            context('before the check extension', () => {
              sharedBeforeEach('advance some time', async () => {
                await advanceTime(EMERGENCY_PERIOD_CHECK_EXTENSION / 2);
              });

              it('considers the emergency period on', async () => {
                await assertEmergencyPeriod(true);
              });

              it('cannot change the emergency period', async () => {
                await expect(pool.connect(admin).setEmergencyPeriod(false)).to.be.revertedWith(
                  'EMERGENCY_PERIOD_FINISHED'
                );
              });
            });

            context('after the check extension', () => {
              sharedBeforeEach('reach the check extension', async () => {
                await advanceTime(EMERGENCY_PERIOD_CHECK_EXTENSION);
              });

              it('considers the emergency period off', async () => {
                await assertEmergencyPeriod(false);
              });

              it('cannot change the emergency period', async () => {
                await expect(pool.connect(admin).setEmergencyPeriod(false)).to.be.revertedWith(
                  'EMERGENCY_PERIOD_FINISHED'
                );
              });
            });
          });
        });
      });

      context('when the sender does not have the role to do it', () => {
        it('reverts', async () => {
          await expect(pool.connect(other).setEmergencyPeriod(true)).to.be.revertedWith('CANNOT_CHANGE_EMERGENCY_PER');
        });
      });
    });
  });
});
