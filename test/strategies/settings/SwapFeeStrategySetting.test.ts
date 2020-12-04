import { ethers } from 'hardhat';
import { expect } from 'chai';
import { ContractFactory, Contract } from 'ethers';
import * as expectEvent from '../../helpers/expectEvent';

describe('SwapFeeStrategySetting', function () {
  let strategy: Contract;

  const SWAP_FEE = (0.05e18).toString();

  const deployStrategy = (isMutable: boolean) => {
    beforeEach('deploy strategy', async function () {
      const SwapFeeStrategySetting: ContractFactory = await ethers.getContractFactory('SwapFeeStrategySetting');
      strategy = await SwapFeeStrategySetting.deploy([isMutable, SWAP_FEE]);
      await strategy.deployed();
    });
  };

  const itInitializesTheSettingCorrectly = () => {
    describe('initialization', () => {
      it('initializes the setting correctly', async () => {
        const currentSwapFee = await strategy.getSwapFee();
        expect(currentSwapFee).to.equal(SWAP_FEE);
      });
    });
  };

  context('when the setting is mutable', () => {
    const mutable = true;

    deployStrategy(mutable);

    itInitializesTheSettingCorrectly();

    it('supports changing its value', async () => {
      const newSwapFee = (0.1e18).toString();

      const receipt = await (await strategy.setSwapFee(newSwapFee)).wait();
      expectEvent.inReceipt(receipt, 'SwapFeeSet', { swapFee: newSwapFee });

      const currentSwapFee = await strategy.getSwapFee();
      expect(currentSwapFee).to.equal(newSwapFee);
    });
  });

  context('when the setting is immutable', () => {
    const mutable = false;

    deployStrategy(mutable);

    itInitializesTheSettingCorrectly();

    it('does not support changing its value', async () => {
      const newSwapFee = (0.1e18).toString();
      await expect(strategy.setSwapFee(newSwapFee)).to.be.revertedWith('Swap fee is not mutable');
    });
  });
});
