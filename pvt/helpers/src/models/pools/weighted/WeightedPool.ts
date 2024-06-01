import { Contract } from 'ethers';
import TypesConverter from '../../types/TypesConverter';
import VaultDeployer from '../../vault/VaultDeployer';
import BaseWeightedPool from './BaseWeightedPool';
import { BUFFER_PERIOD_DURATION, NAME, PAUSE_WINDOW_DURATION, SYMBOL } from '../base/BasePool';
import { RawWeightedPoolDeployment, WeightedPoolDeployment } from './types';
import Vault from '../../vault/Vault';
import { deploy, deployedAt } from '../../../contract';
import * as expectEvent from '../../../test/expectEvent';
import { Account } from '../../types/types';
import TokenList from '../../tokens/TokenList';
import { BigNumberish } from '../../../numbers';
import { randomBytes } from 'ethers/lib/utils';

export default class WeightedPool extends BaseWeightedPool {
  rateProviders: Account[];
  assetManagers: string[];
  isCustomFeeEnabled: boolean;

  constructor(
    instance: Contract,
    poolId: string,
    vault: Vault,
    tokens: TokenList,
    weights: BigNumberish[],
    rateProviders: Account[],
    assetManagers: string[],
    swapFeePercentage: BigNumberish,
    isCustomFeeEnabled: boolean,
    owner?: Account
  ) {
    super(instance, poolId, vault, tokens, weights, swapFeePercentage, owner);

    this.rateProviders = rateProviders;
    this.assetManagers = assetManagers;
    this.isCustomFeeEnabled = isCustomFeeEnabled;
  }

  static async create(params: RawWeightedPoolDeployment = {}): Promise<WeightedPool> {
    const vault = params?.vault ?? (await VaultDeployer.deploy(TypesConverter.toRawVaultDeployment(params)));
    const deployment = TypesConverter.toWeightedPoolDeployment(params);
    const pool = await (params.fromFactory ? this._deployFromFactory : this._deployStandalone)(deployment, vault);
    const poolId = await pool.getPoolId();

    const { tokens, weights, rateProviders, assetManagers, swapFeePercentage, owner, isCustomFeeEnabled } = deployment;

    return new WeightedPool(
      pool,
      poolId,
      vault,
      tokens,
      weights,
      rateProviders,
      assetManagers,
      swapFeePercentage,
      isCustomFeeEnabled,
      owner
    );
  }

  static async _deployStandalone(params: WeightedPoolDeployment, vault: Vault): Promise<Contract> {
    const { from } = params;

    return deploy('v2-pool-weighted/WeightedPool', {
      args: [
        {
          name: NAME,
          symbol: SYMBOL,
          tokens: params.tokens.addresses,
          normalizedWeights: params.weights,
          rateProviders: TypesConverter.toAddresses(params.rateProviders),
          assetManagers: params.assetManagers,
          swapFeePercentage: params.swapFeePercentage,
          isCustomFeeEnabled: params.isCustomFeeEnabled,
        },
        vault.address,
        vault.protocolFeesProvider.address,
        params.pauseWindowDuration,
        params.bufferPeriodDuration,
        params.owner,
      ],
      from,
    });
  }

  static async _deployFromFactory(params: WeightedPoolDeployment, vault: Vault): Promise<Contract> {
    // Note that we only support asset managers with the standalone deploy method.

    const { tokens, weights, rateProviders, swapFeePercentage, owner, isCustomFeeEnabled, from } = params;

    const factory = await deploy('v2-pool-weighted/WeightedPoolFactory', {
      args: [vault.address, vault.getFeesProvider().address, PAUSE_WINDOW_DURATION, BUFFER_PERIOD_DURATION],
      from,
    });

    const tx = await factory.create(
      NAME,
      SYMBOL,
      tokens.addresses,
      weights,
      rateProviders,
      swapFeePercentage,
      owner,
      isCustomFeeEnabled,
      randomBytes(32)
    );
    const receipt = await tx.wait();
    const event = expectEvent.inReceipt(receipt, 'PoolCreated');
    return deployedAt('v2-pool-weighted/WeightedPool', event.args.pool);
  }
}
