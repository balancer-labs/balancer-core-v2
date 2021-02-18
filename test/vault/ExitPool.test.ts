import { times } from 'lodash';
import { ethers, network } from 'hardhat';
import { expect } from 'chai';
import { BigNumber, Contract, ContractTransaction } from 'ethers';
import { SignerWithAddress } from '@nomiclabs/hardhat-ethers/dist/src/signer-with-address';

import * as expectEvent from '../helpers/expectEvent';
import { encodeExit } from '../helpers/mockPool';
import { expectBalanceChange } from '../helpers/tokenBalance';

import { roleId } from '../../lib/helpers/roles';
import { deploy } from '../../lib/helpers/deploy';
import { MAX_UINT256, ZERO_ADDRESS } from '../../lib/helpers/constants';
import { deploySortedTokens, mintTokens, TokenList } from '../../lib/helpers/tokens';
import { bn, BigNumberish, fp, arraySub, arrayAdd, FP_SCALING_FACTOR, divCeil } from '../../lib/helpers/numbers';
import { PoolSpecializationSetting, MinimalSwapInfoPool, GeneralPool, TwoTokenPool } from '../../lib/helpers/pools';
import { sharedBeforeEach } from '../helpers/lib/sharedBeforeEach';

describe('Vault - exit pool', () => {
  let admin: SignerWithAddress, creator: SignerWithAddress, lp: SignerWithAddress;
  let recipient: SignerWithAddress, relayer: SignerWithAddress;
  let authorizer: Contract, vault: Contract;
  let tokens: TokenList = {};

  const SWAP_FEE = fp(0.1);
  let TOKEN_ADDRESSES: string[];

  before(async () => {
    [, admin, creator, lp, recipient, relayer] = await ethers.getSigners();
  });

  sharedBeforeEach('deploy vault & tokens', async () => {
    authorizer = await deploy('Authorizer', { args: [admin.address] });
    vault = await deploy('Vault', { args: [authorizer.address] });
    vault = vault.connect(lp);

    const role = roleId(vault, 'setProtocolFees');
    await authorizer.connect(admin).grantRole(role, admin.address);
    await vault.connect(admin).setProtocolFees(SWAP_FEE, 0, 0);

    tokens = await deploySortedTokens(['DAI', 'MKR', 'SNX', 'BAT'], [18, 18, 18, 18]);
    TOKEN_ADDRESSES = [];

    for (const symbol in tokens) {
      // Mint tokens for the creator to create the Pool and deposit as Internal Balance
      await mintTokens(tokens, symbol, creator, bn(100e18));
      await tokens[symbol].connect(creator).approve(vault.address, MAX_UINT256);

      // Mint tokens for the recipient to set as initial Internal Balance
      await mintTokens(tokens, symbol, recipient, bn(100e18));
      await tokens[symbol].connect(recipient).approve(vault.address, MAX_UINT256);

      TOKEN_ADDRESSES.push(tokens[symbol].address);
    }
  });

  function symbol(tokenAddress: string): string {
    for (const symbol in tokens) {
      if (tokens[symbol].address === tokenAddress) {
        return symbol;
      }
    }

    throw new Error(`Symbol for token ${tokenAddress} not found`);
  }

  describe('with general pool', () => {
    itExitsSpecializedPoolCorrectly(GeneralPool, 4);
  });

  describe('with minimal swap info pool', () => {
    itExitsSpecializedPoolCorrectly(MinimalSwapInfoPool, 3);
  });

  describe('with two token pool', () => {
    itExitsSpecializedPoolCorrectly(TwoTokenPool, 2);
  });

  function itExitsSpecializedPoolCorrectly(specialization: PoolSpecializationSetting, tokenAmount: number) {
    let pool: Contract;
    let poolId: string;

    let tokenAddresses: string[];

    let exitAmounts: BigNumber[];
    let dueProtocolFeeAmounts: BigNumber[];

    function array(value: BigNumberish): BigNumber[] {
      return Array(tokenAmount).fill(bn(value));
    }

    sharedBeforeEach('deploy & register pool', async () => {
      pool = await deploy('MockPool', { args: [vault.address, specialization] });
      poolId = await pool.getPoolId();

      tokenAddresses = TOKEN_ADDRESSES.slice(0, tokenAmount);
      await pool.registerTokens(tokenAddresses, Array(tokenAmount).fill(ZERO_ADDRESS));

      exitAmounts = tokenAddresses.map(
        (_, i) =>
          bn(1e18)
            .mul(i + 1)
            .add(1) // Cannot be evenly divided when calculating protocol fees, exposing the rounding behavior
      );
      dueProtocolFeeAmounts = array(0);

      // Join the Pool from the creator so that it has some tokens to exit and pay protocol fees with
      await vault
        .connect(creator)
        .joinPool(
          poolId,
          creator.address,
          ZERO_ADDRESS,
          tokenAddresses,
          array(MAX_UINT256),
          false,
          encodeExit(array(50e18), array(0))
        );

      // Deposit to Internal Balance from the creator so that the Vault has some additional tokens. Otherwise, tests
      // might fail not because the Vault checks its accounting, but because it is out of tokens to send.
      await vault
        .connect(creator)
        .depositToInternalBalance(creator.address, tokenAddresses, array(50e18), creator.address);
    });

    type ExitPoolData = {
      poolId?: string;
      tokenAddresses?: string[];
      minAmountsOut?: BigNumberish[];
      toInternalBalance?: boolean;
      exitAmounts?: BigNumberish[];
      dueProtocolFeeAmounts?: BigNumberish[];
      sender?: SignerWithAddress;
    };

    function exitPool(data: ExitPoolData): Promise<ContractTransaction> {
      return vault
        .connect(data.sender ?? lp)
        .exitPool(
          data.poolId ?? poolId,
          lp.address,
          recipient.address,
          data.tokenAddresses ?? tokenAddresses,
          data.minAmountsOut ?? array(0),
          data.toInternalBalance ?? false,
          encodeExit(data.exitAmounts ?? exitAmounts, data.dueProtocolFeeAmounts ?? dueProtocolFeeAmounts)
        );
    }

    context('when called incorrectly', () => {
      it('reverts if the pool ID does not exist', async () => {
        await expect(exitPool({ poolId: ethers.utils.id('invalid') })).to.be.revertedWith('INVALID_POOL_ID');
      });

      it('reverts if token array is incorrect', async () => {
        // Missing - token addresses and min amounts out length must match
        await expect(
          exitPool({ tokenAddresses: tokenAddresses.slice(1), minAmountsOut: array(0).slice(1) })
        ).to.be.revertedWith('INPUT_LENGTH_MISMATCH');

        // Extra - token addresses and min amounts out length must match
        await expect(
          exitPool({ tokenAddresses: tokenAddresses.concat(tokenAddresses[0]), minAmountsOut: array(0).concat(bn(0)) })
        ).to.be.revertedWith('INPUT_LENGTH_MISMATCH');

        // Unordered
        await expect(exitPool({ tokenAddresses: [...tokenAddresses].reverse() })).to.be.revertedWith('TOKENS_MISMATCH');
      });

      it('reverts if tokens and amounts length do not match', async () => {
        await expect(exitPool({ minAmountsOut: array(0).slice(1) })).to.be.revertedWith('INPUT_LENGTH_MISMATCH');

        await expect(exitPool({ minAmountsOut: array(0).concat(bn(0)) })).to.be.revertedWith('INPUT_LENGTH_MISMATCH');
      });
    });

    context('when called correctly', () => {
      context('with incorrect pool return values', () => {
        it('reverts if exit amounts length does not match token length', async () => {
          // Missing
          await expect(exitPool({ exitAmounts: array(0).slice(1) })).to.be.revertedWith('INPUT_LENGTH_MISMATCH');

          // Extra
          await expect(exitPool({ exitAmounts: array(0).concat(bn(0)) })).to.be.revertedWith('INPUT_LENGTH_MISMATCH');
        });

        it('reverts if due protocol fees length does not match token length', async () => {
          // Missing
          await expect(exitPool({ dueProtocolFeeAmounts: array(0).slice(1) })).to.be.revertedWith(
            'INPUT_LENGTH_MISMATCH'
          );

          // Extra
          await expect(exitPool({ dueProtocolFeeAmounts: array(0).concat(bn(0)) })).to.be.revertedWith(
            'INPUT_LENGTH_MISMATCH'
          );
        });

        it('reverts if exit amounts and due protocol fees length do not match token length', async () => {
          // Missing
          await expect(
            exitPool({ exitAmounts: array(0).slice(1), dueProtocolFeeAmounts: array(0).slice(1) })
          ).to.be.revertedWith('INPUT_LENGTH_MISMATCH');

          // Extra
          await expect(
            exitPool({ exitAmounts: array(0).concat(bn(0)), dueProtocolFeeAmounts: array(0).concat(bn(0)) })
          ).to.be.revertedWith('INPUT_LENGTH_MISMATCH');
        });
      });

      context('with correct pool return values', () => {
        context('with no protocol withdraw fee', () => {
          itExitsCorrectlyWithAndWithoutDueProtocolFeesAndInternalBalance();
        });

        context('with protocol withdraw fee', () => {
          sharedBeforeEach('set protocol withdraw fee', async () => {
            const role = roleId(vault, 'setProtocolFees');
            await authorizer.connect(admin).grantRole(role, admin.address);
            await vault.connect(admin).setProtocolFees(SWAP_FEE, fp(0.02), 0);
          });

          itExitsCorrectlyWithAndWithoutDueProtocolFeesAndInternalBalance();
        });
      });
    });

    function itExitsCorrectlyWithAndWithoutDueProtocolFeesAndInternalBalance() {
      const dueProtocolFeeAmounts = array(0);

      context('with no due protocol fees', () => {
        context('when the sender is the user', () => {
          itExitsCorrectlyWithAndWithoutInternalBalance({ dueProtocolFeeAmounts });
        });

        context('when the sender is a relayer', () => {
          let sender: SignerWithAddress;

          beforeEach('set sender', () => {
            sender = relayer;
          });

          context('when the relayer is whitelisted by the authorizer', () => {
            sharedBeforeEach('grant role to relayer', async () => {
              const role = roleId(vault, 'exitPool');
              await authorizer.connect(admin).grantRole(role, relayer.address);
            });

            context('when the relayer is allowed by the user', () => {
              sharedBeforeEach('allow relayer', async () => {
                await vault.connect(lp).changeRelayerAllowance(relayer.address, true);
              });

              itExitsCorrectlyWithAndWithoutInternalBalance({ dueProtocolFeeAmounts, sender });
            });

            context('when the relayer is not allowed by the user', () => {
              sharedBeforeEach('disallow relayer', async () => {
                await vault.connect(lp).changeRelayerAllowance(relayer.address, false);
              });

              it('reverts', async () => {
                await expect(exitPool({ dueProtocolFeeAmounts, sender })).to.be.revertedWith(
                  'USER_DOESNT_ALLOW_RELAYER'
                );
              });
            });
          });

          context('when the relayer is not whitelisted by the authorizer', () => {
            sharedBeforeEach('revoke role from relayer', async () => {
              const role = roleId(vault, 'batchSwapGivenIn');
              await authorizer.connect(admin).revokeRole(role, relayer.address);
            });

            context('when the relayer is allowed by the user', () => {
              sharedBeforeEach('allow relayer', async () => {
                await vault.connect(lp).changeRelayerAllowance(relayer.address, true);
              });

              it('reverts', async () => {
                await expect(exitPool({ dueProtocolFeeAmounts, sender })).to.be.revertedWith('SENDER_NOT_ALLOWED');
              });
            });

            context('when the relayer is not allowed by the user', () => {
              sharedBeforeEach('disallow relayer', async () => {
                await vault.connect(lp).changeRelayerAllowance(relayer.address, false);
              });

              it('reverts', async () => {
                await expect(exitPool({ dueProtocolFeeAmounts, sender })).to.be.revertedWith('SENDER_NOT_ALLOWED');
              });
            });
          });
        });
      });

      context('with due protocol fees', () => {
        const dueProtocolFeeAmounts = array(1e18);

        itExitsCorrectlyWithAndWithoutInternalBalance({ dueProtocolFeeAmounts });
      });
    }

    function itExitsCorrectlyWithAndWithoutInternalBalance({
      dueProtocolFeeAmounts,
      sender,
    }: {
      dueProtocolFeeAmounts: BigNumberish[];
      sender?: SignerWithAddress;
    }) {
      context('not using internal balance', () => {
        const toInternalBalance = false;

        context('without internal balance', () => {
          itExitsCorrectly({ toInternalBalance, dueProtocolFeeAmounts, sender });
        });

        context('with some internal balance', () => {
          sharedBeforeEach('deposit to internal balance', async () => {
            await vault
              .connect(recipient)
              .depositToInternalBalance(recipient.address, tokenAddresses, array(1.5e18), recipient.address);
          });

          itExitsCorrectly({ toInternalBalance, dueProtocolFeeAmounts, sender });
        });
      });

      context('using internal balance', () => {
        const toInternalBalance = true;

        context('with no internal balance', () => {
          itExitsCorrectly({ toInternalBalance, dueProtocolFeeAmounts, sender });
        });

        context('with some internal balance', () => {
          sharedBeforeEach('deposit to internal balance', async () => {
            await vault
              .connect(recipient)
              .depositToInternalBalance(recipient.address, tokenAddresses, array(1.5e18), recipient.address);
          });

          itExitsCorrectly({ toInternalBalance, dueProtocolFeeAmounts, sender });
        });
      });
    }

    function itExitsCorrectly({
      toInternalBalance,
      dueProtocolFeeAmounts,
      sender,
    }: {
      toInternalBalance: boolean;
      dueProtocolFeeAmounts: BigNumberish[];
      sender?: SignerWithAddress;
    }) {
      let expectedProtocolWithdrawFeesToCollect: BigNumber[];

      sharedBeforeEach('calculate intermediate values', async () => {
        const { withdrawFee } = await vault.getProtocolFees();
        expectedProtocolWithdrawFeesToCollect = exitAmounts.map((amount) =>
          toInternalBalance
            ? bn(0)
            : // Fixed point division rounding up, since the protocol withdraw fee is a fixed point number
              divCeil(amount.mul(withdrawFee), FP_SCALING_FACTOR)
        );
      });

      it('sends tokens from the vault to the recipient', async () => {
        const expectedTransferAmounts = toInternalBalance
          ? array(0)
          : arraySub(exitAmounts, expectedProtocolWithdrawFeesToCollect);

        // Tokens are sent to the recipient, so the expected change is positive
        const recipientChanges = tokenAddresses.reduce(
          (changes, token, i) => ({ ...changes, [symbol(token)]: expectedTransferAmounts[i] }),
          {}
        );

        // Tokens are sent from the Vault, so the expected change is negative
        const vaultChanges = tokenAddresses.reduce(
          (changes, token, i) => ({ ...changes, [symbol(token)]: expectedTransferAmounts[i].mul(-1) }),
          {}
        );

        await expectBalanceChange(() => exitPool({ toInternalBalance, dueProtocolFeeAmounts, sender }), tokens, [
          { account: vault, changes: vaultChanges },
          { account: recipient, changes: recipientChanges },
        ]);
      });

      it('assigns internal balance to the caller', async () => {
        const previousInternalBalances = await vault.getInternalBalance(recipient.address, tokenAddresses);
        await exitPool({ toInternalBalance, dueProtocolFeeAmounts, sender });
        const currentInternalBalances = await vault.getInternalBalance(recipient.address, tokenAddresses);

        // Internal balance is expected to increase: current - previous should equal expected. Protocol withdraw fees
        // are not charged.
        const expectedInternalBalanceIncrease = toInternalBalance ? exitAmounts : array(0);
        expect(arraySub(currentInternalBalances, previousInternalBalances)).to.deep.equal(
          expectedInternalBalanceIncrease
        );
      });

      it('deducts tokens from the pool', async () => {
        const { balances: previousPoolBalances } = await vault.getPoolTokens(poolId);
        await exitPool({ toInternalBalance, dueProtocolFeeAmounts, sender });
        const { balances: currentPoolBalances } = await vault.getPoolTokens(poolId);

        // The Pool balance is expected to decrease by exit amounts plus due protocol fees.
        expect(arraySub(previousPoolBalances, currentPoolBalances)).to.deep.equal(
          arrayAdd(exitAmounts, dueProtocolFeeAmounts)
        );
      });

      it('calls the pool with the exit data', async () => {
        const { balances: previousPoolBalances } = await vault.getPoolTokens(poolId);
        const { blockNumber: previousBlockNumber } = await vault.getPoolTokenInfo(poolId, tokenAddresses[0]);

        const receipt = await (await exitPool({ toInternalBalance, dueProtocolFeeAmounts, sender })).wait();

        expectEvent.inIndirectReceipt(receipt, pool.interface, 'OnExitPoolCalled', {
          poolId,
          sender: lp.address,
          recipient: recipient.address,
          currentBalances: previousPoolBalances,
          protocolSwapFee: (await vault.getProtocolFees()).swapFee,
          latestBlockNumberUsed: previousBlockNumber,
          userData: encodeExit(exitAmounts, dueProtocolFeeAmounts),
        });
      });

      it('updates the latest block number used for all tokens', async () => {
        const currentBlockNumber = Number(await network.provider.send('eth_blockNumber'));

        await exitPool({ toInternalBalance, dueProtocolFeeAmounts, sender });

        for (const token of tokenAddresses) {
          const { blockNumber: newBlockNumber } = await vault.getPoolTokenInfo(poolId, token);
          expect(newBlockNumber).to.equal(currentBlockNumber + 1);
        }
      });

      it('emits PoolExited from the vault', async () => {
        const receipt = await (await exitPool({ toInternalBalance, dueProtocolFeeAmounts, sender })).wait();

        expectEvent.inReceipt(receipt, 'PoolExited', {
          poolId,
          liquidityProvider: lp.address,
          amountsOut: exitAmounts,
          protocolFees: dueProtocolFeeAmounts,
        });
      });

      it('collects protocol fees', async () => {
        const previousCollectedFees = await vault.getCollectedFees(tokenAddresses);
        await exitPool({ toInternalBalance, dueProtocolFeeAmounts, sender });
        const currentCollectedFees = await vault.getCollectedFees(tokenAddresses);

        // Fees from both sources are lumped together.
        expect(arraySub(currentCollectedFees, previousCollectedFees)).to.deep.equal(
          arrayAdd(dueProtocolFeeAmounts, expectedProtocolWithdrawFeesToCollect)
        );
      });

      it('exits multiple times', async () => {
        await Promise.all(
          times(3, () => async () => {
            const receipt = await (await exitPool({ toInternalBalance, dueProtocolFeeAmounts })).wait();
            expectEvent.inIndirectReceipt(receipt, pool.interface, 'OnExitPoolCalled');
          })
        );
      });

      it('exits the pool fully', async () => {
        const { balances: poolBalances } = await vault.getPoolTokens(poolId);
        const fullExitAmounts = arraySub(poolBalances, dueProtocolFeeAmounts);

        await exitPool({ toInternalBalance, dueProtocolFeeAmounts, exitAmounts: fullExitAmounts, sender });

        const { balances: currentBalances } = await vault.getPoolTokens(poolId);
        expect(currentBalances).to.deep.equal(array(0));
      });

      it('reverts if any of the min amounts out is not enough', async () => {
        await Promise.all(
          exitAmounts.map((amount, i) => {
            const minAmountsOut = array(0);
            minAmountsOut[i] = amount.add(1);

            return expect(
              exitPool({ toInternalBalance, dueProtocolFeeAmounts, minAmountsOut, sender })
            ).to.be.revertedWith('EXIT_BELOW_MIN');
          })
        );
      });

      it('reverts if any of the amounts to exit plus fees is larger than the pool balance', async () => {
        const { balances: poolBalances } = await vault.getPoolTokens(poolId);

        await Promise.all(
          poolBalances.map((balance: BigNumber, i: number) => {
            const excessiveExitAmounts = [...exitAmounts];
            excessiveExitAmounts[i] = balance.sub(dueProtocolFeeAmounts[i]).add(1);

            return expect(
              exitPool({ toInternalBalance, dueProtocolFeeAmounts, exitAmounts: excessiveExitAmounts, sender })
            ).to.be.revertedWith('SUB_OVERFLOW');
          })
        );
      });
    }
  }
});
