import { ethers } from 'hardhat';
import { expect } from 'chai';
import { Contract } from 'ethers';
import { SignerWithAddress } from '@nomiclabs/hardhat-ethers/dist/src/signer-with-address';

import { bn, fp, FP_ONE } from '@balancer-labs/v2-helpers/src/numbers';
import { sharedBeforeEach } from '@balancer-labs/v2-common/sharedBeforeEach';
import * as expectEvent from '@balancer-labs/v2-helpers/src/test/expectEvent';

import Token from '@balancer-labs/v2-helpers/src/models/tokens/Token';
import TokenList from '@balancer-labs/v2-helpers/src/models/tokens/TokenList';
import LinearPool from '@balancer-labs/v2-helpers/src/models/pools/linear/LinearPool';

import { deploy } from '@balancer-labs/v2-helpers/src/contract';
import Vault from '@balancer-labs/v2-helpers/src/models/vault/Vault';

describe('IdleLinearPool', function () {
  let pool: LinearPool, tokens: TokenList, token: Token, rebasingYieldToken: Token, wrappedYieldToken: Token;
  let poolFactory: Contract;
  let wrappedYieldTokenInstance: Contract;
  let trader: SignerWithAddress, lp: SignerWithAddress, owner: SignerWithAddress;

  const POOL_SWAP_FEE_PERCENTAGE = fp(0.01);

  before('setup', async () => {
    [, lp, trader, owner] = await ethers.getSigners();
  });

  sharedBeforeEach('deploy tokens', async () => {
    token = await Token.create({ symbol: 'USDC', decimals: 6 });
    rebasingYieldToken = await Token.create({ symbol: 'idleUSDC', decimals: 18 });
    wrappedYieldTokenInstance = await deploy('MockIdleTokenV3_1', {
      args: ['idleUSDC', 'idleUSDC', 18, rebasingYieldToken.address],
    });
    wrappedYieldToken = await Token.deployedAt(wrappedYieldTokenInstance.address);

    tokens = new TokenList([token, rebasingYieldToken]).sort();

    await tokens.mint({ to: [lp, trader], amount: fp(100) });
  });

  sharedBeforeEach('deploy pool factory', async () => {
    const vault = await Vault.create();
    poolFactory = await deploy('IdleLinearPoolFactory', {
      args: [vault.address, vault.getFeesProvider().address],
    });
  });

  sharedBeforeEach('deploy and initialize pool', async () => {
    const tx = await poolFactory.create(
      'Balancer Pool Token',
      'BPT',
      token.address,
      wrappedYieldToken.address,
      bn(0),
      POOL_SWAP_FEE_PERCENTAGE,
      owner.address
    );

    const receipt = await tx.wait();
    const event = expectEvent.inReceipt(receipt, 'PoolCreated');

    pool = await LinearPool.deployedAt(event.args.pool);
  });

  describe('getWrappedTokenRate', () => {
    it('returns expected value for 1:1 exchange', async () => {
      // Exchange rate is 1:1, scaled to 1e18 regardless of token decimals
      await wrappedYieldTokenInstance.setRate(bn(1e6));
      expect(await pool.getWrappedTokenRate()).to.be.eq(FP_ONE);

      // Deposit one asset and check decimals on assets/shares
      await wrappedYieldTokenInstance.mintIdleToken(bn(1e6));
      expect(await wrappedYieldTokenInstance.totalSupply()).to.be.eq(bn(1e18));
      expect(await wrappedYieldTokenInstance.totalAssets()).to.be.eq(bn(1e6));

      // Redeem one share and check zero asset/share balances
      await wrappedYieldTokenInstance.redeemIdleToken(bn(1e18));
      expect(await wrappedYieldTokenInstance.totalSupply()).to.be.eq(0);
      expect(await wrappedYieldTokenInstance.totalAssets()).to.be.eq(0);
    });

    it('returns expected value for 2:1 exchange', async () => {
      // Double the exchange rate to 2:1
      await wrappedYieldTokenInstance.setRate(bn(2e6));
      expect(await pool.getWrappedTokenRate()).to.be.eq(fp(2));

      // At this rate we get half as many shares
      await wrappedYieldTokenInstance.mintIdleToken(bn(1e6));
      expect(await wrappedYieldTokenInstance.totalSupply()).to.be.eq(bn(5e17));
      await wrappedYieldTokenInstance.redeemIdleToken(bn(5e17));
      expect(await wrappedYieldTokenInstance.totalAssets()).to.be.eq(0);
    });

    it('returns expected value for 1:2 exchange', async () => {
      // Halve the exchange rate to 1:2
      await wrappedYieldTokenInstance.setRate(bn(5e5));
      expect(await pool.getWrappedTokenRate()).to.be.eq(fp(0.5));

      // At this rate we get twice as many shares
      await wrappedYieldTokenInstance.mintIdleToken(bn(1e6));
      expect(await wrappedYieldTokenInstance.totalSupply()).to.be.eq(bn(2e18));
      await wrappedYieldTokenInstance.redeemIdleToken(bn(2e18));
      expect(await wrappedYieldTokenInstance.totalAssets()).to.be.eq(0);
    });

    it('returns expected value for 1.25:1 exchange', async () => {
      // Set the exchange rate to 1.25:1
      await wrappedYieldTokenInstance.setRate(bn(125e4));
      expect(await pool.getWrappedTokenRate()).to.be.eq(fp(1.25));

      // At this rate we get 20% fewer shares
      await wrappedYieldTokenInstance.mintIdleToken(bn(1e6));
      expect(await wrappedYieldTokenInstance.totalSupply()).to.be.eq(bn(8e17));
      await wrappedYieldTokenInstance.redeemIdleToken(bn(8e17));
      expect(await wrappedYieldTokenInstance.totalAssets()).to.be.eq(0);
    });
  });
});
