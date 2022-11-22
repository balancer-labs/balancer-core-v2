import { ethers } from 'hardhat';
import { expect } from 'chai';
import { BigNumber } from 'ethers';
import { SignerWithAddress } from '@nomiclabs/hardhat-ethers/dist/src/signer-with-address';

import { bn, fp, fromFp } from '@balancer-labs/v2-helpers/src/numbers';
import { MAX_UINT112, MAX_UINT96, ZERO_ADDRESS, ZERO_BYTES32 } from '@balancer-labs/v2-helpers/src/constants';
import * as expectEvent from '@balancer-labs/v2-helpers/src/test/expectEvent';
import { sharedBeforeEach } from '@balancer-labs/v2-common/sharedBeforeEach';
import { PoolSpecialization } from '@balancer-labs/balancer-js';
import { RawSecondaryPoolDeployment } from '@balancer-labs/v2-helpers/src/models/pools/secondary-issue/types';

import Token from '@balancer-labs/v2-helpers/src/models/tokens/Token';
import TokenList from '@balancer-labs/v2-helpers/src/models/tokens/TokenList';
import SecondaryPool from '@balancer-labs/v2-helpers/src/models/pools/secondary-issue/SecondaryIssuePool';
import { keccak256 } from "@ethersproject/keccak256";
import { toUtf8Bytes } from "@ethersproject/strings";
import Decimal from 'decimal.js';

