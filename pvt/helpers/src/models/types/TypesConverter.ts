import { SignerWithAddress } from '@nomiclabs/hardhat-ethers/dist/src/signer-with-address';
import { toNormalizedWeights } from '@balancer-labs/balancer-js';
import { ethers } from 'ethers';

import { BigNumberish, bn, fp, FP_100_PCT, FP_ZERO } from '../../numbers';
import { DAY, MONTH } from '../../time';
import { ZERO_ADDRESS } from '../../constants';
import TokenList from '../tokens/TokenList';
import { Account } from './types';
import { ProtocolFee, RawVaultDeployment, VaultDeployment } from '../vault/types';
import { RawLinearPoolDeployment, LinearPoolDeployment } from '../pools/linear/types';
import { RawStablePoolDeployment, StablePoolDeployment } from '../pools/stable/types';
import {
  RawWeightedPoolDeployment,
  WeightedPoolDeployment,
  RawLiquidityBootstrappingPoolDeployment,
  LiquidityBootstrappingPoolDeployment,
  RawManagedPoolDeployment,
  ManagedPoolDeployment,
  ManagedPoolType,
} from '../pools/weighted/types';
import {
  RawTokenApproval,
  RawTokenMint,
  RawTokensDeployment,
  TokenApproval,
  TokenMint,
  TokenDeployment,
  RawTokenDeployment,
} from '../tokens/types';

const DEFAULT_PAUSE_WINDOW_DURATION = 3 * MONTH;
const DEFAULT_BUFFER_PERIOD_DURATION = MONTH;

export function computeDecimalsFromIndex(i: number): number {
  // Produces repeating series (0..18)
  return i % 19;
}

