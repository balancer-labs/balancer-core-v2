import { expect } from 'chai';
import { ethers } from 'hardhat';
import { Dictionary } from 'lodash';
import { BigNumber, Contract } from 'ethers';
import { SignerWithAddress } from '@nomiclabs/hardhat-ethers/dist/src/signer-with-address';

import * as expectEvent from '../helpers/expectEvent';
import { expectBalanceChange } from '../helpers/tokenBalance';

import { roleId } from '../../lib/helpers/roles';
import { deploy } from '../../lib/helpers/deploy';
import { bn, fp, pct } from '../../lib/helpers/numbers';
import { ZERO_ADDRESS } from '../../lib/helpers/constants';
import { deployTokens, mintTokens, TokenList } from '../../lib/helpers/tokens';

describe('Vault - internal balance', () => {
  let admin: SignerWithAddress,
    sender: SignerWithAddress,
    otherSender: SignerWithAddress,
    recipient: SignerWithAddress;
  let relayer: SignerWithAddress, otherRecipient: SignerWithAddress;
  let authorizer: Contract, vault: Contract;
  let tokens: TokenList = {};

  before('setup signers', async () => {
    [, admin, sender, otherSender, recipient, otherRecipient, relayer] = await ethers.getSigners();
  });

  beforeEach('deploy vault & tokens', async () => {
    authorizer = await deploy('Authorizer', { args: [admin.address] });
    vault = await deploy('Vault', { args: [authorizer.address] });
    tokens = await deployTokens(['DAI', 'MKR'], [18, 18]);
  });

  describe('deposit', () => {
    const initialBalance = bn(10);

    const itHandlesDepositsProperly = (amount: BigNumber) => {
      it('transfers the tokens from the sender to the vault', async () => {
        await expectBalanceChange(
          () => vault.depositToInternalBalance([{ token: tokens.DAI.address, amount: amount, source: sender.address, destination: recipient.address }]),
          tokens,
          [
            { account: sender.address, changes: { DAI: -amount } },
            { account: vault.address, changes: { DAI: amount } },
          ]
        );
      });

      it('deposits the internal balance into the recipient account', async () => {
        const previousSenderBalance = await vault.getInternalBalance(sender.address, [tokens.DAI.address]);
        const previousRecipientBalance = await vault.getInternalBalance(recipient.address, [tokens.DAI.address]);

        await vault.depositToInternalBalance([{ token: tokens.DAI.address, amount: amount, source: sender.address, destination: recipient.address }]);

        const currentSenderBalance = await vault.getInternalBalance(sender.address, [tokens.DAI.address]);
        expect(currentSenderBalance[0]).to.be.equal(previousSenderBalance[0]);

        const currentRecipientBalance = await vault.getInternalBalance(recipient.address, [tokens.DAI.address]);
        expect(currentRecipientBalance[0]).to.be.equal(previousRecipientBalance[0].add(amount));
      });

      it('emits an event', async () => {
        const receipt = await (
          await vault.depositToInternalBalance([{ token: tokens.DAI.address, amount: amount, source: sender.address, destination: recipient.address }])
        ).wait();

        expectEvent.inReceipt(receipt, 'InternalBalanceChanged', {
          user: recipient.address,
          token: tokens.DAI.address,
          balance: amount,
        });
      });
    };

    context('when the sender is the user', () => {
      beforeEach('set sender', () => {
        vault = vault.connect(sender);
      });

      context('when the token is not the zero address', () => {
        context('when the sender does hold enough balance', () => {
          beforeEach('mint tokens', async () => {
            await mintTokens(tokens, 'DAI', sender, initialBalance);
          });

          context('when the given amount is approved by the sender', () => {
            beforeEach('approve tokens', async () => {
              await tokens.DAI.connect(sender).approve(vault.address, initialBalance);
            });

            context('when tokens and balances match', () => {
              context('when depositing zero balance', () => {
                const depositAmount = bn(0);

                itHandlesDepositsProperly(depositAmount);
              });

              context('when depositing some balance', () => {
                const depositAmount = initialBalance;

                itHandlesDepositsProperly(depositAmount);
              });
            });
          });

          context('when the given amount is not approved by the sender', () => {
            it('reverts', async () => {
              await expect(
                vault.depositToInternalBalance([{token: tokens.DAI.address, amount: initialBalance, source: sender.address, destination: recipient.address}])
              ).to.be.revertedWith('ERC20: transfer amount exceeds allowance');
            });
          });
        });

        context('when the sender does not hold enough balance', () => {
          it('reverts', async () => {
            await expect(
              vault.depositToInternalBalance([{ token: tokens.DAI.address, amount: initialBalance, source: sender.address, destination: recipient.address }])
            ).to.be.revertedWith('ERC20: transfer amount exceeds balance');
          });
        });
      });

      context('when the token is the zero address', () => {
        it('reverts', async () => {
          await expect(
            vault.depositToInternalBalance([{ token: ZERO_ADDRESS, amount: initialBalance, source: sender.address, destination: recipient.address }])
          ).to.be.revertedWith('Address: call to non-contract');
        });
      });
    });

    context('when the sender is a relayer', () => {
      beforeEach('set sender', async () => {
        vault = vault.connect(relayer);
        await mintTokens(tokens, 'DAI', sender, initialBalance);
        await tokens.DAI.connect(sender).approve(vault.address, initialBalance);
      });

      context('when the relayer is whitelisted by the authorizer', () => {
        beforeEach('grant role to relayer', async () => {
          const role = roleId(vault, 'depositToInternalBalance');
          await authorizer.connect(admin).grantRole(role, relayer.address);
        });

        context('when the relayer is allowed by the user', () => {
          beforeEach('allow relayer', async () => {
            await vault.connect(sender).changeRelayerAllowance(relayer.address, true);
          });

          itHandlesDepositsProperly(initialBalance);
        });

        context('when the relayer is not allowed by the user', () => {
          it('reverts', async () => {
            await expect(
              vault.depositToInternalBalance([{ token: tokens.DAI.address, amount: initialBalance, source: sender.address, destination: recipient.address }])
            ).to.be.revertedWith('USER_DOESNT_ALLOW_RELAYER');
          });
        });
      });

      context('when the relayer is not whitelisted by the authorizer', () => {
        context('when the relayer is allowed by the user', () => {
          beforeEach('allow relayer', async () => {
            await vault.connect(sender).changeRelayerAllowance(relayer.address, true);
          });

          it('reverts', async () => {
            await expect(
              vault.depositToInternalBalance([{ token: tokens.DAI.address, amount: initialBalance, source: sender.address, destination: recipient.address }])
            ).to.be.revertedWith('SENDER_NOT_ALLOWED');
          });
        });

        context('when the relayer is not allowed by the user', () => {
          beforeEach('disallow relayer', async () => {
            await vault.connect(sender).changeRelayerAllowance(relayer.address, false);
          });

          it('reverts', async () => {
            await expect(
              vault.depositToInternalBalance([{ token: tokens.DAI.address, amount: initialBalance, source: sender.address, destination: recipient.address }])
            ).to.be.revertedWith('SENDER_NOT_ALLOWED');
          });
        });
      });
    });
  });

  describe('withdraw', () => {
    const itHandlesWithdrawalsProperly = (initialBalance: BigNumber, amount: BigNumber) => {
      context('when tokens and balances match', () => {
        context('without protocol withdraw fees', () => {
          it('transfers the tokens from the vault to recipient', async () => {
            await expectBalanceChange(
              () =>
                vault.withdrawFromInternalBalance([{ token: tokens.DAI.address, amount: amount, source: sender.address, destination: recipient.address }]),
              tokens,
              { account: recipient, changes: { DAI: amount } }
            );
          });

          it('withdraws the internal balance from the sender account', async () => {
            const previousSenderBalance = await vault.getInternalBalance(sender.address, [tokens.DAI.address]);
            const previousRecipientBalance = await vault.getInternalBalance(recipient.address, [tokens.DAI.address]);

            await vault.withdrawFromInternalBalance([{ token: tokens.DAI.address, amount: amount, source: sender.address, destination: recipient.address }]);

            const currentSenderBalance = await vault.getInternalBalance(sender.address, [tokens.DAI.address]);
            expect(currentSenderBalance[0]).to.be.equal(previousSenderBalance[0].sub(amount));

            const currentRecipientBalance = await vault.getInternalBalance(recipient.address, [tokens.DAI.address]);
            expect(currentRecipientBalance[0]).to.be.equal(previousRecipientBalance[0]);
          });

          it('emits an event', async () => {
            const receipt = await (
              await vault.withdrawFromInternalBalance([{ token: tokens.DAI.address, amount: amount, source: sender.address, destination: recipient.address }])
            ).wait();

            expectEvent.inReceipt(receipt, 'InternalBalanceChanged', {
              user: sender.address,
              token: tokens.DAI.address,
              balance: initialBalance.sub(amount),
            });
          });
        });

        context('with protocol withdraw fees', () => {
          const withdrawFee = 0.01;

          beforeEach('set fee', async () => {
            const role = await roleId(vault, 'setProtocolFees');
            await authorizer.connect(admin).grantRole(role, admin.address);
            await vault.connect(admin).setProtocolFees(0, fp(withdrawFee), 0);
          });

          it('tokens minus fee are pushed', async () => {
            await expectBalanceChange(
              () =>
                vault.withdrawFromInternalBalance([{ token: tokens.DAI.address, amount: amount, source: sender.address, destination: recipient.address }]),
              tokens,
              { account: recipient, changes: { DAI: amount.sub(pct(amount, withdrawFee)) } }
            );
          });

          it('protocol fees are collected', async () => {
            const previousCollectedFees = await vault.getCollectedFees([tokens.DAI.address]);

            await vault.withdrawFromInternalBalance([{ token: tokens.DAI.address, amount: amount, source: sender.address, destination: recipient.address }]);

            const currentCollectedFees = await vault.getCollectedFees([tokens.DAI.address]);
            expect(currentCollectedFees[0].sub(previousCollectedFees[0])).to.equal(pct(amount, withdrawFee));
          });
        });
      });
    };

    context('when the sender is a user', () => {
      beforeEach('set sender', async () => {
        vault = vault.connect(sender);
      });

      context('when the sender has enough internal balance', () => {
        const depositedAmount = bn(10e18);

        beforeEach('deposit internal balance', async () => {
          await mintTokens(tokens, 'DAI', sender, depositedAmount);
          await tokens.DAI.connect(sender).approve(vault.address, depositedAmount);
          await vault.depositToInternalBalance([{ token: tokens.DAI.address, amount: depositedAmount, source: sender.address, destination: sender.address }]);
        });

        context('when requesting all the available balance', () => {
          const amount = depositedAmount;

          itHandlesWithdrawalsProperly(depositedAmount, amount);
        });

        context('when requesting part of the balance', () => {
          const amount = depositedAmount.div(2);

          itHandlesWithdrawalsProperly(depositedAmount, amount);
        });

        context('when requesting no balance', () => {
          const amount = bn(0);

          itHandlesWithdrawalsProperly(depositedAmount, amount);
        });

        context('with requesting more balance than available', () => {
          const amount = depositedAmount.add(1);

          it('reverts', async () => {
            await expect(
              vault.withdrawFromInternalBalance([{ token: tokens.DAI.address, amount: amount, source: sender.address, destination: recipient.address }])
            ).to.be.revertedWith('INSUFFICIENT_INTERNAL_BALANCE');
          });
        });
      });

      context('when the sender does not have any internal balance', () => {
        const amount = 1;

        it('reverts', async () => {
          await expect(
            vault.withdrawFromInternalBalance([{ token: tokens.DAI.address, amount: amount, source: sender.address, destination: recipient.address }])
          ).to.be.revertedWith('INSUFFICIENT_INTERNAL_BALANCE');
        });
      });
    });

    context('when the sender is a relayer', () => {
      const depositedAmount = bn(1e18);

      beforeEach('set sender', async () => {
        vault = vault.connect(relayer);

        await mintTokens(tokens, 'DAI', sender, depositedAmount);
        await tokens.DAI.connect(sender).approve(vault.address, depositedAmount);
        await vault
          .connect(sender)
          .depositToInternalBalance([{ token: tokens.DAI.address, amount: depositedAmount, source: sender.address, destination: sender.address }]);
      });

      context('when the relayer is whitelisted by the authorizer', () => {
        beforeEach('grant role to relayer', async () => {
          const role = roleId(vault, 'withdrawFromInternalBalance');
          await authorizer.connect(admin).grantRole(role, relayer.address);
        });

        context('when the relayer is allowed by the user', () => {
          beforeEach('allow relayer', async () => {
            await vault.connect(sender).changeRelayerAllowance(relayer.address, true);
          });

          itHandlesWithdrawalsProperly(depositedAmount, depositedAmount);
        });

        context('when the relayer is not allowed by the user', () => {
          it('reverts', async () => {
            await expect(
              vault.withdrawFromInternalBalance([{token: tokens.DAI.address, amount: depositedAmount, source: sender.address, destination: recipient.address}])
            ).to.be.revertedWith('USER_DOESNT_ALLOW_RELAYER');
          });
        });
      });

      context('when the relayer is not whitelisted by the authorizer', () => {
        context('when the relayer is allowed by the user', () => {
          beforeEach('allow relayer', async () => {
            await vault.connect(sender).changeRelayerAllowance(relayer.address, true);
          });

          it('reverts', async () => {
            await expect(
              vault.withdrawFromInternalBalance([{token: tokens.DAI.address, amount: depositedAmount, source: sender.address, destination: recipient.address}])
            ).to.be.revertedWith('SENDER_NOT_ALLOWED');
          });
        });

        context('when the relayer is not allowed by the user', () => {
          beforeEach('disallow relayer', async () => {
            await vault.connect(sender).changeRelayerAllowance(relayer.address, false);
          });

          it('reverts', async () => {
            await expect(
              vault.withdrawFromInternalBalance([{token: tokens.DAI.address, amount: depositedAmount, source: sender.address, destination: recipient.address}])
              ).to.be.revertedWith('SENDER_NOT_ALLOWED');
          });
        });
      });
    });
  });

  describe('transfer', () => {
    let tokenAddresses: string[];

    beforeEach('set token addresses', async () => {
      tokenAddresses = Object.values(tokens).map((token) => token.address);
    });

    function itHandlesTransfersProperly(
      initialBalances: Dictionary<BigNumber>,
      transferredAmounts: Dictionary<BigNumber>
    ) {
      const amounts = Object.values(transferredAmounts);

      it('transfers the tokens from the sender to a single recipient', async () => {
        const previousSenderBalances = await vault.getInternalBalance(sender.address, tokenAddresses);
        const previousRecipientBalances = await vault.getInternalBalance(recipient.address, tokenAddresses);
        const transfers = [];

        for (let idx = 0; idx < tokenAddresses.length; ++idx) {
          transfers.push({ token: tokenAddresses[idx], amount: amounts[idx], source: sender.address, destination: recipient.address });
        }

        await vault.transferInternalBalance(transfers);

        const senderBalances = await vault.getInternalBalance(sender.address, tokenAddresses);
        const recipientBalances = await vault.getInternalBalance(recipient.address, tokenAddresses);

        for (let i = 0; i < tokenAddresses.length; i++) {
          expect(senderBalances[i]).to.equal(previousSenderBalances[i].sub(amounts[i]));
          expect(recipientBalances[i]).to.equal(previousRecipientBalances[i].add(amounts[i]));
        }
      });

      it('transfers the tokens from the sender to multiple recipients', async () => {
        const previousSenderBalances = await vault.getInternalBalance(sender.address, tokenAddresses);
        const previousRecipientBalances = await vault.getInternalBalance(recipient.address, tokenAddresses);
        const previousOtherRecipientBalances = await vault.getInternalBalance(otherRecipient.address, tokenAddresses);
        const transfers = [
          { token: tokenAddresses[0], amount: amounts[0], source: sender.address, destination: recipient.address },
          { token: tokenAddresses[1], amount: amounts[1], source: sender.address, destination: otherRecipient.address },
        ];

        await vault.transferInternalBalance(transfers);

        const senderBalances = await vault.getInternalBalance(sender.address, tokenAddresses);
        const recipientBalances = await vault.getInternalBalance(recipient.address, tokenAddresses);
        const otherRecipientBalances = await vault.getInternalBalance(otherRecipient.address, tokenAddresses);

        for (let i = 0; i < tokenAddresses.length; i++) {
          expect(senderBalances[i]).to.equal(previousSenderBalances[i].sub(amounts[i]));
        }

        expect(recipientBalances[0]).to.equal(previousRecipientBalances[0].add(amounts[0]));
        expect(recipientBalances[1]).to.equal(previousRecipientBalances[1]);

        expect(otherRecipientBalances[0]).to.equal(previousOtherRecipientBalances[0]);
        expect(otherRecipientBalances[1]).to.equal(previousOtherRecipientBalances[1].add(amounts[1]));
      });

      it('does not affect the token balances of the sender nor the recipient', async () => {
        const previousBalances: Dictionary<Dictionary<BigNumber>> = {};

        for (const symbol in tokens) {
          const senderBalance = await tokens[symbol].balanceOf(sender.address);
          const recipientBalance = await tokens[symbol].balanceOf(recipient.address);
          previousBalances[symbol] = { sender: senderBalance, recipient: recipientBalance };
        }

        const transfers = [];

        for (let idx = 0; idx < tokenAddresses.length; ++idx) {
          transfers.push({ token: tokenAddresses[idx], amount: amounts[idx], source: sender.address, destination: recipient.address });
        }

        await vault.transferInternalBalance(transfers);

        for (const symbol in tokens) {
          const senderBalance = await tokens[symbol].balanceOf(sender.address);
          expect(senderBalance).to.equal(previousBalances[symbol].sender);

          const recipientBalance = await tokens[symbol].balanceOf(recipient.address);
          expect(recipientBalance).to.equal(previousBalances[symbol].recipient);
        }
      });

      it('emits an event for each transfer', async () => {
        const transfers = [];

        for (let idx = 0; idx < tokenAddresses.length; ++idx) {
          transfers.push({ token: tokenAddresses[idx], amount: amounts[idx], source: sender.address, destination: recipient.address });
        }

        const receipt = await (
          await vault.transferInternalBalance(transfers)
        ).wait();

        expectEvent.inReceipt(receipt, 'InternalBalanceChanged', {
          user: sender.address,
          token: tokens.DAI.address,
          balance: initialBalances.DAI.sub(transferredAmounts.DAI),
        });

        expectEvent.inReceipt(receipt, 'InternalBalanceChanged', {
          user: sender.address,
          token: tokens.MKR.address,
          balance: initialBalances.MKR.sub(transferredAmounts.MKR),
        });

        expectEvent.inReceipt(receipt, 'InternalBalanceChanged', {
          user: recipient.address,
          token: tokens.DAI.address,
          balance: transferredAmounts.DAI,
        });

        expectEvent.inReceipt(receipt, 'InternalBalanceChanged', {
          user: recipient.address,
          token: tokens.MKR.address,
          balance: transferredAmounts.MKR,
        });
      });
    }

    function depositInitialBalances(initialBalances: Dictionary<BigNumber>) {
      beforeEach('deposit initial balances', async () => {
        for (const symbol in tokens) {
          const token = tokens[symbol];
          const amount = initialBalances[symbol];
          await mintTokens(tokens, symbol, sender, amount);
          await token.connect(sender).approve(vault.address, amount);
        }

        const balances = Object.values(initialBalances);
        const transfers = [];

        for (let idx = 0; idx < tokenAddresses.length; ++idx) {
          transfers.push({ token: tokenAddresses[idx], amount: balances[idx], source: sender.address, destination: sender.address });
        }

        await vault.connect(sender).depositToInternalBalance(transfers);
      });
    }

    context('when the sender is a user', () => {
      beforeEach('set sender', async () => {
        vault = vault.connect(sender);
      });

      function itReverts(transferredAmounts: Dictionary<BigNumber>, errorReason = 'INSUFFICIENT_INTERNAL_BALANCE') {
        it('reverts', async () => {
          const amounts = Object.values(transferredAmounts);
          const transfers = [];

          for (let idx = 0; idx < tokenAddresses.length; ++idx) {
            transfers.push({ token: tokenAddresses[idx], amount: amounts[idx], source: sender.address, destination: recipient.address });
          }
  
          await expect(
            vault.transferInternalBalance(transfers)
          ).to.be.revertedWith(errorReason);
        });
      }

      context('when the given input is correct', () => {
        context('when the sender specifies some balance', () => {
          const transferredAmounts = { DAI: bn(1e16), MKR: bn(2e16) };

          context('when the sender holds enough balance', () => {
            const initialBalances = { DAI: bn(1e18), MKR: bn(5e19) };

            depositInitialBalances(initialBalances);
            itHandlesTransfersProperly(initialBalances, transferredAmounts);
          });

          context('when the sender does not hold said balance', () => {
            context('when the sender does not hold enough balance of one token', () => {
              depositInitialBalances({ DAI: bn(10), MKR: bn(5e19) });

              itReverts(transferredAmounts);
            });

            context('when the sender does not hold enough balance of the other token', () => {
              depositInitialBalances({ DAI: bn(1e18), MKR: bn(5) });

              itReverts(transferredAmounts);
            });

            context('when the sender does not hold enough balance of both tokens', () => {
              depositInitialBalances({ DAI: bn(10), MKR: bn(5) });

              itReverts(transferredAmounts);
            });
          });
        });

        context('when the sender does not specify any balance', () => {
          const transferredAmounts = { DAI: bn(0), MKR: bn(0) };

          context('when the sender holds some balance', () => {
            const initialBalances: Dictionary<BigNumber> = { DAI: bn(1e18), MKR: bn(5e19) };

            depositInitialBalances(initialBalances);
            itHandlesTransfersProperly(initialBalances, transferredAmounts);
          });

          context('when the sender does not have any balance', () => {
            const initialBalances = { DAI: bn(0), MKR: bn(0) };

            itHandlesTransfersProperly(initialBalances, transferredAmounts);
          });
        });
      });
    });

    context('when the sender is a relayer', () => {
      const transferredAmounts = { DAI: bn(1e16), MKR: bn(2e16) };

      beforeEach('set sender', async () => {
        vault = vault.connect(relayer);
      });

      depositInitialBalances(transferredAmounts);

      context('when the relayer is whitelisted by the authorizer', () => {
        beforeEach('grant role to relayer', async () => {
          const role = roleId(vault, 'transferInternalBalance');
          await authorizer.connect(admin).grantRole(role, relayer.address);
        });

        context('when the relayer is allowed by the user', () => {
          beforeEach('allow relayer', async () => {
            await vault.connect(sender).changeRelayerAllowance(relayer.address, true);
          });

          itHandlesTransfersProperly(transferredAmounts, transferredAmounts);
        });

        context('when the relayer is not allowed by the user', () => {
          it('reverts', async () => {
            const transfers = [];
            const amounts = Object.values(transferredAmounts);

            for (let idx = 0; idx < tokenAddresses.length; ++idx) {
              transfers.push({ token: tokenAddresses[idx], amount: amounts[idx], source: sender.address, destination: recipient.address });
            }

            await expect(
              vault.transferInternalBalance(transfers)
            ).to.be.revertedWith('USER_DOESNT_ALLOW_RELAYER');
          });
        });
      });

      context('when the relayer is not whitelisted by the authorizer', () => {
        context('when the relayer is allowed by the user', () => {
          beforeEach('allow relayer', async () => {
            await vault.connect(sender).changeRelayerAllowance(relayer.address, true);
          });

          it('reverts', async () => {
            const transfers = [];
            const amounts = Object.values(transferredAmounts);

            for (let idx = 0; idx < tokenAddresses.length; ++idx) {
              transfers.push({ token: tokenAddresses[idx], amount: amounts[idx], source: sender.address, destination: recipient.address });
            }

            await expect(
              vault.transferInternalBalance(transfers)
            ).to.be.revertedWith('SENDER_NOT_ALLOWED');
          });
        });

        context('when the relayer is not allowed by the user', () => {
          beforeEach('disallow relayer', async () => {
            await vault.connect(sender).changeRelayerAllowance(relayer.address, false);
          });

          it('reverts', async () => {
            const transfers = [];
            const amounts = Object.values(transferredAmounts);

            for (let idx = 0; idx < tokenAddresses.length; ++idx) {
              transfers.push({ token: tokenAddresses[idx], amount: amounts[idx], source: sender.address, destination: recipient.address });
            }

            await expect(
              vault.transferInternalBalance(transfers)
            ).to.be.revertedWith('SENDER_NOT_ALLOWED');
          });
        });
      });
    });
  });
});