describe('SecondaryPool', function () {
  let pool: SecondaryPool, tokens: TokenList, securityToken: Token, currencyToken: Token;
  let   trader: SignerWithAddress,
        lp: SignerWithAddress,
        admin: SignerWithAddress,
        owner: SignerWithAddress,
        other: SignerWithAddress;
  
  const TOTAL_TOKENS = 3;
  const POOL_SWAP_FEE_PERCENTAGE = fp(0.01);
  const eventName = "CallSwap(string)";
  const eventType = ["string orderType"];
  const encodedEventSignature = keccak256(toUtf8Bytes(eventName));

  const EXPECTED_RELATIVE_ERROR = 1e-14;

  before('setup', async () => {
    [, lp, trader, admin, owner, other] = await ethers.getSigners();
  });
  
  sharedBeforeEach('deploy tokens', async () => {
    tokens = await TokenList.create(['DAI', 'CDAI'], { sorted: true });
    await tokens.mint({ to: [lp, trader], amount: fp(100) });

    securityToken = tokens.DAI;
    currencyToken = tokens.CDAI;
  });
   
  async function deployPool(params: RawSecondaryPoolDeployment, mockedVault = true): Promise<any> {
    params = Object.assign({}, { swapFeePercentage: POOL_SWAP_FEE_PERCENTAGE, owner, admin }, params);
    pool = await SecondaryPool.create(params, mockedVault);
    return pool;
  }
  
  describe('creation', () => {
    context('when the creation succeeds', () => {

      sharedBeforeEach('deploy pool', async () => {
        await deployPool({ securityToken, currencyToken }, false);
      });

      it('sets the vault', async () => {
        expect(await pool.getVault()).to.equal(pool.vault.address);
      });

      it('uses general specialization', async () => {
        const { address, specialization } = await pool.getRegisteredInfo();
        expect(address).to.equal(pool.address);
        expect(specialization).to.equal(PoolSpecialization.GeneralPool);
      });

      it('registers tokens in the vault', async () => {
        const { tokens, balances } = await pool.getTokens();

        expect(tokens).to.have.members(pool.tokens.addresses);
        expect(balances).to.be.zeros;
      });

      it('sets the asset managers', async () => {
        await tokens.asyncEach(async (token) => {
          const { assetManager } = await pool.getTokenInfo(token);
          expect(assetManager).to.be.zeroAddress;
        });
      });

      it('sets swap fee', async () => {
        expect(await pool.getSwapFeePercentage()).to.equal(POOL_SWAP_FEE_PERCENTAGE);
      });

      it('sets the name', async () => {
        expect(await pool.name()).to.equal('Verified Liquidity Token');
      });

      it('sets the symbol', async () => {
        expect(await pool.symbol()).to.equal('VITTA');
      });

      it('sets the decimals', async () => {
        expect(await pool.decimals()).to.equal(18);
      });

    });

    context('when the creation fails', () => {
      it('reverts if there are repeated tokens', async () => {
        await expect(deployPool({ securityToken, currencyToken: securityToken }, false)).to.be.revertedWith('UNSORTED_ARRAY');
      });

    });
  });
  
  describe('initialization', () => {
    sharedBeforeEach('deploy pool', async () => {
      await deployPool({ securityToken, currencyToken }, false);
    });

    it('initialize pool', async () => {
      const previousBalances = await pool.getBalances();
      expect(previousBalances).to.be.zeros;

      await pool.initialize();

      const currentBalances = await pool.getBalances();
      expect(currentBalances[pool.securityIndex]).to.be.equal(0);
      expect(currentBalances[pool.currencyIndex]).to.be.equal(0);
    });

    it('cannot be initialized outside of the initialize function', async () => {
      await expect(
        pool.vault.joinPool({
          poolId: await pool.getPoolId(),
          tokens: pool.tokens.addresses,
        })
      ).to.be.revertedWith('INVALID_INITIALIZATION');
    });

    it('cannot be initialized twice', async () => {
      await pool.initialize();
      await expect(pool.initialize()).to.be.revertedWith('UNHANDLED_BY_SECONDARY_POOL');
    });
  });

  describe('swaps', () => {
    let currentBalances: BigNumber[];
    let params: {};
    let secondary_pool: any;

    sharedBeforeEach('deploy and initialize pool', async () => {

      secondary_pool = await deployPool({ securityToken, currencyToken }, true);

      await setBalances(pool, { securityBalance: fp(20), currencyBalance: fp(35), bptBalance: MAX_UINT112 });
      
      const poolId = await pool.getPoolId();
      currentBalances = (await pool.vault.getPoolTokens(poolId)).balances;

      params = {
        fee: POOL_SWAP_FEE_PERCENTAGE,
      };
    });

    const setBalances = async (
      pool: SecondaryPool,
      balances: { securityBalance?: BigNumber; currencyBalance?: BigNumber; bptBalance?: BigNumber }
    ) => {

      const updateBalances = Array.from({ length: TOTAL_TOKENS }, (_, i) =>
        i == pool.securityIndex
          ? balances.securityBalance ?? bn(0)
          : i == pool.currencyIndex
          ? balances.currencyBalance ?? bn(0)
          : i == pool.bptIndex
          ? balances.bptBalance ?? bn(0)
          : bn(0)
      );
      const poolId = await pool.getPoolId();
      await pool.vault.updateBalances(poolId, updateBalances);
    };
   

  context('Placing Market order', () => {
    let sell_amount: BigNumber;
    let buy_amount: BigNumber;
    let sell_price: BigNumber;
    let buy_price: BigNumber;
    let beforeSwapLPCurrency: BigNumber;
    let beforeSwapLPSecurity: BigNumber;
    let beforeSwapTraderCurrency: BigNumber;
    let beforeSwapTraderSecurity: BigNumber;

    sharedBeforeEach('initialize values ', async () => {
      sell_amount = fp(10); // sell qty
      buy_amount = fp(15); // buy qty
      buy_price = fp(14); // Buying price
      sell_price = fp(12); // Selling price
      beforeSwapLPCurrency = await currencyToken.balanceOf(lp);
      beforeSwapLPSecurity = await securityToken.balanceOf(lp);
      beforeSwapTraderCurrency = await currencyToken.balanceOf(trader);
      beforeSwapTraderSecurity = await securityToken.balanceOf(trader);
    });
    
    it('accepts Empty order: Sell Order@CMP > Buy Order@CMP', async () => {

      const sell_order = await pool.swapGivenIn({
        in: pool.securityIndex,
        out: pool.currencyIndex,
        amount: sell_amount,
        balances: currentBalances,
        from: lp,
        data: ethers.utils.hexlify(ethers.utils.toUtf8Bytes('')), // MarketOrder Sell 15@Market Price,
      });
      
      const buy_order = await pool.swapGivenIn({
        in: pool.currencyIndex,
        out: pool.securityIndex,
        amount: buy_amount,
        balances: currentBalances,
        from: trader,
        data: ethers.utils.hexlify(ethers.utils.toUtf8Bytes('')), // MarketOrder Buy 15@market price
        eventHash: encodedEventSignature
      });

      const eventEncodedData =  ethers.utils.defaultAbiCoder.decode(eventType,buy_order[1]);

      if(eventEncodedData.orderType == "buySwap")
      {
        const sell_order = await pool.swapGivenIn({
          in: pool.securityIndex,
          out: pool.currencyIndex,
          amount: sell_amount,
          from: lp,
          balances: currentBalances,
          data: ethers.utils.hexlify(ethers.utils.toUtf8Bytes("self")), 
          eventHash: encodedEventSignature
        });
        expect(sell_order.toString()).to.be.equals(fp(sell_amount));

        const buy_order = await pool.swapGivenIn({
          in: pool.currencyIndex,
          out: pool.securityIndex,
          amount: buy_amount,
          from: trader,
          balances: currentBalances,
          data: ethers.utils.hexlify(ethers.utils.toUtf8Bytes("self")),  
        });
        expect(buy_order.toString()).to.be.equals(fp(buy_amount));
      }

      // const postPaidCurrencyBalance = currentBalances[pool.currencyIndex].add(buy_amount);
      // const request_amount = fp(postPaidCurrencyBalance.div(currentBalances[pool.securityIndex]).toString());

      // const afterSwapLPCurrency = await currencyToken.balanceOf(lp);
      // const afterSwapLPSecurity = await securityToken.balanceOf(lp);
      // const afterSwapTraderCurrency = await currencyToken.balanceOf(trader);
      // const afterSwapTraderSecurity = await securityToken.balanceOf(trader);
      
      // expect(afterSwapLPCurrency.toString()).to.be.equals(beforeSwapLPCurrency.toString());
      // expect(afterSwapLPSecurity.toString()).to.be.equals(beforeSwapLPSecurity.sub(request_amount).toString());
      // expect(afterSwapTraderCurrency.toString()).to.be.equals(beforeSwapTraderCurrency.toString());
      // expect(afterSwapTraderSecurity.toString()).to.be.equals(beforeSwapTraderSecurity.add(request_amount).toString());
    });

    it('accepts Market order: Sell Order@CMP > Buy Limit Order', async () => {
    
      const sell_order = await pool.swapGivenIn({
        in: pool.securityIndex,
        out: pool.currencyIndex,
        amount: sell_amount,
        balances: currentBalances,
        from: lp,
        data: ethers.utils.hexlify(ethers.utils.toUtf8Bytes('')) // MarketOrder Sell 15@Market Price
      });
      
      const buy_order = await pool.swapGivenIn({
        in: pool.currencyIndex,
        out: pool.securityIndex,
        amount: buy_amount,
        balances: currentBalances,
        from: trader,
        data: ethers.utils.hexlify(ethers.utils.toUtf8Bytes('5Limit' + buy_price.toString())) // MarketOrder Buy 15@market price
      });

      const eventEncodedData =  ethers.utils.defaultAbiCoder.decode(eventType,buy_order[1]);
      if(eventEncodedData.orderType == "buySwap")
      {
        const sell_order = await pool.swapGivenIn({
          in: pool.securityIndex,
          out: pool.currencyIndex,
          amount: sell_amount,
          balances: currentBalances,
          from: lp,
          data: ethers.utils.hexlify(ethers.utils.toUtf8Bytes('')) // MarketOrder Sell 15@Market Price
        });
        console.log(sell_order.toString());
        const buy_order = await pool.swapGivenIn({
          in: pool.currencyIndex,
          out: pool.securityIndex,
          amount: buy_amount,
          balances: currentBalances,
          from: trader,
          data: ethers.utils.hexlify(ethers.utils.toUtf8Bytes('5Limit' + buy_price.toString())) // MarketOrder Buy 15@market price
        });
        console.log(buy_order.toString());
      }


      const postPaidCurrencyBalance = currentBalances[pool.currencyIndex].add(buy_amount);
      const request_amount = fp(postPaidCurrencyBalance.div(currentBalances[pool.securityIndex]).toString());

      const afterSwapLPCurrency = await currencyToken.balanceOf(lp);
      const afterSwapLPSecurity = await securityToken.balanceOf(lp);
      const afterSwapTraderCurrency = await currencyToken.balanceOf(trader);
      const afterSwapTraderSecurity = await securityToken.balanceOf(trader);
      
      expect(afterSwapLPCurrency.toString()).to.be.equals(beforeSwapLPCurrency.add(buy_price).toString());
      expect(afterSwapLPSecurity.toString()).to.be.equals(beforeSwapLPSecurity.sub(request_amount).toString());
      expect(afterSwapTraderCurrency.toString()).to.be.equals(beforeSwapTraderCurrency.add(buy_price).toString());
      expect(afterSwapTraderSecurity.toString()).to.be.equals(beforeSwapTraderSecurity.add(request_amount).toString());
    });

    context('when pool paused', () => {
      sharedBeforeEach('pause pool', async () => {
        await pool.pause();
      });
      it('reverts', async () => {
        await expect(
          pool.swapGivenOut({
            in: pool.currencyIndex,
            out: pool.securityIndex,
            amount: buy_amount,
            balances: currentBalances,
          })
        ).to.be.revertedWith('PAUSED');
      });
    });
  });

  context('Placing Limit order', () => {
    let sell_amount: BigNumber;
    let buy_amount: BigNumber;
    let sell_price: BigNumber;
    let buy_price: BigNumber;
    let beforeSwapLPCurrency: BigNumber;
    let beforeSwapLPSecurity: BigNumber;
    let beforeSwapTraderCurrency: BigNumber;
    let beforeSwapTraderSecurity: BigNumber;

    sharedBeforeEach('initialize values ', async () => {
      sell_amount = fp(10); //qty
      buy_amount = fp(15); //qty
      buy_price = fp(12); // Buying price
      sell_price = fp(20); // Selling price
      beforeSwapLPCurrency = await currencyToken.balanceOf(lp);
      beforeSwapLPSecurity = await securityToken.balanceOf(lp);
      beforeSwapTraderCurrency = await currencyToken.balanceOf(trader);
      beforeSwapTraderSecurity = await securityToken.balanceOf(trader);
    });
    
    it('accepts Market Buy Order: Sell Limit Order > Buy Market Order', async () => {

      const sell_order = await pool.swapGivenIn({
        in: pool.securityIndex,
        out: pool.currencyIndex,
        amount: sell_amount,
        from: lp,
        balances: currentBalances,
        data: ethers.utils.hexlify(ethers.utils.toUtf8Bytes('5Limit' + sell_price.toString())), // Limit Order Sell@price12
      });

      const buy_order = await pool.swapGivenIn({
        in: pool.currencyIndex,
        out: pool.securityIndex,
        amount: buy_amount,
        from: trader,
        balances: currentBalances,
        data: ethers.utils.hexlify(ethers.utils.toUtf8Bytes('')), // MarketOrder Buy@market price
        eventHash: encodedEventSignature
      });

      const eventEncodedData =  ethers.utils.defaultAbiCoder.decode(eventType,buy_order[1]);

      if(eventEncodedData.orderType == "buySwap")
      {
        const sell_order = await pool.swapGivenIn({
          in: pool.securityIndex,
          out: pool.currencyIndex,
          amount: sell_amount,
          from: lp,
          balances: currentBalances,
          data: ethers.utils.hexlify(ethers.utils.toUtf8Bytes("self")), // Limit Order Sell@price12
          eventHash: encodedEventSignature
        });
        console.log("sell_order", sell_order.toString());

        const buy_order = await pool.swapGivenIn({
          in: pool.currencyIndex,
          out: pool.securityIndex,
          amount: buy_amount,
          from: trader,
          balances: currentBalances,
          data: ethers.utils.hexlify(ethers.utils.toUtf8Bytes("self")) // MarketOrder Buy@market price
        });
        console.log("buy_order", buy_order.toString());
      }

      const postPaidCurrencyBalance = currentBalances[pool.currencyIndex].add(buy_amount);
      const request_amount = fp(postPaidCurrencyBalance.div(currentBalances[pool.securityIndex]).toString());

      const afterSwapLPCurrency = await currencyToken.balanceOf(lp);
      const afterSwapLPSecurity = await securityToken.balanceOf(lp);
      const afterSwapTraderCurrency = await currencyToken.balanceOf(trader);
      const afterSwapTraderSecurity = await securityToken.balanceOf(trader);
      
      expect(afterSwapLPCurrency.toString()).to.be.equals(beforeSwapLPCurrency.add(sell_price).toString());
      expect(afterSwapLPSecurity.toString()).to.be.equals(beforeSwapLPSecurity.sub(request_amount).toString());
      expect(afterSwapTraderCurrency.toString()).to.be.equals(beforeSwapTraderCurrency.sub(sell_price).toString());
      expect(afterSwapTraderSecurity.toString()).to.be.equals(beforeSwapTraderSecurity.add(request_amount).toString());
    });

    it('accepts Limit Buy Order: Sell Limit Order > Buy Limit Order', async () => {

      const sell_order= await pool.swapGivenIn({
        in: pool.securityIndex,
        out: pool.currencyIndex,
        amount: sell_amount,
        balances: currentBalances,
        from: lp,
        data: ethers.utils.hexlify(ethers.utils.toUtf8Bytes('5Limit' + sell_price.toString())) // Limit Order Sell@price12
      });

      const buy_order = await pool.swapGivenIn({
        in: pool.currencyIndex,
        out: pool.securityIndex,
        amount: buy_amount,
        from: trader,
        balances: currentBalances,
        data: ethers.utils.hexlify(ethers.utils.toUtf8Bytes('5Limit' + buy_price.toString())) // Limit Order Sell@price12
      });

      const postPaidCurrencyBalance = currentBalances[pool.currencyIndex].add(buy_amount);
      const request_amount = fp(postPaidCurrencyBalance.div(currentBalances[pool.securityIndex]).toString());

      const afterSwapLPCurrency = await currencyToken.balanceOf(lp);
      const afterSwapLPSecurity = await securityToken.balanceOf(lp);
      const afterSwapTraderCurrency = await currencyToken.balanceOf(trader);
      const afterSwapTraderSecurity = await securityToken.balanceOf(trader);
      
      expect(afterSwapLPCurrency.toString()).to.be.equals(beforeSwapLPCurrency.add(buy_price).toString());
      expect(afterSwapLPSecurity.toString()).to.be.equals(beforeSwapLPSecurity.sub(request_amount).toString());
      expect(afterSwapTraderCurrency.toString()).to.be.equals(beforeSwapTraderCurrency.sub(buy_price).toString());
      expect(afterSwapTraderSecurity.toString()).to.be.equals(beforeSwapTraderSecurity.add(request_amount).toString());
    });

    context('when pool paused', () => {
      sharedBeforeEach('pause pool', async () => {
        await pool.pause();
      });
      it('reverts', async () => {
        await expect(
          pool.swapGivenOut({
            in: pool.currencyIndex,
            out: pool.securityIndex,
            amount: buy_amount,
            balances: currentBalances,
          })
        ).to.be.revertedWith('PAUSED');
      });
    });
  });


  context('Placing Stop Loss order', () => {
    let sell_amount: BigNumber;
    let buy_amount: BigNumber;
    let buy_price: BigNumber;
    let sell_price: BigNumber;
    let beforeSwapLPCurrency: BigNumber;
    let beforeSwapLPSecurity: BigNumber;
    let beforeSwapTraderCurrency: BigNumber;
    let beforeSwapTraderSecurity: BigNumber;

    sharedBeforeEach('initialize values ', async () => {
      sell_amount = fp(10); //qty
      buy_amount = fp(25); //qty
      buy_price = fp(12); // Buying price
      sell_price = fp(12); // Selling price
      beforeSwapLPCurrency = await currencyToken.balanceOf(lp);
      beforeSwapLPSecurity = await securityToken.balanceOf(lp);
      beforeSwapTraderCurrency = await currencyToken.balanceOf(trader);
      beforeSwapTraderSecurity = await securityToken.balanceOf(trader);
    });
    
    it('accepts Stop order: Sell Stop Order > Buy Market Order', async () => {

      const stop_order = await pool.swapGivenIn({
        in: pool.securityIndex,
        out: pool.currencyIndex,
        amount: sell_amount,
        balances: currentBalances,
        from: lp,
        data: ethers.utils.hexlify(ethers.utils.toUtf8Bytes('4Stop' + sell_price.toString())) // Stop Order Sell@price12
      });

      const buy_order_cmp = await pool.swapGivenIn({
        in: pool.currencyIndex,
        out: pool.securityIndex,
        amount: buy_amount,
        balances: currentBalances,
        from: trader,
        data: ethers.utils.hexlify(ethers.utils.toUtf8Bytes('')) // MarketOrder Buy@CMP
      });

      const postPaidCurrencyBalance = currentBalances[pool.currencyIndex].add(buy_amount);
      const request_amount = fp(postPaidCurrencyBalance.div(currentBalances[pool.securityIndex]).toString());

      const afterSwapLPCurrency = await currencyToken.balanceOf(lp);
      const afterSwapLPSecurity = await securityToken.balanceOf(lp);
      const afterSwapTraderCurrency = await currencyToken.balanceOf(trader);
      const afterSwapTraderSecurity = await securityToken.balanceOf(trader);
      
      expect(afterSwapLPCurrency.toString()).to.be.equals(beforeSwapLPCurrency.add(sell_price).toString());
      expect(afterSwapLPSecurity.toString()).to.be.equals(beforeSwapLPSecurity.sub(request_amount).toString());
      expect(afterSwapTraderCurrency.toString()).to.be.equals(beforeSwapTraderCurrency.sub(sell_price).toString());
      expect(afterSwapTraderSecurity.toString()).to.be.equals(beforeSwapTraderSecurity.add(request_amount).toString());

    });

    it('accepts Stop order: Sell Limit Order > Buy Stop Order', async () => {

      const sell_order_cmp = await pool.swapGivenOut({
        in: pool.securityIndex,
        out: pool.currencyIndex,
        amount: sell_amount,
        balances: currentBalances,
        from: lp,
        data: ethers.utils.hexlify(ethers.utils.toUtf8Bytes('5Limit' + sell_price.toString())) // Limit Order Sell@price12
      });

      const buy_order_cmp = await pool.swapGivenOut({
        in: pool.currencyIndex,
        out: pool.securityIndex,
        amount: buy_amount,
        balances: currentBalances,
        from: trader,
        data: ethers.utils.hexlify(ethers.utils.toUtf8Bytes('4Stop' + buy_price.toString())) // Buy Stop Order Buy@12
      });

      const postPaidCurrencyBalance = currentBalances[pool.currencyIndex].add(buy_amount);
      const request_amount = fp(postPaidCurrencyBalance.div(currentBalances[pool.securityIndex]).toString());

      const afterSwapLPCurrency = await currencyToken.balanceOf(lp);
      const afterSwapLPSecurity = await securityToken.balanceOf(lp);
      const afterSwapTraderCurrency = await currencyToken.balanceOf(trader);
      const afterSwapTraderSecurity = await securityToken.balanceOf(trader);
      
      expect(afterSwapLPCurrency.toString()).to.be.equals(beforeSwapLPCurrency.add(sell_price).toString());
      expect(afterSwapLPSecurity.toString()).to.be.equals(beforeSwapLPSecurity.sub(request_amount).toString());
      expect(afterSwapTraderCurrency.toString()).to.be.equals(beforeSwapTraderCurrency.sub(sell_price).toString());
      expect(afterSwapTraderSecurity.toString()).to.be.equals(beforeSwapTraderSecurity.add(request_amount).toString());

    });

    context('when pool paused', () => {
      sharedBeforeEach('pause pool', async () => {
        await pool.pause();
      });
      it('reverts', async () => {
        await expect(
          pool.swapGivenOut({
            in: pool.currencyIndex,
            out: pool.securityIndex,
            amount: buy_amount,
            balances: currentBalances,
          })
        ).to.be.revertedWith('PAUSED');
      });
    });

  });

  context('Placing Cancel Order Request', () => {
    let sell_amount: BigNumber;
    let buy_amount: BigNumber;
    let sell_price: BigNumber;

    sharedBeforeEach('initialize values ', async () => {
      sell_amount = fp(10); //qty
      buy_amount = fp(25); //qty
      sell_price = fp(12); //qty
    });
    
    it('order cancelled', async () => {

      const stop_order = await pool.swapGivenIn({
        in: pool.securityIndex,
        out: pool.currencyIndex,
        amount: sell_amount,
        balances: currentBalances,
        data: ethers.utils.hexlify(ethers.utils.toUtf8Bytes('5Limit'+ sell_price.toString())) // Stop Order Sell@price12
      });

      const _ref = await pool.getOrderRef();

      const cancel_order = await pool.cancelOrder({
        ref: _ref[0].toString()
      });

      const _refAfterCancell = await pool.getOrderRef();
      expect(_refAfterCancell[0]).to.be.equals(ZERO_BYTES32);

      
    });
  });

  context('Placing Edit Order Request', () => {
    let sell_amount: BigNumber;
    let buy_amount: BigNumber;
    let buy_price: BigNumber;
    let sell_price: BigNumber;
    let beforeSwapLPCurrency: BigNumber;
    let beforeSwapLPSecurity: BigNumber;
    let beforeSwapTraderCurrency: BigNumber;
    let beforeSwapTraderSecurity: BigNumber;


    sharedBeforeEach('initialize values ', async () => {
      sell_amount = fp(10); //qty
      buy_amount = fp(25); //qty
      buy_price = fp(25); // Buying price
      sell_price = fp(12); // Selling price
      beforeSwapLPCurrency = await currencyToken.balanceOf(lp);
      beforeSwapLPSecurity = await securityToken.balanceOf(lp);
      beforeSwapTraderCurrency = await currencyToken.balanceOf(trader);
      beforeSwapTraderSecurity = await securityToken.balanceOf(trader);
    });
    
    it('accepts edited order', async () => {
      const stop_order = await pool.swapGivenIn({
        in: pool.securityIndex,
        out: pool.currencyIndex,
        amount: sell_amount,
        balances: currentBalances,
        data: ethers.utils.hexlify(ethers.utils.toUtf8Bytes('5Limit' + sell_price.toString())) // Stop Order Sell@price12
      });

      const _ref = await pool.getOrderRef();

      const edit_order = await pool.editOrder({
        ref: _ref[0].toString(),
        price: fp(25), //Changed price from 12 --> 25
        amount: buy_amount //Changed Qty from 10 --> 25
      });

      const buy_order = await pool.swapGivenIn({
        in: pool.currencyIndex,
        out: pool.securityIndex,
        amount: buy_amount, //Qty 25
        balances: currentBalances,
        data: ethers.utils.hexlify(ethers.utils.toUtf8Bytes('')) // MarketOrder Buy@CMP
      });

      const postPaidCurrencyBalance = currentBalances[pool.currencyIndex].add(buy_amount);
      const request_amount = fp(postPaidCurrencyBalance.div(currentBalances[pool.securityIndex]).toString());


      const afterSwapLPCurrency = await currencyToken.balanceOf(lp);
      const afterSwapLPSecurity = await securityToken.balanceOf(lp);
      const afterSwapTraderCurrency = await currencyToken.balanceOf(trader);
      const afterSwapTraderSecurity = await securityToken.balanceOf(trader);
      
      expect(afterSwapLPCurrency.toString()).to.be.equals(beforeSwapLPCurrency.add(sell_price).toString());
      expect(afterSwapLPSecurity.toString()).to.be.equals(beforeSwapLPSecurity.sub(request_amount).toString());
      expect(afterSwapTraderCurrency.toString()).to.be.equals(beforeSwapTraderCurrency.sub(sell_price).toString());
      expect(afterSwapTraderSecurity.toString()).to.be.equals(beforeSwapTraderSecurity.add(request_amount).toString());
      
    });
  });

});

  describe('joins and exits', () => {
    sharedBeforeEach('deploy pool', async () => {
      await deployPool({ securityToken, currencyToken }, false);
      await pool.initialize();
    });

    it('regular joins should revert', async () => {
      const { tokens: allTokens } = await pool.getTokens();

      const tx = pool.vault.joinPool({
        poolAddress: pool.address,
        poolId: await pool.getPoolId(),
        recipient: lp.address,
        tokens: allTokens,
        data: '0x',
      });

      await expect(tx).to.be.revertedWith('UNHANDLED_BY_SECONDARY_POOL');
    });

    it('regular exits should revert', async () => {
      const { tokens: allTokens } = await pool.getTokens();

      const tx = pool.vault.exitPool({
        poolAddress: pool.address,
        poolId: await pool.getPoolId(),
        recipient: lp.address,
        tokens: allTokens,
        data: '0x',
      });

      await expect(tx).to.be.revertedWith('UNHANDLED_BY_SECONDARY_POOL');
    });
  });
});
