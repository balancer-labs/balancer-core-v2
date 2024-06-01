import { BigNumber, ContractReceipt } from 'ethers';
import { SignerWithAddress } from '@nomiclabs/hardhat-ethers/dist/src/signer-with-address';

import { BigNumberish } from '../../../numbers';

import Token from '../../tokens/Token';
import TokenList from '../../tokens/TokenList';
import { Account, NAry } from '../../types/types';
import Vault from '../../vault/Vault';

export enum WeightedPoolType {
  WEIGHTED_POOL = 0,
  LIQUIDITY_BOOTSTRAPPING_POOL,
}

// These names are used in the helpers to fetch the artifacts
export enum ManagedPoolType {
  MANAGED_POOL = 'ManagedPool',
  MOCK_MANAGED_POOL = 'MockManagedPool',
  MOCK_MANAGED_POOL_SETTINGS = 'MockManagedPoolSettings',
}

export type RawWeightedPoolDeployment = {
  tokens?: TokenList;
  weights?: BigNumberish[];
  rateProviders?: Account[];
  assetManagers?: string[];
  swapFeePercentage?: BigNumberish;
  pauseWindowDuration?: BigNumberish;
  bufferPeriodDuration?: BigNumberish;
  owner?: Account;
  isCustomFeeEnabled?: boolean;
  admin?: SignerWithAddress;
  from?: SignerWithAddress;
  vault?: Vault;
  fromFactory?: boolean;
};

export type WeightedPoolDeployment = {
  tokens: TokenList;
  weights: BigNumberish[];
  rateProviders: Account[];
  assetManagers: string[];
  swapFeePercentage: BigNumberish;
  pauseWindowDuration: BigNumberish;
  bufferPeriodDuration: BigNumberish;
  owner: Account;
  isCustomFeeEnabled: boolean;
  admin?: SignerWithAddress;
  from?: SignerWithAddress;
};

export type RawLiquidityBootstrappingPoolDeployment = {
  tokens?: TokenList;
  weights?: BigNumberish[];
  swapFeePercentage?: BigNumberish;
  swapEnabledOnStart?: boolean;
  pauseWindowDuration?: BigNumberish;
  bufferPeriodDuration?: BigNumberish;
  owner?: Account;
  admin?: SignerWithAddress;
  from?: SignerWithAddress;
  vault?: Vault;
  fromFactory?: boolean;
};

export type LiquidityBootstrappingPoolDeployment = {
  tokens: TokenList;
  weights: BigNumberish[];
  swapFeePercentage: BigNumberish;
  swapEnabledOnStart: boolean;
  pauseWindowDuration: BigNumberish;
  bufferPeriodDuration: BigNumberish;
  owner: Account;
  admin?: SignerWithAddress;
  from?: SignerWithAddress;
};

export type RawManagedPoolDeployment = {
  tokens?: TokenList;
  weights?: BigNumberish[];
  rateProviders?: Account[];
  assetManagers?: string[];
  swapFeePercentage?: BigNumberish;
  pauseWindowDuration?: BigNumberish;
  bufferPeriodDuration?: BigNumberish;
  swapEnabledOnStart?: boolean;
  mustAllowlistLPs?: boolean;
  managementAumFeePercentage?: BigNumberish;
  owner?: Account;
  admin?: SignerWithAddress;
  from?: SignerWithAddress;
  vault?: Vault;
  fromFactory?: boolean;
  poolType?: ManagedPoolType;
  factoryVersion?: string;
  poolVersion?: string;
  aumFeeId?: BigNumberish;
};

export type ManagedPoolDeployment = {
  tokens: TokenList;
  weights: BigNumberish[];
  rateProviders: Account[];
  assetManagers: string[];
  swapFeePercentage: BigNumberish;
  pauseWindowDuration: BigNumberish;
  bufferPeriodDuration: BigNumberish;
  swapEnabledOnStart: boolean;
  mustAllowlistLPs: boolean;
  managementAumFeePercentage: BigNumberish;
  factoryVersion: string;
  poolVersion: string;
  owner: Account;
  admin?: SignerWithAddress;
  from?: SignerWithAddress;
  poolType?: ManagedPoolType;
  aumFeeId?: BigNumberish;
};

export type SwapWeightedPool = {
  in: number | Token;
  out: number | Token;
  amount: BigNumberish;
  recipient?: Account;
  from?: SignerWithAddress;
  lastChangeBlock?: BigNumberish;
  data?: string;
};