export default {
  toVaultDeployment(params: RawVaultDeployment): VaultDeployment {
    let { mocked, admin, nextAdmin, pauseWindowDuration, bufferPeriodDuration, maxYieldValue, maxAUMValue } = params;
    if (!mocked) mocked = false;
    if (!admin) admin = params.from;
    if (!nextAdmin) nextAdmin = ZERO_ADDRESS;
    if (!pauseWindowDuration) pauseWindowDuration = 0;
    if (!bufferPeriodDuration) bufferPeriodDuration = 0;
    if (!maxYieldValue) maxYieldValue = FP_100_PCT;
    if (!maxAUMValue) maxAUMValue = FP_100_PCT;
    return { mocked, admin, nextAdmin, pauseWindowDuration, bufferPeriodDuration, maxYieldValue, maxAUMValue };
  },

  toRawVaultDeployment(params: RawWeightedPoolDeployment): RawVaultDeployment {
    let { admin, pauseWindowDuration, bufferPeriodDuration } = params;
    if (!admin) admin = params.from;
    if (!pauseWindowDuration) pauseWindowDuration = 0;
    if (!bufferPeriodDuration) bufferPeriodDuration = 0;

    const mocked = params.fromFactory !== undefined ? !params.fromFactory : true;
    return { mocked, admin, pauseWindowDuration, bufferPeriodDuration };
  },

  toWeightedPoolDeployment(params: RawWeightedPoolDeployment): WeightedPoolDeployment {
    let {
      tokens,
      weights,
      rateProviders,
      assetManagers,
      swapFeePercentage,
      pauseWindowDuration,
      bufferPeriodDuration,
      isCustomFeeEnabled,
    } = params;
    if (!params.owner) params.owner = ZERO_ADDRESS;
    if (!tokens) tokens = new TokenList();
    if (!weights) weights = Array(tokens.length).fill(fp(1));
    weights = toNormalizedWeights(weights.map(bn));
    if (!swapFeePercentage) swapFeePercentage = bn(1e16);
    if (!pauseWindowDuration) pauseWindowDuration = DEFAULT_PAUSE_WINDOW_DURATION;
    if (!bufferPeriodDuration) bufferPeriodDuration = DEFAULT_BUFFER_PERIOD_DURATION;
    if (!rateProviders) rateProviders = Array(tokens.length).fill(ZERO_ADDRESS);
    if (!assetManagers) assetManagers = Array(tokens.length).fill(ZERO_ADDRESS);
    if (isCustomFeeEnabled === undefined) isCustomFeeEnabled = false;

    return {
      tokens,
      weights,
      rateProviders,
      assetManagers,
      swapFeePercentage,
      pauseWindowDuration,
      bufferPeriodDuration,
      owner: this.toAddress(params.owner),
      isCustomFeeEnabled,
      from: params.from,
    };
  },

  toLiquidityBootstrappingPoolDeployment(
    params: RawLiquidityBootstrappingPoolDeployment
  ): LiquidityBootstrappingPoolDeployment {
    let { tokens, weights, swapFeePercentage, swapEnabledOnStart, pauseWindowDuration, bufferPeriodDuration } = params;
    if (!params.owner) params.owner = ZERO_ADDRESS;
    if (!tokens) tokens = new TokenList();
    if (!weights) weights = Array(tokens.length).fill(fp(1));
    weights = toNormalizedWeights(weights.map(bn));
    if (!swapFeePercentage) swapFeePercentage = bn(1e16);
    if (!pauseWindowDuration) pauseWindowDuration = DEFAULT_PAUSE_WINDOW_DURATION;
    if (!bufferPeriodDuration) bufferPeriodDuration = DEFAULT_BUFFER_PERIOD_DURATION;
    if (swapEnabledOnStart == undefined) swapEnabledOnStart = true;

    return {
      tokens,
      weights,
      swapFeePercentage,
      swapEnabledOnStart,
      pauseWindowDuration,
      bufferPeriodDuration,
      owner: params.owner,
      from: params.from,
    };
  },

  toManagedPoolDeployment(params: RawManagedPoolDeployment): ManagedPoolDeployment {
    let {
      tokens,
      weights,
      rateProviders,
      assetManagers,
      swapFeePercentage,
      swapEnabledOnStart,
      mustAllowlistLPs,
      managementAumFeePercentage,
      pauseWindowDuration,
      bufferPeriodDuration,
      factoryVersion,
      poolVersion,
      poolType,
      aumFeeId,
    } = params;
    if (!params.owner) params.owner = ZERO_ADDRESS;
    if (!tokens) tokens = new TokenList();
    if (!weights) weights = Array(tokens.length).fill(fp(1));
    weights = toNormalizedWeights(weights.map(bn));
    if (!swapFeePercentage) swapFeePercentage = bn(1e16);
    if (!rateProviders) rateProviders = Array(tokens.length).fill(ZERO_ADDRESS);
    if (!assetManagers) assetManagers = Array(tokens.length).fill(ZERO_ADDRESS);
    if (!poolType) poolType = ManagedPoolType.MANAGED_POOL;
    if (swapEnabledOnStart == undefined) swapEnabledOnStart = true;
    if (undefined == swapEnabledOnStart) swapEnabledOnStart = true;
    if (undefined == mustAllowlistLPs) mustAllowlistLPs = false;
    if (undefined == managementAumFeePercentage) managementAumFeePercentage = FP_ZERO;
    if (undefined == factoryVersion) factoryVersion = 'default factory version';
    if (undefined == poolVersion) poolVersion = 'default pool version';
    if (undefined == aumFeeId) aumFeeId = ProtocolFee.AUM;
    if (!pauseWindowDuration) pauseWindowDuration = 9 * MONTH;
    if (!bufferPeriodDuration) bufferPeriodDuration = MONTH;
    return {
      tokens,
      weights,
      rateProviders,
      assetManagers,
      swapFeePercentage,
      swapEnabledOnStart,
      mustAllowlistLPs,
      managementAumFeePercentage,
      owner: this.toAddress(params.owner),
      from: params.from,
      factoryVersion,
      poolVersion,
      poolType,
      pauseWindowDuration,
      bufferPeriodDuration,
      aumFeeId,
    };
  },

  toLinearPoolDeployment(params: RawLinearPoolDeployment): LinearPoolDeployment {
    let { upperTarget, assetManagers, swapFeePercentage, pauseWindowDuration, bufferPeriodDuration } = params;

    if (!upperTarget) upperTarget = bn(0);
    if (!swapFeePercentage) swapFeePercentage = bn(1e12);
    if (!pauseWindowDuration) pauseWindowDuration = DEFAULT_PAUSE_WINDOW_DURATION;
    if (!bufferPeriodDuration) bufferPeriodDuration = DEFAULT_BUFFER_PERIOD_DURATION;
    if (!assetManagers) assetManagers = [ZERO_ADDRESS, ZERO_ADDRESS];

    return {
      mainToken: params.mainToken,
      wrappedToken: params.wrappedToken,
      upperTarget,
      assetManagers,
      swapFeePercentage,
      pauseWindowDuration,
      bufferPeriodDuration,
      owner: params.owner,
    };
  },

  toStablePoolDeployment(params: RawStablePoolDeployment): StablePoolDeployment {
    let {
      tokens,
      rateProviders,
      tokenRateCacheDurations,
      exemptFromYieldProtocolFeeFlags,
      amplificationParameter,
      swapFeePercentage,
      pauseWindowDuration,
      bufferPeriodDuration,
      version,
    } = params;

    if (!tokens) tokens = new TokenList();
    if (!rateProviders) rateProviders = Array(tokens.length).fill(ZERO_ADDRESS);
    if (!tokenRateCacheDurations) tokenRateCacheDurations = Array(tokens.length).fill(DAY);
    if (!amplificationParameter) amplificationParameter = bn(200);
    if (!swapFeePercentage) swapFeePercentage = bn(1e12);
    if (!pauseWindowDuration) pauseWindowDuration = DEFAULT_PAUSE_WINDOW_DURATION;
    if (!bufferPeriodDuration) bufferPeriodDuration = DEFAULT_BUFFER_PERIOD_DURATION;
    if (!exemptFromYieldProtocolFeeFlags) exemptFromYieldProtocolFeeFlags = Array(tokens.length).fill(false);
    if (!version) version = 'test';

    return {
      tokens,
      rateProviders,
      tokenRateCacheDurations,
      exemptFromYieldProtocolFeeFlags,
      amplificationParameter,
      swapFeePercentage,
      pauseWindowDuration,
      bufferPeriodDuration,
      owner: params.owner,
      version,
    };
  },

  /***
   * Converts a raw list of token deployments into a consistent deployment request
   * @param params It can be a number specifying the number of tokens to be deployed, a list of strings denoting the
   * token symbols to be used, or a list of token attributes (decimals, symbol, name).
   * @param from A default signer can be specified as the deployer address of the entire list, otherwise a single
   * signer per token can be defined.
   */
  toTokenDeployments(params: RawTokensDeployment, from?: SignerWithAddress, varyDecimals = false): TokenDeployment[] {
    params = typeof params === 'number' ? Array(params).fill({}) : params;
    if (!Array.isArray(params)) params = [params];

    return params.map((param, i) => {
      if (typeof param === 'string') param = { symbol: param, from };
      const args = Object.assign(
        {},
        { symbol: `TK${i}`, name: `Token ${i}`, decimals: varyDecimals ? computeDecimalsFromIndex(i) : 18, from },
        param
      );
      return this.toTokenDeployment(args);
    });
  },

  /***
   * Converts a raw token deployment into a consistent deployment request
   * @param params Could be a single string denoting the token symbol or optional token attributes (decimals, symbol, name)
   */
  toTokenDeployment(params: RawTokenDeployment): TokenDeployment {
    if (typeof params === 'string') params = { symbol: params };
    const { name, symbol, decimals, from } = params;
    return {
      from,
      name: name ?? `Token`,
      symbol: symbol ?? `TKN`,
      decimals: decimals ?? 18,
    };
  },

  /***
   * Converts a raw token mint param into a consistent minting list
   */
  toTokenMints(params: RawTokenMint): TokenMint[] {
    if (Array.isArray(params)) return params.flatMap(this.toTokenMints);

    const { to, amount, from } = params;

    if (!Array.isArray(to)) {
      if (Array.isArray(from)) throw Error('Inconsistent mint sender length');
      return [{ to, amount, from }];
    }

    if (Array.isArray(from) && to.length !== from.length) throw Error('Inconsistent mint sender length');
    return to.map((to, i) => ({ to, amount, from: Array.isArray(from) ? from[i] : from }));
  },

  /***
   * Converts a raw token approval param into a consistent approval list
   */
  toTokenApprovals(params: RawTokenApproval): TokenApproval[] {
    if (Array.isArray(params)) return params.flatMap(this.toTokenApprovals);

    const { to: recipients, amount, from } = params;
    const to = Array.isArray(recipients) ? recipients : [recipients];

    return to.flatMap((to) =>
      Array.isArray(from) ? from.map((from) => ({ to, amount, from })) : [{ to, amount, from }]
    );
  },

  toAddresses(to: Account[]): string[] {
    return to.map(this.toAddress);
  },

  toAddress(to?: Account): string {
    if (!to) return ZERO_ADDRESS;
    return typeof to === 'string' ? to : to.address;
  },

  toBytes32(value: BigNumberish): string {
    const hexy = ethers.utils.hexlify(value);
    return ethers.utils.hexZeroPad(hexy, 32);
  },
};
