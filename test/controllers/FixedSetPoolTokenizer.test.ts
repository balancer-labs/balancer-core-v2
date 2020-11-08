import { ethers } from 'hardhat';
import { expect } from 'chai';
import { BigNumber, Contract } from 'ethers';
import { SignerWithAddress } from '@nomiclabs/hardhat-ethers/dist/src/signer-with-address';
import { deploy } from '../../scripts/helpers/deploy';
import { PairTS } from '../../scripts/helpers/pools';
import { deployTokens, TokenList } from '../helpers/tokens';
import { MAX_UINT256 } from '../helpers/constants';
import { expectBalanceChange } from '../helpers/tokenBalance';
import { setupTokenizer } from '../../scripts/helpers/controllers';
import { toFixedPoint } from '../../scripts/helpers/fixedPoint';

describe('FixedSetPoolTokenizer', function () {
  let admin: SignerWithAddress;
  let lp: SignerWithAddress;
  let other: SignerWithAddress;

  let vault: Contract;
  let strategy: Contract;
  let tokens: TokenList = {};

  const initialBPT = (100e18).toString();
  const poolMakeup: Array<[string, string]> = [
    ['DAI', (1e18).toString()],
    ['MKR', (2e18).toString()],
  ];

  before(async function () {
    [, admin, lp, other] = await ethers.getSigners();
  });

  beforeEach(async function () {
    vault = await deploy('Vault', { from: admin, args: [] });

    tokens = await deployTokens(['DAI', 'MKR']);
    await Promise.all(
      ['DAI', 'MKR'].map(async (token) => {
        await tokens[token].mint(lp.address, (100e18).toString());
        await tokens[token].connect(lp).approve(vault.address, MAX_UINT256);

        await tokens[token].mint(other.address, (100e18).toString());
        await tokens[token].connect(other).approve(vault.address, MAX_UINT256);
      })
    );

    strategy = await deploy('MockTradingStrategy', { args: [] });
  });

  describe('creation via factory', async () => {
    it('creates a pool in the vault', async () => {
      const tokenizer = await setupTokenizer(vault, admin, strategy, PairTS, tokens, lp, initialBPT, poolMakeup);

      const poolId = await tokenizer.poolId();
      expect(await vault.getPoolController(poolId)).to.equal(tokenizer.address);
    });

    it('grants initial BPT to the LP', async () => {
      const tokenizer = await setupTokenizer(vault, admin, strategy, PairTS, tokens, lp, initialBPT, poolMakeup);

      expect(await tokenizer.balanceOf(lp.address)).to.equal((100e18).toString());
    });

    it('adds tokens to pool', async () => {
      const tokenizer = await setupTokenizer(vault, admin, strategy, PairTS, tokens, lp, initialBPT, poolMakeup);
      const poolId = await tokenizer.poolId();

      expect(await vault.getPoolTokens(poolId)).to.have.members([tokens.DAI.address, tokens.MKR.address]);
      expect(await vault.getPoolTokenBalances(poolId, [tokens.DAI.address, tokens.MKR.address])).to.deep.equal([
        BigNumber.from((1e18).toString()),
        BigNumber.from((2e18).toString()),
      ]);
    });
  });

  context('with tokenizer', () => {
    let tokenizer: Contract;
    let poolId: string;

    beforeEach(async () => {
      tokenizer = await setupTokenizer(vault, admin, strategy, PairTS, tokens, lp, initialBPT, poolMakeup);
      poolId = await tokenizer.poolId();
    });

    describe('joining', () => {
      it('grants BPT in return', async () => {
        const previousBPT = await tokenizer.balanceOf(lp.address);

        // To get 10% of the current BTP, an LP needs to supply 10% of the current token balance
        await tokenizer.connect(lp).joinPool((10e18).toString(), [(0.1e18).toString(), (0.2e18).toString()], true);

        const newBPT = await tokenizer.balanceOf(lp.address);
        expect(newBPT.sub(previousBPT)).to.equal((10e18).toString());
      });

      it('fails if maximum amounts are not enough', async () => {
        await expect(
          tokenizer
            .connect(lp)
            .joinPool((10e18).toString(), [BigNumber.from((0.1e18).toString()).sub(1), (0.2e18).toString()], true)
        ).to.be.revertedWith('ERR_LIMIT_IN');

        await expect(
          tokenizer
            .connect(lp)
            .joinPool((10e18).toString(), [(0.1e18).toString(), BigNumber.from((0.2e18).toString()).sub(1)], true)
        ).to.be.revertedWith('ERR_LIMIT_IN');
      });

      it('only the required tokens are pulled', async () => {
        await expectBalanceChange(
          () => tokenizer.connect(lp).joinPool((10e18).toString(), [(10e18).toString(), (10e18).toString()], true),
          lp,
          tokens,
          { DAI: -0.1e18, MKR: -0.2e18 }
        );
      });

      it('anybody can join the pool', async () => {
        await tokenizer.connect(other).joinPool((10e18).toString(), [(0.1e18).toString(), (0.2e18).toString()], true);

        expect(await tokenizer.balanceOf(other.address)).to.equal((10e18).toString());
      });

      it('fails if not supplying all tokens', async () => {
        await expect(
          tokenizer.connect(lp).joinPool((10e18).toString(), [(0.1e18).toString()], [(0.1e18).toString()])
        ).to.be.revertedWith('Tokens and amounts length mismatch');
      });

      it('fails if supplying extra tokens', async () => {
        await expect(
          tokenizer
            .connect(lp)
            .joinPool((10e18).toString(), [(0.1e18).toString(), (0.2e18).toString(), (0.3e18).toString()], true)
        ).to.be.revertedWith('Tokens and amounts length mismatch');
      });

      it('can withdraw from user balance', async () => {
        await vault.connect(lp).deposit(tokens.DAI.address, (1e18).toString(), lp.address);
        await vault.connect(lp).deposit(tokens.MKR.address, (1e18).toString(), lp.address);

        await expectBalanceChange(
          () => tokenizer.connect(lp).joinPool((10e18).toString(), [(0.1e18).toString(), (0.2e18).toString()], false),
          lp,
          tokens,
          {}
        );

        expect(await vault.getUserTokenBalance(lp.address, tokens.DAI.address)).to.equal((0.9e18).toString());
        expect(await vault.getUserTokenBalance(lp.address, tokens.MKR.address)).to.equal((0.8e18).toString());
      });

      it('fails if withdrawing from user balance with insufficient balance', async () => {
        await vault.connect(lp).deposit(tokens.DAI.address, BigNumber.from((0.1e18).toString()).sub(1), lp.address);
        await vault.connect(lp).deposit(tokens.MKR.address, (0.2e18).toString(), lp.address);

        await expect(
          tokenizer.connect(lp).joinPool((10e18).toString(), [(0.1e18).toString(), (0.2e18).toString()], false)
        ).to.be.revertedWith('ERR_SUB_UNDERFLOW');
      });
    });

    describe('exiting', () => {
      it('takes BPT in return', async () => {
        const previousBPT = await tokenizer.balanceOf(lp.address);

        // By returning 10% of the current BTP, an LP gets in return 10% of the current token balance
        await tokenizer.connect(lp).exitPool((10e18).toString(), [0, 0], true);

        const newBPT = await tokenizer.balanceOf(lp.address);
        expect(newBPT.sub(previousBPT)).to.equal((-10e18).toString());
      });

      it('fails if minimum amounts are not enough', async () => {
        await expect(
          tokenizer
            .connect(lp)
            .exitPool((10e18).toString(), [BigNumber.from((0.1e18).toString()).add(1), (0.2e18).toString()], true)
        ).to.be.revertedWith('NOT EXITING ENOUGH');

        await expect(
          tokenizer
            .connect(lp)
            .exitPool((10e18).toString(), [(0.1e18).toString(), BigNumber.from((0.2e18).toString()).add(1)], true)
        ).to.be.revertedWith('NOT EXITING ENOUGH');
      });

      it('fails if not requesting all tokens', async () => {
        await expect(
          tokenizer.connect(lp).exitPool((10e18).toString(), [(0.1e18).toString()], true)
        ).to.be.revertedWith('Tokens and amounts length mismatch');
      });

      it('all tokens due are pushed', async () => {
        await expectBalanceChange(() => tokenizer.connect(lp).exitPool((10e18).toString(), [0, 0], true), lp, tokens, {
          DAI: 0.1e18,
          MKR: 0.2e18,
        });
      });

      context('with protocol withdraw fees', () => {
        const protocolWithdrawFee = 0.01;

        beforeEach(async () => {
          await vault.connect(admin).setProtocolWithdrawFee(toFixedPoint(protocolWithdrawFee));
        });

        it('tokens minus fee are pushed', async () => {
          await expectBalanceChange(
            () => tokenizer.connect(lp).exitPool((10e18).toString(), [0, 0], true),
            lp,
            tokens,
            {
              DAI: 0.1e18 * (1 - protocolWithdrawFee),
              MKR: 0.2e18 * (1 - protocolWithdrawFee),
            }
          );
        });
      });

      it('can deposit into user balance', async () => {
        await expectBalanceChange(
          () => tokenizer.connect(lp).exitPool((10e18).toString(), [0, 0], false),
          lp,
          tokens,
          {}
        );
      });

      it('fails if requesting extra tokens', async () => {
        await expect(
          tokenizer
            .connect(lp)
            .exitPool((10e18).toString(), [(0.1e18).toString(), (0.2e18).toString(), (0.3e18).toString()], true)
        ).to.be.revertedWith('Tokens and amounts length mismatch');
      });

      it('can deposit into user balance', async () => {
        await expectBalanceChange(
          () => tokenizer.connect(lp).exitPool((10e18).toString(), [0, 0], false),
          lp,
          tokens,
          {}
        );

        expect(await vault.getUserTokenBalance(lp.address, tokens.DAI.address)).to.equal((0.1e18).toString());
        expect(await vault.getUserTokenBalance(lp.address, tokens.MKR.address)).to.equal((0.2e18).toString());
      });
    });

    describe('draining', () => {
      it('pools can be fully exited', async () => {
        await tokenizer.connect(lp).exitPool((100e18).toString(), [0, 0], true);

        expect(await tokenizer.totalSupply()).to.equal(0);
        expect(await vault.getPoolTokens(poolId)).to.have.members([]);
      });

      it('drained pools cannot be rejoined', async () => {
        await tokenizer.connect(lp).exitPool((100e18).toString(), [0, 0], true);
        await expect(
          tokenizer.connect(lp).joinPool((10e18).toString(), [(0.1e18).toString(), (0.2e18).toString()], true)
        ).to.be.revertedWith('ERR_DIV_ZERO');
      });
    });
  });
});