export type JoinExitWeightedPool = {
  recipient?: Account;
  currentBalances?: BigNumberish[];
  lastChangeBlock?: BigNumberish;
  protocolFeePercentage?: BigNumberish;
  data?: string;
  from?: SignerWithAddress;
};

export type InitWeightedPool = {
  initialBalances: NAry<BigNumberish>;
  from?: SignerWithAddress;
  recipient?: Account;
  protocolFeePercentage?: BigNumberish;
};

export type JoinGivenInWeightedPool = {
  amountsIn: NAry<BigNumberish>;
  minimumBptOut?: BigNumberish;
  from?: SignerWithAddress;
  recipient?: Account;
  lastChangeBlock?: BigNumberish;
  currentBalances?: BigNumberish[];
  protocolFeePercentage?: BigNumberish;
};

export type JoinGivenOutWeightedPool = {
  token: number | Token;
  bptOut: BigNumberish;
  from?: SignerWithAddress;
  recipient?: Account;
  lastChangeBlock?: BigNumberish;
  currentBalances?: BigNumberish[];
  protocolFeePercentage?: BigNumberish;
};

export type JoinAllGivenOutWeightedPool = {
  bptOut: BigNumberish;
  from?: SignerWithAddress;
  recipient?: Account;
  lastChangeBlock?: BigNumberish;
  currentBalances?: BigNumberish[];
  protocolFeePercentage?: BigNumberish;
};

export type ExitGivenOutWeightedPool = {
  amountsOut: NAry<BigNumberish>;
  maximumBptIn?: BigNumberish;
  recipient?: Account;
  from?: SignerWithAddress;
  lastChangeBlock?: BigNumberish;
  currentBalances?: BigNumberish[];
  protocolFeePercentage?: BigNumberish;
};

export type SingleExitGivenInWeightedPool = {
  bptIn: BigNumberish;
  token: number | Token;
  recipient?: Account;
  from?: SignerWithAddress;
  lastChangeBlock?: BigNumberish;
  currentBalances?: BigNumberish[];
  protocolFeePercentage?: BigNumberish;
};

export type MultiExitGivenInWeightedPool = {
  bptIn: BigNumberish;
  recipient?: Account;
  from?: SignerWithAddress;
  lastChangeBlock?: BigNumberish;
  currentBalances?: BigNumberish[];
  protocolFeePercentage?: BigNumberish;
};

export type JoinResult = {
  amountsIn: BigNumber[];
  dueProtocolFeeAmounts: BigNumber[];
  receipt: ContractReceipt;
};

export type ExitResult = {
  amountsOut: BigNumber[];
  dueProtocolFeeAmounts: BigNumber[];
  receipt: ContractReceipt;
};

export type SwapResult = {
  amount: BigNumber;
  receipt: ContractReceipt;
};

export type JoinQueryResult = {
  bptOut: BigNumber;
  amountsIn: BigNumber[];
};

export type ExitQueryResult = {
  bptIn: BigNumber;
  amountsOut: BigNumber[];
};

export type VoidResult = {
  receipt: ContractReceipt;
};

export type PoolQueryResult = JoinQueryResult | ExitQueryResult;

export type GradualWeightUpdateParams = {
  startTime: BigNumber;
  endTime: BigNumber;
  startWeights: BigNumber[];
  endWeights: BigNumber[];
};

export type GradualSwapFeeUpdateParams = {
  startTime: BigNumber;
  endTime: BigNumber;
  startSwapFeePercentage: BigNumber;
  endSwapFeePercentage: BigNumber;
};

export type ManagedPoolParams = {
  name: string;
  symbol: string;
  assetManagers: string[];
};

export type ManagedPoolSettingsParams = {
  tokens: string[];
  normalizedWeights: BigNumberish[];
  swapFeePercentage: BigNumberish;
  swapEnabledOnStart: boolean;
  mustAllowlistLPs: boolean;
  managementAumFeePercentage: BigNumberish;
  aumFeeId: BigNumberish;
};

export type CircuitBreakerState = {
  bptPrice: BigNumber;
  referenceWeight: BigNumber;
  lowerBound: BigNumber;
  upperBound: BigNumber;
  lowerBptPriceBound: BigNumber;
  upperBptPriceBound: BigNumber;
};
