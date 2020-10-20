import { ethers } from '@nomiclabs/buidler';
import { expect } from 'chai';
import { ContractFactory, Contract } from 'ethers';

describe('ConstantWeightedProdStrategy', function () {
  let poolID: string;
  let twoTokensStrategy: Contract;
  let threeTokensStrategy: Contract;

  beforeEach(async function () {
    poolID = ethers.utils.id('Test');

    const ConstantWeightedProdStrategyFactory: ContractFactory = await ethers.getContractFactory(
      'ConstantWeightedProdStrategy'
    );

    twoTokensStrategy = await ConstantWeightedProdStrategyFactory.deploy(
      [(0.8e18).toString(), (0.2e18).toString()],
      (0.05e18).toString()
    ); //fee: 0.05%
    await twoTokensStrategy.deployed();
    threeTokensStrategy = await ConstantWeightedProdStrategyFactory.deploy(
      [(0.4e18).toString(), (0.4e18).toString(), (0.2e18).toString()],
      (0.05e18).toString()
    ); //fee: 0.05%
    await threeTokensStrategy.deployed();
  });

  describe('Pair balances validation', () => {
    it('should validate correctly two tokens', async () => {
      const result = await twoTokensStrategy.validatePair(
        poolID,
        0,
        1,
        (100e18).toString(),
        (200e18).toString(),
        (15.75e18).toString(), //15e18 + fee
        (85.64935e18).toString()
      );
      expect(result[0]).to.be.true;
    });
    it('should validate correctly three tokens', async () => {
      const result = await threeTokensStrategy.validatePair(
        poolID,
        0,
        1,
        (100e18).toString(),
        (200e18).toString(),
        (15.75e18).toString(), //15e18 + fee
        (26.08695652e18).toString()
      );
      expect(result[0]).to.be.true;
    });
  });
});
