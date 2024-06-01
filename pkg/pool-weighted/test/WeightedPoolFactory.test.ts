import { ethers } from 'hardhat';
import { expect } from 'chai';
import { BigNumber, Contract } from 'ethers';

import { fp } from '@balancer-labs/v2-helpers/src/numbers';
import { advanceTime, currentTimestamp, MONTH } from '@balancer-labs/v2-helpers/src/time';
import * as expectEvent from '@balancer-labs/v2-helpers/src/test/expectEvent';
import { ZERO_ADDRESS } from '@balancer-labs/v2-helpers/src/constants';
import { deploy, deployedAt } from '@balancer-labs/v2-helpers/src/contract';
import { sharedBeforeEach } from '@balancer-labs/v2-common/sharedBeforeEach';

import Vault from '@balancer-labs/v2-helpers/src/models/vault/Vault';
import TokenList from '@balancer-labs/v2-helpers/src/models/tokens/TokenList';
import { toNormalizedWeights } from '@balancer-labs/balancer-js';
import { SignerWithAddress } from '@nomiclabs/hardhat-ethers/signers';
import { randomBytes } from 'ethers/lib/utils';

describe('WeightedPoolFactory', function () {
  let tokens: TokenList;
  let factory: Contract;
  let vault: Vault;
  let rateProviders: string[];
  let owner: SignerWithAddress;

  const NAME = 'Balancer Pool Token';
  const SYMBOL = 'BPT';
  const POOL_SWAP_FEE_PERCENTAGE = fp(0.01);
  const WEIGHTS = toNormalizedWeights([fp(30), fp(70), fp(5), fp(5)]);

  const BASE_PAUSE_WINDOW_DURATION = MONTH * 3;
  const BASE_BUFFER_PERIOD_DURATION = MONTH;

  let createTime: BigNumber;

  before('setup signers', async () => {
    [, owner] = await ethers.getSigners();
  });

  sharedBeforeEach('deploy factory & tokens', async () => {
    vault = await Vault.create();

    factory = await deploy('WeightedPoolFactory', {
      args: [vault.address, vault.getFeesProvider().address, BASE_PAUSE_WINDOW_DURATION, BASE_BUFFER_PERIOD_DURATION],
    });
    createTime = await currentTimestamp();

    tokens = await TokenList.create(['MKR', 'DAI', 'SNX', 'BAT'], { sorted: true });

    rateProviders = await tokens.asyncMap(async () => (await deploy('v2-pool-utils/MockRateProvider')).address);
  });

  async function createPool(): Promise<Contract> {
    const receipt = await (
      await factory.create(
        NAME,
        SYMBOL,
        tokens.addresses,
        WEIGHTS,
        rateProviders,
        POOL_SWAP_FEE_PERCENTAGE,
        owner.address,
        false,
        randomBytes(32)
      )
    ).wait();

    const event = expectEvent.inReceipt(receipt, 'PoolCreated');
    return deployedAt('WeightedPool', event.args.pool);
  }

  describe('constructor arguments', () => {
    let pool: Contract;

    sharedBeforeEach(async () => {
      pool = await createPool();
    });

    it('sets the vault', async () => {
      expect(await pool.getVault()).to.equal(vault.address);
    });

    it('registers tokens in the vault', async () => {
      const poolId = await pool.getPoolId();
      const poolTokens = await vault.getPoolTokens(poolId);

      expect(poolTokens.tokens).to.have.members(tokens.addresses);
      expect(poolTokens.balances).to.be.zeros;
    });

    it('starts with no BPT', async () => {
      expect(await pool.totalSupply()).to.be.equal(0);
    });

    it('sets the rate providers', async () => {
      const providers = await pool.getRateProviders();
      expect(providers).to.deep.eq(rateProviders);
    });

    it('sets the asset managers to zero', async () => {
      await tokens.asyncEach(async (token) => {
        const poolId = await pool.getPoolId();
        const info = await vault.getPoolTokenInfo(poolId, token);
        expect(info.assetManager).to.equal(ZERO_ADDRESS);
      });
    });

    it('sets swap fee', async () => {
      expect(await pool['getSwapFeePercentage()']()).to.equal(POOL_SWAP_FEE_PERCENTAGE);
    });

    it('sets the owner ', async () => {
      expect(await pool.getOwner()).to.equal(owner.address);
    });

    it('sets the name', async () => {
      expect(await pool.name()).to.equal('Balancer Pool Token');
    });

    it('sets the symbol', async () => {
      expect(await pool.symbol()).to.equal('BPT');
    });

    it('sets the decimals', async () => {
      expect(await pool.decimals()).to.equal(18);
    });
  });

  describe('temporarily pausable', () => {
    it('pools have the correct window end times', async () => {
      const pool = await createPool();
      const { pauseWindowEndTime, bufferPeriodEndTime } = await pool.getPausedState();

      expect(pauseWindowEndTime).to.equal(createTime.add(BASE_PAUSE_WINDOW_DURATION));
      expect(bufferPeriodEndTime).to.equal(createTime.add(BASE_PAUSE_WINDOW_DURATION + BASE_BUFFER_PERIOD_DURATION));
    });

    it('multiple pools have the same window end times', async () => {
      const firstPool = await createPool();
      await advanceTime(BASE_PAUSE_WINDOW_DURATION / 3);
      const secondPool = await createPool();

      const { firstPauseWindowEndTime, firstBufferPeriodEndTime } = await firstPool.getPausedState();
      const { secondPauseWindowEndTime, secondBufferPeriodEndTime } = await secondPool.getPausedState();

      expect(firstPauseWindowEndTime).to.equal(secondPauseWindowEndTime);
      expect(firstBufferPeriodEndTime).to.equal(secondBufferPeriodEndTime);
    });

    it('pools created after the pause window end date have no buffer period', async () => {
      await advanceTime(BASE_PAUSE_WINDOW_DURATION + 1);

      const pool = await createPool();
      const { pauseWindowEndTime, bufferPeriodEndTime } = await pool.getPausedState();
      const now = await currentTimestamp();

      expect(pauseWindowEndTime).to.equal(now);
      expect(bufferPeriodEndTime).to.equal(now);
    });
  });
});
